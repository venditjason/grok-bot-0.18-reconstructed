import assert from 'node:assert/strict';
import { after, test } from 'node:test';
import { readFile } from 'node:fs/promises';
import { Window } from 'happy-dom';
import { build } from 'esbuild';

// Exact shipped React, actual card DOM and pointer events. Hit testing is a
// deterministic port; grid pixel geometry remains part of native CUA QA.
const browser = new Window({ url: 'http://sidebar.test' });
globalThis.window = browser; globalThis.document = browser.document;
browser.eval(await readFile(new URL('../frontend/venditbot/react.js', import.meta.url), 'utf8'));
browser.VDS = {};
const React = browser.React, { createRoot, flushSync } = browser.ReactDOM, h = React.createElement;
const style = document.createElement('style'); style.textContent = await readFile(new URL('../frontend/venditbot/style.css', import.meta.url), 'utf8'); document.head.append(style);
const bundle = await build({ entryPoints: ['frontend/venditbot/sidebar-profiles.tsx', 'frontend/venditbot/sidebar-order.ts'], bundle: true, format: 'esm', platform: 'node', write: false, outdir: '/unused', jsx: 'transform', jsxFactory: 'React.createElement', jsxFragment: 'React.Fragment' });
const load = name => import(`data:text/javascript;base64,${Buffer.from(bundle.outputFiles.find(file => file.path.endsWith(`/${name}.js`)).text).toString('base64')}`);
const { AgentSidebarCards, TeamSidebarCards } = await load('sidebar-profiles'), { useSidebarOrder, sidebarOrderKey } = await load('sidebar-order');
const agents = ['a', 'b', 'c'].map(id => ({ id, name: `에이전트 ${id}`, instructions: 'role', connectionId: 'codex', model: 'fixture' }));
const teams = ['one', 'two', 'three'].map(id => ({ id, name: `협업 팀 ${id}`, leaderAgentId: 'a', memberAgentIds: ['a', 'b', 'c'] }));
after(() => browser.happyDOM.abort());
function fixture(t) {
  browser.localStorage.clear();
  const host = document.createElement('div'); document.body.append(host); const opened = [], menus = [], moved = [];
  let root, mounted = false;
  function App() {
    const order = useSidebarOrder(agents.map(a => a.id), teams.map(t => t.id));
    const props = kind => ({ avatarUrl: () => undefined, onOpen: id => opened.push([kind, id]), onMenu: id => menus.push([kind, id]), onReorder: (id, target) => { moved.push([kind, id, target]); order.reorder(kind === 'team' ? 'teams' : 'agents', id, target); } });
    return h('div', { className: 'sidebar-scroll' }, h(TeamSidebarCards, { ...props('team'), teams: order.teams.map(id => teams.find(t => t.id === id)), agents, onCreate() {} }), h(AgentSidebarCards, { ...props('agent'), agents: order.agents.map(id => agents.find(a => a.id === id)), teams }));
  }
  const mount = () => { root = createRoot(host); mounted = true; flushSync(() => root.render(h(App))); };
  const unmount = () => { if (mounted) { flushSync(() => root.unmount()); mounted = false; } };
  mount();
  const originalHit = document.elementFromPoint;
  t.after(() => { unmount(); host.remove(); document.elementFromPoint = originalHit; });
  const card = id => host.querySelector(`[data-sidebar-id="${id}"] button`);
  const pointer = (target, type, x, y, extra = {}) => { const event = new browser.PointerEvent(type, { bubbles: true, cancelable: true, pointerId: 9, isPrimary: true, button: 0, buttons: type === 'pointerup' ? 0 : 1, clientX: x, clientY: y, ...extra }); flushSync(() => target.dispatchEvent(event)); return event; };
  const mouse = (target, type, extra = {}) => { const event = new browser.MouseEvent(type, { bubbles: true, cancelable: true, detail: 1, ...extra }); flushSync(() => target.dispatchEvent(event)); return event; };
  const key = (target, key, extra = {}) => { const event = new browser.KeyboardEvent('keydown', { bubbles: true, cancelable: true, key, ...extra }); flushSync(() => target.dispatchEvent(event)); return event; };
  const ids = kind => [...host.querySelectorAll(`nav[data-sidebar-list="${kind}"] [data-sidebar-id]`)].map(node => node.dataset.sidebarId);
  return { host, card, pointer, mouse, key, ids, opened, menus, moved, unmount, remount() { unmount(); mount(); } };
}

