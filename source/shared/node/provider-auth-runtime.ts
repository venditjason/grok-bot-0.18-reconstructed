import type {ActiveProviderTurn, ProviderSteerInput, ProviderSteerResult, SafeProviderFailure} from "../provider-turns.js";
import {ProviderTurnFailure, codexTurnFailure, providerTurnFailure} from "./provider-failures.js";
import {webInput} from "./native-web-events.js";
import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { resolve } from "node:path";
import { CodexAppServer, CodexRequestFailure, codexProtocolError, type CodexServerOptions } from "./codex-app-server.js";
import { streamClaudeCliTurn, type ClaudeTurnEvent, type ClaudeMcpServer } from "./claude-cli-session.js";
import { configureProviderCliPaths, resolveClaudeCodeCliPath, resolveCodexCliPath, validateProviderExecutable } from "./provider-cli-paths.js";
import { createVenditBotChildEnvironment, ensureVenditBotDirectories, resolveVenditBotPaths } from "./venditbot-paths.js";
import { selectProviderModel, type ProviderModelCatalog } from "../provider-model-catalog.js";
import { codexCatalogModels, discoverClaudeModels } from "./provider-model-discovery.js";
export type { ProviderModel, ProviderModelCatalog } from "../provider-model-catalog.js";

type Loose = Record<string, any>;
export type LoginProvider = "codex" | "claude-code";
export interface ProviderAuthStatus {
  provider: LoginProvider;
  installed: boolean;
  executablePath: string | null;
  phase: "disconnected" | "preparing" | "awaiting-browser" | "authenticated" | "testing" | "ready" | "cancelled" | "error" | "policy-blocked";
  authenticated: boolean;
  inferenceVerified: boolean;
  credentialStorage: "session" | "keyring" | "provider-managed";
  account: { email: string | null; plan: string | null } | null;
  error: string | null;
}
export interface ProviderLoginResult extends ProviderAuthStatus { authUrl?: string }
export interface ProviderMessage { role: string; content: string | readonly unknown[]; [key: string]: unknown }
export interface ProviderUsage { inputTokens?: number; outputTokens?: number; cacheReadTokens?: number; cacheWriteTokens?: number }
export type CodexTurnEvent = {type:"provider-status";status:"retrying";failure:SafeProviderFailure} | { type: "text-delta"; delta: string } | { type: "done"; text: string; threadId: string; turnId: string; usage: ProviderUsage } | import('./native-web-events.js').NativeWebSearchEvent;
export interface CodexTurnOptions {
  clientConversationId?: string;
  attemptId?: string;
  /** Advisory main-process UI notification; this is not admission authority. */
  onActiveTurn?: (turn: ActiveProviderTurn | null) => void;
  messages: readonly ProviderMessage[];
  model?: string;
  effort?: string;
  systemInstructions?: string;
  signal?: AbortSignal;
  /** Enabled only after this turn's host action-rule authorization. */
  nativeWebSearch?: boolean;
  tools?: readonly Loose[];
  executeTool?: (tool: Loose, args: unknown, toolCallId: string) => Promise<unknown>;
}
export interface ClaudeTurnOptions {
  nativeWebSearch?: boolean;
  messages: readonly ProviderMessage[]; model?: string; effort?: string; systemInstructions?: string; signal?: AbortSignal; sessionId?: string; mcpServer?: ClaudeMcpServer;
  /** Explicitly pass completed cross-provider history as quoted JSON context on a new Claude session. The host must disclose this transfer. */
  historyHandoff?: boolean;
}
export interface AuthRuntimeOptions {
  codexExecutable?: string;
  /** keyring is production default; ephemeral is explicit demo/test mode only. */
  codexCredentialStore?: "keyring" | "ephemeral";
  claudeExecutable?: string;
  claudeLoginPolicy?: { mode: "personal-local" } | { mode: "approved-distribution"; approved: boolean; isolationVerified: boolean; evidence: string };
  /** Injection seam for protocol tests; never exposed over renderer IPC. */
  createCodexServer?: (options: CodexServerOptions) => CodexAppServer;
  paths?: ReturnType<typeof resolveVenditBotPaths>;
  loginTimeoutMs?: number;
  turnTimeoutMs?: number;
}
const POLICY_ERROR = "Claude 계정 로그인은 배포 승인과 전용 인증 저장소 검증 후 제공됩니다. 현재는 Anthropic API 연결을 사용하세요.";
const SYSTEM_PROMPT = "You are 벤디트봇 (VenditBot), a concise desktop assistant. Use only tools explicitly supplied by VenditBot. Do not access local files or execute shell commands outside those tools.";
function initial(provider: LoginProvider): ProviderAuthStatus {
  return { provider, installed: false, executablePath: null, phase: "disconnected", authenticated: false, inferenceVerified: false, credentialStorage: provider === "codex" ? "keyring" : "provider-managed", account: null, error: null };
}
function abortError(): Error { return new DOMException("요청이 취소되었습니다.", "AbortError"); }
function abortable<T>(operation: Promise<T>, signal: AbortSignal): Promise<T> {
  return new Promise<T>((resolveResult, reject) => {
    const abort = () => reject(signal.reason instanceof Error ? signal.reason : abortError());
    if (signal.aborted) { operation.catch(() => {}); abort(); return; }
    signal.addEventListener("abort", abort, { once: true });
    operation.then(resolveResult, reject).finally(() => signal.removeEventListener("abort", abort));
  });
}
function stopOwnedChild(child: ChildProcessWithoutNullStreams): void {
  child.kill("SIGTERM");
  const timer = setTimeout(() => { if (child.exitCode == null && child.signalCode == null) child.kill("SIGKILL"); }, 1_000);
  timer.unref();
}
function validatedAuthUrl(value: unknown): string {
  if (typeof value !== "string") throw new Error("Codex did not return a browser login URL.");
  const url = new URL(value);
  if (url.protocol !== "https:" || url.username || url.password || !["auth.openai.com", "chatgpt.com"].includes(url.hostname)) throw new Error("Codex returned an unsupported login URL.");
  return url.toString();
}

