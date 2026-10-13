import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { EventEmitter } from "node:events";

type JsonObject = Record<string, any>;
export class CodexRequestFailure extends Error {
  constructor(message: string, readonly outcome: "not-sent" | "unknown", readonly kind: "closed" | "cancelled" | "timeout" | "protocol" | "write") { super(message); this.name = kind === "cancelled" ? "AbortError" : "CodexRequestFailure"; }
}
export interface CodexObservedRequestOptions { signal?: AbortSignal; onWriteAttempt?: () => void; timeoutMs?: number }

export interface CodexServerOptions {
  executable: string;
  args?: readonly string[];
  cwd: string;
  env: NodeJS.ProcessEnv;
  credentialStore?: "keyring" | "ephemeral";
  requestTimeoutMs?: number;
  /** Image-only clients can opt into a bounded larger base64 response. */
  maxMessageBytes?: number;
  spawnProcess?: typeof spawn;
}

/**
 * Official newline-delimited app-server protocol. Never handles OAuth tokens.
 * Pinned Codex 0.162.1 source: the macOS direct keyring backend uses service
 * "Codex Auth" and cli|SHA256(canonical CODEX_HOME)[0:16] as its account name.
 * Only that profile's key is loaded/saved/deleted; keyring mode fails closed.
 * https://github.com/openai/codex/blob/rust-v0.162.1/codex-rs/login/src/auth/storage.rs#L221-L315
 * https://github.com/openai/codex/blob/rust-v0.162.1/codex-rs/config/src/types.rs#L152-L169
 * This is source evidence, not a substitute for live macOS Keychain coexistence QA.
 */
export class CodexAppServer extends EventEmitter {
  private child: ChildProcessWithoutNullStreams | undefined;
  private nextId = 1;
  private pending = new Map<number, { resolve(value: JsonObject): void; reject(error: Error): void; timer: NodeJS.Timeout }>();
  private startPromise: Promise<void> | undefined;
  private buffer = "";
  private closed = false;
  requestHandler: ((method: string, params: JsonObject) => Promise<unknown>) | undefined;

  constructor(private readonly options: CodexServerOptions) { super(); }

  start(): Promise<void> {
    if (this.startPromise != null) return this.startPromise;
    this.startPromise = this.initialize();
    return this.startPromise;
  }

  private async initialize(): Promise<void> {
    const child = (this.options.spawnProcess ?? spawn)(this.options.executable, [...(this.options.args ?? [
      "app-server", "--listen", "stdio://", "-c", `cli_auth_credentials_store="${this.options.credentialStore ?? "keyring"}"`,
      "-c", "features.shell_tool=false", "-c", "features.unified_exec=false", "-c", "features.apply_patch_freeform=false",
    ])], { cwd: this.options.cwd, env: this.options.env, stdio: "pipe", windowsHide: true }) as ChildProcessWithoutNullStreams;
    this.child = child;
    child.stdout.setEncoding("utf8");
    child.stdout.on("data", (chunk: string) => this.consume(chunk));
    // Provider stderr may contain auth URLs or sensitive diagnostics. Drain, never log.
    child.stderr.on("data", () => {});
    child.stdin.on("error", () => this.fail(new Error("Codex app-server input closed.")));
    child.on("error", () => { this.fail(new Error("Codex app-server could not start. Check its configured executable.")); if (child.pid == null) this.emit("process-exit"); });
    child.on("exit", () => { this.fail(new Error("Codex app-server exited. Reconnect the session.")); this.emit("process-exit"); });
    try {
      await this.request("initialize", { clientInfo: { name: "venditbot", title: "벤디트봇", version: "0.1.0" }, capabilities: { experimentalApi: true } });
      this.notify("initialized", {});
    } catch (error) { this.close(); throw error; }
  }

  request(method: string, params: JsonObject = {}, timeoutMs = this.options.requestTimeoutMs ?? 20_000): Promise<JsonObject> {
    return this.requestObserved(method, params, {timeoutMs});
  }

  /** A write attempt is irreversible even when stdin reports backpressure or subsequently fails. */
  requestObserved(method: string, params: JsonObject = {}, options: CodexObservedRequestOptions = {}): Promise<JsonObject> {
    const child = this.child;
    if (options.signal?.aborted) return Promise.reject(new CodexRequestFailure("Codex request cancelled.", "not-sent", "cancelled"));
    if (this.closed || !child || child.stdin.destroyed || child.stdin.writableEnded) return Promise.reject(new CodexRequestFailure("Codex app-server is not running.", "not-sent", "closed"));
    const id = this.nextId++;
    let line: string;
    try { line = `${JSON.stringify({id,method,params})}\n`; } catch { return Promise.reject(new CodexRequestFailure("Codex request could not be encoded.", "not-sent", "protocol")); }
    return new Promise((resolve, reject) => {
      let attempted = false, settled = false;
      const finish = (error?: Error, value?: JsonObject) => {
        if (settled) return; settled = true; clearTimeout(timer); options.signal?.removeEventListener("abort", abort); this.pending.delete(id);
        if (error) reject(error instanceof CodexRequestFailure ? error : new CodexRequestFailure(error.message, attempted ? "unknown" : "not-sent", "protocol"));
        else resolve(value ?? {});
      };
      const abort = () => finish(new CodexRequestFailure("Codex request cancelled.", attempted ? "unknown" : "not-sent", "cancelled"));
      const timer = setTimeout(() => finish(new CodexRequestFailure(`Codex app-server timed out (${method}).`, attempted ? "unknown" : "not-sent", "timeout")), options.timeoutMs ?? this.options.requestTimeoutMs ?? 20_000); timer.unref();
      this.pending.set(id, {resolve:value=>finish(undefined,value),reject:error=>finish(error),timer});
      options.signal?.addEventListener("abort", abort, {once:true});
      if (options.signal?.aborted) {abort(); return;}
      try {
        attempted = true; options.onWriteAttempt?.();
        child.stdin.write(line, error => {if (error) finish(new CodexRequestFailure("Codex app-server input closed.", "unknown", "write"));});
      } catch {finish(new CodexRequestFailure("Codex app-server write failed.", "unknown", "write"));}
    });
  }

