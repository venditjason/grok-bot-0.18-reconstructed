import { join } from "node:path";
import { resolveSandUserDataDir, SAND_DATA_ROOT_ENV, SAND_USER_DATA_DIR_ENV } from "../../host/host-paths.js";
import { PRODUCT_IDENTITY } from "../../shared/product-identity.js";
import { createVenditBotChildEnvironment, ensureVenditBotDirectories, resolveVenditBotPaths } from "../../shared/node/venditbot-paths.js";
import type { DataRootSettlement } from "./startup-data-root-migration.js";

export const STRANDED_USER_DATA_REASONS = new Set<string>();
export const STRANDED_DATA_ROOT_REASONS = new Set<string>();

export interface DesktopBootstrapApp {
  readonly isPackaged: boolean;
  setPath(name: "userData" | "sessionData", path: string): void;
  getPath(name: "appData" | "userData"): string;
  setName?(name: string): void;
  setAppLogsPath?(path: string): void;
}

export interface DesktopUserDataBootstrapOptions {
  readonly isLabBuild: boolean;
  readonly app: DesktopBootstrapApp;
  readonly argv?: readonly string[];
  readonly env?: NodeJS.ProcessEnv;
  readonly platform?: NodeJS.Platform;
  readonly cwd?: string;
  readonly homeDir?: string;
  reportFailureClass?(surface: "startup", operation: "user-data-settlement", reason: string): void;
}

/** Runs before the Electron single-instance lock and before any session access. */
export function bootstrapDesktopUserData(options: DesktopUserDataBootstrapOptions): string {
  const env = options.env ?? process.env;
  const configured = resolveSandUserDataDir(options.argv ?? process.argv, env, options.cwd ?? process.cwd());
  if (configured != null) env[SAND_USER_DATA_DIR_ENV] = configured;
  const paths = resolveVenditBotPaths({
    env,
    development: options.isLabBuild || !options.app.isPackaged,
    ...(options.platform === undefined ? {} : { platform: options.platform }),
    ...(options.homeDir === undefined ? {} : { homeDir: options.homeDir }),
  });
  const childEnv = createVenditBotChildEnvironment(env, paths);
  for (const key of Object.keys(env)) if (!(key in childEnv)) delete env[key];
  Object.assign(env, childEnv);
  ensureVenditBotDirectories(paths);
  env.SAND_PACKAGED = options.app.isPackaged ? "1" : "0";
  env.SAND_LAB = options.isLabBuild ? "1" : "0";
  options.app.setName?.(PRODUCT_IDENTITY.displayName);
  options.app.setPath("userData", paths.profileRoot);
  options.app.setPath("sessionData", paths.cacheRoot);
  options.app.setAppLogsPath?.(paths.logsRoot);
  env[SAND_DATA_ROOT_ENV] = join(paths.profileRoot, "agent-data");
  console.log(`[venditbot] using isolated user-data dir: ${paths.profileRoot}`);
  return paths.profileRoot;
}

export interface DesktopDataRootBootstrapOptions {
  readonly isPrimaryInstance: boolean;
  readonly isLabBuild: boolean;
  readonly hasIsolatedUserData: boolean;
  readonly app: Pick<DesktopBootstrapApp, "isPackaged">;
  readonly env?: NodeJS.ProcessEnv;
  readonly homeDir?: string;
  reportFailureClass?(surface: "startup", operation: "data-root-settlement", reason: string): void;
}

export function bootstrapDesktopDataRoot(options: DesktopDataRootBootstrapOptions): DataRootSettlement | null {
  if (!options.isPrimaryInstance) return null;
  const env = options.env ?? process.env;
  const paths = resolveVenditBotPaths({ env, development: options.isLabBuild || !options.app.isPackaged, ...(options.homeDir === undefined ? {} : { homeDir: options.homeDir }) });
  env[SAND_DATA_ROOT_ENV] = join(paths.profileRoot, "agent-data");
  // VenditBot never runs Grok/Cursor migration or attaches their existing host.
  return { route: "unchanged", reason: "isolated-user-data" };
}
