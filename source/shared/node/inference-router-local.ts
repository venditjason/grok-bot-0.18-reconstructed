import { getCachedProviderAuthStatus } from "./provider-auth-runtime.js";
export { resolveClaudeCodeCliPath, resolveCodexCliPath } from "./provider-cli-paths.js";
export interface LocalInferenceCliStatus {
  readonly installed: boolean;
  readonly authenticated: boolean;
  readonly executablePath: string | null;
  readonly inferenceVerified: boolean;
}
/** Cached official protocol status only. File presence is never authentication. */
export function getLocalInferenceCliStatus(): { readonly codex: LocalInferenceCliStatus; readonly "claude-code": LocalInferenceCliStatus } {
  return { codex: getCachedProviderAuthStatus("codex"), "claude-code": getCachedProviderAuthStatus("claude-code") };
}
