import assert from 'node:assert/strict';
import test from 'node:test';
import { build } from 'esbuild';
const built = await build({entryPoints: ['frontend/venditbot/sidebar-pointer-drag.ts'], bundle: true, platform: 'node', format: 'esm', write: false});
const { SidebarPointerDrag, sidebarDragThreshold } = await import(`data:text/javascript;base64,${Buffer.from(built.outputFiles[0].text).toString('base64')}`);

// Real controller methods, with a small DOM port for capture, ancestry and
// coordinate hit testing. This is deterministic logic coverage, not native UI QA.
class Events extends EventTarget {
  listeners = new Map();
  addEventListener(type, listener) {super.addEventListener(type, listener); const listeners = this.listeners.get(type) ?? new Set(); listeners.add(listener); this.listeners.set(type, listeners);}
  removeEventListener(type, listener) {super.removeEventListener(type, listener); this.listeners.get(type)?.delete(listener);}
  count() {return [...this.listeners.values()].reduce((count, values) => count + values.size, 0);}
}
class Element {
  attrs = new Map(); isConnected = true; captured = new Set();
  constructor(doc, parent, attrs = {}) {this.ownerDocument = doc; this.parent = parent; for (const [key, value] of Object.entries(attrs)) this.attrs.set(key, value);}
  getAttribute(key) {return this.attrs.get(key) ?? null;}
  setAttribute(key, value) {this.attrs.set(key, value);}
  removeAttribute(key) {this.attrs.delete(key);}
  closest(selector) {for (let node = this; node; node = node.parent) if (selector === 'nav[data-sidebar-list]' ? node.attrs.has('data-sidebar-list') : node.attrs.has('data-sidebar-id') && node.attrs.has('data-sidebar-kind')) return node; return null;}
  setPointerCapture(id) {if (this.captureFails) throw new Error('pointer already ended'); this.captured.add(id);}
  hasPointerCapture(id) {return this.captured.has(id);}
  releasePointerCapture(id) {this.captured.delete(id); this.onRelease?.(id);}
  focus() {this.focused = true;}
}
function fixture(kind = 'agent') {
  const doc = new Events(); doc.defaultView = new Events(); doc.hit = null; doc.points = []; doc.elementFromPoint = (x, y) => {doc.points.push([x, y]); return doc.hit;};
  const list = new Element(doc, null, {'data-sidebar-list': kind});
  const card = (id, parent = list, cardKind = kind) => new Element(doc, parent, {'data-sidebar-id': id, 'data-sidebar-kind': cardKind});
  const source = card('a'), target = card('b'), third = card('c'), handle = new Element(doc, source), image = new Element(doc, target);
  const moves = [], menus = [], options = {kind, id: 'a', itemIds: ['a', 'b', 'c'], onReorder: (id, to) => moves.push([id, to]), onMenu: id => menus.push(id)};
  const controller = new SidebarPointerDrag(() => options);
  const pointer = (x = 10, y = 20, extra = {}) => ({pointerId: 7, clientX: x, clientY: y, button: 0, isPrimary: true, prevented: 0, preventDefault() {this.prevented++;}, ...extra});
  const click = (detail = 1) => ({detail, prevented: 0, stopped: 0, preventDefault() {this.prevented++;}, stopPropagation() {this.stopped++;}});
  const start = () => controller.pointerDown(pointer(), handle);
  const checkClean = () => {assert.equal(doc.count(), 0); assert.equal(doc.defaultView.count(), 0); assert.equal(handle.captured.size, 0); for (const element of [source, target, third, list]) {assert.equal(element.getAttribute('data-sidebar-dragging'), null); assert.equal(element.getAttribute('data-sidebar-drop-target'), null);}};
  return {doc, list, card, source, target, third, handle, image, moves, menus, options, controller, pointer, click, start, checkClean};
}

