import assert from 'node:assert/strict';
import { access, mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import test from 'node:test';
import { build } from 'esbuild';

// Explicit opt-in: tests only disposable, app-owned Keychain entries using a
// synthetic non-working API key. No browser login, real credentials, or inference.
// Run with VENDITBOT_CODEX_TEST_BINARY=/absolute/packaged/runtimes/codex/bin/codex
const executable = process.env.VENDITBOT_CODEX_TEST_BINARY;
test('official Codex keyring restores a disposable profile and isolates logout across homes', { skip: !executable }, async t => {
  const root = await mkdtemp(path.join(tmpdir(), 'venditbot-native-keyring-'));
  const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
  const serverModule = path.join(root, 'server.mjs'), pathsModule = path.join(root, 'paths.mjs');
  await build({ entryPoints: [path.join(repoRoot, 'source/shared/node/codex-app-server.ts')], bundle: true, platform: 'node', format: 'esm', outfile: serverModule });
  await build({ entryPoints: [path.join(repoRoot, 'source/shared/node/venditbot-paths.ts')], bundle: true, platform: 'node', format: 'esm', outfile: pathsModule });
  const { CodexAppServer } = await import(pathToFileURL(serverModule).href);
  const { resolveVenditBotPaths, ensureVenditBotDirectories, createVenditBotChildEnvironment } = await import(pathToFileURL(pathsModule).href);
  const servers = [], active = new Map();
  async function open(profileId) {
    const paths = resolveVenditBotPaths({ homeDir: root, profileId, env: {} }); ensureVenditBotDirectories(paths);
    const server = new CodexAppServer({ executable, cwd: paths.codexHome, env: createVenditBotChildEnvironment(process.env, paths), credentialStore: 'keyring', requestTimeoutMs: 10000 });
    servers.push(server); await server.start(); active.set(profileId, server); return { server, paths };
  }
  t.after(async () => {
    for (const server of active.values()) await server.request('account/logout').catch(() => {});
    for (const server of servers) server.close();
    await rm(root, { recursive: true, force: true });
  });
  let first = await open('storage-one');
  assert.equal((await first.server.request('account/read', { refreshToken: false })).account, null);
  await first.server.request('account/login/start', { type: 'apiKey', apiKey: 'venditbot-synthetic-nonworking-key-for-storage-test' });
  first.server.close(); first = await open('storage-one');
  assert.equal((await first.server.request('account/read', { refreshToken: false })).account?.type, 'apiKey');
  const second = await open('storage-two');
  assert.equal((await second.server.request('account/read', { refreshToken: false })).account, null);
  await second.server.request('account/logout');
  assert.equal((await first.server.request('account/read', { refreshToken: false })).account?.type, 'apiKey');
  assert.equal(await access(path.join(first.paths.codexHome, 'auth.json')).then(() => true, () => false), false);
  await first.server.request('account/logout');
  first.server.close(); first = await open('storage-one');
  assert.equal((await first.server.request('account/read', { refreshToken: false })).account, null);
});
