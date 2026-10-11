import assert from 'node:assert/strict';
import test from 'node:test';
import React from 'react';
import { build } from 'esbuild';
import { setImmediate as tick } from 'node:timers/promises';
let slots = [], cursor = 0;
const hooks = { ...React, useState(initial) { const at = cursor++; if (!(at in slots)) slots[at] = typeof initial === 'function' ? initial() : initial; return [slots[at], next => { slots[at] = typeof next === 'function' ? next(slots[at]) : next; }]; }, useRef(initial) { const at = cursor++; if (!(at in slots)) slots[at] = { current: initial }; return slots[at]; }, useEffect() {} };
const passthrough = ({ children }) => children;
globalThis.window = { React: hooks, VDS: { Button: passthrough, TextInput: passthrough, TextArea: passthrough, Checkbox: passthrough, Badge: passthrough } };
async function bundle(file) { const result = await build({ entryPoints: [new URL(file, import.meta.url).pathname], bundle: true, platform: 'node', format: 'esm', jsx: 'transform', jsxFactory: 'React.createElement', jsxFragment: 'React.Fragment', write: false }); return import(`data:text/javascript;base64,${Buffer.from(result.outputFiles[0].text).toString('base64')}`); }
const { RabbitSettings } = await bundle('../frontend/venditbot/rabbit-settings.tsx');
const { blankRabbitEdit, rabbitEditFor, rabbitRunLabel, rabbitPreset, mergeRabbitRun } = await bundle('../frontend/venditbot/rabbit-ui-state.ts');
const { LocalDraftStore, rabbitEditDrafts, rabbitWorkDrafts } = await bundle('../frontend/venditbot/draft-storage.ts');
const { normalizeRabbitRunInput } = await bundle('../source/shared/rabbit-project-api.ts');
const id = '10000000-0000-4000-8000-000000000001', otherId = '10000000-0000-4000-8000-000000000002', projectId = '5bedba5c-3539-4e57-b8fd-e0b0351e4f34';
const profile = { ...blankRabbitEdit().draft, id, name: '개발 프로젝트', baseUrl: 'https://lane.vendit.work', projectId, hasKey: true, verified: false, createdAt: '2026-10-11T00:00:00.000Z', updatedAt: '2026-10-11T00:00:00.000Z' };
const second = { ...profile, id: otherId, name: '다른 프로젝트' }, key = `rabbit_${'x'.repeat(43)}`;
const input = normalizeRabbitRunInput({ objective: '첫 요청', acceptance_criteria: ['테스트 통과'] }, profile);
const run = { id: '10000000-0000-4000-8000-000000000003', connectionId: id, connectionSnapshot: profile, request: input, idempotencyKey: '10000000-0000-4000-8000-000000000004', phase: 'accepted', attempts: 1, createdAt: profile.createdAt, updatedAt: profile.updatedAt, receipt: { run_id: '10000000-0000-4000-8000-000000000005', project_id: projectId, state: 'queued', created_at: profile.createdAt, poll_url: 'https://lane.vendit.work/v1/runs/10000000-0000-4000-8000-000000000005', events_url: 'https://lane.vendit.work/v1/runs/10000000-0000-4000-8000-000000000005/events' } };
const nodes = node => Array.isArray(node) ? node.flatMap(nodes) : React.isValidElement(node) ? [node, ...nodes(node.props.children)] : [];
const text = node => Array.isArray(node) ? node.map(text).join('') : React.isValidElement(node) ? text(node.props.children) : typeof node === 'string' || typeof node === 'number' ? String(node) : '';
const button = (tree, label, at = 0) => nodes(tree).filter(node => node.props.onPress && text(node) === label)[at];
const field = (tree, label) => nodes(tree).find(node => node.props.label === label || node.props['aria-label'] === label);
function fixture(extra = {}) {
  slots = []; const calls = [], guards = [];
  const props = { connections: [profile], runs: [], edits: {}, work: {}, editKey: id, active: true, onGuard: value => guards.push(value), onFlushWork: () => true, invoke: async (...args) => { calls.push(args); return {}; }, ...extra };
  props.onEdits = value => { props.edits = typeof value === 'function' ? value(props.edits) : value; };
  props.onWork = value => { props.work = typeof value === 'function' ? value(props.work) : value; };
  props.onEditKey = value => { props.editKey = value; };
  props.onConnections = value => { props.connections = value; };
  props.onRun = value => { props.runs = mergeRabbitRun(props.runs, value); };
  const render = () => { cursor = 0; return RabbitSettings(props); };
  return { props, calls, guards, render };
}