test('mouse, touch and pen drags capture the pointer and reorder by release coordinates in either list', () => {
  for (const kind of ['agent', 'team']) for (const pointerType of ['mouse', 'touch', 'pen']) {
    const f = fixture(kind); f.controller.pointerDown(f.pointer(10, 20, {pointerType}), f.handle); assert.equal(f.handle.focused, true); assert.equal(f.handle.hasPointerCapture(7), true);
    f.doc.hit = f.image; f.controller.pointerMove(f.pointer(50, 70, {pointerType})); assert.equal(f.target.getAttribute('data-sidebar-drop-target'), 'true'); assert.equal(f.source.getAttribute('data-sidebar-dragging'), 'true');
    // Captured pointer events still target the handle, not the card under it.
    f.handle.onRelease = pointerId => f.controller.lostPointerCapture({pointerId});
    f.controller.pointerUp(f.pointer(80, 90, {pointerType, target: f.handle})); assert.deepEqual(f.moves, [['a', 'b']]); assert.deepEqual(f.doc.points.at(-1), [80, 90]); f.checkClean();
    const click = f.click(); f.controller.click(click); assert.equal(click.prevented, 1); assert.equal(click.stopped, 1); assert.deepEqual(f.menus, []);
  }
});

test('less than 6px remains a normal menu click; threshold drag and missing move events still reorder', () => {
  assert.equal(sidebarDragThreshold, 6); const f = fixture(); f.start(); f.doc.hit = f.image;
  f.controller.pointerUp(f.pointer(13, 24)); f.controller.click(f.click()); assert.deepEqual(f.moves, []); assert.deepEqual(f.menus, ['a']); f.checkClean();
  f.start(); f.controller.pointerUp(f.pointer(16, 20)); assert.deepEqual(f.moves, [['a', 'b']]); f.controller.click(f.click()); assert.equal(f.menus.length, 1);
  f.start(); f.controller.pointerUp(f.pointer()); f.controller.click(f.click()); assert.equal(f.menus.length, 2, 'the next ordinary gesture must not retain suppression'); f.checkClean();
});

test('pointerup re-hit-tests after target changes and does not reorder to the last highlighted card', () => {
  const f = fixture(); f.start(); f.doc.hit = f.image; f.controller.pointerMove(f.pointer(50, 60)); assert.equal(f.target.getAttribute('data-sidebar-drop-target'), 'true');
  f.doc.hit = new Element(f.doc, f.third); f.controller.pointerUp(f.pointer(70, 80)); assert.deepEqual(f.moves, [['a', 'c']]); f.checkClean();
});

test('invalid, cross-kind, cross-list, missing, removed and self targets never reorder or open a drag menu', () => {
  for (const kind of ['blank', 'self', 'cross kind', 'cross list', 'unknown id', 'deleted target', 'removed id', 'detached source', 'changed source id', 'invalid coordinates']) {
    const f = fixture(); f.start(); f.doc.hit = f.image; f.controller.pointerMove(f.pointer(50, 60));
    if (kind === 'blank') f.doc.hit = f.list;
    if (kind === 'self') f.doc.hit = f.handle;
    if (kind === 'cross kind') f.doc.hit = f.card('b', f.list, 'team');
    if (kind === 'cross list') f.doc.hit = f.card('b', new Element(f.doc, null, {'data-sidebar-list': 'agent'}));
    if (kind === 'unknown id') f.doc.hit = f.card('not-in-items');
    if (kind === 'deleted target') f.target.isConnected = false;
    if (kind === 'removed id') f.options.itemIds = ['a', 'c'];
    if (kind === 'detached source') f.handle.isConnected = false;
    if (kind === 'changed source id') f.source.setAttribute('data-sidebar-id', 'new-source');
    f.controller.pointerUp(f.pointer(kind === 'invalid coordinates' ? NaN : 80, 90));
    assert.deepEqual(f.moves, [], kind); const click = f.click(); f.controller.click(click); assert.equal(click.prevented, 1, kind); assert.deepEqual(f.menus, [], kind); f.checkClean();
  }
});

test('other pointer IDs cannot move, release or cancel the active pointer', () => {
  const f = fixture(); f.start(); f.doc.hit = f.image;
  f.controller.pointerDown(f.pointer(90, 90, {pointerId: 8}), f.handle); f.controller.pointerMove(f.pointer(90, 90, {pointerId: 8})); f.controller.pointerUp(f.pointer(90, 90, {pointerId: 8})); f.controller.pointerCancel({pointerId: 8}); f.controller.lostPointerCapture({pointerId: 8});
  assert.equal(f.doc.points.length, 0); assert.equal(f.handle.hasPointerCapture(7), true); assert.equal(f.handle.hasPointerCapture(8), false);
  f.controller.pointerUp(f.pointer(80, 90)); assert.deepEqual(f.moves, [['a', 'b']]); f.checkClean();
});

