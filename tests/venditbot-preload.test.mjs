import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import path from 'node:path';
import {runInNewContext} from 'node:vm';
import test from 'node:test';
import {build} from 'esbuild';
const built = await build({entryPoints: [path.resolve('source/venditbot/preload.ts')], bundle: true, platform: 'node', format: 'cjs', external: ['electron'], write: false});
function port() {
  const requests = [], listeners = new Map(); let api;
  const ipcRenderer = {async invoke(channel, payload) {requests.push({channel, payload}); return payload.args?.reject ? {ok: false, error: 'native failure'} : {ok: true, value: payload};}, on(channel, listener) {listeners.set(channel, listener);}, removeListener(channel, listener) {assert.equal(listeners.get(channel), listener); listeners.delete(channel);}};
  runInNewContext(built.outputFiles[0].text, {require(name) {assert.equal(name, 'electron'); return {ipcRenderer, contextBridge: {exposeInMainWorld(name, value) {assert.equal(name, 'venditbot'); api = value;}}};}});
  return {api, requests, listeners};
}
test('actual preload forwards every public desktop request including teams and avatars, and rejects other channels', async () => {
  const f = port(); const main = await readFile('source/venditbot/main.ts', 'utf8'); const methods = [...main.matchAll(/case '([^']+)':/g)].map(m => m[1]);
  assert.ok(methods.includes('startTeamRun')); assert.ok(methods.includes('generateAgentAvatar'));
  for (const method of methods) {const result = await f.api.invoke(method, {sample: true}); assert.equal(result.method, method); assert.equal(f.requests.at(-1).channel, 'venditbot:request');}
  const before = f.requests.length; await assert.rejects(f.api.invoke('executeShell', {}), /지원/); assert.equal(f.requests.length, before);
  await assert.rejects(f.api.invoke('state', {reject: true}), /native failure/); assert.equal(Object.isFrozen(f.api), true);
});
test('preload subscriptions hide Electron event objects and unsubscribe the precise handler', () => {
  const f = port(), seen = [], close = f.api.onEvent(event => seen.push(event)), payload = {type: 'team-run', run: {id: 'test'}};
  f.listeners.get('venditbot:event')({sender: 'native'}, payload); assert.deepEqual(seen, [payload]); close(); assert.equal(f.listeners.size, 0);
});