test('Rabbit full endpoint imports only project routing and GET test populates optional repositories without creating work', async () => {
  const f = fixture({ editKey: 'new', connections: [] }); let tree = f.render();
  field(tree, 'Rabbit 프로젝트 POST 주소').props.onChange({ target: { value: rabbitPreset } }); tree = f.render();
  assert.equal(field(tree, 'Rabbit 서버 주소').props.value, 'https://lane.vendit.work'); assert.equal(field(tree, 'Rabbit 프로젝트 ID').props.value, projectId);
  assert.equal(field(tree, 'Rabbit 프로젝트 API 키').props.type, 'password'); assert.equal(field(tree, 'Rabbit API 비용 한도(USD)').props.readOnly, true); assert.equal(field(tree, '에이전트의 Rabbit 프로젝트 사용 허용').props.checked, false);
  f.props.connections = [profile]; f.props.editKey = id; f.props.invoke = async (...args) => { f.calls.push(args); return { projectId, repositories: [{ id: otherId, url: 'https://github.com/example/project', provider: 'github', status: 'ready', default_branch: 'develop' }], pages: 1, checkedAt: profile.createdAt }; };
  tree = f.render(); button(tree, 'Rabbit 연결 검사 · GET').props.onPress(); await tick(); tree = f.render();
  assert.deepEqual(f.calls, [['testRabbitConnection', { id }]]); assert.match(text(tree), /작업을 생성하지 않았습니다/); assert.equal(nodes(field(tree, 'Rabbit 저장소')).filter(n => n.type === 'option').length, 2); assert.equal(field(tree, 'Rabbit 기준 브랜치').props.value, 'main');
});

test('masked Rabbit key fails before IPC and valid password stays in memory while synchronous guard blocks updates', async () => {
  const f = fixture(); let tree = f.render(); field(tree, 'Rabbit 프로젝트 API 키').props.onChange({ target: { value: 'rabbit_••••' } });
  assert.equal(f.guards.at(-1).keyDirty, true); tree = f.render(); button(tree, 'Rabbit 연결 저장').props.onPress(); await tick(); assert.equal(f.calls.length, 0); assert.match(text(f.render()), /키 형식/);
  tree = f.render(); field(tree, 'Rabbit 프로젝트 API 키').props.onChange({ target: { value: key } }); field(tree, 'Rabbit 연결 이름').props.onChange({ target: { value: '키 없는 초안' } }); assert.doesNotMatch(JSON.stringify(f.props.edits), /rabbit_x/);
  f.props.editKey = otherId; f.props.connections.push(second); tree = f.render(); assert.equal(field(tree, 'Rabbit 프로젝트 API 키').props.value, ''); f.props.editKey = id; assert.equal(field(f.render(), 'Rabbit 프로젝트 API 키').props.value, key);
});

test('save targets its captured connection and preserves newer text/key without navigating another editor', async () => {
  const f = fixture({ connections: [profile, second], edits: { [id]: rabbitEditFor(profile) } }); let finish;
  f.props.invoke = (...args) => { f.calls.push(args); return new Promise(resolve => { finish = resolve; }); };
  let tree = f.render(); field(tree, 'Rabbit 프로젝트 API 키').props.onChange({ target: { value: key } }); tree = f.render(); button(tree, 'Rabbit 연결 저장').props.onPress();
  tree = f.render(); field(tree, 'Rabbit 연결 이름').props.onChange({ target: { value: '응답 대기 중 쓴 이름' } }); field(tree, 'Rabbit 프로젝트 API 키').props.onChange({ target: { value: `${key.slice(0, -1)}y` } }); f.props.editKey = otherId; f.render();
  finish({ rabbitConnections: [{ ...profile, updatedAt: '2026-10-11T00:00:01.000Z' }, second] }); await tick();
  assert.equal(f.props.editKey, otherId); assert.equal(f.props.edits[id].draft.name, '응답 대기 중 쓴 이름'); assert.equal(f.calls[0][1].expectedUpdatedAt, profile.updatedAt); assert.equal(f.calls[0][1].apiKey, key);
  f.props.editKey = id; assert.equal(field(f.render(), 'Rabbit 프로젝트 API 키').props.value, `${key.slice(0, -1)}y`);
});

