import assert from 'node:assert/strict';
import test from 'node:test';
import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { build } from 'esbuild';
import { setImmediate as tick } from 'node:timers/promises';

// Actual App/form handlers with synthetic IPC and private in-memory draft storage.
let slots = [], cursor = 0, invoke = async () => {};
const hooks = { ...React, useState(initial) { const at = cursor++; if (!(at in slots)) slots[at] = typeof initial === 'function' ? initial() : initial; return [slots[at], value => { slots[at] = typeof value === 'function' ? value(slots[at]) : value; }]; }, useRef(initial) { const at = cursor++; if (!(at in slots)) slots[at] = { current: initial }; return slots[at]; }, useEffect() {} };
const passthrough = ({ children }) => children;
globalThis.window = { React: hooks, ReactDOM: { createRoot: () => ({ render() {} }) }, VDS: {
  VDSProvider: passthrough, Button: passthrough, Badge: passthrough, Icon: () => null, TextInput: passthrough, TextArea: passthrough,
  Checkbox: ({ checked, disabled, 'aria-label': label }) => React.createElement('input', { type: 'checkbox', checked, disabled, 'aria-label': label, readOnly: true }),
  Dialog: { Root: passthrough, Portal: passthrough, Content: passthrough, Header: passthrough, Footer: passthrough },
}, venditbot: { invoke: (...args) => invoke(...args), onEvent: () => () => {} } };
globalThis.document = { getElementById: () => ({}) };
async function bundle(path) { const result = await build({ entryPoints: [new URL(path, import.meta.url).pathname], bundle: true, platform: 'node', format: 'esm', jsx: 'transform', jsxFactory: 'React.createElement', jsxFragment: 'React.Fragment', write: false }); return import(`data:text/javascript;base64,${Buffer.from(result.outputFiles[0].text).toString('base64')}`); }
const { App } = await bundle('../frontend/venditbot/app.tsx');
const { TeamEditor, TeamRunView } = await bundle('../frontend/venditbot/teams-ui.tsx');
const { teamDraftForRequest } = await bundle('../frontend/venditbot/ui-state.ts');
const { LocalDraftStore, teamEditDrafts } = await bundle('../frontend/venditbot/draft-storage.ts');
const elements = node => Array.isArray(node) ? node.flatMap(elements) : React.isValidElement(node) ? [node, ...elements(node.props.children)] : [];
const text = node => Array.isArray(node) ? node.map(text).join('') : React.isValidElement(node) ? text(node.props.children) : typeof node === 'string' || typeof node === 'number' ? String(node) : '';
const button = (tree, label) => elements(tree).find(node => node.props.onPress && text(node) === label);
const field = (tree, label) => elements(tree).find(node => node.props['aria-label'] === label);
const component = (tree, name) => elements(tree).find(node => node.type?.name === name);
const noop = () => {};
const agents = Array.from({ length: 3 }, (_, at) => ({ id: `agent-${at}`, name: `담당자 ${at}`, instructions: `역할 ${at}`, connectionId: 'codex', model: 'synthetic-model', createdAt: '2026-01-01', updatedAt: '2026-01-01' }));
const team = { id: 'team', name: '기존 팀', instructions: '공동 지시 유지', topic: '주제 유지', policies: '운영 지침 유지', leaderAgentId: agents[0].id, memberAgentIds: agents.map(agent => agent.id), rounds: 1, createdAt: '2026-01-01', updatedAt: '2026-01-02' };
const state = { version: 'fixture', profiles: [], agents, teams: [team], teamRuns: [], sessions: [], queue: { running: [], queued: [] }, activeRun: null };
function storage() { const values = new Map(); return { getItem: key => values.get(key) ?? null, setItem: (key, value) => values.set(key, value), values }; }
function fixture(initialState = state, disk = storage(), props = {}) { slots = []; cursor = 0; window.localStorage = disk; invoke = async () => {}; return () => { cursor = 0; return App({ initialState, ...props }); }; }

