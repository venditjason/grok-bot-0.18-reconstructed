// Opt-in QA probe, never part of the normal test suite. No login or inference.
// Usage: node tests/fixtures/probe-codex-models.mjs [official-codex-path] [evidence-json]
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { spawn } from 'node:child_process';
import path from 'node:path';
import { build } from 'esbuild';

const executable = path.resolve(process.argv[2] ?? 'node_modules/@openai/codex-darwin-arm64/vendor/aarch64-apple-darwin/bin/codex');
const evidenceFile = path.resolve(process.argv[3] ?? '.build/codex-model-list-evidence.json');
await mkdir(path.resolve('.build'), {recursive: true});
const root = await mkdtemp(path.resolve('.build/codex-model-probe-'));
const home = path.join(root, 'home'), codexHome = path.join(home, 'codex');
await mkdir(codexHome, {recursive: true, mode: 0o700});
const built = await build({entryPoints: [path.resolve('source/shared/node/codex-app-server.ts')], platform: 'node', format: 'esm', bundle: true, write: false});
const {CodexAppServer} = await import(`data:text/javascript;base64,${Buffer.from(built.outputFiles[0].text).toString('base64')}`);
let child;
const requests = [], notifications = [];
const server = new CodexAppServer({
  executable, cwd: codexHome, credentialStore: 'ephemeral', requestTimeoutMs: 20_000,
  // Deliberately exclude the user's HOME, auth keys, proxies and CLI settings.
  env: {HOME: home, CODEX_HOME: codexHome, PATH: '/usr/bin:/bin:/usr/sbin:/sbin', LANG: 'en_US.UTF-8', TMPDIR: root},
  spawnProcess(command, args, options) {
    assert.ok(args.includes('cli_auth_credentials_store="ephemeral"'));
    child = spawn(command, args, options);
    const write = child.stdin.write.bind(child.stdin);
    child.stdin.write = function (chunk, ...rest) {
      for (const line of String(chunk).trim().split('\n')) {
        const message = JSON.parse(line);
        assert.ok(['initialize', 'initialized', 'account/read', 'model/list'].includes(message.method), `unexpected method ${message.method}`);
        requests.push({method: message.method, ...(message.params === undefined ? {} : {params: message.params})});
      }
      return write(chunk, ...rest);
    };
    return child;
  },
});
server.on('notification', method => notifications.push(method));
try {
  await server.start();
  const account = await server.request('account/read', {refreshToken: false});
  assert.equal(account.account, null, 'the probe must remain unauthenticated');
  const pages = []; let cursor;
  do {
    const page = await server.request('model/list', {includeHidden: false, limit: 100, ...(cursor ? {cursor} : {})});
    assert.ok(Array.isArray(page.data)); pages.push(page); cursor = page.nextCursor;
    assert.ok(pages.length <= 10, 'bounded pagination');
  } while (cursor);
  const packageMetadata = JSON.parse(await readFile(path.resolve('node_modules/@openai/codex/package.json'), 'utf8'));
  const evidence = {capturedAt: new Date().toISOString(), runtimePackage: `@openai/codex@${packageMetadata.version}`, platform: process.platform, architecture: process.arch,
    authenticated: false, credentialStore: 'ephemeral', inferenceRequested: false, requests, notifications, pages};
  await mkdir(path.dirname(evidenceFile), {recursive: true});
  await writeFile(evidenceFile, `${JSON.stringify(evidence, null, 2)}\n`, {mode: 0o600});
  console.log(JSON.stringify({evidenceFile, models: pages.flatMap(page => page.data).map(model => ({id: model.id, model: model.model, displayName: model.displayName, isDefault: model.isDefault,
    supportedReasoningEfforts: model.supportedReasoningEfforts, defaultReasoningEffort: model.defaultReasoningEffort}))}, null, 2));
} finally {
  server.close();
  if (child && child.exitCode == null && child.signalCode == null) await new Promise(resolve => child.once('exit', resolve));
  await rm(root, {recursive: true, force: true});
}