test('new connection save retains text typed after submit on the created ID and current revision', async () => {
  const record = rabbitEditFor(profile); delete record.draft.id; record.expectedUpdatedAt = '';
  const f = fixture({ connections: [], editKey: 'new', edits: { new: record } }); let finish;
  f.props.invoke = () => new Promise(resolve => { finish = resolve; }); let tree = f.render(); field(tree, 'Rabbit 프로젝트 API 키').props.onChange({ target: { value: key } }); tree = f.render(); button(tree, 'Rabbit 연결 저장').props.onPress();
  tree = f.render(); field(tree, 'Rabbit 연결 이름').props.onChange({ target: { value: '새로 쓴 이름' } }); f.render(); finish({ rabbitConnections: [profile] }); await tick();
  assert.equal(f.props.editKey, id); assert.equal(f.props.edits[id].draft.name, '새로 쓴 이름'); assert.equal(f.props.edits[id].expectedUpdatedAt, profile.updatedAt); assert.equal(f.props.edits.new, undefined);
});

test('POST persists exact request before invoking and a lost response retries same UUID/body while preserving newer work', async () => {
  const f = fixture({ work: { [id]: { objective: '첫 요청', criteria: '테스트 통과' } } });
  f.props.invoke = async (method, args) => { f.calls.push([method, args]); assert.equal(f.props.work[id].pending.requestId, args.requestId); throw new Error('응답 유실'); };
  button(f.render(), 'Rabbit 작업 접수').props.onPress(); await tick(); const original = f.calls[0][1]; assert.equal(original.input.constraints.api_cost_limit_usd, 0);
  let tree = f.render(); field(tree, `${profile.name} 작업 목표`).props.onChange({ target: { value: '후속 새 요청' } }); f.render(); f.props.invoke = async (method, args) => { f.calls.push([method, args]); return run; };
  button(f.render(), '이전 접수 확인 다시 시도').props.onPress(); await tick(); assert.deepEqual(f.calls[1][1], original); assert.equal(f.props.work[id].objective, '후속 새 요청'); assert.equal(f.props.work[id].pending, undefined); assert.equal(f.props.runs.length, 1);
});

test('failed durable outbox write prevents POST and duplicate clicks share a single in-flight request', async () => {
  const f = fixture({ work: { [id]: { objective: '첫 요청', criteria: '테스트 통과' } }, onFlushWork: () => false }); button(f.render(), 'Rabbit 작업 접수').props.onPress(); await tick(); assert.equal(f.calls.length, 0); assert.match(text(f.render()), /초안을 저장하지 못했습니다/);
  f.props.onFlushWork = () => true; let finish; f.props.invoke = (...args) => { f.calls.push(args); return new Promise(resolve => { finish = resolve; }); };
  const send = button(f.render(), '이전 접수 확인 다시 시도'); send.props.onPress(); send.props.onPress(); assert.equal(f.calls.length, 1); assert.equal(f.guards.at(-1).pending, true); finish(run); await tick(); assert.equal(f.guards.at(-1).pending, false);
});

test('unknown retry uses ledger ID only; receipt is not completion and state reads never call remote cancel', async () => {
  const unknown = { ...run, phase: 'unknown', receipt: undefined }, f = fixture({ runs: [unknown] }); f.props.invoke = async (...args) => { f.calls.push(args); return run; };
  button(f.render(), '같은 요청으로 접수 재시도').props.onPress(); await tick(); assert.deepEqual(f.calls[0], ['retryRabbitRun', { id: run.id }]); let tree = f.render(); assert.match(text(tree), /202 접수됨 · 완료 전/); assert.match(text(tree), /닫아도 원격 작업은 계속/);
  button(tree, '상태·이벤트 조회').props.onPress(); await tick(); assert.deepEqual(f.calls[1], ['refreshRabbitRun', { id: run.id }]); assert.ok(f.calls.every(call => !/cancel/i.test(call[0])));
  assert.equal(rabbitRunLabel({ ...run, detail: { state: 'blocked' } }), '차단됨'); assert.equal(rabbitRunLabel({ ...run, detail: { state: 'completed' } }), '완료');
  assert.equal(mergeRabbitRun([{ ...run, updatedAt: '2026-10-12' }], run)[0].updatedAt, '2026-10-12');
});