test('new and legacy forms default to manual, and selecting one representative is sufficient', () => {
  let draft = { name: '새 팀', instructions: '', memberAgentIds: [], rounds: 1 };
  const render = (busy = false) => TeamEditor({ draft, agents, busy, onChange: next => { draft = next; }, onSave: noop, onCancel: noop });
  assert.equal(field(render(), '대표 자율주행').props.checked, false);
  assert.equal(button(render(), '팀 저장').props.disabled, true);
  field(render(), '대표 자율주행').props.onCheckedChange(true);
  field(render(), '팀 대표').props.onChange({ target: { value: agents[0].id } });
  assert.deepEqual(draft.memberAgentIds, [agents[0].id]); assert.equal(draft.leaderAgentId, agents[0].id);
  assert.equal(button(render(), '팀 저장').props.disabled, false);
  assert.equal(teamDraftForRequest(draft, agents).autonomous, true);
  field(render(), '팀 대표').props.onChange({ target: { value: agents[0].id } });
  assert.equal(draft.memberAgentIds.length, 1);
  field(render(true), '대표 자율주행').props.onCheckedChange(false);
  assert.equal(draft.autonomous, true, 'disabled form must not change mode');
  assert.match(text(render()), /초기 멤버 추가는 선택/);
  assert.match(text(render()), /인원 수 제한 없음 · 저장 공간 및 동시 실행 제한 적용/);
  assert.match(text(render()), /영구 삭제는 사용자\(관리자\)가 개별적으로/);
  assert.equal(teamDraftForRequest(team, agents).autonomous, false);
  assert.throws(() => teamDraftForRequest({ ...team, autonomous: 'true' }, agents), /자율주행 설정/);
});

test('large roster edits keep all memberships and settings; member removal only changes this draft', () => {
  const roster = Array.from({ length: 301 }, (_, at) => ({ ...agents[0], id: `member-${at}`, name: `멤버 ${at}` }));
  const original = { ...team, autonomous: true, memberAgentIds: roster.slice(0, 300).map(agent => agent.id), leaderAgentId: roster[0].id };
  const saved = structuredClone(original); let draft = original;
  const render = () => TeamEditor({ draft, agents: roster, onChange: next => { draft = next; }, onSave: noop, onCancel: noop });
  const selection = field(render(), '팀 멤버 추가'); assert.equal(selection.props.disabled, false);
  selection.props.onChange({ target: { value: roster[300].id } });
  field(render(), '팀 대표').props.onChange({ target: { value: roster[250].id } });
  field(render(), '대표 자율주행').props.onCheckedChange(false);
  assert.equal(draft.memberAgentIds.length, 301); assert.equal(draft.autonomous, false);
  for (const key of ['name', 'instructions', 'topic', 'policies']) assert.equal(draft[key], original[key]);
  const request = teamDraftForRequest(draft, roster); assert.equal(request.memberAgentIds.length, 301);
  button(render(), '1번 멤버 제외').props.onPress();
  assert.equal(draft.memberAgentIds.length, 300); assert.equal(draft.leaderAgentId, roster[250].id);
  assert.deepEqual(original, saved); assert.equal(roster.length, 301);
});

test('actual App creates a leader-only autonomous team through the normal save IPC', async () => {
  const disk = storage(), render = fixture({ ...state, teams: [] }, disk, { initialView: 'teams' });
  component(render(), 'TeamsOverview').props.onCreate();
  let editor = component(render(), 'TeamEditor'); assert.equal(editor.props.draft.autonomous, false);
  editor.props.onChange({ ...editor.props.draft, name: '  새 자율 팀  ', autonomous: true, memberAgentIds: [agents[1].id], leaderAgentId: agents[1].id });
  const calls = []; invoke = async (method, args) => { calls.push([method, args]); return { ...state, teams: [{ ...team, ...args.team, id: 'new-team' }] }; };
  component(render(), 'TeamEditor').props.onSave(); await tick();
  assert.equal(calls.length, 1); assert.equal(calls[0][0], 'saveTeam'); assert.equal(calls[0][1].team.autonomous, true);
  assert.equal(calls[0][1].team.name, '새 자율 팀'); assert.deepEqual(calls[0][1].team.memberAgentIds, [agents[1].id]);
  assert.equal(calls[0][1].expectedUpdatedAt, undefined);
  assert.deepEqual(JSON.parse(disk.getItem('venditbot.drafts.v1.team-edits')), {});
});

