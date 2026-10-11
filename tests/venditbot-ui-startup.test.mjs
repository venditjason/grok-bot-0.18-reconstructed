import assert from 'node:assert/strict';
import { after, test } from 'node:test';
import { readFile } from 'node:fs/promises';
import { setTimeout as delay } from 'node:timers/promises';
import { Window } from 'happy-dom';
import { build } from 'esbuild';

// Real shipped React/VDS renderer and App effects. Only native IPC is synthetic.
const browser = new Window({ url: 'http://startup.test' });
globalThis.window = browser; globalThis.document = browser.document;
for (const name of ['HTMLElement', 'HTMLInputElement', 'Node', 'Element']) globalThis[name] = browser[name];
for (const file of ['react.js', 'vds.js']) browser.eval(await readFile(new URL(`../frontend/venditbot/${file}`, import.meta.url), 'utf8'));
const React = browser.React, { createRoot, flushSync } = browser.ReactDOM;
browser.ReactDOM = { createRoot: () => ({ render() {} }) };
const built = await build({ entryPoints: ['frontend/venditbot/app.tsx'], bundle: true, platform: 'node', format: 'esm', jsx: 'transform', jsxFactory: 'React.createElement', jsxFragment: 'React.Fragment', write: false });
const { App } = await import(`data:text/javascript;base64,${Buffer.from(built.outputFiles[0].text).toString('base64')}`);
after(() => browser.happyDOM.abort());
const deferred = () => { let resolve; const promise = new Promise(done => { resolve = done; }); return { promise, resolve }; };
const disconnected = { phase: 'disconnected', authenticated: false, inferenceVerified: false };
const ready = provider => ({ phase: 'ready', authenticated: true, inferenceVerified: true, account: { email: `${provider}@fixture.invalid` } });
const auth = { codex: disconnected, 'claude-code': disconnected };
const snapshot = (text = '', status = 'running') => ({ version: '0.3.7', profiles: [], agents: ['a', 'b', 'c'].map(id => ({ id, name: `합성 ${id}`, instructions: 'role', connectionId: 'codex', model: 'fixture' })), teams: [], teamRuns: [], sessions: [{ id: 'live', title: '합성 대화', connectionId: 'codex', model: 'fixture', createdAt: '2026-01-01', updatedAt: '2026-01-01', messages: [{ id: 'answer', role: 'assistant', text, status }] }], queue: { running: status === 'running' ? ['live'] : [], queued: [] }, activeRun: status === 'running' ? { sessionId: 'live' } : null, update: { phase: 'idle', currentVersion: '0.3.7' } });
async function until(check, label) { for (let i = 0; i < 100; i++) { flushSync(() => {}); if (check()) return; await delay(10); } assert.ok(check(), label); }
function fixture(t, handlers = {}, props = {}) {
  browser.localStorage.clear(); let listener, mounted = true; const calls = [];
  browser.venditbot = { invoke: async (method, args) => { calls.push({ method, args }); if (handlers[method]) return handlers[method](args); if (method === 'state') return snapshot(); if (method === 'authStatus') return auth; if (method === 'listModels') return { models: [{ id: 'fixture', label: 'Fixture', efforts: [], isDefault: true }], fetchedAt: '2026-01-01', source: 'fixture' }; return {}; }, onEvent: handler => { listener = handler; return () => { listener = undefined; }; } };
  const host = document.createElement('div'); document.body.append(host); const root = createRoot(host);
  flushSync(() => root.render(React.createElement(App, { initialSessionId: 'live', ...props })));
  const unmount = () => { if (mounted) { flushSync(() => root.unmount()); host.remove(); mounted = false; } };
  t.after(unmount);
  return { host, calls, unmount, emit(event) { assert.ok(listener, 'subscribed before native events'); flushSync(() => listener(event)); }, agents: () => [...host.querySelectorAll('nav[data-sidebar-list="agent"] [data-sidebar-id]')].map(node => node.dataset.sidebarId), text: () => host.querySelector('.markdown-content')?.textContent ?? host.textContent };
}

