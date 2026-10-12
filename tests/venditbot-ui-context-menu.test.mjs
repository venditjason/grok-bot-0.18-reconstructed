import assert from 'node:assert/strict';
import { test, after } from 'node:test';
import { readFile } from 'node:fs/promises';
import { Window } from 'happy-dom';
import { build } from 'esbuild';

// Shipped React + actual card/menu events, with deterministic rectangle measurements.
const browser = new Window({ url: 'http://context-menu.test' });
globalThis.window = browser; globalThis.document = browser.document; globalThis.HTMLElement = browser.HTMLElement;
browser.eval(await readFile(new URL('../frontend/venditbot/react.js', import.meta.url), 'utf8'));
browser.VDS = {};
const { React, ReactDOM: { createRoot, flushSync } } = browser, h = React.createElement;
const built = await build({ entryPoints: ['frontend/venditbot/agent-menu.tsx', 'frontend/venditbot/sidebar-profiles.tsx', 'frontend/venditbot/context-menu-position.ts'], bundle: true, format: 'esm', platform: 'node', outdir: '/unused', write: false, jsx: 'transform', jsxFactory: 'React.createElement', jsxFragment: 'React.Fragment' });
const load = name => import(`data:text/javascript;base64,${Buffer.from(built.outputFiles.find(file => file.path.endsWith(`/${name}.js`)).text).toString('base64')}`);
const { AgentMenu } = await load('agent-menu'), { AgentSidebarCards, TeamSidebarCards } = await load('sidebar-profiles'), { contextMenuPosition } = await load('context-menu-position');
after(() => browser.happyDOM.abort());
const agent = { id: 'a', name: '김 개발', instructions: 'role', connectionId: 'codex', model: 'fixture' };
const team = { id: 't', name: '신제품 개발팀', leaderAgentId: 'a', memberAgentIds: ['a'] };
function fixture(t) {
  const host = document.createElement('div'); document.body.append(host); const calls = [], anchors = [];
  const rect = browser.HTMLElement.prototype.getBoundingClientRect;
  browser.HTMLElement.prototype.getBoundingClientRect = function () { return this.getAttribute('role') === 'menu' ? { width: 208, height: 266 } : { left: 32, bottom: 140, width: 88, height: 100 }; };
  function App() {
    const [menu, setMenu] = React.useState();
    const shared = kind => ({ avatarUrl() {}, onOpen: id => calls.push(['chat', id]), onMenu: (id, anchor) => { anchors.push(anchor); setMenu({ kind, id, anchor }); } });
    return h('div', {}, h(AgentSidebarCards, { agents: [agent], ...shared('agent') }), h(TeamSidebarCards, { teams: [team], agents: [agent], onCreate() {}, ...shared('team') }), h('button', { id: 'outside', onClick: () => calls.push(['outside']) }, '다른 작업'), h(AgentMenu, { agent: menu?.kind === 'agent' ? agent : menu?.kind === 'team' ? team : undefined, kind: menu?.kind === 'team' ? '팀' : '에이전트', anchor: menu?.anchor, canMoveDown: true, onClose: () => setMenu(undefined), onClone: () => calls.push(['clone', menu.id]), onOpen: () => calls.push(['open', menu.id]), onEdit: () => calls.push(['edit', menu.id]), onDelete: () => calls.push(['delete', menu.id]), onMove: offset => calls.push(['move', menu.id, offset]) }));
  }
  const root = createRoot(host); flushSync(() => root.render(h(App)));
  const fire = (element, event) => { flushSync(() => element.dispatchEvent(event)); return event; };
  const mouse = (element, type, props = {}) => fire(element, new browser.MouseEvent(type, { bubbles: true, cancelable: true, ...props }));
  const key = (element, key, props = {}) => fire(element, new browser.KeyboardEvent('keydown', { bubbles: true, cancelable: true, key, ...props }));
  const card = kind => host.querySelector(`[data-sidebar-kind="${kind}"] button`);
  const popup = () => host.querySelector('[role="menu"]');
  t.after(() => { flushSync(() => root.unmount()); host.remove(); browser.HTMLElement.prototype.getBoundingClientRect = rect; });
  return { host, calls, anchors, card, popup, mouse, key, fire };
}