test('actual App edit preserves mode, all members and CAS revision through local draft recovery', async () => {
  const snapshot = { ...state, teams: [{ ...team, autonomous: true }] }, disk = storage();
  let render = fixture(snapshot, disk, { initialView: 'team', initialTeamId: team.id });
  button(render(), '팀 설정').props.onPress(); let editor = component(render(), 'TeamEditor');
  assert.equal(editor.props.draft.autonomous, true); assert.deepEqual(editor.props.draft.memberAgentIds, team.memberAgentIds);
  editor.props.onChange({ ...editor.props.draft, policies: '새 운영 지침', autonomous: false });
  render = fixture(snapshot, disk, { initialView: 'team', initialTeamId: team.id });
  button(render(), '팀 설정').props.onPress(); editor = component(render(), 'TeamEditor');
  assert.equal(editor.props.draft.autonomous, false); assert.equal(editor.props.draft.policies, '새 운영 지침');
  const calls = []; invoke = async (method, args) => { calls.push([method, args]); return { ...snapshot, teams: [{ ...snapshot.teams[0], ...args.team, updatedAt: '2026-01-03' }] }; };
  editor.props.onSave(); await tick();
  const request = calls[0][1]; assert.equal(request.expectedUpdatedAt, team.updatedAt); assert.equal(request.team.autonomous, false);
  assert.deepEqual(request.team.memberAgentIds, team.memberAgentIds); assert.equal(request.team.leaderAgentId, team.leaderAgentId);
  assert.equal(request.team.instructions, team.instructions); assert.equal(request.team.topic, team.topic);
});

test('legacy App edit remains manual and a failed save retains the new autonomy draft', async () => {
  const disk = storage(), render = fixture(state, disk, { initialView: 'team', initialTeamId: team.id });
  button(render(), '팀 설정').props.onPress(); const editor = component(render(), 'TeamEditor');
  assert.equal(editor.props.draft.autonomous, false);
  editor.props.onChange({ ...editor.props.draft, autonomous: true });
  invoke = async method => { if (method === 'saveTeam') throw new Error('fixture storage unavailable'); return state; };
  component(render(), 'TeamEditor').props.onSave(); await tick();
  assert.equal(component(render(), 'TeamEditor').props.draft.autonomous, true);
  assert.equal(JSON.parse(disk.getItem('venditbot.drafts.v1.team-edits')).team.draft.autonomous, true);
});

test('draft restoration accepts explicit boolean modes and leaves legacy absence compatible', () => {
  const disk = storage();
  for (const autonomous of [true, false, undefined]) {
    const draft = { ...team }; if (autonomous !== undefined) draft.autonomous = autonomous;
    const record = { draft, expectedUpdatedAt: team.updatedAt };
    const store = new LocalDraftStore(disk, 'team-edits', {}, teamEditDrafts); store.set({ team: record });
    assert.equal(new LocalDraftStore(disk, 'team-edits', {}, teamEditDrafts).value.team.draft.autonomous, autonomous);
  }
  for (const invalid of ['true', 'false', 1, null, {}]) assert.equal(teamEditDrafts({ team: { draft: { ...team, autonomous: invalid }, expectedUpdatedAt: team.updatedAt } }), undefined);
});

test('run details show the captured execution mode rather than changing team settings', () => {
  const run = { id: 'run', teamId: team.id, teamName: team.name, goal: '실행 중 요청', autonomous: true, status: 'completed', rounds: 1, members: [{ id: agents[0].id, name: agents[0].name }], steps: [], messageCount: 0, createdAt: team.createdAt, updatedAt: team.updatedAt };
  const props = { run, sessions: [], detail: { ...run, messages: [] }, message: '', recipient: '', onMessage: noop, onRecipient: noop, onSend: noop, onCancel: noop, onRetry: noop, onOpenSession: noop };
  slots = []; cursor = 0;
  assert.match(renderToStaticMarkup(React.createElement(TeamRunView, props)), /실행 모드 · 대표 자율주행/);
  slots = []; cursor = 0;
  assert.match(renderToStaticMarkup(React.createElement(TeamRunView, { ...props, run: { ...run, autonomous: undefined } })), /실행 모드 · 기존 팀 운영/);
});
