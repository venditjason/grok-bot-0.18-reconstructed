import assert from 'node:assert/strict';
import test from 'node:test';
import React from 'react';
import { build } from 'esbuild';
import { setImmediate as tick } from 'node:timers/promises';

// Exercise App's real subscription, refresh and effect ordering with a virtual paint clock.
let slots = [], cursor = 0, effects = [], invoke, listener, timerId = 0;
const timers = new Map();
globalThis.__uiSetTimeout = callback => { const id = ++timerId; timers.set(id, callback); return id; };
globalThis.__uiClearTimeout = id => timers.delete(id);
const hooks = {
  ...React,
  useState(initial) { const index = cursor++; if (!(index in slots)) slots[index] = typeof initial === 'function' ? initial() : initial; return [slots[index], value => { slots[index] = typeof value === 'function' ? value(slots[index]) : value; }]; },
  useRef(initial) { const index = cursor++; if (!(index in slots)) slots[index] = { current: initial }; return slots[index]; },
  useEffect(callback, deps) { const index = cursor++, previous = slots[index]; if (!previous || !deps || deps.some((value, at) => !Object.is(value, previous.deps?.[at]))) effects.push(() => { previous?.cleanup?.(); slots[index] = { deps, cleanup: callback() }; }); },
};
const passthrough = ({ children }) => children;
globalThis.window = { React: hooks, ReactDOM: { createRoot: () => ({ render() {} }) }, VDS: { VDSProvider: passthrough, Button: passthrough, Icon: passthrough, Badge: passthrough, TextInput: passthrough, TextArea: passthrough, Checkbox: passthrough, Dialog: { Root: passthrough, Portal: passthrough, Content: passthrough, Header: passthrough, Footer: passthrough } }, venditbot: { invoke: (...args) => invoke(...args), onEvent: callback => { listener = callback; return () => { listener = undefined; }; } } };
globalThis.document = { getElementById: () => ({}) };
const built = await build({ entryPoints: [new URL('../frontend/venditbot/app.tsx', import.meta.url).pathname], bundle: true, platform: 'node', format: 'esm', jsx: 'transform', jsxFactory: 'React.createElement', jsxFragment: 'React.Fragment', write: false, define: { setTimeout: 'globalThis.__uiSetTimeout', clearTimeout: 'globalThis.__uiClearTimeout' } });
const { App } = await import(`data:text/javascript;base64,${Buffer.from(built.outputFiles[0].text).toString('base64')}`);
const elements = node => Array.isArray(node) ? node.flatMap(elements) : React.isValidElement(node) ? [node, ...elements(node.props.children)] : [];
const component = (tree, name) => elements(tree).find(node => node.type?.name === name);
const assistantText = tree => elements(tree).find(node => node.type?.type?.name === 'MarkdownContent')?.props.text ?? '';
const snapshot = (text = '', status = 'running') => ({ version: 'fixture', profiles: [], agents: [], teams: [], teamRuns: [], sessions: [{ id: 'live', title: '실시간 대화', connectionId: 'api', model: 'fixture', createdAt: '2026-01-01', updatedAt: '2026-01-01', messages: [{ id: 'answer', role: 'assistant', text, status }] }], activeRun: status === 'running' ? { sessionId: 'live' } : null, queue: { running: status === 'running' ? ['live'] : [], queued: [] }, update: { phase: 'idle', currentVersion: 'fixture' } });
async function fixture(t, initialState = snapshot(), stored = []) {
  slots = []; cursor = 0; effects = []; timers.clear(); listener = undefined;
  const storage = new Map(stored); window.localStorage = { getItem: key => storage.get(key) ?? null, setItem: (key, value) => storage.set(key, value) };
  let read = async () => initialState;
  invoke = async (method, args) => method === 'state' ? read() : method === 'authStatus' ? {} : method === 'getAgentAvatar' ? { id: args.id, dataUrl: 'data:image/png;base64,recovered', kind: 'image', createdAt: '2026-01-01' } : {};
  const render = () => { cursor = 0; const tree = App({ initialState, initialSessionId: 'live' }); const pending = effects; effects = []; pending.forEach(effect => effect()); return tree; };
  t.after(() => { for (const slot of slots) slot?.cleanup?.(); assert.equal(timers.size, 0); });
  render(); await tick(); render(); assert.equal(typeof listener, 'function');
  return { render, storage, read: callback => { read = callback; }, delta: text => listener({ type: 'delta', sessionId: 'live', messageId: 'answer', delta: text }), event: event => listener(event), refresh: () => component(render(), 'UpdateControl').props.onCheck(), paint: () => { const pending = [...timers.values()]; timers.clear(); pending.forEach(callback => callback()); } };
}

test('App flushes queued stream deltas before accepting a live refresh snapshot', async t => {
  const app = await fixture(t);
  app.delta('첫 '); app.delta('응답'); assert.equal(timers.size, 1); assert.equal(assistantText(app.render()), '');
  app.read(async () => snapshot('첫 응답')); app.refresh(); await tick();
  assert.equal(assistantText(app.render()), '첫 응답');
  app.paint(); assert.equal(assistantText(app.render()), '첫 응답', 'the pending paint must not append text already included by the host snapshot');
  assert.equal(timers.size, 0);
});

