import assert from 'node:assert/strict';
import test from 'node:test';
import React, { act } from 'react';
import { createRoot } from 'react-dom/client';
import { Window } from 'happy-dom';
import { build } from 'esbuild';

// Real React render/commit/effect cycles and App IPC handlers, using an isolated
// DOM/storage and VDS presentation ports. This is not a native mouse/GUI test.
const dom = new Window({ url: 'http://venditbot.test' });
globalThis.window = dom; globalThis.document = dom.document;
globalThis.IS_REACT_ACT_ENVIRONMENT = true;
const h = React.createElement;
const passthrough = ({ children }) => children;
const Button = ({ children, onPress, onClick, disabled, className, title, ...props }) => h('button', { type: 'button', onClick: onPress ?? onClick, disabled, className, title, ...Object.fromEntries(Object.entries(props).filter(([key]) => key.startsWith('aria-') || key.startsWith('data-') || key === 'onContextMenu' || key === 'onKeyDown')) }, children);
const TextInput = ({ label, value, onChange, readOnly, disabled, type, ...props }) => h('label', {}, label, h('input', { value, onChange, readOnly, disabled, type, 'aria-label': props['aria-label'] ?? label }));
const TextArea = ({ value, onChange, disabled, ...props }) => h('textarea', { value, onChange, disabled, 'aria-label': props['aria-label'] });
const Dialog = { Root: ({ open, children }) => open ? h('section', { role: 'dialog' }, children) : null, Portal: passthrough, Content: passthrough, Header: ({ title }) => h('h2', {}, title), Footer: ({ RightComponent }) => RightComponent ? h(RightComponent) : null };
window.React = React; window.ReactDOM = { createRoot: () => ({ render() {} }) };
window.VDS = { VDSProvider: passthrough, Button, TextInput, TextArea, Checkbox: () => null, Icon: () => null, Badge: passthrough, Dialog };
let invoke, nativeEvent;
window.venditbot = { invoke: (...args) => invoke(...args), onEvent: callback => { nativeEvent = callback; return () => { nativeEvent = undefined; }; } };
const bundled = await build({ entryPoints: ['frontend/venditbot/app.tsx', 'frontend/venditbot/sidebar-order.ts'], bundle: true, platform: 'node', format: 'esm', jsx: 'transform', jsxFactory: 'React.createElement', jsxFragment: 'React.Fragment', write: false, outdir: '/unused' });
const load = async name => import(`data:text/javascript;base64,${Buffer.from(bundled.outputFiles.find(file => file.path.endsWith(`/${name}.js`)).text).toString('base64')}`);
const { App } = await load('app'), { useSidebarOrder, sidebarOrderKey } = await load('sidebar-order');
const stamp = '2026-10-11T00:00:00Z';
const agents = ['a1', 'a2', 'a3'].map(id => ({ id, name: id, instructions: 'role', connectionId: 'api', model: 'fixture', createdAt: stamp, updatedAt: stamp }));
const teams = ['product', 'design', 'review'].map(id => ({ id, name: id, leaderAgentId: 'a1', memberAgentIds: ['a1'], instructions: '', topic: '', policies: '', rounds: 1, createdAt: stamp, updatedAt: stamp }));
const snapshot = { version: 'fixture', profiles: [], agents, teams, teamRuns: [], sessions: [], queue: { running: [], queued: [] }, activeRun: null };
const seed = { agents: ['a3', 'a1', 'a2'], teams: ['review', 'product', 'design'] };
function deferred() { let resolve, reject; const promise = new Promise((yes, no) => { resolve = yes; reject = no; }); return { promise, resolve, reject }; }
function storage(value = seed) {
  const values = new Map([[sidebarOrderKey, JSON.stringify(value)]]), writes = [];
  Object.defineProperty(window, 'localStorage', { configurable: true, value: { getItem: key => values.get(key) ?? null, setItem: (key, value) => { values.set(key, String(value)); if (key === sidebarOrderKey) writes.push(String(value)); }, removeItem: key => values.delete(key) } });
  return { values, writes, order: () => JSON.parse(values.get(sidebarOrderKey)) };
}
async function mount(t, element) {
  const container = document.createElement('div'); document.body.append(container); const root = createRoot(container); let mounted = true;
  const unmount = async () => { if (mounted) { await act(async () => root.unmount()); container.remove(); mounted = false; } };
  t.after(unmount); await act(async () => root.render(element));
  return { container, render: async element => act(async () => root.render(element)), unmount };
}
async function click(element) { assert.ok(element, 'click target must exist'); await act(async () => element.click()); }
const button = (root, label) => [...root.querySelectorAll('button')].find(node => node.textContent === label);
const ids = (root, kind) => [...root.querySelectorAll(`nav[data-sidebar-list="${kind}"] [data-sidebar-id]`)].map(node => node.getAttribute('data-sidebar-id'));

