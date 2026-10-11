import assert from 'node:assert/strict';
import {after, test} from 'node:test';
import InstalledReact from 'react';
import {readFile} from 'node:fs/promises';
import {Window} from 'happy-dom';
import {build} from 'esbuild';

const browser = new Window({url: 'http://localhost/'});
globalThis.window = browser; globalThis.document = browser.document;
globalThis.HTMLElement = browser.HTMLElement; globalThis.Node = browser.Node;
// Default exercises the installed react-dom/client; an explicit second run
// also covers the exact React 18 production browser asset shipped by this app.
const productionRuntime = process.env.VENDITBOT_TEST_PRODUCTION_REACT === '1';
if (productionRuntime) browser.eval(await readFile(new URL('../frontend/venditbot/react.js', import.meta.url), 'utf8'));
const React = productionRuntime ? browser.React : InstalledReact;
browser.React = React;
const {createRoot} = productionRuntime ? browser.ReactDOM : await import('react-dom/client');
const {flushSync} = productionRuntime ? browser.ReactDOM : await import('react-dom');
const built = await build({entryPoints: [new URL('../frontend/venditbot/sidebar-layout.tsx', import.meta.url).pathname], bundle: true, platform: 'node', format: 'esm', jsx: 'transform', jsxFactory: 'React.createElement', write: false});
const {SidebarResizeHandle, useSidebarWidth, sidebarWidthKey} = await import(`data:text/javascript;base64,${Buffer.from(built.outputFiles[0].text).toString('base64')}`);
after(() => browser.happyDOM.abort());

function fixture(t, {initialWidth = 734, maximum = 960, persisted = false, captureThrows = false} = {}) {
  browser.localStorage.clear(); browser.innerWidth = 1600;
  const host = document.createElement('main'), outside = document.createElement('aside');
  document.body.append(host, outside);
  const changes = [], captures = [], releases = []; let current, limit = maximum, revision = 1;
  let mounted = true, activeCapture;
  const root = createRoot(host);
  function App() {
    const stored = useSidebarWidth(), [width, setWidth] = React.useState(initialWidth);
    current = persisted ? stored.width : width;
    const callbackRevision = revision;
    return React.createElement(SidebarResizeHandle, {width: current, maximum: limit, onChange(next) {
      changes.push({width: next, revision: callbackRevision});
      if (persisted) stored.change(next); else setWidth(next);
    }});
  }
  const render = () => flushSync(() => root.render(React.createElement(App)));
  render();
  const handle = host.querySelector('[role="separator"]');
  handle.setPointerCapture = id => {captures.push(id); if (captureThrows) throw new Error('capture unavailable'); activeCapture = id;};
  handle.hasPointerCapture = id => activeCapture === id;
  handle.releasePointerCapture = id => {releases.push(id); activeCapture = undefined;};
  const listeners = new Map(), originals = new Map();
  for (const target of [document, browser]) {
    const add = target.addEventListener, remove = target.removeEventListener;
    originals.set(target, {add, remove});
    target.addEventListener = function(type, callback, options) {
      if (['pointermove', 'pointerup', 'pointercancel', 'keydown', 'blur'].includes(type)) {
        let callbacks = listeners.get(type); if (!callbacks) listeners.set(type, callbacks = new Set()); callbacks.add(callback);
      }
      return add.call(this, type, callback, options);
    };
    target.removeEventListener = function(type, callback, options) {listeners.get(type)?.delete(callback); return remove.call(this, type, callback, options);};
  }
  const pointer = (target, type, x, options = {}) => {
    const event = new browser.PointerEvent(type, {bubbles: true, cancelable: true, composed: true, pointerId: 1, pointerType: 'mouse', isPrimary: true, button: 0, buttons: type === 'pointerup' ? 0 : 1, clientX: x, ...options});
    flushSync(() => target.dispatchEvent(event)); return event;
  };
  const key = key => flushSync(() => outside.dispatchEvent(new browser.KeyboardEvent('keydown', {key, bubbles: true, cancelable: true})));
  const unmount = () => {if (mounted) {flushSync(() => root.unmount()); mounted = false;}};
  const noListeners = () => assert.deepEqual([...listeners].filter(([, callbacks]) => callbacks.size).map(([type]) => type), []);
  t.after(() => {unmount(); noListeners(); for (const [target, methods] of originals) {target.addEventListener = methods.add; target.removeEventListener = methods.remove;} host.remove(); outside.remove();});
  return {handle, outside, pointer, key, changes, captures, releases, unmount, noListeners,
    get width() {return current;}, rerender(nextMaximum = limit) {limit = nextMaximum; revision++; render();},
    blur() {flushSync(() => browser.dispatchEvent(new browser.Event('blur')));},
  };
}