test('App rejects a snapshot when a new delta arrives while the refresh is in flight', async t => {
  const app = await fixture(t); let finish;
  app.delta('기존 '); app.read(() => new Promise(resolve => { finish = resolve; })); app.refresh(); await tick();
  assert.equal(assistantText(app.render()), '기존 ', 'pre-refresh buffered text is applied before the request');
  app.delta('새 조각'); finish(snapshot('기존 새 조각')); await tick(); app.paint();
  assert.equal(assistantText(app.render()), '기존 새 조각'); assert.equal(timers.size, 0);
});

test('App preserves terminal ordering and ignores late deltas after cancellation during refresh', async t => {
  const app = await fixture(t); let finish;
  app.delta('보존할 답변'); app.read(() => new Promise(resolve => { finish = resolve; })); app.refresh(); await tick();
  app.event({ type: 'session', session: snapshot('보존할 답변', 'cancelled').sessions[0] });
  app.event({ type: 'queue', running: [], queued: [] }); app.event({ type: 'run-end', sessionId: 'live', error: '취소됨' });
  app.delta('늦은 조각'); finish(snapshot('오래된 답변')); await tick(); app.paint();
  const tree = app.render(); assert.equal(assistantText(tree), '보존할 답변'); assert.equal(component(tree, 'UpdateControl').props.working, false); assert.equal(timers.size, 0);
});

test('App restores only the matching completed avatar request after renderer restart and respects later removal', async t => {
  const draft = { draft: { name: '복원할 에이전트', instructions: '역할', connectionId: 'api', model: 'fixture', avatarId: 'old-image' }, avatarPrompt: '파란 이미지', avatarOwnerKey: 'draft:owner', avatarRequestId: 'request' };
  const state = { ...snapshot(), avatarJobs: [{ requestId: 'unrelated', ownerKey: 'agent:another', phase: 'completed', assetId: 'wrong-image' }, { requestId: 'request', ownerKey: 'draft:owner', phase: 'completed', assetId: 'new-image' }] };
  const app = await fixture(t, state, [['venditbot.drafts.v1.agent-edits', JSON.stringify({ new: draft })]]);
  let stored = JSON.parse(app.storage.get('venditbot.drafts.v1.agent-edits')); assert.equal(stored.new.draft.avatarId, 'new-image'); assert.equal(stored.new.avatarAppliedRequestId, 'request');
  let tree = app.render(); const draftButton = elements(tree).find(node => node.props.onPress && node.props.children === '초안 보기'); draftButton.props.onPress(); tree = app.render(); component(tree, 'DraftRecovery').props.onAgent('new'); tree = app.render(); component(tree, 'AgentAvatarEditor').props.onRemove();
  app.event({ type: 'avatar-job', job: state.avatarJobs[1] }); app.render(); stored = JSON.parse(app.storage.get('venditbot.drafts.v1.agent-edits')); assert.equal(stored.new.draft.avatarId, '', 'a repeated completion event must not undo explicit removal');
});

test('clone success exposes an early optional image failure only on its own saved editor', async t => {
  const agent = { id: 'original', name: '원본', instructions: '복사할 역할', connectionId: 'api', model: 'fixture', avatarId: 'original-image', createdAt: '2026-01-01', updatedAt: '2026-01-01' };
  const copy = { ...agent, id: 'copy', name: '원본의 복제본' }, state = { ...snapshot('', 'completed'), agents: [agent] };
  const app = await fixture(t, state), previousInvoke = invoke;
  invoke = async (method, args) => {
    if (method !== 'cloneAgent') return previousInvoke(method, args);
    assert.equal(args.id, agent.id);
    app.event({ type: 'avatar-job', job: { requestId: 'rejected-image', ownerKey: 'agent:copy', phase: 'failed', error: '복제본과 원본 사진은 저장했습니다. 사진 변형 대기열이 가득 찼습니다.' } });
    return { state: { ...state, agents: [copy, agent] }, agent: copy, avatarRequestId: 'rejected-image' };
  };
  let tree = app.render(); component(tree, 'AgentSidebarCards').props.onMenu(agent.id); tree = app.render(); component(tree, 'AgentMenu').props.onClone(); await tick(); tree = app.render();
  const editor = component(tree, 'AgentAvatarEditor'); assert.equal(editor.props.name, copy.name); assert.equal(editor.props.hasAvatar, true); assert.equal(editor.props.busy, false); assert.match(editor.props.error, /복제본과 원본 사진은 저장/);
  const stored = JSON.parse(app.storage.get('venditbot.drafts.v1.agent-edits')); assert.equal(stored.copy.draft.avatarId, agent.avatarId); assert.equal(stored.copy.avatarRequestId, 'rejected-image');
  component(tree, 'AgentSidebarCards').props.onMenu(agent.id); tree = app.render(); component(tree, 'AgentMenu').props.onEdit(); tree = app.render(); assert.equal(component(tree, 'AgentAvatarEditor').props.name, agent.name); assert.equal(component(tree, 'AgentAvatarEditor').props.error, undefined);
});