test('cold App mount recovers its full state after startup update invalidates the first response', async t => {
  const first = deferred(); let reads = 0;
  const f = fixture(t, { state: () => ++reads === 1 ? first.promise : { ...snapshot(), update: { phase: 'available', currentVersion: '0.3.7', version: 'next' } } });
  assert.match(f.host.querySelector('.topbar-title').textContent, /불러오는 중/);
  assert.doesNotMatch(f.host.querySelector('.topbar-title').textContent, /0\.1\.0/);
  f.emit({ type: 'update', update: { phase: 'available', currentVersion: '0.3.7', version: 'next' } });
  first.resolve(snapshot());
  await until(() => f.agents().length === 3, 'startup must load all persisted agents without any user action');
  assert.deepEqual(f.agents(), ['a', 'b', 'c']); assert.match(f.host.querySelector('.topbar-title').textContent, /0\.3\.7/); assert.equal(reads, 2);
});

test('auth event during cold mount retains both providers and cannot discard unrelated application state', async t => {
  const firstAuth = deferred(), firstState = deferred(); let authReads = 0, stateReads = 0;
  const f = fixture(t, { state: () => { stateReads++; return firstState.promise; }, authStatus: () => ++authReads === 1 ? firstAuth.promise : { codex: ready('codex'), 'claude-code': ready('claude') } });
  f.emit({ type: 'auth', provider: 'codex', status: ready('codex') }); firstState.resolve(snapshot()); firstAuth.resolve(auth);
  await until(() => f.agents().length === 3 && new Set(f.calls.filter(call => call.method === 'listModels').map(call => call.args.provider)).size === 2, 'one auth event must not strand the second provider at disconnected');
  assert.equal(stateReads, 1); assert.equal(authReads, 2);
});

test('repeated startup invalidations re-read authoritative state without duplicating buffered deltas or reviving a cancelled turn', async t => {
  const first = deferred(), second = deferred(), third = deferred(); let reads = 0;
  const f = fixture(t, { state: () => [first, second, third][reads++].promise });
  f.emit({ type: 'update', update: { phase: 'idle', currentVersion: '0.3.7' } }); first.resolve(snapshot());
  await until(() => reads === 2, 'first invalidation starts a fresh read');
  f.emit({ type: 'delta', sessionId: 'live', messageId: 'answer', delta: '보존할 답변' });
  f.emit({ type: 'session', session: snapshot('보존할 답변', 'cancelled').sessions[0] });
  f.emit({ type: 'queue', running: [], queued: [] });
  second.resolve(snapshot('오래된 응답')); await until(() => reads === 3, 'terminal event requires another full read');
  third.resolve(snapshot('보존할 답변', 'cancelled'));
  await until(() => f.agents().length === 3, 'final current snapshot applied');
  f.emit({ type: 'delta', sessionId: 'live', messageId: 'answer', delta: '늦은 조각' }); await delay(70);
  assert.match(f.host.textContent, /보존할 답변/); assert.doesNotMatch(f.host.textContent, /오래된 응답|늦은 조각|보존할 답변보존할 답변/); assert.equal(reads, 3);
});

test('unmount cancels invalidated startup work and never starts a replacement IPC read', async t => {
  const first = deferred(); let reads = 0;
  const f = fixture(t, { state: () => { reads++; return first.promise; } });
  f.emit({ type: 'update', update: { phase: 'idle', currentVersion: '0.3.7' } }); f.unmount(); first.resolve(snapshot()); await delay(90);
  assert.equal(reads, 1);
});

test('each retried snapshot flushes buffered text before applying a host snapshot that already includes it', async t => {
  const first = deferred(); let reads = 0;
  const f = fixture(t, { state: () => ++reads === 1 ? first.promise : snapshot('한 번만 표시') }, { initialState: snapshot() });
  f.emit({ type: 'update', update: { phase: 'idle', currentVersion: '0.3.7' } });
  first.resolve(snapshot()); await Promise.resolve();
  f.emit({ type: 'delta', sessionId: 'live', messageId: 'answer', delta: '한 번만 표시' });
  await until(() => reads === 2 && f.host.textContent.includes('한 번만 표시'), 'retry completed'); await delay(80);
  assert.equal(f.host.textContent.split('한 번만 표시').length - 1, 1); assert.equal(reads, 2);
});
