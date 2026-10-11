import { createHash } from "node:crypto";
import { lstatSync, mkdirSync, realpathSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, isAbsolute, join, resolve } from "node:path";
import { PRODUCT_IDENTITY } from "../product-identity.js";

export interface VenditBotPaths {
  readonly dataRoot: string;
  readonly profileRoot: string;
  readonly providersRoot: string;
  readonly codexHome: string;
  readonly claudeConfigDir: string;
  readonly logsRoot: string;
  readonly cacheRoot: string;
  readonly rendererDataRoot: string;
  readonly profileId: string;
  readonly development: boolean;
}

export function validateVenditBotProfileId(value: string): string {
  if (!/^[a-zA-Z0-9][a-zA-Z0-9_-]{0,63}$/.test(value)) throw new Error("Invalid VenditBot profile ID.");
  return value;
}

/** Only the product-specific namespace is consumed; inherited SAND/CLI homes are ignored. */
export function resolveVenditBotPaths(options: {
  readonly homeDir?: string;
  readonly platform?: NodeJS.Platform;
  readonly development?: boolean;
  readonly profileId?: string;
  readonly env?: NodeJS.ProcessEnv;
} = {}): VenditBotPaths {
  const home = options.homeDir ?? homedir();
  if (!isAbsolute(home)) throw new Error("VenditBot requires an absolute home directory.");
  const env = options.env ?? process.env;
  const platform = options.platform ?? process.platform;
  const development = options.development ?? env.VENDITBOT_DEVELOPMENT === "1";
  const profileId = validateVenditBotProfileId(options.profileId ?? env.VENDITBOT_PROFILE_ID ?? "default");
  const name = development ? PRODUCT_IDENTITY.developmentName : PRODUCT_IDENTITY.englishName;
  const productDataRoot = (product: string) => platform === "darwin" ? join(home, "Library", "Application Support", product)
    : platform === "win32" ? join(home, "AppData", "Roaming", product) : join(home, ".local", "share", product);
  const defaultDataRoot = productDataRoot(name);
  const configuredRoot = env.VENDITBOT_USER_DATA_DIR?.trim();
  if (configuredRoot != null && configuredRoot.length > 0 && !isAbsolute(configuredRoot)) throw new Error("VENDITBOT_USER_DATA_DIR must be absolute.");
  const dataRoot = resolve(configuredRoot || defaultDataRoot);
  if (development) {
    const comparable = (path: string) => platform === "darwin" || platform === "win32" ? path.replace(/\\/g, "/").toLowerCase() : path;
    const production = comparable(resolve(productDataRoot(PRODUCT_IDENTITY.englishName))), selected = comparable(dataRoot);
    if (selected === production || selected.startsWith(`${production}/`)) throw new Error("Development VenditBot cannot use the production data directory or its descendants.");
  }
  // Explicit test/development roots are supported, but known shared credential/app roots are never accepted.
  if (/(?:^|[/\\])\.(?:codex|claude|grokbot|cursor)(?:[/\\]|$)/i.test(dataRoot)
    || /(?:^|[/\\])(?:Grok Bot|grokbot|sand)(?:[/\\]|$)/i.test(dataRoot)) throw new Error("VenditBot cannot use another application's data directory.");
  const profileRoot = join(dataRoot, "profiles", profileId);
  const providersRoot = join(profileRoot, "providers");
  return {
    dataRoot, profileRoot, providersRoot, profileId, development,
    rendererDataRoot: join(profileRoot, "renderer-state"),
    codexHome: join(providersRoot, "codex"),
    claudeConfigDir: join(providersRoot, "claude"),
    logsRoot: configuredRoot ? join(dataRoot, "logs") : platform === "darwin" ? join(home, "Library", "Logs", name) : join(dataRoot, "logs"),
    cacheRoot: configuredRoot ? join(profileRoot, "cache") : platform === "darwin" ? join(home, "Library", "Caches", name, profileId) : join(profileRoot, "cache"),
  };
}