test('whole-card uncaptured drags reorder both lists once, suppress chat/menu activation and survive remount', t => {
  const f = fixture(t);
  for (const [kind, sourceId, targetId, expected] of [['team', 'three', 'one', ['three', 'one', 'two']], ['agent', 'c', 'a', ['c', 'a', 'b']]]) {
    const source = f.card(sourceId), target = f.card(targetId).querySelector('span');
    source.setPointerCapture = () => {}; source.hasPointerCapture = () => false;
    document.elementFromPoint = () => target;
    f.pointer(source.querySelector('img'), 'pointerdown', 510, 480);
    f.pointer(target, 'pointermove', 305, 190); f.pointer(target, 'pointerup', 305, 190);
    f.pointer(source, 'pointerup', 305, 190); // duplicate React delivery
    f.mouse(source, 'click');
    assert.deepEqual(f.ids(kind), expected); assert.equal(f.moved.filter(value => value[0] === kind).length, 1);
    assert.deepEqual(f.opened, []); assert.deepEqual(f.menus, []);
    assert.equal(f.host.querySelector('[data-sidebar-dragging],[data-sidebar-drop-target]'), null);
  }
  assert.deepEqual(JSON.parse(browser.localStorage.getItem(sidebarOrderKey)), { teams: ['three', 'one', 'two'], agents: ['c', 'a', 'b'] });
  f.remount(); assert.deepEqual(f.ids('team'), ['three', 'one', 'two']); assert.deepEqual(f.ids('agent'), ['c', 'a', 'b']);
});

test('right-click and keyboard menu pin the card without starting a drag or opening chat; ordinary click opens chat', t => {
  const f = fixture(t);
  for (const [kind,id] of [['team','two'],['agent','b']]) {
    const card = f.card(id); document.elementFromPoint = () => f.card(kind === 'team' ? 'one' : 'a');
    f.pointer(card, 'pointerdown', 500, 400, { button: 2, buttons: 2 });
    const context = f.mouse(card, 'contextmenu', { button: 2 }); assert.equal(context.defaultPrevented, true);
    f.pointer(document.body, 'pointermove', 300, 150); f.pointer(document.body, 'pointerup', 300, 150, { button: 2 });
    f.mouse(card, 'click', { button: 2 });
    assert.equal(f.key(card, 'F10', { shiftKey: true }).defaultPrevented, true);
    assert.equal(f.key(card, 'ContextMenu').defaultPrevented, true);
    assert.deepEqual(f.menus.slice(-3), [[kind,id],[kind,id],[kind,id]]); assert.deepEqual(f.moved, []); assert.deepEqual(f.opened, []);
    const dragStart = new browser.Event('dragstart', { bubbles: true, cancelable: true }); card.querySelector('img').dispatchEvent(dragStart); assert.equal(dragStart.defaultPrevented, true);
  }
  const card = f.card('b'); f.pointer(card, 'pointerdown', 20, 20); f.pointer(card, 'pointerup', 23, 23); f.mouse(card, 'click');
  assert.deepEqual(f.opened, [['agent','b']]); assert.equal(f.host.querySelectorAll('button').length, 6); assert.equal(f.host.querySelector('.sidebar-drag-handle,.agent-menu-trigger'), null);
});

test('cross-list drops, pointer cancellation and opening a menu mid-drag never reorder or activate', t => {
  const f = fixture(t), source = f.card('three'); document.elementFromPoint = () => f.card('a');
  f.pointer(source, 'pointerdown', 500, 450); f.pointer(document.body, 'pointerup', 200, 150); f.mouse(source, 'click');
  assert.deepEqual(f.moved, []); assert.deepEqual(f.opened, []);
  document.elementFromPoint = () => f.card('one');
  f.pointer(source, 'pointerdown', 500, 450); f.pointer(document.body, 'pointermove', 200, 150); f.pointer(document.body, 'pointercancel', 200, 150); f.mouse(source, 'click');
  f.pointer(source, 'pointerdown', 500, 450); f.pointer(document.body, 'pointermove', 200, 150); f.key(source, 'F10', { shiftKey: true }); f.pointer(document.body, 'pointerup', 200, 150); f.mouse(source, 'click');
  assert.deepEqual(f.moved, []); assert.deepEqual(f.opened, []); assert.deepEqual(f.menus, [['team','three']]);
  assert.equal(f.host.querySelector('[data-sidebar-dragging],[data-sidebar-drop-target]'), null);
});

test('responsive team grid retains names, leader portrait and accessible small member portraits', t => {
  const f = fixture(t), nav = f.host.querySelector('.team-photo-list');
  assert.equal(browser.getComputedStyle(nav).display, 'grid');
  for (const team of teams) {
    const card = f.card(team.id); assert.equal(card.getAttribute('aria-haspopup'), 'menu'); assert.equal(card.querySelector('.team-photo-name').textContent, team.name);
    assert.equal(card.querySelector('.team-leader-name').textContent, '에이전트 a');
    assert.equal(card.querySelector('.team-leader-portrait img').getAttribute('alt'), '에이전트 a 프로필 사진');
    assert.deepEqual([...card.querySelectorAll('.team-member-portrait')].map(node => node.getAttribute('aria-label')), ['에이전트 b 팀원','에이전트 c 팀원']);
  }
});
