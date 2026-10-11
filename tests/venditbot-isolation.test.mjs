import assert from "node:assert/strict";
import { mkdir, mkdtemp, readdir, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { build } from "esbuild";
import { planMacProductIdentity } from "../scripts/lib/macos-product-identity.mjs";

const root = path.resolve(import.meta.dirname, "..");
async function load(relative) {
  const result = await build({ entryPoints: [path.join(root, relative)], bundle: true, write: false, platform: "node", format: "esm", target: "node22", logLevel: "silent" });
  return import(`data:text/javascript;base64,${Buffer.from(result.outputFiles[0].text).toString("base64")}`);
}
const paths = await load("source/shared/node/venditbot-paths.ts");
const links = await load("source/shared/deep-link.ts");
const protocol = await load("source/electron-main/auth/auth-callback-registration.ts");
const bootstrap = await load("source/electron-main/startup/desktop-user-data-bootstrap.ts");
const docker = await load("source/electron-main/box/local-docker-host-connector.ts");

async function temporary(t) {
  const directory = await mkdtemp(path.join(tmpdir(), "venditbot-isolation-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  return directory;
}

test("product paths isolate prod, dev and profiles without inheriting Grok or CLI homes", () => {
  const env = { SAND_DATA_ROOT: "/shared/grok", SAND_USER_DATA_DIR: "/shared/cursor", CODEX_HOME: "/shared/codex", CLAUDE_CONFIG_DIR: "/shared/claude" };
  const prod = paths.resolveVenditBotPaths({ homeDir: "/Users/example", platform: "darwin", env });
  const dev = paths.resolveVenditBotPaths({ homeDir: "/Users/example", platform: "darwin", development: true, env });
  const other = paths.resolveVenditBotPaths({ homeDir: "/Users/example", platform: "darwin", profileId: "second", env });
  assert.equal(prod.dataRoot, "/Users/example/Library/Application Support/VenditBot");
  assert.equal(prod.codexHome, `${prod.profileRoot}/providers/codex`);
  assert.equal(prod.claudeConfigDir, `${prod.profileRoot}/providers/claude`);
  assert.equal(prod.rendererDataRoot, `${prod.profileRoot}/renderer-state`);
  assert.notEqual(prod.rendererDataRoot, prod.cacheRoot);
  assert.notEqual(dev.dataRoot, prod.dataRoot);
  assert.notEqual(other.profileRoot, prod.profileRoot);
  assert.throws(() => paths.resolveVenditBotPaths({ profileId: "../codex" }), /profile ID/);
  for (const inherited of ["/Users/example/.codex", "/Users/example/.claude", "/Users/example/.grokbot", "/Users/example/.cursor/sand"]) assert.throws(() => paths.resolveVenditBotPaths({ env: { VENDITBOT_USER_DATA_DIR: inherited } }), /another application/);
});

test("provider child environment keeps OS runtime but removes ambient auth and runtime injection", () => {
  const original = { HOME: "/Users/example", PATH: "/usr/bin", LANG: "ko_KR.UTF-8", CODEX_HOME: "/shared/codex", CLAUDE_CONFIG_DIR: "/shared/claude", OPENAI_API_KEY: "secret-a", ANTHROPIC_AUTH_TOKEN: "secret-b", OPENROUTER_API_KEY: "secret-c", SAND_BACKEND_URL: "https://other.test", NODE_OPTIONS: "--require=evil", NODE_PATH: "/other", ELECTRON_RUN_AS_NODE: "1", AWS_ACCESS_KEY_ID: "secret-d", DYLD_INSERT_LIBRARIES: "/evil.dylib", SOME_UNEXPECTED_SECRET: "secret-e" };
  const dedicated = paths.resolveVenditBotPaths({ homeDir: original.HOME, platform: "darwin", env: {} });
  const child = paths.createVenditBotChildEnvironment(original, dedicated);
  assert.equal(child.HOME, original.HOME);
  assert.equal(child.PATH, original.PATH);
  assert.equal(child.CODEX_HOME, dedicated.codexHome);
  assert.equal(child.CLAUDE_CONFIG_DIR, dedicated.claudeConfigDir);
  for (const key of ["OPENAI_API_KEY", "ANTHROPIC_AUTH_TOKEN", "OPENROUTER_API_KEY", "SAND_BACKEND_URL", "NODE_OPTIONS", "NODE_PATH", "ELECTRON_RUN_AS_NODE", "AWS_ACCESS_KEY_ID", "DYLD_INSERT_LIBRARIES", "SOME_UNEXPECTED_SECRET"]) assert.equal(child[key], undefined);
  assert.equal(original.CODEX_HOME, "/shared/codex", "parent environment was not changed");
});

test("development rejects production-root overrides and descendants while isolated QA remains supported", () => {
  const homeDir = '/Users/example', root = `${homeDir}/Library/Application Support/VenditBot`;
  for (const selected of [root, `${root}/profiles/default`, `${root}/cache/../qa`, root.toLowerCase()]) {
    assert.throws(() => paths.resolveVenditBotPaths({homeDir, platform: 'darwin', development: true, env: {VENDITBOT_USER_DATA_DIR: selected}}), /production data directory/);
  }
  for (const selected of ['/workspace/private-qa', `${root} Development`, `${root}-qa`]) {
    assert.equal(paths.resolveVenditBotPaths({homeDir, platform: 'darwin', development: true, env: {VENDITBOT_USER_DATA_DIR: selected}}).dataRoot, selected);
  }
  assert.equal(paths.resolveVenditBotPaths({homeDir, platform: 'darwin', development: false, env: {VENDITBOT_USER_DATA_DIR: '/workspace/custom-prod'}}).dataRoot, '/workspace/custom-prod');
  assert.equal(paths.resolveVenditBotPaths({homeDir, platform: 'darwin', development: false, env: {VENDITBOT_USER_DATA_DIR: root}}).dataRoot, root);
});

test("an explicit QA root contains logs, caches, profiles and credentials", () => {
  const root = "/workspace/isolated-qa/VenditBot";
  const own = paths.resolveVenditBotPaths({ homeDir: "/Users/actual-home", platform: "darwin", env: { VENDITBOT_USER_DATA_DIR: root } });
  for (const key of ["logsRoot", "cacheRoot", "rendererDataRoot", "profileRoot", "codexHome", "claudeConfigDir"]) assert.ok(own[key].startsWith(`${root}/`), `${key} escaped the QA root`);
});

test("durable renderer drafts cannot be redirected into another profile by symlink", async t => {
  const directory = await temporary(t), own = paths.resolveVenditBotPaths({homeDir: directory, platform: 'darwin', env: {}}), foreign = path.join(directory, 'foreign-renderer');
  await mkdir(foreign); await mkdir(own.profileRoot, {recursive: true}); await symlink(foreign, own.rendererDataRoot);
  assert.throws(() => paths.ensureVenditBotDirectories(own), /symbolic link/); assert.deepEqual(await readdir(foreign), []);
});

test("profile bootstrap rejects a credential directory symlink into a different app", async t => {
  const directory = await temporary(t);
  const own = paths.resolveVenditBotPaths({ homeDir: directory, platform: "darwin", env: {} });
  const foreign = path.join(directory, ".codex");
  await mkdir(foreign);
  await mkdir(own.providersRoot, { recursive: true });
  await symlink(foreign, own.codexHome);
  assert.throws(() => paths.ensureVenditBotDirectories(own), /symbolic link/);
});

test("an arbitrary ancestor symlink is rejected before anything is written to its target", async t => {
  const directory = await temporary(t);
  const foreign = path.join(directory, "foreign-app-data");
  const alias = path.join(directory, "alias");
  await mkdir(foreign);
  await symlink(foreign, alias);
  const own = paths.resolveVenditBotPaths({ homeDir: directory, platform: "darwin", env: { VENDITBOT_USER_DATA_DIR: path.join(alias, "apparently-owned", "VenditBot") } });
  assert.throws(() => paths.ensureVenditBotDirectories(own), /symbolic link/);
  assert.deepEqual(await readdir(foreign), []);
});

test("bootstrap assigns name and isolated Electron storage before caller takes the instance lock", async t => {
  const homeDir = await temporary(t);
  const events = [];
  const env = { SAND_DATA_ROOT: "/other", CODEX_HOME: "/other" };
  const app = { isPackaged: true, getPath: () => "/original", setName: name => events.push(["name", name]), setPath: (name, directory) => events.push([name, directory]), setAppLogsPath: directory => events.push(["logs", directory]) };
  const result = bootstrap.bootstrapDesktopUserData({ app, isLabBuild: false, homeDir, platform: "darwin", env, argv: [] });
  events.push(["lock"]);
  assert.deepEqual(events.map(event => event[0]), ["name", "userData", "sessionData", "logs", "lock"]);
  assert.equal(events[0][1], "벤디트봇");
  assert.equal(events[1][1], result);
  assert.ok(result.startsWith(homeDir));
  assert.equal(env.SAND_DATA_ROOT, undefined);
  assert.ok(env.VENDITBOT_DATA_ROOT.startsWith(result));
});

test("deep links and protocol registration never claim original schemes from inherited configuration", () => {
  assert.equal(links.parseSandDeepLink("venditbot://app/v1/open")?.link.route, "open");
  for (const url of ["sand://app/v1/open", "grokbot://app/v1/open", "https://cursor.com/sand/link/v1/open"]) assert.equal(links.parseSandDeepLink(url), null);
  const registered = [];
  const result = protocol.registerAuthCallbackProtocol({ app: { setAsDefaultProtocolClient: value => { registered.push(value); return true; } }, isPackaged: true, isLabBuild: false, env: { SAND_AUTH_CALLBACK_SCHEME: "sand", SAND_AUTH_REDIRECT_TARGET: "grokbot" } });
  assert.equal(result.protocolScheme, "venditbot");
  assert.deepEqual(registered, ["venditbot"]);
});

test("IPC identity rejects oversized Unix sockets and traversal", () => {
  const socket = paths.venditBotSocketPath("/tmp/venditbot", "abc123", "gateway");
  assert.ok(Buffer.byteLength(socket) <= 103);
  assert.notEqual(socket, paths.venditBotSocketPath("/tmp/venditbot", "def456", "gateway"));
  assert.throws(() => paths.venditBotSocketPath(`/${"x".repeat(95)}`, "abc123", "gateway"), /too long/);
  assert.throws(() => paths.venditBotSocketPath("/tmp/venditbot", "../old", "gateway"), /Invalid/);
});

test("Docker instance creation is stable under a race and separate between profiles", async t => {
  const homeDir = await temporary(t);
  const settingsPath = path.join(homeDir, "first", "settings.json");
  const [first, racing] = await Promise.all([docker.resolveLocalDockerResources(settingsPath), docker.resolveLocalDockerResources(settingsPath)]);
  const second = await docker.resolveLocalDockerResources(path.join(homeDir, "second", "settings.json"));
  assert.deepEqual(first, racing);
  assert.notEqual(first.containerName, second.containerName);
  assert.match(first.containerName, /^venditbot-[a-f0-9]{24}-vm$/);
  await writeFile(path.join(homeDir, "first", "venditbot-instance-id"), "../grok");
  await assert.rejects(docker.resolveLocalDockerResources(settingsPath), /installation identity/);
});

function portBindings(base = 49150) {
  return Object.fromEntries(docker.LOCAL_DOCKER_PORTS.map((port, index) => [`${port}/tcp`, [{ HostIp: "127.0.0.1", HostPort: String(base + index) }]]));
}
function inspectPayload(resources, { owned = true, running = true } = {}) {
  return { Id: "a".repeat(64), State: { Running: running }, Config: { Image: docker.LOCAL_DOCKER_BOX_IMAGE, Labels: { [docker.LOCAL_DOCKER_OWNER_LABEL]: owned ? "1" : "0", [docker.LOCAL_DOCKER_INSTANCE_LABEL]: resources.instanceId, "com.vendit.venditbot.host-sha256": "host-hash", "com.vendit.venditbot.box-exec-daemon-sha256": "daemon-hash", "com.vendit.venditbot.schema-version": docker.LOCAL_DOCKER_SCHEMA_VERSION } }, NetworkSettings: { Ports: portBindings() } };
}

test("Docker uses ephemeral loopback ports, scoped labeled volumes, bounded resources and no auth mounts", () => {
  const resource = { instanceId: "a".repeat(24), containerName: "venditbot-test-vm", workspaceVolume: "venditbot-test-workspace", dataVolume: "venditbot-test-data" };
  const bundle = { path: "/owned/runtime/host-main.cjs", sha256: "h", boxExecDaemonPath: "/owned/runtime/box-exec-daemon/main.cjs", boxExecDaemonSha256: "d" };
  const args = docker.buildLocalDockerRunArguments(resource, bundle, "/owned/gateway.env", "linux/amd64");
  assert.deepEqual(args.filter((arg, index) => args[index - 1] === "--publish"), docker.LOCAL_DOCKER_PORTS.map(port => `127.0.0.1::${port}`));
  assert.equal(args[args.indexOf("--cpus") + 1], "4");
  assert.equal(args[args.indexOf("--memory") + 1], "6g");
  assert.equal(args.some(arg => /\.codex|\.claude|inference\.json/.test(arg)), false);
  assert.equal(args.some(arg => arg.startsWith("SAND_GATEWAY_TOKEN=")), false, "gateway token is not placed in process arguments");
  const mappings = docker.readLocalDockerPortMappings(portBindings());
  assert.equal(mappings[1340], 49152, "actual assigned gateway port is returned");
  const unsafe = portBindings();
  unsafe["1340/tcp"][0].HostIp = "0.0.0.0";
  assert.throws(() => docker.readLocalDockerPortMappings(unsafe), /loopback/);
});

test("Docker start reports the actual dynamic gateway while old fixed ports may be occupied", async t => {
  const homeDir = await temporary(t);
  const settingsPath = path.join(homeDir, "settings.json");
  const resource = await docker.resolveLocalDockerResources(settingsPath);
  const calls = [];
  const controller = docker.createLocalDockerController(settingsPath, { architecture: "x64", run: async args => { calls.push(args); return { ok: true, output: args[0] === "info" ? "28.0" : JSON.stringify(inspectPayload(resource)) }; }, stageBundle: async () => ({ path: "/owned/host.cjs", sha256: "host-hash", boxExecDaemonPath: "/owned/daemon/main.cjs", boxExecDaemonSha256: "daemon-hash" }), ready: async url => { assert.equal(url, "http://127.0.0.1:49152"); return true; } });
  const gateway = await controller.start();
  assert.equal(gateway.baseUrl, "http://127.0.0.1:49152");
  assert.equal(calls.some(args => ["rm", "kill", "stop"].includes(args[0])), false);
});

test("a same-name unowned Docker volume blocks creation without mounting or replacing it", async t => {
  const homeDir = await temporary(t);
  const settingsPath = path.join(homeDir, "settings.json");
  const calls = [];
  const controller = docker.createLocalDockerController(settingsPath, {
    architecture: "x64",
    run: async args => {
      calls.push(args);
      if (args[0] === "info") return { ok: true, output: "28.0" };
      if (args[0] === "container") return { ok: false, output: "Error: No such container" };
      if (args[0] === "volume" && args[1] === "inspect") return { ok: true, output: JSON.stringify({ "com.other-app.owner": "1" }) };
      throw new Error(`Unexpected destructive action: ${args[0]} ${args[1]}`);
    },
    stageBundle: async () => ({ path: "/owned/host.cjs", sha256: "host-hash", boxExecDaemonPath: "/owned/daemon/main.cjs", boxExecDaemonSha256: "daemon-hash" }),
  });
  await assert.rejects(controller.start(), /unowned Docker volume/);
  assert.equal(calls.some(args => args[0] === "run" || args[0] === "rm" || args[1] === "create"), false);
});

test("every destructive Docker operation rejects an unowned container before invoking mutation", async t => {
  const homeDir = await temporary(t);
  const settingsPath = path.join(homeDir, "settings.json");
  const resource = await docker.resolveLocalDockerResources(settingsPath);
  const calls = [];
  for (const wrongInstance of [false, true]) {
    const inspected = inspectPayload(resource, { owned: wrongInstance });
    if (wrongInstance) inspected.Config.Labels[docker.LOCAL_DOCKER_INSTANCE_LABEL] = "b".repeat(24);
    const controller = docker.createLocalDockerController(settingsPath, { architecture: "x64", run: async args => { calls.push(args); return { ok: true, output: JSON.stringify(inspected) }; } });
    await assert.rejects(controller.stop(), /unowned/);
    await assert.rejects(controller.restart(), /unowned/);
    await assert.rejects(controller.remove(), /unowned/);
  }
  assert.ok(calls.every(args => args[0] === "container" && args[1] === "inspect"));
});

test("owned Docker operations address the inspected immutable container ID", async t => {
  const homeDir = await temporary(t);
  const settingsPath = path.join(homeDir, "settings.json");
  const resource = await docker.resolveLocalDockerResources(settingsPath);
  const calls = [];
  const controller = docker.createLocalDockerController(settingsPath, { run: async args => { calls.push(args); return { ok: true, output: JSON.stringify(inspectPayload(resource)) }; } });
  await controller.stop();
  await controller.restart();
  await controller.remove();
  assert.deepEqual(calls.filter(args => args[0] !== "container"), [["stop", "a".repeat(64)], ["restart", "a".repeat(64)], ["rm", "--force", "a".repeat(64)]]);
});

test("arm64 never silently relabels an amd64 image as native", () => {
  assert.throws(() => docker.localDockerArchitecture("arm64", {}), /verified native arm64/);
  assert.deepEqual(docker.localDockerArchitecture("arm64", { VENDITBOT_DOCKER_ALLOW_AMD64_EMULATION: "1" }), { platform: "linux/amd64", emulated: true });
});

test("packaging renames all Electron helper roles coherently with separate development identity", () => {
  const helperNames = ["Electron Helper.app", "Electron Helper (GPU).app", "Electron Helper (Renderer).app", "Electron Helper (Plugin).app"];
  const prod = planMacProductIdentity({ sourceName: "Electron", helperNames });
  const dev = planMacProductIdentity({ sourceName: "Electron", helperNames, development: true });
  assert.equal(prod.displayName, "벤디트봇");
  assert.equal(prod.executableName, "VenditBot");
  assert.equal(prod.bundleId, "com.vendit.venditbot");
  assert.notEqual(dev.bundleId, prod.bundleId);
  assert.ok(prod.helpers.every(helper => helper.bundleName === `${helper.executableName}.app` && helper.executableName.startsWith("VenditBot Helper")));
  assert.throws(() => planMacProductIdentity({ sourceName: "Electron", helperNames: helperNames.slice(1) }), /helper ABI layout/);
});