const CHILD_OS_ENVIRONMENT = new Set([
  "HOME", "USER", "LOGNAME", "PATH", "SHELL", "LANG", "LC_ALL", "LC_CTYPE", "TZ", "TERM", "COLORTERM",
  "TMPDIR", "TMP", "TEMP", "SystemRoot", "SYSTEMROOT", "WINDIR", "ComSpec", "COMSPEC", "PATHEXT",
  "HTTP_PROXY", "HTTPS_PROXY", "ALL_PROXY", "NO_PROXY", "http_proxy", "https_proxy", "all_proxy", "no_proxy",
  "SSL_CERT_FILE", "SSL_CERT_DIR",
]);

/** Never follow a pre-existing symlink for an app-owned profile or credential directory. */
export function ensureVenditBotDirectories(paths: VenditBotPaths): void {
  const directories = [paths.dataRoot, join(paths.dataRoot, "profiles"), paths.profileRoot, paths.providersRoot, paths.codexHome, paths.claudeConfigDir, paths.rendererDataRoot, paths.logsRoot, dirname(paths.cacheRoot), paths.cacheRoot];
  // Check before any mkdir: a symlink in an arbitrary ancestor may redirect every
  // apparently dedicated child into another app. Darwin's OS-owned aliases are
  // the only exception (tmpdir commonly starts with /var).
  for (const directory of directories) assertNoSharedDirectoryAncestor(directory);
  for (const directory of directories) {
    mkdirSync(directory, { recursive: true, mode: 0o700 });
    const entry = lstatSync(directory);
    if (!entry.isDirectory() || entry.isSymbolicLink()) throw new Error("VenditBot refuses to share a profile or credential directory through a symbolic link.");
  }
}

function assertNoSharedDirectoryAncestor(directory: string): void {
  let candidate = resolve(directory);
  for (;;) {
    try {
      if (lstatSync(candidate).isSymbolicLink()) {
        const systemAlias = process.platform === "darwin" && ["/tmp", "/var", "/etc"].includes(candidate) && realpathSync(candidate) === `/private${candidate}`;
        if (!systemAlias) throw new Error("VenditBot refuses a symbolic link in its profile or credential directory ancestry.");
      }
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    }
    const parent = dirname(candidate);
    if (parent === candidate) break;
    candidate = parent;
  }
}

/** Explicit OS allowlist: no inherited provider/cloud credentials, runtime injection or old product settings. */
export function createVenditBotChildEnvironment(baseEnv: NodeJS.ProcessEnv = process.env, paths: VenditBotPaths = resolveVenditBotPaths({ env: baseEnv })): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = {};
  for (const [key, value] of Object.entries(baseEnv)) if (CHILD_OS_ENVIRONMENT.has(key)) env[key] = value;
  env.VENDITBOT_USER_DATA_DIR = paths.dataRoot;
  env.VENDITBOT_PROFILE_ID = paths.profileId;
  env.VENDITBOT_DEVELOPMENT = paths.development ? "1" : "0";
  env.VENDITBOT_DATA_ROOT = join(paths.profileRoot, "agent-data");
  env.CODEX_HOME = paths.codexHome;
  env.CLAUDE_CONFIG_DIR = paths.claudeConfigDir;
  return env;
}

/** Darwin AF_UNIX has a 104-byte sun_path; leave room for the terminating NUL. */
export function venditBotSocketPath(directory: string, instanceId: string, purpose: string): string {
  if (!isAbsolute(directory) || !/^[a-z0-9-]{1,64}$/.test(instanceId) || !/^[a-z0-9-]{1,32}$/.test(purpose)) throw new Error("Invalid VenditBot IPC identity.");
  const digest = createHash("sha256").update(`${instanceId}:${purpose}`).digest("hex").slice(0, 20);
  const socket = join(directory, `venditbot-${digest}.sock`);
  if (Buffer.byteLength(socket, "utf8") > 103) throw new Error("VenditBot IPC socket path is too long; choose a shorter dedicated IPC directory.");
  return socket;
}