  notify(method: string, params: JsonObject): void { this.send({ method, params }); }

  private send(message: unknown): void {
    if (this.closed || this.child == null) return;
    this.child.stdin.write(`${JSON.stringify(message)}\n`);
  }

  private consume(chunk: string): void {
    this.buffer += chunk;
    if (Buffer.byteLength(this.buffer) > (this.options.maxMessageBytes ?? 8 * 1024 * 1024)) { this.fail(new Error("Codex app-server exceeded its message size limit.")); this.close(); return; }
    let newline: number;
    while ((newline = this.buffer.indexOf("\n")) >= 0) {
      const line = this.buffer.slice(0, newline); this.buffer = this.buffer.slice(newline + 1);
      if (!line.trim()) continue;
      let message: JsonObject;
      try { message = JSON.parse(line) as JsonObject; } catch { this.fail(new Error("Codex app-server returned malformed JSON.")); this.close(); return; }
      if (message == null || typeof message !== "object" || Array.isArray(message)) { this.fail(new Error("Codex app-server returned an invalid message.")); this.close(); return; }
      if (typeof message.method === "string") {
        if (message.id != null) void this.handleRequest(message);
        else this.emit("notification", message.method, message.params ?? {});
      } else if (typeof message.id === "number") {
        const pending = this.pending.get(message.id);
        if (pending == null) continue;
        this.pending.delete(message.id); clearTimeout(pending.timer);
        // Do not expose server message strings: providers may echo input or credentials.
        if (message.error != null) pending.reject(codexProtocolError(message.error));
        else pending.resolve(message.result ?? {});
      }
    }
  }

  private async handleRequest(message: JsonObject): Promise<void> {
    const { id, method } = message;
    try {
      // Host-owned tools are the only execution bridge. Built-in approvals always fail closed.
      if (method === "item/commandExecution/requestApproval" || method === "item/fileChange/requestApproval") {
        this.send({ id, result: { decision: "decline" } }); return;
      }
      if (method !== "item/tool/call" || this.requestHandler == null) {
        this.send({ id, error: { code: -32601, message: "This request is not enabled by VenditBot." } }); return;
      }
      this.send({ id, result: await this.requestHandler(method, message.params ?? {}) });
    } catch {
      this.send({ id, result: { success: false, contentItems: [{ type: "inputText", text: "Tool request could not be completed." }] } });
    }
  }

  private fail(error: Error): void {
    if (this.closed) return;
    for (const pending of this.pending.values()) { clearTimeout(pending.timer); pending.reject(error); }
    this.pending.clear();
    this.emit("failure", error);
    this.close();
  }

  close(): void {
    if (this.closed) return;
    this.closed = true;
    for (const pending of this.pending.values()) { clearTimeout(pending.timer); pending.reject(new Error("Codex app-server closed.")); }
    this.pending.clear();
    this.emit("closed");
    const child = this.child;
    if (child != null && child.exitCode == null) {
      child.stdin.end(); child.kill("SIGTERM");
      const timer = setTimeout(() => { if (child.exitCode == null && child.signalCode == null) child.kill("SIGKILL"); }, 1_000);
      timer.unref();
    }
  }
  /** Updates must observe real child exit, not only the logical closed event. */
  closeAndWait(timeoutMs = 4000): Promise<void> {
    const child = this.child;
    if (!child || child.exitCode != null || child.signalCode != null || child.pid == null) {this.close(); return Promise.resolve();}
    return new Promise((resolveExit, reject) => {
      const done = () => {clearTimeout(timer); child.off('exit', done); resolveExit();};
      const timer = setTimeout(() => {child.off('exit', done); reject(new Error('Codex 프로세스 종료를 확인하지 못했습니다.'));}, timeoutMs);
      child.once('exit', done); this.close();
    });
  }
}

/** Classify official diagnostics without forwarding potentially secret-bearing text. */
export function codexProtocolError(error: JsonObject): Error {
  const message = typeof error.message === "string" ? error.message : "";
  if (/keyring|keychain|secure storage|credential storage/i.test(message)) return new Error("Codex 보안 저장소(Keychain)에 접근할 수 없습니다. macOS에서 이 앱의 접근을 허용한 뒤 다시 연결하세요. 평문 저장으로 전환하지 않았습니다.");
  if (/address already in use|port.*(?:busy|occupied|in use)|bind.*(?:failed|error)/i.test(message)) return new Error("Codex 인증 포트가 사용 중입니다. 진행 중인 다른 로그인 절차를 완료하거나 취소한 뒤 다시 시도하세요.");
  return new Error(`Codex app-server request failed (code ${Number(error.code) || "unknown"}).`);
}
