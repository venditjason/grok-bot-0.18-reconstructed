import assert from 'node:assert/strict';
import test from 'node:test';
import React from 'react';
import { build } from 'esbuild';
let slots = [], cursor = 0, resize;
const storage = new Map();
globalThis.window = { innerWidth: 1440, React: { ...React, useRef(initial) { const at = cursor++; return slots[at] ??= { current: initial }; }, useState(initial) { const at = cursor++; if (!(at in slots)) slots[at] = typeof initial === 'function' ? initial() : initial; return [slots[at], value => { slots[at] = value; }]; }, useEffect(callback) { const at = cursor++; if (!(at in slots)) slots[at] = { cleanup: callback() }; } }, addEventListener: (type, callback) => { if (type === 'resize') resize = callback; }, removeEventListener() {}, localStorage: { getItem: key => storage.get(key) ?? null, setItem: (key, value) => storage.set(key, value) } };
const built = await build({ entryPoints: [new URL('../frontend/venditbot/sidebar-layout.tsx', import.meta.url).pathname], bundle: true, format: 'esm', platform: 'node', jsx: 'transform', jsxFactory: 'React.createElement', write: false });
const { sidebarWidthKey, sidebarLimit, clampSidebarWidth, readSidebarWidth, useSidebarWidth, SidebarResizeHandle } = await import(`data:text/javascript;base64,${Buffer.from(built.outputFiles[0].text).toString('base64')}`);
const orderBuilt = await build({ entryPoints: [new URL('../frontend/venditbot/sidebar-order.ts', import.meta.url).pathname], bundle: true, format: 'esm', platform: 'node', write: false });
const { sidebarOrderKey, reconcileSidebarOrder, reorderSidebarItem, useSidebarOrder } = await import(`data:text/javascript;base64,${Buffer.from(orderBuilt.outputFiles[0].text).toString('base64')}`);
function reset() { slots = []; cursor = 0; storage.clear(); window.innerWidth = 1440; }

test('sidebar bounds keep a 480px main area and support wide layouts up to 960px', () => {
  assert.equal(sidebarLimit(1440), 954); assert.equal(sidebarLimit(2560), 960); assert.equal(sidebarLimit(980), 494);
  assert.equal(clampSidebarWidth(-100, 1440), 240); assert.equal(clampSidebarWidth(9999, 980), 494); assert.equal(clampSidebarWidth(NaN, 1440), 280);
  assert.equal(readSidebarWidth({ getItem: () => 'malformed' }), 280); assert.equal(readSidebarWidth({ getItem() { throw new Error('unavailable'); } }), 280);
});

test('sidebar width persists immediately per renderer profile and temporary window shrink keeps the preferred width', () => {
  reset(); const render = () => { cursor = 0; return useSidebarWidth(); }; let layout = render(); layout.change(850);
  assert.equal(storage.get(sidebarWidthKey), '850'); assert.equal(render().width, 850);
  window.innerWidth = 980; resize(); assert.equal(render().width, 494); assert.equal(storage.get(sidebarWidthKey), '850');
  window.innerWidth = 1440; resize(); assert.equal(render().width, 850);
  slots = []; assert.equal(render().width, 850);
  const normalStorage = window.localStorage; window.localStorage = { ...normalStorage, setItem() { throw new Error('quota'); } };
  layout = render(); layout.change(700); assert.equal(render().width, 700); assert.match(render().error, /보관하지 못했습니다/); window.localStorage = normalStorage;
});

test('sidebar separator supports keyboard bounds and pointer capture without cross-pointer resizing', () => {
  reset(); let width = 400, captured, focused = false, prevented = 0;
  const render = () => { cursor = 0; return SidebarResizeHandle({ width, maximum: 954, onChange: value => { width = value; } }); };
  const key = (key, shiftKey = false) => render().props.onKeyDown({ key, shiftKey, preventDefault() { prevented++; } });
  key('ArrowRight'); assert.equal(width, 410); key('ArrowLeft', true); assert.equal(width, 370); key('Home'); assert.equal(width, 240); key('End'); assert.equal(width, 954); key('ArrowRight'); assert.equal(width, 954); key('Enter'); assert.equal(prevented, 5);
  width = 400; const target = { focus() { focused = true; }, setPointerCapture(id) { captured = id; }, hasPointerCapture(id) { return captured === id; }, releasePointerCapture() { captured = undefined; } };
  const pointer = (id, x) => ({ pointerId: id, clientX: x, button: 0, currentTarget: target, preventDefault() {} });
  let handle = render(); assert.equal(handle.props.role, 'separator'); assert.equal(handle.props['aria-orientation'], 'vertical'); assert.equal(handle.props.tabIndex, 0);
  handle.props.onPointerDown(pointer(1, 400)); assert.equal(focused, true); assert.equal(captured, 1);
  handle.props.onPointerMove(pointer(2, 800)); assert.equal(width, 400); handle.props.onPointerMove(pointer(1, 700)); assert.equal(width, 700);
  handle.props.onPointerCancel(pointer(1, 700)); assert.equal(captured, undefined); handle.props.onPointerMove(pointer(1, 900)); assert.equal(width, 700);
});

test('sidebar orders survive remounts, retain renames, drop deleted IDs and append new agents without crossing team lists', () => {
  assert.deepEqual(reconcileSidebarOrder(['gone', 'c', 'c', 'a'], ['a', 'b', 'c', 'new']), ['c', 'a', 'b', 'new']);
  assert.deepEqual(reorderSidebarItem(['a', 'b', 'c'], 'a', 'c'), ['b', 'c', 'a']);
  assert.deepEqual(reorderSidebarItem(['a', 'b', 'c'], 'c', 'a'), ['c', 'a', 'b']);
  reset(); let agents = ['a', 'b', 'c'], teams = ['x', 'y']; const render = () => { cursor = 0; return useSidebarOrder(agents, teams); };
  render().reorder('agents', 'c', 'a'); render().move('teams', 'y', -1);
  assert.deepEqual(JSON.parse(storage.get(sidebarOrderKey)), { agents: ['c', 'a', 'b'], teams: ['y', 'x'] });
  slots = []; assert.deepEqual(render().agents, ['c', 'a', 'b']); assert.deepEqual(render().teams, ['y', 'x']);
  agents = ['new', 'b', 'c']; assert.deepEqual(render().agents, ['c', 'b', 'new']);
  render().reorder('agents', 'x', 'b'); assert.deepEqual(render().agents, ['c', 'b', 'new']); assert.deepEqual(render().teams, ['y', 'x']);
});