test('both profile menus use exact pointer position with no dialog/backdrop and execute each chosen action once', t => {
  const f = fixture(t);
  for (const kind of ['agent', 'team']) {
    for (const [label, action] of [['대화 열기', 'open'], [kind === 'team' ? '팀 수정' : '에이전트 수정', 'edit'], [kind === 'team' ? '팀 복제' : '에이전트 복제', 'clone'], ['목록에서 뒤로', 'move'], [kind === 'team' ? '팀 삭제' : '에이전트 삭제', 'delete']]) {
      const card = f.card(kind); f.mouse(card, 'contextmenu', { button: 2, clientX: 210, clientY: 180 });
      const menu = f.popup(); assert.ok(menu); assert.equal(menu.style.left, '210px'); assert.equal(menu.style.top, '180px');
      assert.equal(f.host.querySelector('[role="dialog"],[aria-modal="true"],[data-slot="dialog-overlay"]'), null);
      assert.equal(card.getAttribute('aria-haspopup'), 'menu');
      const item = [...menu.querySelectorAll('[role="menuitem"]')].find(item => item.textContent === label);
      const before = f.calls.length; f.mouse(item, 'click'); assert.equal(f.calls.length, before + 1); assert.equal(f.calls.at(-1)[0], action); assert.equal(f.calls.at(-1)[1], kind === 'team' ? 't' : 'a'); assert.equal(f.popup(), null);
    }
  }
});

test('keyboard anchoring, enabled-item navigation and Escape restore focus without trapping the page', t => {
  const f = fixture(t), card = f.card('team'); card.focus(); f.key(card, 'F10', { shiftKey: true });
  assert.equal(f.popup().style.left, '56px'); assert.equal(f.popup().style.top, '140px');
  assert.equal(document.activeElement.textContent, '대화 열기');
  f.key(document.activeElement, 'End'); assert.equal(document.activeElement.textContent, '팀 삭제');
  f.key(document.activeElement, 'ArrowUp'); assert.equal(document.activeElement.textContent, '목록에서 뒤로');
  f.key(document.activeElement, 'ArrowUp'); assert.equal(document.activeElement.textContent, '팀 복제');
  f.key(document.activeElement, 'Home'); assert.equal(document.activeElement.textContent, '대화 열기');
  f.key(document.activeElement, 'Escape'); assert.equal(f.popup(), null); assert.equal(document.activeElement, card); assert.deepEqual(f.calls, []);
  f.key(card, 'ContextMenu'); const tab = f.key(document.activeElement, 'Tab'); assert.equal(tab.defaultPrevented, false); assert.equal(f.popup(), null);
});

test('outside click passes through, second right-click retargets, and scrolling/resizing/window blur dismiss safely', t => {
  const f = fixture(t), open = () => f.mouse(f.card('agent'), 'contextmenu', { button: 2, clientX: 300, clientY: 220 });
  open(); const outside = f.host.querySelector('#outside'); f.fire(outside, new browser.PointerEvent('pointerdown', { bubbles: true })); f.mouse(outside, 'click'); assert.equal(f.popup(), null); assert.deepEqual(f.calls, [['outside']]);
  open(); f.mouse(f.card('team'), 'contextmenu', { button: 2, clientX: 320, clientY: 230 }); assert.equal(f.host.querySelectorAll('[role="menu"]').length, 1); assert.equal(f.popup().getAttribute('aria-label'), '신제품 개발팀 메뉴'); assert.equal(f.popup().style.left, '320px');
  f.fire(f.popup(), new browser.Event('scroll')); assert.ok(f.popup());
  f.fire(f.host, new browser.Event('scroll')); assert.equal(f.popup(), null);
  for (const event of ['resize', 'blur']) { open(); f.fire(browser, new browser.Event(event)); assert.equal(f.popup(), null); }
});

test('all viewport corners and an oversized menu remain clamped; bottom/right menus flip next to the pointer', () => {
  const size = { width: 208, height: 266 }, viewport = { width: 800, height: 600 };
  for (const x of [0, 50, 795, 900]) for (const y of [0, 40, 595, 700]) { const p = contextMenuPosition({ x, y }, size, viewport); assert.ok(p.left >= 8 && p.left + size.width <= 792); assert.ok(p.top >= 8 && p.top + size.height <= 592); }
  assert.deepEqual(contextMenuPosition({ x: 795, y: 595 }, size, viewport), { left: 584, top: 326 });
  assert.deepEqual(contextMenuPosition({ x: NaN, y: Infinity }, { width: 900, height: 900 }, viewport), { left: 8, top: 8 });
});