test('native events outside the resize handle retain the final drag coordinate and pointerup removes listeners', t => {
  const f = fixture(t);
  f.pointer(f.handle, 'pointerdown', 735);
  f.pointer(f.handle, 'pointermove', 628); assert.equal(f.width, 627);
  // Simulate Electron's capture loss without lostpointercapture/cancel delivery.
  f.pointer(f.outside, 'pointermove', 520); assert.equal(f.width, 519);
  f.pointer(f.outside, 'pointerup', 500); assert.equal(f.width, 499);
  assert.deepEqual(f.changes.map(change => change.width), [627, 519, 499]);
  assert.deepEqual(f.releases, [1]); f.noListeners();
  f.pointer(f.outside, 'pointermove', 900); assert.equal(f.width, 499);
});

test('document capture handles stopped bubbling, thrown setPointerCapture and pointerup without any final move', t => {
  const f = fixture(t, {captureThrows: true});
  f.outside.addEventListener('pointerup', event => event.stopPropagation());
  f.pointer(f.handle, 'pointerdown', 735);
  f.pointer(f.outside, 'pointerup', 520);
  assert.equal(f.width, 519); assert.deepEqual(f.captures, [1]); f.noListeners();
});

test('right button, non-primary pointer and other pointer events cannot start, replace or end the active drag', t => {
  const f = fixture(t);
  f.pointer(f.handle, 'pointerdown', 735, {button: 2, buttons: 2});
  f.pointer(f.outside, 'pointermove', 520); assert.equal(f.width, 734); f.noListeners();
  f.pointer(f.handle, 'pointerdown', 735, {pointerId: 2, isPrimary: false}); f.noListeners();
  f.pointer(f.handle, 'pointerdown', 735);
  f.pointer(f.handle, 'pointerdown', 800, {pointerId: 2});
  f.pointer(f.outside, 'pointermove', 950, {pointerId: 2});
  f.pointer(f.outside, 'pointerup', 950, {pointerId: 2});
  f.pointer(f.outside, 'pointercancel', 950, {pointerId: 2});
  assert.equal(f.width, 734); assert.deepEqual(f.captures, [1]);
  f.pointer(f.outside, 'pointermove', 600); assert.equal(f.width, 599);
  f.pointer(f.outside, 'pointerup', 600); f.noListeners();
});

for (const action of ['cancel', 'escape', 'blur', 'unmount']) {
  test(`active resize cleans up on ${action} without applying a later unrelated coordinate`, t => {
    const f = fixture(t); f.pointer(f.handle, 'pointerdown', 735); f.pointer(f.outside, 'pointermove', 600);
    if (action === 'cancel') f.pointer(f.outside, 'pointercancel', 300);
    if (action === 'escape') f.key('Escape');
    if (action === 'blur') f.blur();
    if (action === 'unmount') f.unmount();
    f.noListeners(); assert.deepEqual(f.releases, [1]);
    f.pointer(f.outside, 'pointermove', 900); f.pointer(f.outside, 'pointerup', 900);
    assert.equal(f.width, 599); assert.equal(f.changes.length, 1);
  });
}

test('native mouse move with buttons zero remains active until pointerup then ignores later movement', t => {
  const f = fixture(t); f.pointer(f.handle, 'pointerdown', 735, {buttons: 1});
  // Exact Electron/CUA event metadata observed during the native regression.
  f.pointer(f.outside, 'pointermove', 520, {button: -1, buttons: 0});
  assert.equal(f.width, 519); assert.deepEqual(f.releases, []);
  f.pointer(f.outside, 'pointerup', 500, {button: 0, buttons: 0});
  assert.equal(f.width, 499); f.noListeners(); assert.deepEqual(f.releases, [1]);
  f.pointer(f.outside, 'pointermove', 900, {button: -1, buttons: 0});
  f.pointer(f.outside, 'pointerup', 900); assert.equal(f.width, 499);
});

test('lost capture continues through the document fallback and subsequent drags install fresh listeners', t => {
  const f = fixture(t); f.pointer(f.handle, 'pointerdown', 735);
  f.pointer(f.handle, 'lostpointercapture', 735); f.pointer(f.outside, 'pointerup', 520);
  assert.equal(f.width, 519); f.noListeners();
  f.pointer(f.handle, 'pointerdown', 520); f.pointer(f.outside, 'pointerup', 560);
  assert.equal(f.width, 559); assert.equal(f.captures.length, 2); f.noListeners();
});

test('active document listeners use current callback and bounds after React rerenders', t => {
  const f = fixture(t); f.pointer(f.handle, 'pointerdown', 735); f.rerender(500);
  f.pointer(f.outside, 'pointermove', 900); assert.equal(f.width, 500);
  assert.equal(f.changes.at(-1).revision, 2);
  f.pointer(f.outside, 'pointerup', -100); assert.equal(f.width, 240); f.noListeners();
});

test('off-handle pointerup persists its final width through the real width hook', t => {
  const f = fixture(t, {persisted: true}); assert.equal(f.width, 280);
  f.pointer(f.handle, 'pointerdown', 280); f.pointer(f.outside, 'pointerup', 640);
  assert.equal(f.width, 640); assert.equal(browser.localStorage.getItem(sidebarWidthKey), '640'); f.noListeners();
});