test('pointer cancellation, lost capture, Escape, window blur and unmount clear capture and indicators', () => {
  for (const method of ['cancel', 'lost capture', 'escape', 'blur', 'unmount']) {
    const f = fixture(); f.start(); f.doc.hit = f.image; f.controller.pointerMove(f.pointer(50, 60));
    if (method === 'cancel') f.controller.pointerCancel({pointerId: 7});
    if (method === 'lost capture') f.controller.lostPointerCapture({pointerId: 7});
    if (method === 'escape') {const event = new Event('keydown', {cancelable: true}); Object.defineProperty(event, 'key', {value: 'Escape'}); f.doc.dispatchEvent(event); assert.equal(event.defaultPrevented, true);}
    if (method === 'blur') f.doc.defaultView.dispatchEvent(new Event('blur'));
    if (method === 'unmount') f.controller.destroy();
    f.controller.pointerUp(f.pointer(80, 90)); assert.deepEqual(f.moves, [], method); f.checkClean();
    if (method !== 'unmount') {f.controller.click(f.click()); assert.deepEqual(f.menus, [], method);}
  }
});

test('right buttons, nonprimary pointers and unavailable reorder remain non-drag interactions', () => {
  for (const mode of ['right button', 'nonprimary', 'no reorder']) {
    const f = fixture(); if (mode === 'no reorder') f.options.onReorder = undefined;
    f.controller.pointerDown(f.pointer(10, 20, {button: mode === 'right button' ? 2 : 0, isPrimary: mode !== 'nonprimary'}), f.handle); f.doc.hit = f.image; f.controller.pointerUp(f.pointer(90, 90)); assert.deepEqual(f.moves, []); f.checkClean();
  }
  const f = fixture(); f.start(); f.doc.hit = null; f.controller.pointerUp(f.pointer(90, 90)); f.controller.click(f.click(0)); assert.deepEqual(f.menus, ['a'], 'keyboard activation remains available after a cancelled drop');
});

function dispatchPointer(f, type, x, y, pointerId = 7) {
  const event = new Event(type, {cancelable: true}); Object.assign(event, {pointerId, clientX: x, clientY: y}); f.doc.dispatchEvent(event); return event;
}

test('document fallback handles missing or failed capture and a duplicate React release commits once', () => {
  for (const mode of ['capture absent', 'capture throws']) {
    const f = fixture(); f.handle.setPointerCapture = () => {if (mode === 'capture throws') throw new Error('capture unavailable');};
    f.start(); f.doc.hit = f.image;
    const move = dispatchPointer(f, 'pointermove', 50, 60); assert.equal(move.defaultPrevented, true); assert.equal(f.target.getAttribute('data-sidebar-drop-target'), 'true');
    dispatchPointer(f, 'pointerup', 80, 90); f.controller.pointerUp(f.pointer(80, 90));
    assert.deepEqual(f.moves, [['a', 'b']], mode); f.checkClean();
  }
});

test('document fallback rejects other pointers and invalid targets and cleans up after matching cancellation', () => {
  const f = fixture(); f.start(); f.doc.hit = f.image;
  dispatchPointer(f, 'pointermove', 50, 60, 99); dispatchPointer(f, 'pointerup', 80, 90, 99); dispatchPointer(f, 'pointercancel', 80, 90, 99);
  assert.equal(f.doc.points.length, 0); assert.equal(f.handle.hasPointerCapture(7), true);
  dispatchPointer(f, 'pointermove', 50, 60); dispatchPointer(f, 'pointercancel', 50, 60); dispatchPointer(f, 'pointerup', 80, 90);
  assert.deepEqual(f.moves, []); f.checkClean();
  f.start(); f.doc.hit = f.card('b', new Element(f.doc, null, {'data-sidebar-list': 'agent'}));
  dispatchPointer(f, 'pointerup', 80, 90); assert.deepEqual(f.moves, []); f.checkClean();
});

test('one list has at most one captured reorder owner and releases the lock after cancellation', () => {
  const f = fixture(), second = new SidebarPointerDrag(() => ({...f.options, id: 'b'})), handle = new Element(f.doc, f.target);
  f.start(); second.pointerDown(f.pointer(10, 20, {pointerId: 8}), handle); assert.equal(handle.captured.size, 0);
  f.controller.cancel(); f.checkClean(); second.pointerDown(f.pointer(10, 20, {pointerId: 8}), handle); assert.equal(handle.hasPointerCapture(8), true); second.destroy(); assert.equal(handle.captured.size, 0); assert.equal(f.doc.count(), 0);
});
