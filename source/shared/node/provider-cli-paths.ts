import { accessSync, constants, statSync } from "node:fs";
import { isAbsolute, join } from "node:path";
import { resolveVenditBotPaths } from "./venditbot-paths.js";

let configured: { codexExecutable?: string; claudeExecutable?: string } = {};
export function configureProviderCliPaths(value: typeof configured): void { configured = { ...configured, ...value }; }
export function validateProviderExecutable(candidate: string | undefined): string | null {
  if (candidate == null || !isAbsolute(candidate)) return null;
  try { accessSync(candidate, constants.X_OK); return statSync(candidate).isFile() ? candidate : null; } catch { return null; }
}
function resolveCli(provider: "codex" | "claude", override: string | undefined): string | null {
  // Existing global CLI locations are never searched or updated. An explicit advanced
  // path can select a user-verified binary; packaged binaries live under app ownership.
  if (override != null) return validateProviderExecutable(override);
  const paths = resolveVenditBotPaths();
  const resources = (process as NodeJS.Process & { resourcesPath?: string }).resourcesPath;
  return (resources == null ? null : validateProviderExecutable(join(resources, "providers", provider, provider)))
    ?? validateProviderExecutable(join(paths.dataRoot, "runtimes", provider, provider));
}
export function resolveCodexCliPath(): string | null { return resolveCli("codex", configured.codexExecutable); }
export function resolveClaudeCodeCliPath(): string | null { return resolveCli("claude", configured.claudeExecutable); }
