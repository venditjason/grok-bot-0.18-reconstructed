import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import type { ProviderModel } from "../provider-model-catalog.js";

type Loose = Record<string, any>;
const field = (value: unknown): value is string => typeof value === "string" && value.length > 0 && value.length <= 512;
function efforts(value: unknown): string[] {
  return Array.isArray(value) ? [...new Set(value.filter((item): item is string => typeof item === "string" && /^[a-z][a-z0-9_-]{0,31}$/.test(item)))] : [];
}
export function codexCatalogModels(data: unknown): ProviderModel[] {
  if (!Array.isArray(data) || data.length > 200) throw new Error("Codex 모델 목록 응답을 확인할 수 없습니다.");
  return data.filter((row: Loose) => row?.hidden !== true).map((row: Loose) => {
    if (!field(row?.model) || !field(row.displayName)) throw new Error("Codex 모델 정보가 올바르지 않습니다.");
    const supported = efforts(row.supportedReasoningEfforts?.map((entry: Loose) => entry?.reasoningEffort));
    return { id: row.model, label: row.displayName, ...(typeof row.description === "string" ? { description: row.description.slice(0, 4000) } : {}), isDefault: row.isDefault === true, efforts: supported,
      ...(supported.includes(row.defaultReasoningEffort) ? { defaultEffort: row.defaultReasoningEffort } : {}) };
  });
}
export function claudeCatalogModels(data: unknown): ProviderModel[] {
  if (!Array.isArray(data) || data.length > 200) throw new Error("Claude 모델 목록 응답을 확인할 수 없습니다.");
  // Official CLI catalogs can include visible-but-unselectable policy rows.
  // Keep those out of both the picker and the execution allowlist.
  return data.filter((row: Loose) => row?.disabled !== true).map((row: Loose) => {
    if (!field(row?.value) || !field(row.displayName)) throw new Error("Claude 모델 정보가 올바르지 않습니다.");
    const supported = row.supportsEffort === false ? [] : efforts(row.supportedEffortLevels);
    return { id: row.value, ...(field(row.resolvedModel) ? { resolvedId: row.resolvedModel } : {}), label: row.displayName,
      ...(typeof row.description === "string" ? { description: row.description.slice(0, 4000) } : {}), isDefault: row.isDefault === true || row.value === "default", efforts: supported,
      ...(supported.includes(row.defaultEffort) ? { defaultEffort: row.defaultEffort } : {}) };
  });
}

/** Same initialize control message used by the official SDK's supportedModels().
 * No user message is sent, so discovery does not start inference or a paid turn.
 */
export function discoverClaudeModels(options: { executable: string; cwd: string; env: NodeJS.ProcessEnv; onChild?: (child: ChildProcessWithoutNullStreams) => void }): Promise<ProviderModel[]> {
  return new Promise((resolveModels, reject) => {
    const child = spawn(options.executable, ["-p", "--input-format", "stream-json", "--output-format", "stream-json", "--verbose", "--tools", "", "--strict-mcp-config", "--mcp-config", '{"mcpServers":{}}', "--setting-sources", "", "--no-session-persistence"],
      { cwd: options.cwd, env: { ...options.env, ENABLE_CLAUDEAI_MCP_SERVERS: "false", CLAUDE_CODE_DISABLE_BACKGROUND_TASKS: "1" }, stdio: "pipe", windowsHide: true });
    options.onChild?.(child);
    let buffer = ""; let bytes = 0; let settled = false;
    const finish = (error?: Error, models?: ProviderModel[]) => {
      if (settled) return; settled = true; clearTimeout(timer);
      child.stdin.end(); child.kill("SIGTERM");
      const killTimer = setTimeout(() => { if (child.exitCode == null && child.signalCode == null) child.kill("SIGKILL"); }, 1000); killTimer.unref();
      if (error != null) reject(error); else resolveModels(models ?? []);
    };
    const timer = setTimeout(() => finish(new Error("Claude 모델 목록 확인 시간이 초과되었습니다.")), 20_000); timer.unref();
    child.stdout.setEncoding("utf8"); child.stderr.on("data", () => {});
    child.stdout.on("data", (chunk: string) => {
      if (settled) return;
      bytes += Buffer.byteLength(chunk); if (bytes > 2 * 1024 * 1024) { finish(new Error("Claude 모델 목록 응답 크기를 초과했습니다.")); return; }
      buffer += chunk; let newline: number;
      while ((newline = buffer.indexOf("\n")) >= 0) {
        const line = buffer.slice(0, newline); buffer = buffer.slice(newline + 1); if (!line.trim()) continue;
        try {
          const message = JSON.parse(line);
          if (message.type === "control_response" && message.response?.request_id === "venditbot-model-catalog") {
            if (message.response.subtype !== "success") throw new Error("Claude 모델 목록을 확인할 수 없습니다.");
            finish(undefined, claudeCatalogModels(message.response.response?.models)); return;
          }
          if (message.type === "control_request") child.stdin.write(`${JSON.stringify({ type: "control_response", response: { subtype: "error", request_id: message.request_id, error: "Model discovery does not permit actions." } })}\n`);
        } catch { finish(new Error("Claude 모델 목록 응답을 확인할 수 없습니다.")); return; }
      }
    });
    child.stdin.on("error", () => finish(new Error("Claude 모델 목록 입력 연결이 종료되었습니다.")));
    child.once("error", () => finish(new Error("Claude 모델 목록 조회를 시작할 수 없습니다.")));
    child.once("close", () => finish(new Error("Claude 모델 목록 응답 전에 CLI가 종료되었습니다.")));
    child.stdin.write(`${JSON.stringify({ type: "control_request", request_id: "venditbot-model-catalog", request: { subtype: "initialize" } })}\n`);
  });
}