/** One auth owner per Electron main process. Credentials never cross renderer IPC. */
export class ProviderAuthRuntime {
  private options: AuthRuntimeOptions;
  private states: Record<LoginProvider, ProviderAuthStatus> = { codex: initial("codex"), "claude-code": initial("claude-code") };
  private server: CodexAppServer | undefined;
  private serverPromise: Promise<CodexAppServer> | undefined;
  private loginPromise: Promise<ProviderLoginResult> | undefined;
  private claudeBeginPromise: Promise<ProviderLoginResult> | undefined;
  private readonly attempts: Partial<Record<LoginProvider, { cancelled: boolean }>> = {};
  private readonly statusPending = new Map<LoginProvider, Promise<ProviderAuthStatus>>();
  private readonly disconnectPending = new Map<LoginProvider, Promise<ProviderAuthStatus>>();
  private readonly authGeneration: Record<LoginProvider, number> = { codex: 0, "claude-code": 0 };
  private readonly catalogs = new Map<LoginProvider, ProviderModelCatalog>();
  private readonly catalogPending = new Map<LoginProvider, Promise<ProviderModelCatalog>>();
  private readonly catalogGeneration: Record<LoginProvider, number> = { codex: 0, "claude-code": 0 };
  private readonly claudeCommands = new Set<ChildProcessWithoutNullStreams>();
  private readonly ownedClaudeChildren = new Set<ChildProcessWithoutNullStreams>();
  private readonly ownedCodexServers = new Set<CodexAppServer>();
  private loginId: string | undefined;
  private loginUrl: string | undefined;
  private loginTimer: NodeJS.Timeout | undefined;
  private completedLogins = new Map<string, boolean>();
  private claudeLogin: ChildProcessWithoutNullStreams | undefined;
  private turnActive = false;
  private activeCodexTurn: {descriptor: ActiveProviderTurn; server: CodexAppServer; stop: AbortController; close:()=>void; receipts: Map<string,{text:string;result:Promise<ProviderSteerResult>}>} | undefined;
  /** Retain this turn's receipts after its admission fence closes; never turn an unknown duplicate into FIFO. */
  private lastSteerTurn: Pick<NonNullable<ProviderAuthRuntime['activeCodexTurn']>, 'descriptor' | 'receipts'> | undefined;
  getActiveTurn(): ActiveProviderTurn | null { return this.activeCodexTurn ? {...this.activeCodexTurn.descriptor} : null; }
  async steer(input: ProviderSteerInput, signal?: AbortSignal): Promise<ProviderSteerResult> {
    const binding = {clientConversationId:input.clientConversationId,attemptId:input.attemptId,clientMessageId:input.clientMessageId,turnId:input.expectedTurnId};
    const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
    if (typeof input.clientConversationId !== 'string' || !input.clientConversationId || input.clientConversationId.length > 100 || input.clientConversationId.includes('\0') || !uuid.test(input.attemptId) || !uuid.test(input.clientMessageId)
      || typeof input.expectedTurnId !== 'string' || !input.expectedTurnId || input.expectedTurnId.length > 256 || input.expectedTurnId.includes('\0') || typeof input.text !== 'string' || !input.text.trim() || input.text.length > 100000 || input.text.includes('\0')) return {...binding,state:'conflict-before-wire'};
    const remembered = this.lastSteerTurn;
    if (remembered && remembered.descriptor.clientConversationId === input.clientConversationId && remembered.descriptor.attemptId === input.attemptId && remembered.descriptor.turnId === input.expectedTurnId) {
      const receipt = remembered.receipts.get(input.clientMessageId);
      if (receipt) return receipt.text === input.text ? receipt.result : {...binding,state:'conflict-before-wire'};
    }
    const active = this.activeCodexTurn;
    if (!active || active.descriptor.clientConversationId !== input.clientConversationId || active.descriptor.attemptId !== input.attemptId || active.descriptor.turnId !== input.expectedTurnId) return {...binding,state:'not-active-before-wire'};
    const existing = active.receipts.get(input.clientMessageId);
    if (existing) return existing.text === input.text ? existing.result : {...binding,state:'conflict-before-wire'};
    if (active.receipts.size >= 16) return {...binding,state:'unsupported-before-wire'};
    // Reserve the ID synchronously before any await or wire attempt.
    const result: Promise<ProviderSteerResult> = Promise.resolve().then(async () => {
      if (this.activeCodexTurn !== active || active.stop.signal.aborted || signal?.aborted) return {...binding,state:'not-active-before-wire'};
      let sent = false;
      try {
        const ack = await active.server.requestObserved('turn/steer', {threadId:active.descriptor.threadId,expectedTurnId:input.expectedTurnId,clientUserMessageId:input.clientMessageId,input:[{type:'text',text:input.text}]},
          {signal:signal ? AbortSignal.any([active.stop.signal,signal]) : active.stop.signal, onWriteAttempt:()=>{sent=true;}});
        if (ack.turnId !== input.expectedTurnId) throw new ProviderTurnFailure({provider:'codex',code:'protocol',phase:'steer',outcome:'unknown',autoRetry:false});
        return {...binding,state:'accepted'};
      } catch (error) {
        if (!sent && error instanceof CodexRequestFailure && error.outcome === 'not-sent') return {...binding,state:'not-active-before-wire'};
        active.close();
        return {...binding,state:'unknown',safeProviderFailure: {...runtimeTurnFailure(error,'codex','steer',true).safe}};
      }
    });
    active.receipts.set(input.clientMessageId,{text:input.text,result});
    return result;
  }
  private claudeTurnController: AbortController | undefined;
  constructor(options: AuthRuntimeOptions = {}) { this.options = options; }
  private trackClaude(child: ChildProcessWithoutNullStreams): void { this.ownedClaudeChildren.add(child); child.once('exit', () => this.ownedClaudeChildren.delete(child)); child.once('error', () => {if (child.pid == null) this.ownedClaudeChildren.delete(child);}); }
  configure(options: AuthRuntimeOptions): void {
    if (this.server != null || this.claudeLogin != null || this.turnActive || this.statusPending.size || this.loginPromise != null || this.claudeBeginPromise != null) throw new Error("연결을 해제한 뒤 실행 파일 설정을 변경하세요.");
    this.options = { ...this.options, ...options }; configureProviderCliPaths(options);
    this.invalidateModels("codex"); this.invalidateModels("claude-code");
  }
  private paths() { return this.options.paths ?? resolveVenditBotPaths(); }
  private claudeEnv(): NodeJS.ProcessEnv {
    return { ...createVenditBotChildEnvironment(process.env, this.paths()), DISABLE_AUTOUPDATER: "1", CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC: "1" };
  }
  private executable(provider: LoginProvider): string | null {
    return provider === "codex" ? this.options.codexExecutable == null ? resolveCodexCliPath() : validateProviderExecutable(this.options.codexExecutable)
      : this.options.claudeExecutable == null ? resolveClaudeCodeCliPath() : validateProviderExecutable(this.options.claudeExecutable);
  }
  private claudeAllowed(): boolean { const p = this.options.claudeLoginPolicy; return p?.mode === "personal-local" || (p?.mode === "approved-distribution" && p.approved === true && p.isolationVerified === true && p.evidence.trim().length > 0); }
  snapshot(provider: LoginProvider): ProviderAuthStatus {
    const executablePath = this.executable(provider);
    const state = { ...this.states[provider], installed: executablePath != null, executablePath };
    if (provider === "codex") state.credentialStorage = this.options.codexCredentialStore === "ephemeral" ? "session" : "keyring";
    if (provider === "claude-code" && !this.claudeAllowed()) return { ...state, phase: "policy-blocked", error: POLICY_ERROR };
    return state;
  }
  private prepare(): void {
    ensureVenditBotDirectories(this.paths());
  }
  private invalidateModels(provider: LoginProvider): void { this.catalogGeneration[provider]++; this.catalogs.delete(provider); this.catalogPending.delete(provider); }
  async listModels(provider: LoginProvider, options: { refresh?: boolean } = {}): Promise<ProviderModelCatalog> {
    if (provider === "claude-code" && !this.claudeAllowed()) throw new Error(POLICY_ERROR);
    if (this.executable(provider) == null) throw new Error("공급자의 실행 파일을 찾을 수 없습니다.");
    const pending = this.catalogPending.get(provider); if (pending != null) return structuredClone(await pending);
    const cached = this.catalogs.get(provider);
    if (!options.refresh && cached != null && Date.now() - Date.parse(cached.fetchedAt) < 5 * 60_000) return structuredClone(cached);
    const generation = this.catalogGeneration[provider];
    const query = this.fetchModels(provider).then(catalog => {
      if (generation !== this.catalogGeneration[provider]) throw new Error("공급자 연결 상태가 바뀌었습니다. 모델 목록을 다시 확인하세요.");
      this.catalogs.set(provider, catalog); return catalog;
    });
    this.catalogPending.set(provider, query);
    try { return structuredClone(await query); } finally { if (this.catalogPending.get(provider) === query) this.catalogPending.delete(provider); }
  }
  private async fetchModels(provider: LoginProvider): Promise<ProviderModelCatalog> {
    this.prepare();
    if (provider === "claude-code") {
      const models = await discoverClaudeModels({ executable: this.executable(provider)!, cwd: this.paths().claudeConfigDir, env: this.claudeEnv(), onChild: child => { this.trackClaude(child); this.claudeCommands.add(child); child.once("close", () => this.claudeCommands.delete(child)); } });
      return { models, fetchedAt: new Date().toISOString(), source: "claude-cli/initialize", ...(!models.length ? { warning: "공급자가 선택 가능한 모델을 반환하지 않았습니다." } : {}) };
    }
    const server = await this.codex(); const models: ProviderModelCatalog["models"] = []; const cursors = new Set<string>(); let cursor: string | undefined;
    for (let page = 0; page < 20; page++) {
      const result = await server.request("model/list", { limit: 100, includeHidden: false, ...(cursor ? { cursor } : {}) });
      for (const model of codexCatalogModels(result.data)) if (!models.some(existing => existing.id === model.id)) models.push(model);
      if (result.nextCursor == null) return { models, fetchedAt: new Date().toISOString(), source: "codex-app-server/model/list", ...(!models.length ? { warning: "공급자가 선택 가능한 모델을 반환하지 않았습니다." } : {}) };
      if (typeof result.nextCursor !== "string" || !result.nextCursor || cursors.has(result.nextCursor)) throw new Error("Codex 모델 목록 페이지 정보가 올바르지 않습니다.");
      cursor = result.nextCursor; cursors.add(cursor);
    }
    throw new Error("Codex 모델 목록의 페이지 제한을 초과했습니다.");
  }
  private async codex(): Promise<CodexAppServer> {
    if (this.serverPromise != null) return this.serverPromise;
    const executable = this.executable("codex");
    if (executable == null) throw new Error("검증된 Codex 실행 파일이 필요합니다. 고급 설정에서 경로를 선택하세요.");
    this.prepare();
    const paths = this.paths();
    const server = (this.options.createCodexServer ?? (options => new CodexAppServer(options)))({ executable, cwd: paths.codexHome, env: createVenditBotChildEnvironment(process.env, paths), credentialStore: this.options.codexCredentialStore ?? "keyring" });
    this.ownedCodexServers.add(server); server.once('process-exit', () => this.ownedCodexServers.delete(server));
    this.server = server;
    server.on("notification", (method: string, params: Loose) => {
      if (this.server !== server) return;
      if (method === "account/login/completed" && typeof params.loginId === "string") {
        if (params.loginId === this.loginId) void this.finishCodexLogin(params.success === true, params.error);
        else if (this.loginPromise != null && this.loginId == null && this.completedLogins.size < 8) this.completedLogins.set(params.loginId, params.success === true);
      }
    });
    server.on("failure", () => {
      if (this.server !== server) return;
      this.server = undefined; this.serverPromise = undefined; this.clearLogin();
      this.states.codex = { ...initial("codex"), phase: "error", error: "Codex 세션이 종료되었습니다. 다시 연결하세요." };
    });
    server.on("closed", () => {
      if (this.server !== server) return;
      this.server = undefined; this.serverPromise = undefined; this.clearLogin();
      const current = this.states.codex;
      this.states.codex = { ...initial("codex"), ...(current.phase === "cancelled" || current.phase === "error" ? { phase: current.phase, error: current.error } : {}) };
    });
    this.serverPromise = server.start().then(() => server).catch(error => { if (this.server === server) { this.server = undefined; this.serverPromise = undefined; } throw error; });
    return this.serverPromise;
  }
  private clearLogin(): void {
    if (this.loginTimer != null) clearTimeout(this.loginTimer);
    this.loginTimer = undefined; this.loginId = undefined; this.loginUrl = undefined; this.completedLogins.clear();
  }
  async status(provider: LoginProvider): Promise<ProviderAuthStatus> {
    const pending = this.statusPending.get(provider);
    if (pending != null) return pending;
    const query = this.queryStatus(provider, this.authGeneration[provider]);
    this.statusPending.set(provider, query);
    try { return await query; } finally { if (this.statusPending.get(provider) === query) this.statusPending.delete(provider); }
  }
  private async queryStatus(provider: LoginProvider, generation: number): Promise<ProviderAuthStatus> {
    if (provider === "claude-code") {
      if (!this.claudeAllowed() || this.executable(provider) == null || this.claudeLogin != null) return this.snapshot(provider);
      const { output, code } = await this.claudeCommand(["auth", "status"]);
      if (generation !== this.authGeneration[provider]) return this.snapshot(provider);
      let data: Loose;
      try { data = JSON.parse(output) as Loose; } catch { throw new Error("Claude 인증 상태 JSON을 확인할 수 없습니다. 지원되는 CLI 버전이 필요합니다."); }
      if (typeof data.configDirectory !== "string" || resolve(data.configDirectory) !== resolve(this.paths().claudeConfigDir)) throw new Error("Claude CLI 인증 디렉터리 격리를 확인할 수 없습니다.");
      const authenticated = code === 0 && data.loggedIn === true && data.authMethod === "claude.ai";
      if (authenticated !== this.states[provider].authenticated || (authenticated && (data.email ?? null) !== this.states[provider].account?.email)) this.invalidateModels(provider);
      this.states[provider] = { ...this.states[provider], authenticated, inferenceVerified: authenticated && this.states[provider].inferenceVerified, phase: authenticated ? this.states[provider].inferenceVerified ? "ready" : "authenticated" : "disconnected", account: authenticated ? { email: typeof data.email === "string" ? data.email : null, plan: typeof data.subscriptionType === "string" ? data.subscriptionType : null } : null, error: null };
      return this.snapshot(provider);
    }
    if (this.executable(provider) == null) return this.snapshot(provider);
    const result = await (await this.codex()).request("account/read", { refreshToken: false });
    if (generation !== this.authGeneration[provider]) return this.snapshot(provider);
    const account = result.account; const authenticated = account?.type === "chatgpt"; const current = this.states.codex;
    if (authenticated !== current.authenticated || (authenticated && (account.email ?? null) !== current.account?.email)) this.invalidateModels(provider);
    this.states.codex = { ...current, authenticated, inferenceVerified: authenticated && current.inferenceVerified, account: authenticated ? { email: typeof account.email === "string" ? account.email : null, plan: typeof account.planType === "string" ? account.planType : null } : null, phase: this.loginId != null ? "awaiting-browser" : authenticated ? current.inferenceVerified ? "ready" : "authenticated" : current.phase === "error" ? "error" : "disconnected", error: !authenticated && current.phase === "error" ? current.error : null };
    return this.snapshot(provider);
  }
  async begin(provider: LoginProvider): Promise<ProviderLoginResult> {
    if (this.turnActive) throw new Error("진행 중인 요청을 완료하거나 취소한 뒤 연결하세요.");
    if (this.disconnectPending.has(provider)) throw new Error("연결 해제가 진행 중입니다. 완료 후 다시 연결하세요.");
    if (provider === "claude-code") {
      if (this.claudeBeginPromise != null) return this.claudeBeginPromise;
      const attempt = { cancelled: false }; this.attempts[provider] = attempt;
      const promise = (async () => { if (this.claudeAllowed()) await this.status(provider); if (attempt.cancelled) throw abortError(); return this.beginClaude(); })();
      this.claudeBeginPromise = promise;
      try { return await promise; } finally { if (this.claudeBeginPromise === promise) this.claudeBeginPromise = undefined; if (this.attempts[provider] === attempt) delete this.attempts[provider]; }
    }
    if (this.loginPromise != null) return this.loginPromise;
    if (this.loginId != null) return { ...this.snapshot(provider), ...(this.loginUrl == null ? {} : { authUrl: this.loginUrl }) };
    const attempt = { cancelled: false }; this.attempts[provider] = attempt;
    const promise = this.beginCodex(attempt); this.loginPromise = promise;
    try { return await promise; } finally { if (this.loginPromise === promise) this.loginPromise = undefined; if (this.attempts[provider] === attempt) delete this.attempts[provider]; }
  }
  private async beginCodex(attempt: { cancelled: boolean }): Promise<ProviderLoginResult> {
    try {
      const previous = await this.status("codex");
      if (attempt.cancelled) throw abortError();
      if (previous.authenticated) return previous;
      this.invalidateModels("codex");
      this.states.codex = { ...this.states.codex, phase: "preparing", error: null };
      const server = await this.codex();
      if (attempt.cancelled) throw abortError();
      const result = await server.request("account/login/start", { type: "chatgpt" });
      if (attempt.cancelled) throw abortError();
      if (typeof result.loginId !== "string" || result.loginId.length === 0) throw new Error("Codex did not return a login attempt ID.");
      this.loginId = result.loginId;
      try { this.loginUrl = validatedAuthUrl(result.authUrl); } catch (error) { await server.request("account/login/cancel", { loginId: this.loginId }).catch(() => {}); this.clearLogin(); throw error; }
      this.states.codex = { ...this.states.codex, phase: "awaiting-browser" };
      this.loginTimer = setTimeout(() => { void this.cancel("codex").then(() => { this.states.codex = { ...this.states.codex, phase: "error", error: "로그인 시간이 초과되었습니다. 다시 시도하세요." }; }).catch(() => {}); }, this.options.loginTimeoutMs ?? 5 * 60_000);
      this.loginTimer.unref();
      if (this.completedLogins.has(this.loginId)) await this.finishCodexLogin(this.completedLogins.get(this.loginId) === true);
      return { ...this.snapshot("codex"), ...(this.loginUrl == null ? {} : { authUrl: this.loginUrl }) };
    } catch (error) { if (attempt.cancelled) throw abortError(); this.states.codex = { ...this.states.codex, phase: "error", error: error instanceof Error ? error.message : "Codex 로그인을 시작할 수 없습니다." }; throw error; }
  }
  private async finishCodexLogin(success: boolean, diagnostic?: unknown): Promise<void> {
    this.invalidateModels("codex");
    this.clearLogin();
    if (!success) { this.states.codex = { ...this.states.codex, phase: "error", error: typeof diagnostic === "string" ? codexProtocolError({ message: diagnostic }).message : "Codex 로그인이 완료되지 않았습니다. 다시 시도하세요." }; return; }
    try { await this.status("codex"); } catch { this.states.codex = { ...this.states.codex, phase: "error", error: "로그인 후 계정 상태를 확인할 수 없습니다." }; }
  }
  private beginClaude(): ProviderLoginResult {
    if (!this.claudeAllowed()) return this.snapshot("claude-code");
    if (this.claudeLogin != null || this.states["claude-code"].authenticated) return this.snapshot("claude-code");
    const executable = this.executable("claude-code");
    if (executable == null) throw new Error("검증된 Claude CLI 실행 파일이 필요합니다.");
    this.prepare();
    this.invalidateModels("claude-code");
    const child = spawn(executable, ["auth", "login"], { cwd: this.paths().claudeConfigDir, env: this.claudeEnv(), stdio: "pipe", windowsHide: true });
    this.trackClaude(child);
    this.claudeLogin = child;
    this.states["claude-code"] = { ...this.states["claude-code"], phase: "awaiting-browser", error: null };
    child.stdout.on("data", () => {}); child.stderr.on("data", () => {});
    const timer = setTimeout(() => { void this.cancel("claude-code"); }, this.options.loginTimeoutMs ?? 5 * 60_000); timer.unref();
    child.once("error", () => { clearTimeout(timer); if (this.claudeLogin === child) { this.claudeLogin = undefined; this.states["claude-code"] = { ...this.states["claude-code"], phase: "error", error: "Claude 로그인을 시작할 수 없습니다." }; } });
    child.once("exit", code => {
      clearTimeout(timer); if (this.claudeLogin !== child) return; this.claudeLogin = undefined;
      if (code === 0) void this.status("claude-code").catch(() => { this.states["claude-code"] = { ...this.states["claude-code"], phase: "error", error: "Claude 인증 상태 검증에 실패했습니다." }; });
      else this.states["claude-code"] = { ...this.states["claude-code"], phase: "error", error: "Claude 로그인이 완료되지 않았습니다." };
    });
    return this.snapshot("claude-code");
  }
  private claudeCommand(args: string[]): Promise<{ output: string; code: number | null }> {
    const executable = this.executable("claude-code");
    if (executable == null) return Promise.reject(new Error("Claude CLI 실행 파일이 필요합니다."));
    this.prepare();
    return new Promise((resolveResult, reject) => {
      const child = spawn(executable, args, { cwd: this.paths().claudeConfigDir, env: this.claudeEnv(), stdio: "pipe", windowsHide: true });
      this.trackClaude(child);
      this.claudeCommands.add(child);
      let output = "";
      const timer = setTimeout(() => { stopOwnedChild(child); reject(new Error("Claude 인증 명령 시간이 초과되었습니다.")); }, 15_000); timer.unref();
      child.stdout.setEncoding("utf8"); child.stdout.on("data", (chunk: string) => { output += chunk; if (output.length > 256_000) { stopOwnedChild(child); reject(new Error("Claude 인증 응답이 너무 큽니다.")); } });
      child.stderr.on("data", () => {});
      child.once("error", () => { this.claudeCommands.delete(child); clearTimeout(timer); reject(new Error("Claude 인증 명령을 실행할 수 없습니다.")); });
      child.once("exit", code => { this.claudeCommands.delete(child); clearTimeout(timer); resolveResult({ output, code }); });
    });
  }
  async cancel(provider: LoginProvider): Promise<ProviderAuthStatus> {
    this.invalidateModels(provider);
    this.authGeneration[provider]++; this.statusPending.delete(provider);
    const attempt = this.attempts[provider]; if (attempt != null) attempt.cancelled = true;
    this.states[provider] = { ...this.states[provider], phase: "cancelled", error: null };
    if (provider === "codex") {
      const loginId = this.loginId; this.clearLogin();
      if (loginId != null && this.server != null) await this.server.request("account/login/cancel", { loginId }, 1_000).catch(() => { this.server?.close(); this.server = undefined; this.serverPromise = undefined; });
      else if (attempt != null) { this.server?.close(); this.server = undefined; this.serverPromise = undefined; }
    } else {
      if (this.claudeLogin != null) { const child = this.claudeLogin; this.claudeLogin = undefined; stopOwnedChild(child); }
      if (attempt != null) for (const child of this.claudeCommands) stopOwnedChild(child);
    }
    return this.snapshot(provider);
  }
  async disconnect(provider: LoginProvider): Promise<ProviderAuthStatus> {
    const pending = this.disconnectPending.get(provider); if (pending != null) return pending;
    const promise = this.disconnectInternal(provider); this.disconnectPending.set(provider, promise);
    try { return await promise; } finally { if (this.disconnectPending.get(provider) === promise) this.disconnectPending.delete(provider); }
  }
  private async disconnectInternal(provider: LoginProvider): Promise<ProviderAuthStatus> {
    if (this.turnActive) throw new Error("진행 중인 요청을 취소한 뒤 연결을 해제하세요.");
    await this.cancel(provider);
    if (provider === "codex") {
      if (this.executable(provider) != null) { const server = await this.codex(); await server.request("account/logout"); server.close(); }
      this.server = undefined; this.serverPromise = undefined;
    } else if (this.claudeAllowed() && this.executable(provider) != null) {
      await this.status(provider);
      if (this.states[provider].authenticated) { const result = await this.claudeCommand(["auth", "logout"]); if (result.code !== 0) throw new Error("Claude 연결 해제에 실패했습니다."); }
    }
    // A native status command can finish after logout even if it read credentials
    // before logout began. Retire all pre-completion observations atomically.
    this.authGeneration[provider]++; this.statusPending.delete(provider); this.invalidateModels(provider);
    this.states[provider] = initial(provider); return this.snapshot(provider);
  }
  shutdown(): void {
    this.lastSteerTurn=undefined;
    this.invalidateModels("codex"); this.invalidateModels("claude-code");
    for (const provider of ["codex", "claude-code"] as const) { this.authGeneration[provider]++; const attempt = this.attempts[provider]; if (attempt != null) attempt.cancelled = true; }
    this.statusPending.clear();
    for (const child of this.claudeCommands) stopOwnedChild(child);
    this.claudeTurnController?.abort();
    this.clearLogin(); this.server?.close(); this.server = undefined; this.serverPromise = undefined;
    if (this.claudeLogin != null) stopOwnedChild(this.claudeLogin); this.claudeLogin = undefined;
    this.states = { codex: initial("codex"), "claude-code": initial("claude-code") };
  }
  async shutdownForUpdate(): Promise<void> {
    if (this.turnActive || this.loginId || this.claudeLogin || this.loginPromise || this.claudeBeginPromise || this.statusPending.size || this.disconnectPending.size || this.catalogPending.size) throw new Error('진행 중인 공급자 작업을 마친 뒤 업데이트하세요.');
    const servers = [...this.ownedCodexServers], children = [...this.ownedClaudeChildren];
    const pending = children.map(child => new Promise<void>((resolveExit, reject) => {
      if (child.exitCode != null || child.signalCode != null || child.pid == null) {resolveExit(); return;}
      const done = () => {clearTimeout(timer); child.off('exit', done); resolveExit();};
      const timer = setTimeout(() => {child.off('exit', done); reject(new Error('Claude 프로세스 종료를 확인하지 못했습니다.'));}, 4000);
      child.once('exit', done); stopOwnedChild(child);
    }));
    pending.push(...servers.map(server => server.closeAndWait())); this.shutdown(); await Promise.all(pending);
  }
  async *runCodexTurn(options: CodexTurnOptions): AsyncGenerator<CodexTurnEvent> {
    if (this.disconnectPending.has("codex")) throw new Error("Codex 연결 해제가 진행 중입니다.");
    if (this.turnActive) throw new Error("한 번에 하나의 공급자 요청만 실행할 수 있습니다.");
    if (options.signal?.aborted) throw abortError();
    this.turnActive = true;
    let server: CodexAppServer | undefined; let threadId: string | undefined; let turnId: string | undefined;
    let inferenceSent = false; let phase: SafeProviderFailure["phase"] = "preflight";
    let finished = false; let text = ""; let usage: ProviderUsage = {};
    const events: { method: string; params: Loose }[] = [];
    let queuedBytes = 0;
    let wake: (() => void) | undefined; let failure: Error | undefined;
    const controller = new AbortController();
    const terminalTurns = new Set<string>();
    const announce = (turn: ActiveProviderTurn | null) => {try {options.onActiveTurn?.(turn);} catch {/* Advisory UI callback never controls admission. */}};
    const deactivate = () => {
      const active = this.activeCodexTurn;
      if (active && active.descriptor.threadId === threadId) {this.activeCodexTurn=undefined; active.stop.abort(); announce(null);}
    };
    const notify = (method: string, params: Loose) => {
      if (failure != null || params.threadId !== threadId) return;
      const eventTurn = method === 'turn/completed' ? params.turn?.id : params.turnId;
      if ((method === 'turn/completed' || method === 'error' && params.willRetry !== true) && typeof eventTurn === 'string') {
        terminalTurns.add(eventTurn); if (eventTurn === turnId) deactivate();
      }
      queuedBytes += Buffer.byteLength(JSON.stringify(params));
      if (queuedBytes > 8 * 1024 * 1024 || events.length >= 10_000) failure = new Error("Codex 대기 중인 스트림 크기 제한을 초과했습니다.");
      else events.push({ method, params });
      wake?.();
    };
    const failed = (error: Error) => { deactivate(); failure ??= error instanceof ProviderTurnFailure || error.name === 'AbortError' ? error : new ProviderTurnFailure({provider:'codex',code:'connection',phase,outcome:inferenceSent?'unknown':'not-sent',autoRetry:false}); controller.abort(failure); wake?.(); };
    const closed = () => failed(new Error("Codex app-server closed during the request."));
    let interruptPromise: Promise<unknown> | undefined;
    const interrupt = () => {
      if (interruptPromise == null && server != null && threadId != null && turnId != null) interruptPromise = server.request("turn/interrupt", { threadId, turnId }, 1_000).catch(() => { server?.close(); });
      return interruptPromise;
    };
    const abort = () => {
      failed(abortError());
      if (server != null && turnId == null) server.close();
      else void interrupt();
    };
    const timer = setTimeout(() => { failed(new ProviderTurnFailure({provider:"codex",code:"timeout",phase,outcome:inferenceSent?"unknown":"not-sent",autoRetry:false})); if (server != null && turnId == null) server.close(); else void interrupt(); }, this.options.turnTimeoutMs ?? 5 * 60_000); timer.unref();
    const toolResults = new Map<string, Promise<unknown>>();
    options.signal?.addEventListener("abort", abort, { once: true });
    try {
      if (options.signal?.aborted) abort();
      if (!(await abortable(this.status("codex"), controller.signal)).authenticated) throw new ProviderTurnFailure({provider:"codex",code:"authentication",phase:"preflight",outcome:"not-sent",autoRetry:false});
      const selected = selectTurnModel(await abortable(this.listModels("codex"), controller.signal), options.model, options.effort, "codex");
      if (options.systemInstructions != null && options.systemInstructions.length > 32_000) throw new Error("에이전트 지침은 32,000자 이하여야 합니다.");
      server = await abortable(this.codex(), controller.signal);
      server.on("notification", notify); server.on("failure", failed); server.on("closed", closed);
      const tools = options.executeTool == null ? [] : (options.tools ?? []).filter(tool => typeof tool.name === "string" && (tool.inputSchema ?? tool.parameters) != null);
      const started = await abortable(server.request("thread/start", {
        model: selected.model, cwd: this.paths().codexHome, approvalPolicy: "never", sandbox: "read-only", ephemeral: true,
        baseInstructions: `${SYSTEM_PROMPT}${options.systemInstructions ? `\n\nAgent instructions:\n${options.systemInstructions}` : ""}`, config: { web_search: options.nativeWebSearch === true ? "live" : "disabled", features: { apps: false, shell_tool: false, unified_exec: false, apply_patch_freeform: false, multi_agent: false } },
        ...(tools.length ? { dynamicTools: tools.map(tool => ({ type: "function", name: tool.name, description: tool.description ?? "", inputSchema: tool.inputSchema ?? tool.parameters })) } : {}),
      }), controller.signal);
      threadId = started.thread?.id;
      if (typeof threadId !== 'string' || !threadId || threadId.length > 256 || threadId.includes('\0')) throw new ProviderTurnFailure({provider:'codex',code:'protocol',phase:'preflight',outcome:'not-sent',autoRetry:false});
      const last = options.messages.at(-1);
      if (last == null || last.role !== "user") throw new Error("Codex 요청은 새 사용자 메시지로 끝나야 합니다.");
      const history = options.messages.slice(0, -1).flatMap(message => codexHistoryItems(message));
      if (history.length) await abortable(server.request("thread/inject_items", { threadId, items: history }), controller.signal);
      server.requestHandler = async (_method, params) => {
        if (failure != null || params.threadId !== threadId || (turnId != null && params.turnId !== turnId) || typeof params.callId !== "string") throw new Error("Unmatched tool request.");
        const tool = tools.find(tool => tool.name === params.tool);
        if (tool == null || options.executeTool == null) throw new Error("Tool unavailable.");
        let result = toolResults.get(params.callId);
        if (result == null) { result = options.executeTool(tool, params.arguments, params.callId); toolResults.set(params.callId, result); }
        return { success: true, contentItems: [{ type: "inputText", text: JSON.stringify(await result) ?? "null" }] };
      };
      if (options.signal?.aborted) throw abortError();
      phase = 'start';
      const turn = await server.requestObserved("turn/start", { threadId, input: codexInput(last.content), ...selected }, {signal:controller.signal,onWriteAttempt:()=>{inferenceSent=true;}});
      turnId = turn.turn?.id;
      if (typeof turnId !== "string" || !turnId || turnId.length > 256 || turnId.includes('\0')) throw new ProviderTurnFailure({provider:'codex',code:'protocol',phase:'start',outcome:'unknown',autoRetry:false});
      phase = 'stream';
      if (typeof options.clientConversationId === 'string' && options.clientConversationId.length > 0 && options.clientConversationId.length <= 100 && !options.clientConversationId.includes('\0')
        && typeof options.attemptId === 'string' && /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(options.attemptId) && turn.turn.status === 'inProgress' && !terminalTurns.has(turnId) && !controller.signal.aborted) {
        const descriptor: ActiveProviderTurn = {provider:'codex',capability:'steer',clientConversationId:options.clientConversationId,attemptId:options.attemptId,threadId,turnId};
        this.activeCodexTurn={descriptor,server,stop:new AbortController(),close:deactivate,receipts:new Map()}; this.lastSteerTurn={descriptor,receipts:this.activeCodexTurn.receipts}; announce({...descriptor});
      }
      if (options.signal?.aborted) abort();
      while (true) {
        if (failure != null) throw failure;
        const event = events.shift();
        if (event == null) { await new Promise<void>(resolveWake => { wake = resolveWake; }); wake = undefined; continue; }
        const { method, params } = event;
        queuedBytes -= Buffer.byteLength(JSON.stringify(params));
        if (params.turnId != null && params.turnId !== turnId) continue;
        if (method === "item/agentMessage/delta" && typeof params.delta === "string") {
          text += params.delta;
          if (Buffer.byteLength(text) > 4 * 1024 * 1024) throw new Error("Codex 응답 크기 제한을 초과했습니다.");
          yield { type: "text-delta", delta: params.delta };
        } else if ((method === "item/started" || method === "item/completed") && params.item?.type === "webSearch") {
          if (options.nativeWebSearch !== true) throw new ProviderTurnFailure({provider:"codex",code:"policy",phase:"stream",outcome:"unknown",autoRetry:false});
          if (typeof params.item.id !== "string" || params.item.id.length > 200) throw new Error("공식 웹 검색 이벤트 형식이 올바르지 않습니다.");
          yield {type: 'native-web-search', callId: params.item.id, status: method === 'item/started' ? 'running' : 'completed', input: webInput(params.item.action ?? {query:params.item.query}), ...(method === 'item/completed' ? {output: {native_step_completed: true, results_received: Array.isArray(params.item.results) && params.item.results.length > 0}} : {})};
        } else if (method === "thread/tokenUsage/updated") {
          // Each VenditBot request owns a fresh thread: total includes all model/tool
          // steps in this turn; last alone would undercount after a tool continuation.
          const tokens = params.tokenUsage?.total ?? params.tokenUsage?.last ?? {}; usage = {};
          for (const [key, value] of Object.entries({ inputTokens: tokens.inputTokens, outputTokens: tokens.outputTokens, cacheReadTokens: tokens.cachedInputTokens, cacheWriteTokens: tokens.cacheWriteInputTokens })) if (typeof value === "number" && Number.isFinite(value) && value >= 0) (usage as Loose)[key] = value;
        } else if (method === "turn/completed" && params.turn?.id === turnId) {
          finished = true;
          if (params.turn.status === "interrupted") throw abortError();
          if (params.turn.status !== "completed") throw codexTurnFailure(params.turn.error);
          this.states.codex = { ...this.states.codex, phase: "ready", inferenceVerified: true, error: null };
          yield { type: "done", text, threadId, turnId, usage }; return;
        } else if (method === "error") {
          const error = codexTurnFailure(params.error);
          if (params.willRetry !== true) throw error;
          yield {type:'provider-status',status:'retrying',failure:{...error.safe}};
        }
      }
    } catch (error) { throw runtimeTurnFailure(error,'codex',phase,inferenceSent); }
    finally {
      deactivate();
      clearTimeout(timer); options.signal?.removeEventListener("abort", abort);
      if (server != null) {
        server.off("notification", notify); server.off("failure", failed); server.off("closed", closed); server.requestHandler = undefined;
        if (!finished) await interrupt();
        if (threadId != null) await server.request("thread/unsubscribe", { threadId }, 1_000).catch(() => {});
      }
      this.turnActive = false;
    }
  }
  async test(provider: LoginProvider, model?: string, effort?: string): Promise<ProviderAuthStatus> {
    if (provider === "claude-code") {
      if (!this.claudeAllowed()) return this.snapshot(provider);
      for await (const _event of this.runClaudeTurn({ messages: [{ role: "user", content: "Reply with OK." }], ...(model ? { model } : {}), ...(effort ? { effort } : {}) })) {}
      return this.snapshot(provider);
    }
    this.states.codex = { ...this.states.codex, phase: "testing" };
    try { for await (const _event of this.runCodexTurn({ messages: [{ role: "user", content: "Reply with OK." }], ...(model ? { model } : {}), ...(effort ? { effort } : {}) })) {} }
    catch (error) { this.states.codex = { ...this.states.codex, phase: "error", inferenceVerified: false, error: error instanceof Error ? error.message : "연결 확인 실패" }; throw error; }
    return this.snapshot(provider);
  }
  async *runClaudeTurn(options: ClaudeTurnOptions): AsyncGenerator<ClaudeTurnEvent> {
    if (this.disconnectPending.has("claude-code")) throw new Error("Claude 연결 해제가 진행 중입니다.");
    if (!this.claudeAllowed()) throw new Error(POLICY_ERROR);
    if (this.turnActive) throw new Error("한 번에 하나의 공급자 요청만 실행할 수 있습니다.");
    this.turnActive = true;
    const controller = new AbortController(); this.claudeTurnController = controller; let inferenceSent = false;
    const abort = () => controller.abort();
    options.signal?.addEventListener("abort", abort, { once: true });
    if (options.signal?.aborted) abort();
    try {
      if (!(await abortable(this.status("claude-code"), controller.signal)).authenticated) throw new ProviderTurnFailure({provider:"claude-code",code:"authentication",phase:"preflight",outcome:"not-sent",autoRetry:false});
      const selected = selectTurnModel(await abortable(this.listModels("claude-code"), controller.signal), options.model, options.effort, "claude-code");
      const executable = this.executable("claude-code");
      if (executable == null) throw new Error("Claude CLI 실행 파일이 필요합니다.");
      for await (const event of streamClaudeCliTurn({ ...options, ...selected, signal: controller.signal, executable, cwd: this.paths().claudeConfigDir, env: this.claudeEnv(), onChild: child => {inferenceSent=true; this.trackClaude(child);}, ...(this.options.turnTimeoutMs ? { timeoutMs: this.options.turnTimeoutMs } : {}) })) {
        if (event.type === "done") this.states["claude-code"] = { ...this.states["claude-code"], phase: "ready", inferenceVerified: true, error: null };
        yield event;
      }
    } catch (error) { throw runtimeTurnFailure(error,'claude-code',inferenceSent?'stream':'preflight',inferenceSent); }
    finally { options.signal?.removeEventListener("abort", abort); this.claudeTurnController = undefined; this.turnActive = false; }
  }
}
function selectTurnModel(catalog: ProviderModelCatalog, model: string | undefined, effort: string | undefined, provider: SafeProviderFailure['provider']): ReturnType<typeof selectProviderModel> {
  try {return selectProviderModel(catalog,model,effort);} catch {throw new ProviderTurnFailure({provider,code:'bad-request',phase:'preflight',outcome:'not-sent',autoRetry:false});}
}
function runtimeTurnFailure(error: unknown, provider: SafeProviderFailure['provider'], phase: SafeProviderFailure['phase'], sent: boolean): ProviderTurnFailure {
  if (error instanceof CodexRequestFailure) {
    const code = error.kind === 'timeout' ? 'timeout' : error.kind === 'cancelled' ? 'cancelled' : error.kind === 'protocol' ? 'protocol' : 'connection';
    return new ProviderTurnFailure({provider,code,phase,outcome:sent?'unknown':'not-sent',autoRetry:false});
  }
  return providerTurnFailure(error,provider,phase,sent);
}
function codexInput(content: string | readonly unknown[]): Loose[] {
  if (typeof content === "string") return [{ type: "text", text: content }];
  return content.map(part => {
    const item = part as Loose;
    if (item.type === "text" && typeof item.text === "string") return { type: "text", text: item.text };
    if (item.type === "image" && typeof item.image === "string" && (/^https:\/\//.test(item.image) || /^data:image\/(png|jpeg|webp|gif);base64,[A-Za-z0-9+/]+={0,2}$/.test(item.image))) return { type: "image", url: item.image };
    throw new Error("이 Codex 경로에서 지원하지 않는 첨부 형식입니다.");
  });
}
function codexHistoryItems(message: ProviderMessage): Loose[] {
  if (!["user", "assistant", "system", "tool"].includes(message.role)) throw new Error("지원하지 않는 Codex 대화 역할입니다.");
  const role = message.role === "system" ? "developer" : message.role;
  if (typeof message.content === "string") {
    if (role === "tool") throw new Error("도구 결과에는 호출 ID가 필요합니다.");
    return [{ type: "message", role, content: [{ type: role === "assistant" ? "output_text" : "input_text", text: message.content }] }];
  }
  const items: Loose[] = []; const textParts: Loose[] = [];
  for (const raw of message.content) {
    const part = raw as Loose;
    if (part.type === "text" && typeof part.text === "string" && role !== "tool") textParts.push({ type: role === "assistant" ? "output_text" : "input_text", text: part.text });
    else if (part.type === "image" && role === "user" && typeof part.image === "string" && /^data:image\/(png|jpeg|webp|gif);base64,[A-Za-z0-9+/]+={0,2}$/.test(part.image)) textParts.push({type:"input_image",image_url:part.image});
    else if (part.type === "tool-call" && typeof part.toolCallId === "string") items.push({ type: "function_call", call_id: part.toolCallId, name: part.toolName, arguments: JSON.stringify(part.args) });
    else if (part.type === "tool-result" && typeof part.toolCallId === "string") items.push({ type: "function_call_output", call_id: part.toolCallId, output: JSON.stringify(part.result) });
    else throw new Error("지원하지 않는 Codex 대화 항목입니다.");
  }
  if (textParts.length) items.unshift({ type: "message", role, content: textParts });
  return items;
}
const runtime = new ProviderAuthRuntime();
export function configureProviderAuthRuntime(options: AuthRuntimeOptions): void { runtime.configure(options); }
export function getCachedProviderAuthStatus(provider: LoginProvider): ProviderAuthStatus { return runtime.snapshot(provider); }
export function beginProviderLogin(provider: LoginProvider): Promise<ProviderLoginResult> { return runtime.begin(provider); }
export function getProviderAuthStatus(provider: LoginProvider): Promise<ProviderAuthStatus> { return runtime.status(provider); }
export function cancelProviderLogin(provider: LoginProvider): Promise<ProviderAuthStatus> { return runtime.cancel(provider); }
export function disconnectProvider(provider: LoginProvider): Promise<ProviderAuthStatus> { return runtime.disconnect(provider); }
export function shutdownProviderAuthRuntime(): void { runtime.shutdown(); }
export function shutdownProviderAuthRuntimeForUpdate(): Promise<void> { return runtime.shutdownForUpdate(); }
export function testProviderConnection(provider: LoginProvider, model?: string, effort?: string): Promise<ProviderAuthStatus> { return runtime.test(provider, model, effort); }
export function listProviderModels(provider: LoginProvider, options?: { refresh?: boolean }): Promise<ProviderModelCatalog> { return runtime.listModels(provider, options); }
export function runCodexTurn(options: CodexTurnOptions): AsyncGenerator<CodexTurnEvent> { return runtime.runCodexTurn(options); }
export function runClaudeTurn(options: ClaudeTurnOptions): AsyncGenerator<ClaudeTurnEvent> { return runtime.runClaudeTurn(options); }

export function getActiveProviderTurn(): ActiveProviderTurn | null {return runtime.getActiveTurn();}
export function steerProviderTurn(input: ProviderSteerInput, signal?: AbortSignal): Promise<ProviderSteerResult> {return runtime.steer(input,signal);}