test('real App cold mount preserves order through delayed failed IPC, retry, menu reorder and another cold mount', async t => {
  const disk = storage(), reads = []; let pending = deferred();
  invoke = async method => { if (method === 'state') { reads.push(method); return pending.promise; } if (method === 'authStatus') return {}; throw new Error(`unexpected IPC ${method}`); };
  const app = await mount(t, h(App));
  assert.equal(reads.length, 1); assert.deepEqual(ids(app.container, 'team'), []);
  assert.deepEqual(disk.order(), seed, 'the blank bootstrap state is not an authoritative deletion'); assert.equal(disk.writes.length, 0);
  await act(async () => pending.reject(new Error('fixture state unavailable')));
  assert.match(app.container.textContent, /fixture state unavailable/); assert.deepEqual(disk.order(), seed); assert.equal(disk.writes.length, 0);
  pending = deferred(); await click(button(app.container, '설정'));
  assert.equal(reads.length, 2); assert.deepEqual(disk.order(), seed);
  await act(async () => pending.resolve(snapshot));
  assert.deepEqual(ids(app.container, 'team'), seed.teams); assert.deepEqual(ids(app.container, 'agent'), seed.agents); assert.equal(disk.writes.length, 0);
  await act(async () => app.container.querySelector('[data-sidebar-id="design"] .sidebar-profile-button').dispatchEvent(new window.MouseEvent('contextmenu', { bubbles: true, cancelable: true, button: 2 })));
  await click(button(app.container.querySelector('[role="dialog"]'), '목록에서 앞으로'));
  const reordered = { ...seed, teams: ['review', 'design', 'product'] };
  assert.deepEqual(ids(app.container, 'team'), reordered.teams); assert.deepEqual(disk.order(), reordered); assert.equal(disk.writes.length, 1);
  await app.unmount(); pending = deferred();
  const reopened = await mount(t, h(App));
  assert.deepEqual(disk.order(), reordered); assert.equal(disk.writes.length, 1);
  await act(async () => pending.resolve(snapshot));
  assert.deepEqual(ids(reopened.container, 'team'), reordered.teams); assert.deepEqual(ids(reopened.container, 'agent'), seed.agents); assert.deepEqual(disk.order(), reordered);
});

test('real React empty/deleted inventories remain filtered without persistence until a valid explicit move', async t => {
  const original = { agents: ['deleted', 'a3', 'a1', 'a2'], teams: seed.teams }, disk = storage(original); let order;
  function Probe({ agents, teams }) { order = useSidebarOrder(agents, teams); return h('output', {}, JSON.stringify({ agents: order.agents, teams: order.teams })); }
  const render = (agents, teams) => h(React.StrictMode, {}, h(Probe, { agents, teams }));
  const app = await mount(t, render([], []));
  assert.deepEqual({ agents: order.agents, teams: order.teams }, { agents: [], teams: [] }); assert.deepEqual(disk.order(), original); assert.equal(disk.writes.length, 0);
  await app.render(render(['a1', 'a3', 'new'], []));
  assert.deepEqual(order.agents, ['a3', 'a1', 'new']); assert.deepEqual(order.teams, []); assert.deepEqual(disk.order(), original);
  await act(async () => { order.reorder('agents', 'missing', 'a1'); order.move('teams', 'review', -1); order.reorder('agents', 'a1', 'a1'); });
  assert.equal(disk.writes.length, 0, 'invalid/self/no-op moves must not persist incomplete inventories');
  await act(async () => order.reorder('agents', 'new', 'a3'));
  assert.deepEqual(disk.order(), { agents: ['new', 'a3', 'a1'], teams: seed.teams }, 'only the explicitly changed list is reconciled in storage');
  await app.render(render(['a1', 'a3', 'new'], ['product', 'design', 'review']));
  assert.deepEqual(order.teams, seed.teams); assert.deepEqual(order.agents, ['new', 'a3', 'a1']);
  await app.render(render([], []));
  assert.deepEqual(order.agents, []); assert.deepEqual(order.teams, []); assert.equal(disk.writes.length, 1, 'a genuinely empty list has no visible ghost entries and need not erase preferences');
  await app.unmount(); await mount(t, render(['new', 'a1'], ['review', 'product']));
  assert.deepEqual(order.agents, ['new', 'a1']); assert.deepEqual(order.teams, ['review', 'product']);
});

test('real React handles an uncaptured drag whose move/up bubble from another card exactly once', async t => {
  const disk = storage(); invoke = async method => method === 'state' ? snapshot : {};
  const app = await mount(t, h(App)), handle = app.container.querySelector('[data-sidebar-id="design"] .sidebar-profile-button');
  const target = app.container.querySelector('[data-sidebar-id="review"] .team-photo-name');
  const originalHit = document.elementFromPoint; document.elementFromPoint = () => target;
  t.after(() => { document.elementFromPoint = originalHit; });
  handle.setPointerCapture = () => {}; handle.hasPointerCapture = () => false;
  const pointer = (type, x, y) => new window.PointerEvent(type, { bubbles: true, cancelable: true, pointerId: 41, isPrimary: true, button: 0, clientX: x, clientY: y });
  await act(async () => handle.dispatchEvent(pointer('pointerdown', 684, 439)));
  await act(async () => handle.dispatchEvent(pointer('pointermove', 547, 314)));
  assert.equal(handle.closest('[data-sidebar-id]').getAttribute('data-sidebar-dragging'), 'true');
  await act(async () => target.dispatchEvent(pointer('pointermove', 410, 189)));
  await act(async () => target.dispatchEvent(pointer('pointerup', 410, 189)));
  assert.deepEqual(ids(app.container, 'team'), ['design', 'review', 'product']);
  assert.deepEqual(disk.order(), { ...seed, teams: ['design', 'review', 'product'] }); assert.equal(disk.writes.length, 1);
  await act(async () => handle.dispatchEvent(pointer('pointerup', 410, 189)));
  assert.equal(disk.writes.length, 1, 'React and document delivery cannot commit twice');
  await act(async () => handle.dispatchEvent(new window.MouseEvent('click', { bubbles: true, cancelable: true, detail: 1 })));
  assert.equal(app.container.querySelector('[role="dialog"]'), null, 'the generated post-drag click must not open a menu');
  assert.equal([...app.container.querySelectorAll('header button')].some(node => node.textContent === '팀 설정'), false, 'drag must not open the team chat');
  assert.equal(app.container.querySelector('[data-sidebar-dragging]'), null); assert.equal(app.container.querySelector('[data-sidebar-drop-target]'), null);
});

test.after(async () => { await dom.happyDOM.close(); });
