import { createHash, randomBytes } from "node:crypto";
import { spawn } from "node:child_process";
import { chmod, link, lstat, mkdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { PRODUCT_IDENTITY } from "../../shared/product-identity.js";
import { createVenditBotChildEnvironment } from "../../shared/node/venditbot-paths.js";
import type { SandSettingsStore } from "../../shared/node/settings/sand-settings-store.js";
import type { RecreateResult } from "./box-recreate-commands.js";
import type { SandRemoteHostConnector } from "./box-host-connector.js";
import type { GatewayConnection } from "./gateway-descriptor-cache.js";

// This upstream image is known only as amd64. No native arm64 compatibility is claimed.
export const LOCAL_DOCKER_BOX_IMAGE = "public.ecr.aws/k0i0n2g5/cursorenvironments/universal:sand-box-latest";
export const LOCAL_DOCKER_OWNER_LABEL = `${PRODUCT_IDENTITY.dockerNamespace}.owner`;
export const LOCAL_DOCKER_INSTANCE_LABEL = `${PRODUCT_IDENTITY.dockerNamespace}.instance`;
export const LOCAL_DOCKER_SCHEMA_VERSION = "7";
export const LOCAL_DOCKER_PORTS = [1337, 1339, 1340, 6080, 6081, 8790] as const;
const READY_TIMEOUT_MS = 180_000;
const label = (suffix: string): string => `${PRODUCT_IDENTITY.dockerNamespace}.${suffix}`;

export interface LocalDockerStatus {
  readonly available: boolean;
  readonly running: boolean;
  readonly ready: boolean;
  readonly containerName: string;
  readonly image: string;
  readonly detail: string;
  readonly emulated?: boolean;
  readonly forwardedPorts?: Readonly<Record<number, number>>;
}
export interface DockerCommandResult { readonly ok: boolean; readonly output: string }
export type DockerCommandRunner = (args: readonly string[]) => Promise<DockerCommandResult>;
export interface LocalDockerResources { readonly instanceId: string; readonly containerName: string; readonly workspaceVolume: string; readonly dataVolume: string }
interface LocalHostBundle { readonly path: string; readonly sha256: string; readonly boxExecDaemonPath: string; readonly boxExecDaemonSha256: string }
interface ContainerInspection { readonly exists: boolean; readonly running: boolean; readonly owned: boolean; readonly id: string; readonly image: string; readonly hostSha256: string; readonly daemonSha256: string; readonly schemaVersion: string; readonly forwardedPorts: Readonly<Record<number, number>> }

const runDocker: DockerCommandRunner = (args) => new Promise((resolveCommand) => {
  const env = createVenditBotChildEnvironment();
  for (const key of ["DOCKER_HOST", "DOCKER_CONTEXT", "DOCKER_CONFIG", "DOCKER_CERT_PATH", "DOCKER_TLS_VERIFY", "DOCKER_API_VERSION"]) if (process.env[key] !== undefined) env[key] = process.env[key];
  const child = spawn("docker", [...args], { stdio: ["ignore", "pipe", "pipe"], env });
  let output = "";
  const append = (chunk: Buffer): void => { output += chunk.toString(); if (output.length > 16_000) output = output.slice(-16_000); };
  child.stdout?.on("data", append);
  child.stderr?.on("data", append);
  const timer = setTimeout(() => { child.kill("SIGTERM"); resolveCommand({ ok: false, output: "Docker command timed out." }); }, READY_TIMEOUT_MS);
  timer.unref();
  child.once("error", (error) => { clearTimeout(timer); resolveCommand({ ok: false, output: error.message }); });
  child.once("close", (code) => { clearTimeout(timer); resolveCommand({ ok: code === 0, output: output.trim() }); });
});

/** Stable per-profile installation identity, created without overwriting a racing instance. */
export async function resolveLocalDockerResources(settingsPath: string): Promise<LocalDockerResources> {
  const target = join(dirname(resolve(settingsPath)), "venditbot-instance-id");
  await mkdir(dirname(target), { recursive: true, mode: 0o700 });
  await createOwnedFileOnce(target, `${randomBytes(12).toString("hex")}\n`);
  const instanceId = (await readFile(target, "utf8")).trim();
  if (!/^[0-9a-f]{24}$/.test(instanceId)) throw new Error("Invalid VenditBot installation identity; refusing to manage Docker resources.");
  const prefix = `venditbot-${instanceId}`;
  return { instanceId, containerName: `${prefix}-vm`, workspaceVolume: `${prefix}-workspace`, dataVolume: `${prefix}-data` };
}

async function createOwnedFileOnce(target: string, content: string): Promise<void> {
  const temporary = `${target}.${randomBytes(8).toString("hex")}.tmp`;
  await writeFile(temporary, content, { flag: "wx", mode: 0o600 });
  try {
    try { await link(temporary, target); }
    catch (error) { if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error; }
  } finally { await rm(temporary, { force: true }); }
  const entry = await lstat(target);
  if (!entry.isFile() || entry.isSymbolicLink()) throw new Error("VenditBot refuses to use a shared Docker identity or credential file.");
}

function owned(labels: Record<string, unknown> | undefined, resources: LocalDockerResources): boolean {
  return labels?.[LOCAL_DOCKER_OWNER_LABEL] === "1" && labels[LOCAL_DOCKER_INSTANCE_LABEL] === resources.instanceId;
}

/** Trust only Docker's actual loopback mapping, never a guessed or fixed host port. */
export function readLocalDockerPortMappings(ports: unknown): Readonly<Record<number, number>> {
  if (typeof ports !== "object" || ports == null) throw new Error("Docker gateway has no loopback port mappings.");
  const mappings: Record<number, number> = {};
  for (const port of LOCAL_DOCKER_PORTS) {
    const values: unknown = Reflect.get(ports, `${port}/tcp`);
    if (!Array.isArray(values) || values.length !== 1) throw new Error(`Docker port ${port} must have exactly one loopback mapping.`);
    const value = values[0] as { HostIp?: unknown; HostPort?: unknown };
    const mapped = Number(value.HostPort);
    if (value.HostIp !== "127.0.0.1" || !Number.isInteger(mapped) || mapped < 1 || mapped > 65535) throw new Error(`Docker port ${port} is not bound exclusively to loopback.`);
    mappings[port] = mapped;
  }
  return mappings;
}

export function localDockerArchitecture(architecture: string, env: NodeJS.ProcessEnv = process.env): { readonly platform: "linux/amd64"; readonly emulated: boolean } {
  if (architecture === "x64") return { platform: "linux/amd64", emulated: false };
  if (architecture === "arm64" && env.VENDITBOT_DOCKER_ALLOW_AMD64_EMULATION === "1") return { platform: "linux/amd64", emulated: true };
  throw new Error("A verified native arm64 Docker image is not available. Docker tools are disabled; amd64 emulation requires explicit opt-in and separate performance validation.");
}

async function inspectContainer(resources: LocalDockerResources, run: DockerCommandRunner): Promise<ContainerInspection> {
  const result = await run(["container", "inspect", "--format", "{{json .}}", resources.containerName]);
  const empty: ContainerInspection = { exists: false, running: false, owned: false, id: "", image: "", hostSha256: "", daemonSha256: "", schemaVersion: "", forwardedPorts: {} };
  if (!result.ok) {
    if (/no such (?:object|container)/i.test(result.output)) return empty;
    throw new Error("Cannot verify Docker container ownership; refusing to manage resources.");
  }
  let value: { Id?: unknown; State?: { Running?: unknown }; Config?: { Image?: unknown; Labels?: Record<string, unknown> }; NetworkSettings?: { Ports?: unknown } };
  try { value = JSON.parse(result.output); } catch { throw new Error("Docker returned malformed inspection data."); }
  const isOwned = owned(value.Config?.Labels, resources);
  if (typeof value.Id !== "string" || !/^[0-9a-f]{64}$/.test(value.Id)) throw new Error("Docker returned an invalid container identity.");
  return {
    exists: true, running: value.State?.Running === true, owned: isOwned, id: value.Id,
    image: String(value.Config?.Image ?? ""), hostSha256: String(value.Config?.Labels?.[label("host-sha256")] ?? ""),
    daemonSha256: String(value.Config?.Labels?.[label("box-exec-daemon-sha256")] ?? ""),
    schemaVersion: String(value.Config?.Labels?.[label("schema-version")] ?? ""),
    forwardedPorts: isOwned && value.State?.Running === true ? readLocalDockerPortMappings(value.NetworkSettings?.Ports) : {},
  };
}

async function ensureOwnedVolume(name: string, resources: LocalDockerResources, run: DockerCommandRunner): Promise<void> {
  let inspected = await run(["volume", "inspect", "--format", "{{json .Labels}}", name]);
  if (!inspected.ok) {
    if (!/no such volume/i.test(inspected.output)) throw new Error("Cannot verify Docker volume ownership.");
    const created = await run(["volume", "create", "--label", `${LOCAL_DOCKER_OWNER_LABEL}=1`, "--label", `${LOCAL_DOCKER_INSTANCE_LABEL}=${resources.instanceId}`, name]);
    if (!created.ok) throw new Error("Could not create the VenditBot Docker volume.");
    inspected = await run(["volume", "inspect", "--format", "{{json .Labels}}", name]);
  }
  let labels: Record<string, unknown> | undefined;
  try { labels = JSON.parse(inspected.output) as Record<string, unknown>; } catch { /* Fail closed below. */ }
  if (!inspected.ok || !owned(labels, resources)) throw new Error(`Refusing to mount unowned Docker volume ${name}.`);
}

async function readOrCreateToken(settingsPath: string): Promise<string> {
  const target = join(dirname(settingsPath), "venditbot-docker-gateway-token");
  await mkdir(dirname(target), { recursive: true, mode: 0o700 });
  await createOwnedFileOnce(target, randomBytes(32).toString("hex"));
  const token = (await readFile(target, "utf8")).trim();
  if (!/^[0-9a-f]{64}$/.test(token)) throw new Error("Invalid VenditBot Docker gateway credential.");
  await chmod(target, 0o600);
  return token;
}

async function gatewayReady(baseUrl: string, token: string): Promise<boolean> {
  try { return (await fetch(`${baseUrl}/health`, { headers: { authorization: `Bearer ${token}` }, redirect: "error", signal: AbortSignal.timeout(2_000) })).ok; }
  catch { return false; }
}

async function stageCurrentHostBundle(settingsPath: string): Promise<LocalHostBundle> {
  const moduleDirectory = dirname(fileURLToPath(import.meta.url));
  const readRuntime = async (relative: string): Promise<Buffer> => {
    for (const candidate of [resolve(moduleDirectory, `../${relative}`), resolve(moduleDirectory, `../../${relative}`)]) {
      try { return await readFile(candidate); } catch { /* Try the packaged runtime location. */ }
    }
    throw new Error("VenditBot tool runtime is unavailable; refusing to start a stock VM.");
  };
  const hostBytes = await readRuntime("host/host-main.cjs");
  const daemonBytes = await readRuntime("box-exec-daemon/main.cjs");
  const sha256 = createHash("sha256").update(hostBytes).digest("hex");
  const boxExecDaemonSha256 = createHash("sha256").update(daemonBytes).digest("hex");
  const directory = join(dirname(settingsPath), "local-docker-runtime", `${sha256}-${boxExecDaemonSha256}`);
  const persist = async (relative: string, bytes: Buffer): Promise<string> => {
    const target = join(directory, relative);
    await mkdir(dirname(target), { recursive: true, mode: 0o700 });
    const temporary = `${target}.${randomBytes(8).toString("hex")}.tmp`;
    await writeFile(temporary, bytes, { mode: 0o600 });
    await rename(temporary, target);
    return target;
  };
  return { path: await persist("host-main.cjs", hostBytes), sha256, boxExecDaemonPath: await persist("box-exec-daemon/main.cjs", daemonBytes), boxExecDaemonSha256 };
}

export function buildLocalDockerRunArguments(resources: LocalDockerResources, bundle: LocalHostBundle, envFile: string, platform: string): string[] {
  return [
    "run", "--detach", "--name", resources.containerName,
    "--label", `${LOCAL_DOCKER_OWNER_LABEL}=1`, "--label", `${LOCAL_DOCKER_INSTANCE_LABEL}=${resources.instanceId}`,
    "--label", `${label("host-sha256")}=${bundle.sha256}`, "--label", `${label("box-exec-daemon-sha256")}=${bundle.boxExecDaemonSha256}`,
    "--label", `${label("schema-version")}=${LOCAL_DOCKER_SCHEMA_VERSION}`,
    "--platform", platform, "--restart", "no", "--cpus", "4", "--memory", "6g", "--pids-limit", "512",
    "--env", "SAND_SUPERVISOR_ENABLED=1", "--env", "SAND_BOX_AUTO_UPDATE=0", "--env", "SAND_USE_EXISTING_BOX_EXEC_DAEMON=1",
    "--env", "SAND_TREE_SITTER_NODE_DEPS=/home/box/deps", "--env", "NODE_PATH=/home/box/deps", "--env", "SAND_GATEWAY_BIND_HOST=0.0.0.0",
    "--env", "SAND_HOST_PORT=1340", "--env", "VENDITBOT_DATA_ROOT=/home/box/sand-data", "--env-file", envFile,
    ...LOCAL_DOCKER_PORTS.flatMap((port) => ["--publish", `127.0.0.1::${port}`]),
    "--volume", `${resources.workspaceVolume}:/workspace`, "--volume", `${resources.dataVolume}:/home/box/sand-data`,
    "--mount", `type=bind,src=${bundle.path},dst=/home/box/sand-host/host-main.cjs,readonly`,
    "--mount", `type=bind,src=${dirname(bundle.boxExecDaemonPath)},dst=/home/box/box-exec-daemon,readonly`,
    LOCAL_DOCKER_BOX_IMAGE,
  ];
}

const inFlight = new Map<string, Promise<GatewayConnection>>();
export function createLocalDockerController(settingsPath: string, options: {
  readonly run?: DockerCommandRunner;
  readonly architecture?: string;
  readonly env?: NodeJS.ProcessEnv;
  readonly stageBundle?: (settingsPath: string) => Promise<LocalHostBundle>;
  readonly ready?: (baseUrl: string, token: string) => Promise<boolean>;
} = {}) {
  const run = options.run ?? runDocker;
  const ready = options.ready ?? gatewayReady;
  const resources = (): Promise<LocalDockerResources> => resolveLocalDockerResources(settingsPath);
  const architecture = () => localDockerArchitecture(options.architecture ?? process.arch, options.env ?? process.env);
  const inspectOwned = async (): Promise<{ resource: LocalDockerResources; container: ContainerInspection }> => {
    const resource = await resources();
    const container = await inspectContainer(resource, run);
    if (container.exists && !container.owned) throw new Error(`Refusing to manage unowned Docker container ${resource.containerName}.`);
    return { resource, container };
  };
  const start = async (): Promise<GatewayConnection> => {
    const platform = architecture();
    const daemon = await run(["info", "--format", "{{.ServerVersion}}"]);
    if (!daemon.ok) throw new Error("Docker is unavailable. Start Docker before enabling Docker tools.");
    const { resource, container } = await inspectOwned();
    const bundle = await (options.stageBundle ?? stageCurrentHostBundle)(settingsPath);
    const token = await readOrCreateToken(settingsPath);
    if (container.exists && (container.image !== LOCAL_DOCKER_BOX_IMAGE || container.schemaVersion !== LOCAL_DOCKER_SCHEMA_VERSION || container.hostSha256 !== bundle.sha256 || container.daemonSha256 !== bundle.boxExecDaemonSha256)) throw new Error("Owned Docker runtime is out of date. Explicitly reset it before starting the new runtime.");
    if (container.exists && !container.running) {
      if (!(await run(["start", container.id])).ok) throw new Error("Could not start the owned VenditBot Docker container.");
    } else if (!container.exists) {
      await ensureOwnedVolume(resource.workspaceVolume, resource, run);
      await ensureOwnedVolume(resource.dataVolume, resource, run);
      const envFile = join(dirname(settingsPath), "venditbot-docker-gateway.env");
      const temporaryEnvFile = `${envFile}.${randomBytes(8).toString("hex")}.tmp`;
      await writeFile(temporaryEnvFile, `SAND_GATEWAY_TOKEN=${token}\n`, { flag: "wx", mode: 0o600 });
      await rename(temporaryEnvFile, envFile);
      if (!(await run(buildLocalDockerRunArguments(resource, bundle, envFile, platform.platform))).ok) throw new Error("Could not create the owned VenditBot Docker container.");
    }
    const deadline = Date.now() + READY_TIMEOUT_MS;
    while (Date.now() < deadline) {
      const state = await inspectContainer(resource, run);
      if (!state.owned || !state.running) throw new Error("Owned VenditBot Docker container stopped before its gateway was ready.");
      const baseUrl = `http://127.0.0.1:${state.forwardedPorts[1340]}`;
      if (await ready(baseUrl, token)) return { baseUrl, token };
      await new Promise((resolveWait) => setTimeout(resolveWait, 1_000));
    }
    throw new Error("VenditBot Docker gateway did not become ready within three minutes.");
  };
  return {
    async status(): Promise<LocalDockerStatus> {
      const resource = await resources();
      const base = { containerName: resource.containerName, image: LOCAL_DOCKER_BOX_IMAGE, running: false, ready: false };
      let platform: ReturnType<typeof architecture>;
      try { platform = architecture(); } catch (error) { return { ...base, available: false, detail: (error as Error).message }; }
      if (!(await run(["info", "--format", "{{.ServerVersion}}"]).catch(() => ({ ok: false, output: "" }))).ok) return { ...base, available: false, detail: "Docker is unavailable." };
      try {
        const { container } = await inspectOwned();
        const isReady = container.running && await ready(`http://127.0.0.1:${container.forwardedPorts[1340]}`, await readOrCreateToken(settingsPath));
        return { ...base, available: true, running: container.running, ready: isReady, emulated: platform.emulated, forwardedPorts: container.forwardedPorts, detail: isReady ? "VenditBot Docker tools are ready." : container.running ? "Owned container is starting." : "VenditBot Docker tools are stopped." };
      } catch (error) { return { ...base, available: true, detail: (error as Error).message }; }
    },
    start,
    async stop(): Promise<void> {
      const { container } = await inspectOwned();
      if (container.exists && container.running && !(await run(["stop", container.id])).ok) throw new Error("Could not stop the owned VenditBot Docker container.");
    },
    async restart(): Promise<void> {
      const { container } = await inspectOwned();
      if (container.exists && !(await run(["restart", container.id])).ok) throw new Error("Could not restart the owned VenditBot Docker container.");
    },
    async remove(): Promise<void> {
      const { container } = await inspectOwned();
      if (container.exists && !(await run(["rm", "--force", container.id])).ok) throw new Error("Could not remove the owned VenditBot Docker container.");
    },
  };
}

export async function getLocalDockerStatus(settingsPath: string): Promise<LocalDockerStatus> { return await createLocalDockerController(settingsPath).status(); }
export function startLocalDockerBox(settingsPath: string): Promise<GatewayConnection> {
  const key = resolve(settingsPath);
  let pending = inFlight.get(key);
  if (pending == null) { pending = createLocalDockerController(key).start().finally(() => { inFlight.delete(key); }); inFlight.set(key, pending); }
  return pending;
}
export async function stopLocalDockerBox(settingsPath: string): Promise<void> { await createLocalDockerController(settingsPath).stop(); }

export function createSettingsRoutedHostConnector(remote: SandRemoteHostConnector, settings: SandSettingsStore): SandRemoteHostConnector {
  const localConnect = (): Promise<GatewayConnection> => startLocalDockerBox(settings.settingsPath);
  return {
    connect: async () => settings.getBoxRuntime() === "local-docker" ? await localConnect() : await remote.connect(),
    ...(remote.issueLocalExecDaemonCredential == null ? {} : { issueLocalExecDaemonCredential: remote.issueLocalExecDaemonCredential.bind(remote) }),
    ...(remote.issueInferenceCredential == null ? {} : { issueInferenceCredential: remote.issueInferenceCredential.bind(remote) }),
    recreate: async (args): Promise<RecreateResult> => {
      if (settings.getBoxRuntime() !== "local-docker") {
        if (remote.recreate == null) throw new Error("Remote computer recreation is unavailable.");
        return await remote.recreate(args);
      }
      await createLocalDockerController(settings.settingsPath).restart();
      await localConnect();
      return { status: "started-untrackable" };
    },
    forceRecreate: async (): Promise<RecreateResult> => {
      if (settings.getBoxRuntime() !== "local-docker") return remote.forceRecreate == null ? { status: "rejected", reason: "Remote computer reset is unavailable." } : await remote.forceRecreate();
      await createLocalDockerController(settings.settingsPath).remove();
      await localConnect();
      return { status: "started-untrackable" };
    },
  };
}