test('Rabbit draft remount retains unfinished input and pinned outbox but strips keys, headers and owner-only fields', () => {
  const values = new Map(), disk = { getItem: key => values.get(key) ?? null, setItem: (key, value) => values.set(key, value) };
  const edit = { ...rabbitEditFor(profile), apiKey: key, draft: { ...rabbitEditFor(profile).draft, apiKey: key } };
  const work = { objective: '후続', criteria: '', apiKey: key, pending: { requestId: run.id, apiKey: key, input: { ...input, lane_id: otherId, model_id: 'secret', headers: { key } } } };
  const edits = new LocalDraftStore(disk, 'rabbit-edits', {}, rabbitEditDrafts), requests = new LocalDraftStore(disk, 'rabbit-work', {}, rabbitWorkDrafts); edits.set({ [id]: edit }); requests.set({ [id]: work }); assert.equal(edits.error, undefined); assert.equal(requests.error, undefined);
  assert.doesNotMatch(JSON.stringify([...values]), /rabbit_x|lane_id|model_id|headers/);
  assert.equal(new LocalDraftStore(disk, 'rabbit-edits', {}, rabbitEditDrafts).value[id].draft.name, profile.name); assert.deepEqual(new LocalDraftStore(disk, 'rabbit-work', {}, rabbitWorkDrafts).value[id].pending.input, input);
});

test('known rejection keeps editable work without a stuck outbox and accepted history is bounded to fifty records', async () => {
  const f = fixture({ work: { [id]: { objective: '첫 요청', criteria: '테스트 통과' } } }); f.props.invoke = async () => ({ ...run, phase: 'rejected', receipt: undefined, error: '사용자가 승인을 거절했습니다.' });
  button(f.render(), 'Rabbit 작업 접수').props.onPress(); await tick(); assert.equal(f.props.work[id].pending, undefined); assert.equal(f.props.work[id].objective, '첫 요청'); assert.match(text(f.render()), /접수 거절됨/);
  f.props.runs = Array.from({ length: 1000 }, (_, index) => ({ ...run, id: `receipt-${index}` })); let tree = f.render(); assert.equal(nodes(tree).filter(node => node.props.onPress && text(node) === '상태·이벤트 조회').length, 50); button(tree, 'Rabbit 이전 기록 더 보기 (950)').props.onPress(); tree = f.render(); assert.equal(nodes(tree).filter(node => node.props.onPress && text(node) === '상태·이벤트 조회').length, 100);
});

test('late GET results and repository choices remain bound to their original server and project', async () => {
  const f = fixture({ connections: [{ ...profile, repositoryId: otherId }] }); let finish;
  f.props.invoke = () => new Promise(resolve => { finish = resolve; }); button(f.render(), 'Rabbit 연결 검사 · GET').props.onPress();
  f.props.connections = [{ ...profile, projectId: otherId, baseUrl: 'https://other.example' }]; f.render(); finish({ projectId, repositories: [{ id: otherId, url: 'https://github.com/old/repo', status: 'ready' }], pages: 1, checkedAt: profile.createdAt }); await tick();
  let tree = f.render(); assert.equal(nodes(field(tree, 'Rabbit 저장소')).filter(node => node.type === 'option').length, 1); assert.doesNotMatch(text(tree), /old\/repo/);
  f.props.edits[id] = rabbitEditFor({ ...profile, repositoryId: otherId }); tree = f.render(); field(tree, 'Rabbit 프로젝트 POST 주소').props.onChange({ target: { value: `https://new.example/v1/projects/${otherId}/runs` } }); assert.equal(f.props.edits[id].draft.repositoryId, undefined);
});

test('Rabbit project preference is explicit, requires agent permission, and persists without adding owner-only execution fields', () => {
  const f = fixture(); let tree = f.render(); const preference = field(tree, '등록 프로젝트 작업은 Rabbit API 최우선'); assert.equal(preference.props.checked, false); assert.equal(preference.props.disabled, true);
  field(tree, '에이전트의 Rabbit 프로젝트 사용 허용').props.onCheckedChange(true); tree = f.render(); assert.equal(field(tree, '등록 프로젝트 작업은 Rabbit API 최우선').props.disabled, false); field(tree, '등록 프로젝트 작업은 Rabbit API 최우선').props.onCheckedChange(true); tree = f.render();
  assert.equal(f.props.edits[id].draft.preferForProjectTasks, true); assert.equal(rabbitEditDrafts(f.props.edits)[id].draft.preferForProjectTasks, true); assert.match(text(tree), /일반 대화는 기존 AI/); assert.match(text(tree), /원격 접수 결과가 불명확하면 로컬에서 중복 실행하지 않습니다/);
  field(tree, '에이전트의 Rabbit 프로젝트 사용 허용').props.onCheckedChange(false); assert.equal(f.props.edits[id].draft.preferForProjectTasks, false); assert.equal(f.props.edits[id].draft.enabledForAgents, false);
});
