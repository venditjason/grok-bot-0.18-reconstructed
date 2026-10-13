import assert from 'node:assert/strict';
import test from 'node:test';
import React from 'react';
import { build } from 'esbuild';
import { setImmediate as tick } from 'node:timers/promises';

// A deterministic hook host runs actual App handlers without native accounts or browser effects.
let slots = [], cursor = 0, invoke = async () => {};
const hooks = { ...React, useState(initial) { const index = cursor++; if (!(index in slots)) slots[index] = typeof initial === 'function' ? initial() : initial; return [slots[index], value => { slots[index] = typeof value === 'function' ? value(slots[index]) : value; }]; }, useRef(initial) { const index = cursor++; if (!(index in slots)) slots[index] = { current: initial }; return slots[index]; }, useEffect() {} };
const passthrough = ({ children }) => children;
globalThis.window = { React: hooks, ReactDOM: { createRoot: () => ({ render() {} }) }, VDS: { VDSProvider: passthrough, Button: passthrough, Icon: passthrough, Badge: passthrough, TextInput: passthrough, TextArea: passthrough, Checkbox: passthrough, Dialog: { Root: passthrough, Portal: passthrough, Content: passthrough, Header: passthrough, Footer: passthrough } }, venditbot: { invoke: (...args) => invoke(...args), onEvent: () => () => {} } };
globalThis.document = { getElementById: () => ({}) };
const built = await build({ entryPoints: [new URL('../frontend/venditbot/app.tsx', import.meta.url).pathname], bundle: true, platform: 'node', format: 'esm', jsx: 'transform', jsxFactory: 'React.createElement', jsxFragment: 'React.Fragment', write: false });
const { App } = await import(`data:text/javascript;base64,${Buffer.from(built.outputFiles[0].text).toString('base64')}`);
const rulesBuilt = await build({ entryPoints: [new URL('../source/shared/action-rules.ts', import.meta.url).pathname], bundle: true, platform: 'node', format: 'esm', write: false });
const { DEFAULT_ACTION_RULES } = await import(`data:text/javascript;base64,${Buffer.from(rulesBuilt.outputFiles[0].text).toString('base64')}`);
function elements(node) { return Array.isArray(node) ? node.flatMap(elements) : React.isValidElement(node) ? [node, ...elements(node.props.children)] : []; }
function text(node) { return Array.isArray(node) ? node.map(text).join('') : React.isValidElement(node) ? text(node.props.children) : typeof node === 'string' || typeof node === 'number' ? String(node) : ''; }
const button = (tree, label) => elements(tree).find(node => node.props.onPress && text(node) === label);
const component = (tree, name) => elements(tree).find(node => node.type?.name === name);
// Exercise the real App callbacks at the shared composer boundary; its DOM/keyboard behavior has a separate component suite.
const composer = tree => { const node = component(tree, 'ChatComposer'); assert.ok(node, 'agent ChatComposer is rendered'); assert.equal(node.props.label, '메시지'); return node.props; };
const agent = { id: 'agent', name: '내 에이전트', instructions: '역할', connectionId: 'api', model: 'fixture', createdAt: '2026-01-01', updatedAt: '2026-01-01' };
const team = { id: 'team', name: '내 팀', instructions: '', topic: '', policies: '', leaderAgentId: agent.id, memberAgentIds: [agent.id], rounds: 1, createdAt: '2026-01-01', updatedAt: '2026-01-01' };
const session = (id, extra = {}) => ({ id, title: id, agentId: agent.id, connectionId: 'api', model: 'fixture', messages: [], createdAt: '2026-01-01', updatedAt: '2026-01-01', ...extra });
const completed = { id: 'completed', teamId: team.id, teamName: team.name, goal: '첫 요청', status: 'completed', rounds: 1, members: [{ id: agent.id, name: agent.name }], steps: [], messageCount: 1, createdAt: '2026-01-01', updatedAt: '2026-01-01', messages: [] };
const state = { version: 'fixture', profiles: [], agents: [agent], teams: [team], teamRuns: [completed], sessions: [], queue: { running: [], queued: [] }, activeRun: null };
function memoryStorage() { const values = new Map(); return { getItem: key => values.get(key) ?? null, setItem: (key, value) => values.set(key, value), values }; }
function fixture(initialState = state, storage = memoryStorage(), props = {}) { slots = []; window.localStorage = storage; invoke = async () => {}; const render = () => { cursor = 0; return App({ initialState, ...props }); }; return render; }
function navClick(tree, navName, label) { const cards = component(tree, navName === '에이전트 목록' ? 'AgentSidebarCards' : 'TeamSidebarCards'); const nav = cards ? cards.type(cards.props) : elements(tree).find(node => node.type === 'nav' && node.props['aria-label'] === navName); elements(nav).find(node => node.props.onPress && (node.props['aria-label']?.startsWith(`${label} 대화 열기`) || text(node) === label)).props.onPress(); }

test('agent sidebar immediately opens its latest ordinary chat, keeps drafts, and new chat creates only on first send', async () => {
  const render = fixture({ ...state, sessions: [session('normal'), session('newer-team', { teamRunId: 'run', updatedAt: '2026-01-03' }), session('newer-avatar', { purpose: 'avatar', updatedAt: '2026-01-04' })] });
  let tree = render(); navClick(tree, '에이전트 목록', agent.name); tree = render();
  assert.ok(button(tree, '에이전트 설정')); assert.equal(component(tree, 'TeamChat'), undefined);
  composer(tree).onChange('일반 대화에서 계속'); tree = render();
  const calls = []; invoke = async (method, args) => { calls.push([method, args]); return method === 'createSession' ? session('created') : {}; };
  composer(tree).onSend(); await tick(); assert.match(calls[0][1].requestId, /^[0-9a-f-]{36}$/); assert.deepEqual(calls, [['send', { requestId: calls[0][1].requestId, sessionId: 'normal', text: '일반 대화에서 계속' }]]);
  tree = render(); button(elements(tree).find(node => node.type === 'header'), '새 대화').props.onPress(); tree = render();
  assert.equal(calls.length, 1);
  composer(tree).onChange('첫 요청'); tree = render(); composer(tree).onSend(); await tick();
  assert.deepEqual(calls.slice(1), [['createSession', { agentId: agent.id }], ['send', { requestId: calls[2][1].requestId, sessionId: 'created', text: '첫 요청' }]]);
});

test('team sidebar opens chat and completed follow-up sends contextRunId; new chat omits it', async () => {
  const render = fixture(), calls = [];
  invoke = async (method, args) => { calls.push([method, args]); return { ...completed, id: `new-${calls.length}`, status: 'running', goal: args.goal, previousRunId: args.contextRunId, updatedAt: '2026-01-02' }; };
  let tree = render(); navClick(tree, '협업 팀 목록', team.name); tree = render();
  let chat = component(tree, 'TeamChat'); assert.ok(chat); assert.equal(chat.props.history.at(-1).id, completed.id); assert.ok(button(tree, '팀 설정'));
  chat.props.onPrompt('이어서 검토'); tree = render(); component(tree, 'TeamChat').props.onSend(); await tick();
  assert.deepEqual(calls[0], ['startTeamRun', { teamId: team.id, goal: '이어서 검토', contextRunId: completed.id }]);
  tree = render(); assert.equal(component(tree, 'TeamChat').props.prompt, '');
  button(elements(tree).find(node => node.type === 'header'), '새 대화').props.onPress(); tree = render(); chat = component(tree, 'TeamChat'); assert.equal(chat.props.history.length, 0);
  chat.props.onPrompt('별도 새 목표'); tree = render(); component(tree, 'TeamChat').props.onSend(); await tick();
  assert.deepEqual(calls[1], ['startTeamRun', { teamId: team.id, goal: '별도 새 목표' }]);
});

test('an active team routes additional instructions into its shared room and a failed submission keeps the draft', async () => {
  const active = { ...completed, status: 'running' }, render = fixture({ ...state, teamRuns: [active] }), calls = [];
  invoke = async (method, args) => { calls.push([method, args]); return active; };
  let tree = render(); navClick(tree, '협업 팀 목록', team.name); tree = render(); component(tree, 'TeamChat').props.onPrompt('추가 근거'); tree = render(); component(tree, 'TeamChat').props.onSend(); await tick();
  assert.deepEqual(calls[0], ['postTeamMessage', { runId: active.id, text: '추가 근거' }]); assert.equal(calls[1][0], 'getTeamRun');
  tree = render(); component(tree, 'TeamChat').props.onPrompt('실패해도 남겨둘 문장'); tree = render(); invoke = async () => { throw new Error('fixture transport failure'); }; component(tree, 'TeamChat').props.onSend(); await tick();
  tree = render(); assert.equal(component(tree, 'TeamChat').props.prompt, '실패해도 남겨둘 문장'); assert.match(text(tree), /fixture transport failure/);
});

test('sidebar update actions use the update IPC and work blocks installation before invoking the host', async () => {
  const update = { phase: 'available', currentVersion: '0.2.0', version: '0.2.1' }, snapshot = { ...state, update }, calls = [];
  let render = fixture(snapshot);
  invoke = async (method, args) => { calls.push([method, args]); return snapshot; };
  let tree = render(), control = component(tree, 'UpdateControl'); assert.equal(control.props.working, false);
  control.props.onCheck(); await tick(); assert.deepEqual(calls.map(call => call[0]), ['checkUpdate', 'state']);
  tree = render(); component(tree, 'UpdateControl').props.onInstall(); await tick(); assert.deepEqual(calls.map(call => call[0]), ['checkUpdate', 'state', 'installUpdate', 'state']);
  render = fixture({ ...snapshot, queue: { running: [], queued: ['pending'] } }); invoke = async method => { throw new Error(`Must not invoke ${method}`); }; tree = render(); control = component(tree, 'UpdateControl'); assert.equal(control.props.working, true);
  control.props.onInstall(); await tick(); assert.match(text(render()), /작업 완료 후 업데이트하세요/);
});

test('unsent agent and team messages survive renderer restart and update without being sent', async () => {
  const disk = memoryStorage(), snapshot = { ...state, update: { phase: 'available', currentVersion: '0.2.0', version: '0.2.1' } };
  let render = fixture(snapshot, disk), tree = render(); navClick(tree, '에이전트 목록', agent.name); tree = render();
  composer(tree).onChange('아직 보내지 않은 개인 작업');
  tree = render(); navClick(tree, '협업 팀 목록', team.name); tree = render(); component(tree, 'TeamChat').props.onPrompt('아직 보내지 않은 팀 작업'); tree = render();
  const calls = []; invoke = async method => { calls.push(method); return snapshot; }; component(tree, 'UpdateControl').props.onInstall(); await tick(); assert.deepEqual(calls, ['installUpdate', 'state']);
  render = fixture(snapshot, disk); tree = render(); assert.match(text(tree), /초안 2개/); navClick(tree, '에이전트 목록', agent.name); tree = render(); assert.equal(composer(tree).value, '아직 보내지 않은 개인 작업');
  navClick(tree, '협업 팀 목록', team.name); tree = render(); assert.equal(component(tree, 'TeamChat').props.prompt, '아직 보내지 않은 팀 작업');
});

test('agent role, image prompt, and team settings recover with the original conflict revision', () => {
  const disk = memoryStorage(); let render = fixture(state, disk), tree = render(); navClick(tree, '에이전트 목록', agent.name); tree = render(); button(tree, '에이전트 설정').props.onPress(); tree = render();
  elements(tree).find(node => node.props.label === '에이전트 이름').props.onChange({ target: { value: '초안 이름' } }); tree = render(); elements(tree).find(node => node.props['aria-label'] === '역할과 지시').props.onChange({ target: { value: '저장 전 역할 변경' } }); tree = render(); component(tree, 'AgentAvatarEditor').props.onPrompt('보관할 이미지 지시');
  tree = render(); navClick(tree, '협업 팀 목록', team.name); tree = render(); button(tree, '팀 설정').props.onPress(); tree = render(); const editor = component(tree, 'TeamEditor'); editor.props.onChange({ ...editor.props.draft, policies: '저장 전 정책 변경' });
  render = fixture({ ...state, teams: [{ ...team, updatedAt: '2026-02-01' }] }, disk); tree = render(); navClick(tree, '에이전트 목록', agent.name); tree = render(); button(tree, '에이전트 설정').props.onPress(); tree = render();
  assert.equal(elements(tree).find(node => node.props.label === '에이전트 이름').props.value, '초안 이름'); assert.equal(elements(tree).find(node => node.props['aria-label'] === '역할과 지시').props.value, '저장 전 역할 변경'); assert.equal(component(tree, 'AgentAvatarEditor').props.prompt, '보관할 이미지 지시');
  navClick(tree, '협업 팀 목록', team.name); tree = render(); button(tree, '팀 설정').props.onPress(); tree = render(); assert.equal(component(tree, 'TeamEditor').props.draft.policies, '저장 전 정책 변경'); assert.match(component(tree, 'TeamEditor').props.conflict, /팀 구성이 변경/);
});

test('draft write failure and unsaved API keys block installation without placing secrets in storage', async () => {
  const disk = memoryStorage(), snapshot = { ...state, update: { phase: 'available', currentVersion: '0.2.0', version: '0.2.1' } };
  let render = fixture(snapshot, disk), tree = render(); disk.setItem = () => { throw new Error('quota'); }; composer(tree).onChange('저장에 실패한 초안'); tree = render();
  let calls = 0; invoke = async () => { calls++; }; assert.match(component(tree, 'UpdateControl').props.blockedReason, /초안/); component(tree, 'UpdateControl').props.onInstall(); await tick(); assert.equal(calls, 0); assert.match(text(render()), /저장하지 못했습니다/);
  const cleanDisk = memoryStorage(); render = fixture(snapshot, cleanDisk); tree = render(); button(tree, '설정').props.onPress(); tree = render(); elements(tree).find(node => node.props.label === 'API 키').props.onChange({ target: { value: 'secret-unsaved-key' } }); tree = render();
  calls = 0; invoke = async () => { calls++; }; assert.match(component(tree, 'UpdateControl').props.blockedReason, /연결 설정/); component(tree, 'UpdateControl').props.onInstall(); await tick(); assert.equal(calls, 0); assert.doesNotMatch(JSON.stringify([...cleanDisk.values]), /secret-unsaved-key/);
});

test('browser login and profile generation keep the update button blocked until completed or cancelled', async () => {
  const snapshot = { ...state, profiles: [{ id: 'api', model: 'fixture', name: 'API', hasKey: true }], update: { phase: 'available', currentVersion: '0.2.0', version: '0.2.1' } };
  let render = fixture(snapshot, memoryStorage(), { initialAuth: { codex: { authenticated: false, phase: 'awaiting-browser' } } }), tree = render(); assert.match(component(tree, 'UpdateControl').props.blockedReason, /로그인/);
  render = fixture(snapshot); tree = render(); navClick(tree, '에이전트 목록', agent.name); tree = render(); button(tree, '에이전트 설정').props.onPress(); tree = render(); component(tree, 'AgentAvatarEditor').props.onPrompt('생성 중 프롬프트'); tree = render();
  let finish; invoke = async () => new Promise(resolve => { finish = resolve; }); component(tree, 'AgentAvatarEditor').props.onGenerate(); tree = render(); assert.match(component(tree, 'UpdateControl').props.blockedReason, /프로필 생성/);
  component(tree, 'AgentAvatarEditor').props.onPrompt('생성 중에도 고친 다음 프롬프트'); tree = render(); finish({ id: 'preview', dataUrl: 'data:image/png;base64,AA', kind: 'image' }); await tick(); tree = render(); assert.equal(component(tree, 'AgentAvatarEditor').props.prompt, '생성 중에도 고친 다음 프롬프트');
  const stored = JSON.parse(window.localStorage.getItem('venditbot.drafts.v1.agent-edits')); assert.equal(stored.agent.avatarPrompt, '생성 중에도 고친 다음 프롬프트'); assert.equal(stored.agent.draft.avatarId, 'preview');
});

test('failed fresh team chat follow-up never sends context from an unrelated completed conversation', async () => {
  const failed = { ...completed, id: 'independent-failed', status: 'failed', updatedAt: '2026-02-01' }, render = fixture({ ...state, teamRuns: [completed, failed] });
  let tree = render(); navClick(tree, '협업 팀 목록', team.name); tree = render(); component(tree, 'TeamChat').props.onPrompt('실패한 요청을 수정'); tree = render(); const calls = [];
  invoke = async (method, args) => { calls.push([method, args]); return { ...failed, id: 'retry', status: 'running' }; }; component(tree, 'TeamChat').props.onSend(); await tick();
  assert.deepEqual(calls, [['startTeamRun', { teamId: team.id, goal: '실패한 요청을 수정' }]]);
});

test('installation rechecks draft durability even if storage fails only after the last input', async () => {
  const disk = memoryStorage(), snapshot = { ...state, update: { phase: 'available', currentVersion: '0.2.0', version: '0.2.1' } }, render = fixture(snapshot, disk);
  let tree = render(); composer(tree).onChange('업데이트 전 저장된 초안'); tree = render(); assert.equal(component(tree, 'UpdateControl').props.blockedReason, undefined);
  disk.setItem = () => { throw new Error('disk became unavailable'); }; let calls = 0; invoke = async () => { calls++; }; component(tree, 'UpdateControl').props.onInstall(); await tick();
  assert.equal(calls, 0); tree = render(); assert.match(text(tree), /업데이트를 시작하지 않았습니다/); assert.equal(composer(tree).value, '업데이트 전 저장된 초안');
});

test('API secure-storage timeout clears test busy state, shows the original error, and preserves unsaved connection input', async () => {
  const profile = { id: 'api', name: '테스트 API', provider: 'openai', model: 'fixture', hasKey: true, protocol: 'responses', baseUrl: 'https://api.openai.com/v1' }, snapshot = { ...state, profiles: [profile] }, render = fixture(snapshot);
  let tree = render(); button(tree, '설정').props.onPress(); tree = render(); elements(tree).find(node => node.props.label === '연결 이름').props.onChange({ target: { value: '저장 전 연결 이름' } }); tree = render(); elements(tree).find(node => node.props.label === 'API 키').props.onChange({ target: { value: 'keep-memory-only-key' } }); tree = render();
  const calls = []; invoke = async method => { calls.push(method); if (method === 'testApi') throw new Error('보안 저장소 응답 대기 시간이 초과되었습니다.'); return snapshot; };
  button(tree, '연결 테스트').props.onPress(); await tick(); tree = render();
  assert.deepEqual(calls, ['testApi', 'state']); assert.match(text(tree), /보안 저장소 응답 대기 시간이 초과/); assert.equal(button(tree, '연결 테스트').props.loading, false); assert.equal(elements(tree).find(node => node.props.label === '연결 이름').props.value, '저장 전 연결 이름'); assert.equal(elements(tree).find(node => node.props.label === 'API 키').props.value, 'keep-memory-only-key'); assert.doesNotMatch(JSON.stringify([...window.localStorage.values]), /keep-memory-only-key/);
});

test('profile timeout and cancellation preserve the existing avatar and every locally saved edit', async () => {
  const pictured = { ...agent, avatarId: 'existing-avatar' }, snapshot = { ...state, agents: [pictured], profiles: [{ id: 'api', name: 'API', model: 'fixture', hasKey: true }] }, disk = memoryStorage(); let render = fixture(snapshot, disk), tree = render();
  navClick(tree, '에이전트 목록', agent.name); tree = render(); button(tree, '에이전트 설정').props.onPress(); tree = render(); component(tree, 'AgentAvatarEditor').props.onPrompt('다시 시도할 초록 로봇'); tree = render();
  invoke = async () => { throw new Error('보안 저장소 15초 대기 시간이 초과되었습니다.'); }; component(tree, 'AgentAvatarEditor').props.onGenerate(); await tick(); tree = render();
  let avatar = component(tree, 'AgentAvatarEditor'); assert.match(avatar.props.error, /15초/); assert.equal(avatar.props.busy, false); assert.equal(avatar.props.hasAvatar, true); assert.equal(avatar.props.prompt, '다시 시도할 초록 로봇');
  let rejectGeneration; const calls = []; invoke = async method => { calls.push(method); if (method === 'generateAgentAvatar') return new Promise((_resolve, reject) => { rejectGeneration = reject; }); if (method === 'cancelAgentAvatar') { rejectGeneration(new Error('프로필 생성을 취소했습니다.')); return { cancelled: true }; } };
  avatar.props.onGenerate(); tree = render(); component(tree, 'AgentAvatarEditor').props.onCancel(); await tick(); tree = render(); avatar = component(tree, 'AgentAvatarEditor');
  assert.deepEqual(calls, ['generateAgentAvatar', 'cancelAgentAvatar']); assert.match(avatar.props.error, /취소/); assert.equal(avatar.props.busy, false); assert.equal(avatar.props.prompt, '다시 시도할 초록 로봇'); assert.equal(JSON.parse(disk.getItem('venditbot.drafts.v1.agent-edits')).agent.draft.avatarId, 'existing-avatar');
  render = fixture(snapshot, disk); tree = render(); navClick(tree, '에이전트 목록', agent.name); tree = render(); button(tree, '에이전트 설정').props.onPress(); tree = render(); assert.equal(component(tree, 'AgentAvatarEditor').props.prompt, '다시 시도할 초록 로봇'); assert.equal(component(tree, 'AgentAvatarEditor').props.hasAvatar, true);
});

test('populated sidebar keeps equal add/settings actions fixed and update controls inside their settings tab', () => {
  const render = fixture({ ...state, agents: Array.from({ length: 4 }, (_, index) => ({ ...agent, id: `agent-${index}` })), sessions: Array.from({ length: 6 }, (_, index) => session(`session-${index}`)), update: { phase: 'available', currentVersion: '0.2.0', version: '0.2.1' } }); let tree = render();
  const sidebar = elements(tree).find(node => node.type === 'aside'), content = elements(sidebar).find(node => node.props.className === 'sidebar-scroll'), footer = elements(sidebar).find(node => node.props.className === 'sidebar-footer');
  assert.equal(content.props.tabIndex, 0); assert.ok(component(content, 'TeamSidebarCards')); assert.ok(component(content, 'AgentSidebarCards')); assert.equal(elements(content).filter(node => node.props.onPress && /^session-/.test(text(node))).length, 6);
  assert.equal(component(content, 'UpdateControl'), undefined); assert.equal(button(content, '설정'), undefined); assert.equal(button(content, '에이전트 만들기'), undefined);
  assert.equal(component(footer, 'UpdateControl'), undefined); assert.ok(button(footer, '설정')); assert.ok(button(footer, '+ 추가')); assert.equal(button(sidebar, '에이전트 만들기'), undefined);
  let updatePane = elements(tree).find(node => node.props['aria-label'] === '업데이트 설정'); assert.equal(updatePane.props.hidden, true);
  button(tree, '+ 추가').props.onPress(); tree = render(); assert.equal(button(tree, '+ 추가').props['aria-expanded'], true); component(tree, 'SidebarAddMenu').props.onTeam(); tree = render(); assert.ok(component(tree, 'TeamEditor'));
  button(tree, '설정').props.onPress(); tree = render(); button(tree, '업데이트').props.onPress(); tree = render(); updatePane = elements(tree).find(node => node.props['aria-label'] === '업데이트 설정'); assert.equal(updatePane.props.hidden, false); assert.ok(component(updatePane, 'UpdateControl'));
});

test('changing avatar connection or mode clears only the stale generation error while preserving edits', async () => {
  const snapshot = { ...state, profiles: [{ id: 'api', name: 'API', model: 'fixture', hasKey: true }] }, auth = { authenticated: true, phase: 'ready', account: { email: 'qa@example.test' } };
  const catalog = { phase: 'ready', accountKey: JSON.stringify(['qa@example.test', null]), catalog: { provider: 'codex', fetchedAt: '2026-01-01', models: [{ id: 'fixture-codex', label: 'Fixture', efforts: ['low'], isDefault: true }] } };
  const render = fixture(snapshot, memoryStorage(), { initialAuth: { codex: auth }, initialCatalogs: { codex: catalog } }); let tree = render(); navClick(tree, '에이전트 목록', agent.name); tree = render(); button(tree, '에이전트 설정').props.onPress(); tree = render(); component(tree, 'AgentAvatarEditor').props.onPrompt('보존할 사진 프롬프트'); tree = render();
  invoke = async () => { throw new Error('이전 API 키체인 오류'); }; component(tree, 'AgentAvatarEditor').props.onGenerate(); await tick(); tree = render(); assert.match(component(tree, 'AgentAvatarEditor').props.error, /키체인/);
  elements(tree).find(node => node.props['aria-label'] === '역할과 지시').props.onChange({ target: { value: '입력 중인 역할' } }); tree = render(); assert.match(component(tree, 'AgentAvatarEditor').props.error, /키체인/);
  component(tree, 'AgentConnectionsEditor').props.onChange([{ connectionId: 'codex', model: 'fixture-codex', effort: 'low' }]); tree = render(); assert.equal(component(tree, 'AgentAvatarEditor').props.error, '');
  invoke = async () => { throw new Error('이전 이미지 모드 오류'); }; component(tree, 'AgentAvatarEditor').props.onGenerate(); await tick(); tree = render(); assert.match(component(tree, 'AgentAvatarEditor').props.error, /이미지 모드/);
  component(tree, 'AgentAvatarEditor').props.onMode('illustration'); tree = render(); assert.equal(component(tree, 'AgentAvatarEditor').props.error, ''); assert.equal(component(tree, 'AgentAvatarEditor').props.prompt, '보존할 사진 프롬프트'); assert.equal(elements(tree).find(node => node.props['aria-label'] === '역할과 지시').props.value, '입력 중인 역할');
});

test('delayed API save acknowledgement cannot erase newer connection edits or a replacement API key', async () => {
  const render = fixture(); let tree = render(); button(tree, '설정').props.onPress(); tree = render();
  for (const [label, value] of [['연결 이름', '전송할 연결'], ['모델 ID', 'first-model'], ['API 키', 'submitted-key']]) { elements(tree).find(node => node.props.label === label).props.onChange({ target: { value } }); tree = render(); }
  let finish, savedId; invoke = async (method, args) => { if (method === 'saveProfile') { savedId = args.profile.id; return new Promise(resolve => { finish = resolve; }); } return state; };
  button(tree, '연결 저장').props.onPress(); tree = render();
  for (const [label, value] of [['연결 이름', '저장 대기 중 수정'], ['모델 ID', 'later-model'], ['API 키', 'later-key']]) { elements(tree).find(node => node.props.label === label).props.onChange({ target: { value } }); tree = render(); }
  finish({}); await tick(); tree = render(); assert.equal(elements(tree).find(node => node.props.label === '연결 이름').props.value, '저장 대기 중 수정'); assert.equal(elements(tree).find(node => node.props.label === '모델 ID').props.value, 'later-model'); assert.equal(elements(tree).find(node => node.props.label === 'API 키').props.value, 'later-key');
  let laterSave; invoke = async (method, args) => { if (method === 'saveProfile') laterSave = args; return state; }; button(tree, '연결 저장').props.onPress(); await tick(); assert.equal(laterSave.profile.id, savedId); assert.equal(laterSave.apiKey, 'later-key');
});

test('a delayed team save cannot pull the user out of another selected team', async () => {
  const second = { ...team, id: 'second', name: '다른 팀' }, snapshot = { ...state, teams: [team, second] }, render = fixture(snapshot); let tree = render(); navClick(tree, '협업 팀 목록', team.name); tree = render(); button(tree, '팀 설정').props.onPress(); tree = render();
  component(tree, 'TeamEditor').props.onChange({ ...component(tree, 'TeamEditor').props.draft, name: '저장할 팀' }); tree = render(); let finish; invoke = async () => new Promise(resolve => { finish = resolve; }); component(tree, 'TeamEditor').props.onSave(); tree = render(); navClick(tree, '협업 팀 목록', second.name); tree = render();
  assert.equal(component(tree, 'TeamChat').props.team.id, second.id); finish({ ...snapshot, teams: [{ ...team, name: '저장할 팀' }, second] }); await tick(); tree = render(); assert.equal(component(tree, 'TeamChat').props.team.id, second.id);
});

test('bounded team selection stress: 25 renderer remounts preserve independent drafts through 100 team switches', t => {
  const other = { ...team, id: 'other', name: '두 번째 팀' }, otherRun = { ...completed, id: 'other-run', teamId: other.id }, disk = memoryStorage(), snapshot = { ...state, teams: [team, other], teamRuns: [completed, otherRun], sessions: Array.from({ length: 250 }, (_, index) => session(`history-${index}`, { messages: Array.from({ length: 50 }, (_, at) => ({ id: `${index}-${at}`, role: 'user', text: 'history', status: 'completed' })) })) };
  for (let index = 0; index < 25; index++) {
    const render = fixture(snapshot, disk); let tree = render(); navClick(tree, '협업 팀 목록', team.name); tree = render(); if (index) assert.equal(component(tree, 'TeamChat').props.prompt, `first-${index - 1}`); component(tree, 'TeamChat').props.onPrompt(`first-${index}`);
    tree = render(); navClick(tree, '협업 팀 목록', other.name); tree = render(); if (index) assert.equal(component(tree, 'TeamChat').props.prompt, `other-${index - 1}`); component(tree, 'TeamChat').props.onPrompt(`other-${index}`);
    tree = render(); navClick(tree, '협업 팀 목록', team.name); tree = render(); assert.equal(component(tree, 'TeamChat').props.prompt, `first-${index}`); navClick(tree, '협업 팀 목록', other.name); tree = render(); assert.equal(component(tree, 'TeamChat').props.prompt, `other-${index}`);
  }
  t.diagnostic('bounded hook-host fixture: 250 sessions × 50 messages, 25 renderer remounts, 100 team switches, two independent persisted team drafts');
});

test('delayed API save leaves a newly opened connection form alone', async () => {
  const render = fixture(); let tree = render(); button(tree, '설정').props.onPress(); tree = render();
  for (const [label, value] of [['연결 이름', '원래 연결'], ['모델 ID', 'old-model']]) { elements(tree).find(node => node.props.label === label).props.onChange({ target: { value } }); tree = render(); }
  let finish; invoke = async method => method === 'saveProfile' ? new Promise(resolve => { finish = resolve; }) : state; button(tree, '연결 저장').props.onPress(); tree = render(); button(tree, '새 연결').props.onPress(); tree = render(); elements(tree).find(node => node.props.label === '연결 이름').props.onChange({ target: { value: '다른 새 연결' } }); tree = render();
  finish({}); await tick(); tree = render(); assert.equal(elements(tree).find(node => node.props.label === '연결 이름').props.value, '다른 새 연결'); assert.equal(elements(tree).find(node => node.props.label === '모델 ID').props.value, '');
});

test('a delayed agent save preserves the newly selected editor and keeps recording that editor changes', async () => {
  const second = { ...agent, id: 'second-agent', name: '두 번째 에이전트' }, snapshot = { ...state, agents: [agent, second], profiles: [{ id: 'api', model: 'fixture', name: 'API' }] }, disk = memoryStorage(), render = fixture(snapshot, disk); let tree = render();
  navClick(tree, '에이전트 목록', agent.name); tree = render(); button(tree, '에이전트 설정').props.onPress(); tree = render(); elements(tree).find(node => node.props.label === '에이전트 이름').props.onChange({ target: { value: '저장할 이름' } }); tree = render();
  let finish; invoke = async () => new Promise(resolve => { finish = resolve; }); button(tree, '에이전트 저장').props.onPress(); tree = render(); navClick(tree, '에이전트 목록', second.name); tree = render(); button(tree, '에이전트 설정').props.onPress(); tree = render();
  finish({ ...snapshot, agents: [{ ...agent, name: '저장할 이름' }, second] }); await tick(); tree = render(); assert.equal(elements(tree).find(node => node.props.label === '에이전트 이름').props.value, second.name);
  elements(tree).find(node => node.props['aria-label'] === '역할과 지시').props.onChange({ target: { value: '두 번째에서 계속 작성' } }); assert.equal(JSON.parse(disk.getItem('venditbot.drafts.v1.agent-edits'))[second.id].draft.instructions, '두 번째에서 계속 작성');
});

test('damaged draft recovery exposes the original and resumes persistence only after explicit preservation', () => {
  const disk = memoryStorage(), original = 'broken original with <script>text</script>'; disk.setItem('venditbot.drafts.v1.prompts', original); let render = fixture(state, disk), tree = render();
  assert.match(text(tree), /원본은 유지/); button(tree, '초안 보기').props.onPress(); tree = render(); let recovery = component(tree, 'DraftRecovery'); assert.equal(recovery.props.originals[0].text, original); assert.equal(recovery.props.originals[0].preserved, false);
  recovery.props.originals[0].onPreserve(); tree = render(); assert.equal(component(tree, 'DraftRecovery').props.originals[0].preserved, true); assert.doesNotMatch(text(tree), /원본은 유지하며 업데이트를 막았습니다/);
  render = fixture(state, disk); tree = render(); button(tree, '초안 보기').props.onPress(); tree = render(); recovery = component(tree, 'DraftRecovery'); assert.equal(recovery.props.originals[0].text, original); assert.equal(recovery.props.originals[0].preserved, true);
});

test('avatar requests stay scoped to their agent while another agent queues, cancels and edits its own profile', async () => {
  const other = { ...agent, id: 'other-avatar-agent', name: '다른 사진 에이전트' }, disk = memoryStorage(), snapshot = { ...state, agents: [agent, other], profiles: [{ id: 'api', name: 'API', model: 'fixture', hasKey: true }] };
  const render = fixture(snapshot, disk); let tree = render(); const pending = new Map(), requests = [], cancelled = [];
  invoke = async (method, args) => { if (method === 'generateAgentAvatar') { requests.push(args); return new Promise((resolve, reject) => pending.set(args.requestId, { resolve, reject })); } if (method === 'cancelAgentAvatar') { cancelled.push(args.requestId); pending.get(args.requestId).reject(new Error('이 요청을 취소했습니다.')); return { cancelled: true }; } return {}; };
  const edit = name => { navClick(tree, '에이전트 목록', name); tree = render(); button(tree, '에이전트 설정').props.onPress(); tree = render(); };
  edit(agent.name); component(tree, 'AgentAvatarEditor').props.onPrompt('첫 번째 파란 사진'); tree = render(); component(tree, 'AgentAvatarEditor').props.onGenerate(); tree = render(); assert.equal(component(tree, 'AgentAvatarEditor').props.busy, true);
  edit(other.name); let avatar = component(tree, 'AgentAvatarEditor'); assert.equal(avatar.props.busy, false); assert.equal(avatar.props.disabled, false); assert.equal(avatar.props.error, undefined);
  avatar.props.onPrompt('두 번째 노란 사진'); tree = render(); component(tree, 'AgentAvatarEditor').props.onGenerate(); tree = render(); assert.equal(requests.length, 2); assert.notEqual(requests[0].requestId, requests[1].requestId); assert.equal(requests[0].ownerKey, `agent:${agent.id}`); assert.equal(requests[1].ownerKey, `agent:${other.id}`);
  pending.get(requests[0].requestId).resolve({ id: 'first-result', dataUrl: 'data:image/png;base64,first', kind: 'image', createdAt: '2026-01-01' }); await tick(); tree = render(); avatar = component(tree, 'AgentAvatarEditor'); assert.equal(avatar.props.name, other.name); assert.equal(avatar.props.busy, true); assert.equal(avatar.props.url, undefined); assert.equal(avatar.props.prompt, '두 번째 노란 사진');
  avatar.props.onCancel(); await tick(); tree = render(); assert.deepEqual(cancelled, [requests[1].requestId]); assert.match(component(tree, 'AgentAvatarEditor').props.error, /이 요청을 취소/); assert.equal(component(tree, 'AgentAvatarEditor').props.busy, false);
  const saved = JSON.parse(disk.getItem('venditbot.drafts.v1.agent-edits')); assert.equal(saved[agent.id].draft.avatarId, 'first-result'); assert.equal(saved[other.id].draft.avatarId, undefined); assert.equal(saved[other.id].avatarPrompt, '두 번째 노란 사진');
  edit(agent.name); avatar = component(tree, 'AgentAvatarEditor'); assert.equal(avatar.props.url, 'data:image/png;base64,first', JSON.stringify(avatar.props)); assert.equal(avatar.props.error, undefined); assert.equal(avatar.props.busy, false);
});

test('agent menu clone pins the source ID and delayed completion preserves another selected editor', async () => {
  const second = { ...agent, id: 'other-menu', name: '다른 에이전트' }, render = fixture({ ...state, agents: [agent, second] }); let tree = render();
  component(tree, 'AgentSidebarCards').props.onMenu(agent.id); tree = render(); const menu = component(tree, 'AgentMenu'); assert.equal(menu.props.agent.name, agent.name);
  let finish, args; invoke = async (_method, input) => { args = input; return new Promise(resolve => { finish = resolve; }); }; menu.props.onClone();
  navClick(tree, '에이전트 목록', second.name); tree = render(); button(tree, '에이전트 설정').props.onPress(); tree = render();
  const cloned = { ...agent, id: 'clone', name: '내 에이전트의 복제본' }; finish({ state: { ...state, agents: [cloned, agent, second] }, agent: cloned }); await tick(); tree = render();
  assert.equal(args.id, agent.id); assert.equal(args.expectedUpdatedAt, agent.updatedAt); assert.equal(elements(tree).find(node => node.props.label === '에이전트 이름').props.value, second.name); assert.ok(component(tree, 'AgentSidebarCards').props.agents.some(item => item.id === cloned.id));
});

test('policy drafts survive renderer restart and agent automation selection survives a saved edit', async () => {
  const policy = { id: 'policy', name: '일상 업무', description: '설명', defaultTaskKind: 'standard', rules: ['routine', 'standard', 'complex'].map(taskKind => ({ taskKind, keywords: [], connections: [{ connectionId: 'api', model: 'fixture' }] })), createdAt: '2026-01-01', updatedAt: '2026-01-02' }, disk = memoryStorage(), snapshot = { ...state, policies: [policy], profiles: [{ id: 'api', name: 'API', model: 'fixture', hasKey: true }] };
  let render = fixture(snapshot, disk), tree = render(); button(tree, '설정').props.onPress(); tree = render(); button(tree, '작업 정책').props.onPress(); tree = render();
  let editor = component(tree, 'PolicySettings'); editor.props.onEdit(policy.id); tree = render(); editor = component(tree, 'PolicySettings'); editor.props.onChange({ ...editor.props.record, draft: { ...editor.props.record.draft, name: '저장 전 새 이름' }, previewText: '아직 미리보기 전 요청' });
  render = fixture(snapshot, disk); tree = render(); button(tree, '초안 보기').props.onPress(); tree = render(); component(tree, 'DraftRecovery').props.onPolicy(policy.id); tree = render(); editor = component(tree, 'PolicySettings'); assert.equal(editor.props.record.draft.name, '저장 전 새 이름'); assert.equal(editor.props.record.expectedUpdatedAt, policy.updatedAt); assert.equal(editor.props.record.previewText, '아직 미리보기 전 요청');
  navClick(tree, '에이전트 목록', agent.name); tree = render(); button(tree, '에이전트 설정').props.onPress(); tree = render(); component(tree, 'AgentAutomationPicker').props.onChange(policy.id); tree = render();
  let request; invoke = async (_method, args) => { request = args; return { ...snapshot, agents: [{ ...agent, automation: { policyId: policy.id } }] }; }; button(tree, '에이전트 저장').props.onPress(); await tick(); assert.equal(request.agent.automation.policyId, policy.id);
});

test('policy save validates all three routes, sends the revision and preserves edits entered while saving', async () => {
  const policy = { id: 'policy', name: '작업 정책', description: '', defaultTaskKind: 'standard', rules: ['routine', 'standard', 'complex'].map(taskKind => ({ taskKind, keywords: [], connections: [{ connectionId: 'api', model: 'fixture' }] })), createdAt: '2026-01-01', updatedAt: '2026-01-02' }, snapshot = { ...state, policies: [policy], profiles: [{ id: 'api', name: 'API', model: 'fixture', hasKey: true }] }, disk = memoryStorage(), render = fixture(snapshot, disk);
  let tree = render(); button(tree, '설정').props.onPress(); tree = render(); button(tree, '작업 정책').props.onPress(); tree = render(); component(tree, 'PolicySettings').props.onEdit(policy.id); tree = render(); let editor = component(tree, 'PolicySettings');
  editor.props.onChange({ ...editor.props.record, draft: { ...editor.props.record.draft, name: '전송할 이름' } }); tree = render(); let request, finish;
  invoke = async (_method, args) => { request = args; return new Promise(resolve => { finish = resolve; }); }; component(tree, 'PolicySettings').props.onSave(); tree = render(); editor = component(tree, 'PolicySettings'); editor.props.onChange({ ...editor.props.record, draft: { ...editor.props.record.draft, name: '저장 대기 중 수정' } });
  finish({ ...snapshot, policies: [{ ...policy, name: '전송할 이름', updatedAt: '2026-01-03' }] }); await tick(); tree = render(); editor = component(tree, 'PolicySettings');
  assert.equal(request.expectedUpdatedAt, policy.updatedAt); assert.equal(request.policy.rules.length, 3); assert.ok(request.policy.rules.every(rule => rule.connections[0].model === 'fixture')); assert.equal(editor.props.record.draft.name, '저장 대기 중 수정'); assert.match(editor.props.conflict, /정책이 변경/); assert.equal(JSON.parse(disk.getItem('venditbot.drafts.v1.policy-edits')).policy.draft.name, '저장 대기 중 수정');
});

test('delayed policy preview cannot display the previous policy result in another editor', async () => {
  const policy = { id: 'one', name: '첫 정책', description: '', defaultTaskKind: 'standard', rules: ['routine', 'standard', 'complex'].map(taskKind => ({ taskKind, keywords: [], connections: [{ connectionId: 'api', model: 'fixture' }] })), createdAt: '2026-01-01', updatedAt: '2026-01-02' }, second = { ...policy, id: 'two', name: '다른 정책' }, snapshot = { ...state, policies: [policy, second], agents: [{ ...agent, automation: { policyId: policy.id } }] }, render = fixture(snapshot);
  let tree = render(); button(tree, '설정').props.onPress(); tree = render(); button(tree, '작업 정책').props.onPress(); tree = render(); component(tree, 'PolicySettings').props.onEdit(policy.id); tree = render(); let editor = component(tree, 'PolicySettings'); editor.props.onChange({ ...editor.props.record, previewAgentId: agent.id, previewText: '샘플 요청' }); tree = render();
  let finish; invoke = async () => new Promise(resolve => { finish = resolve; }); component(tree, 'PolicySettings').props.onPreview(); tree = render(); component(tree, 'PolicySettings').props.onEdit(second.id); tree = render(); finish({ policyId: policy.id, policyName: policy.name, reason: '첫 결과', taskKind: 'standard', connections: policy.rules[0].connections, policyUpdatedAt: policy.updatedAt }); await tick(); tree = render(); assert.equal(component(tree, 'PolicySettings').props.editKey, second.id); assert.equal(component(tree, 'PolicySettings').props.preview, undefined);
});

test('team menu cloning keeps membership reusable and opens the returned team without copying its run history', async () => {
  const render = fixture(); let tree = render(); component(tree, 'TeamSidebarCards').props.onMenu(team.id); tree = render(); const menu = elements(tree).find(node => node.type?.name === 'AgentMenu' && node.props.kind === '팀');
  const clone = { ...team, id: 'team-clone', name: `${team.name}의 복제본` }; let request; invoke = async (method, args) => { request = { method, args }; return { state: { ...state, teams: [clone, team] }, team: clone }; };
  menu.props.onClone(); await tick(); tree = render(); assert.equal(request.method, 'cloneTeam'); assert.equal(request.args.id, team.id); assert.deepEqual(component(tree, 'TeamEditor').props.draft.memberAgentIds, team.memberAgentIds); assert.equal(component(tree, 'TeamEditor').props.draft.id, clone.id);
});

test('rules editor persists unfinished paths, saves with CAS and preserves a newer edit after delayed acknowledgement', async () => {
  const disk = memoryStorage(), snapshot = { ...state, actionRules: structuredClone(DEFAULT_ACTION_RULES) }; let render = fixture(snapshot, disk), tree = render();
  button(tree, '설정').props.onPress(); tree = render(); button(tree, '규칙').props.onPress(); tree = render(); let editor = component(tree, 'ActionRulesSettings');
  editor.props.onChange({ ...editor.props.record, rules: { ...editor.props.record.rules, protectedPaths: [{ id: 'path', pathPrefix: '', mode: 'ask' }] } });
  render = fixture(snapshot, disk); tree = render(); button(tree, '초안 보기').props.onPress(); tree = render(); component(tree, 'DraftRecovery').props.onRules(); tree = render(); editor = component(tree, 'ActionRulesSettings'); assert.equal(editor.props.record.rules.protectedPaths[0].pathPrefix, '');
  editor.props.onChange({ ...editor.props.record, rules: { ...editor.props.record.rules, protectedPaths: [{ id: 'path', pathPrefix: 'docs/private', mode: 'ask' }] } }); tree = render(); let request, finish;
  invoke = async (method, args) => { request = { method, args }; return new Promise(resolve => { finish = resolve; }); }; component(tree, 'ActionRulesSettings').props.onSave(); tree = render(); editor = component(tree, 'ActionRulesSettings'); editor.props.onChange({ ...editor.props.record, rules: { ...editor.props.record.rules, defaultMode: 'ask' } });
  finish({ ...snapshot, actionRules: { ...request.args.rules, updatedAt: '2026-10-12T00:00:00.000Z' } }); await tick(); tree = render(); editor = component(tree, 'ActionRulesSettings');
  assert.equal(request.method, 'saveActionRules'); assert.equal(request.args.expectedUpdatedAt, DEFAULT_ACTION_RULES.updatedAt); assert.equal(request.args.rules.protectedPaths[0].pathPrefix, 'docs/private'); assert.equal(editor.props.record.rules.defaultMode, 'ask'); assert.match(editor.props.conflict, /규칙이 변경/); assert.equal(JSON.parse(disk.getItem('venditbot.drafts.v1.action-rules')).current.rules.defaultMode, 'ask');
});

test('Rabbit has a separate connection section with durable recovery and key or pending-request update guards', async () => {
  const disk = memoryStorage(), snapshot = { ...state, rabbitConnections: [], rabbitRuns: [], update: { phase: 'available', currentVersion: '0.2.1', version: '0.3.0' } };
  let render = fixture(snapshot, disk), tree = render(); button(tree, '설정').props.onPress(); tree = render(); button(tree, '프로젝트 레인 API(Rabbit)').props.onPress(); tree = render();
  let rabbit = component(tree, 'RabbitSettings'); assert.ok(rabbit.props.active); assert.ok(button(tree, 'AI 모델 API'));
  rabbit.props.onEdits({ new: { draft: { name: '보관한 Rabbit 연결', baseUrl: '', projectId: '', baseRef: 'main', workflowTemplate: 'feature_pr', maxParallelTasks: 1, timeoutSeconds: 3600, enabledForAgents: false }, endpoint: '', expectedUpdatedAt: '' } });
  rabbit.props.onWork({ rabbit: { objective: '저장한 원격 작업 목표', criteria: '관련 테스트 통과' } }); rabbit.props.onGuard({ keyDirty: true, pending: false }); tree = render();
  assert.match(component(tree, 'UpdateControl').props.blockedReason, /연결 설정/); let calls = 0; invoke = async () => { calls++; }; component(tree, 'UpdateControl').props.onInstall(); await tick(); assert.equal(calls, 0);
  component(tree, 'RabbitSettings').props.onGuard({ keyDirty: false, pending: true }); tree = render(); assert.match(component(tree, 'UpdateControl').props.blockedReason, /Rabbit 요청/);
  render = fixture(snapshot, disk); tree = render(); rabbit = component(tree, 'RabbitSettings'); assert.equal(rabbit.props.edits.new.draft.name, '보관한 Rabbit 연결'); assert.equal(rabbit.props.work.rabbit.objective, '저장한 원격 작업 목표'); assert.match(text(tree), /초안 2개/);
  button(tree, '초안 보기').props.onPress(); tree = render(); const recovery = component(tree, 'DraftRecovery'); assert.equal(recovery.props.extras.length, 2); assert.doesNotMatch(JSON.stringify(recovery.props.extras), /apiKey/); recovery.props.extras[0].onContinue(); tree = render(); assert.ok(component(tree, 'RabbitSettings').props.active);
});

test('unsaved Rabbit receipt records block installation and remain reachable for explicit export', async () => {
  const snapshot = { ...state, unsavedRabbitRunIds: ['receipt'], update: { phase: 'available', currentVersion: '0.2.1', version: '0.3.0' } }, render = fixture(snapshot), calls = [];
  invoke = async (...args) => { calls.push(args); return { saved: true }; };
  let tree = render(); assert.equal(component(tree, 'UpdateControl').props.unsaved, true); component(tree, 'UpdateControl').props.onInstall(); await tick(); assert.equal(calls.length, 0);
  tree = render(); button(tree, 'Rabbit 기록 내보내기').props.onPress(); await tick(); assert.deepEqual(calls[0], ['exportRabbitRun', { id: 'receipt' }]);
  button(render(), 'Rabbit 작업 열기').props.onPress(); assert.ok(component(render(), 'RabbitSettings').props.active);
});

test('only an actual install request shows preparation while IPC waits and rejected installs restore normal controls', async () => {
  const snapshot = { ...state, update: { phase: 'available', currentVersion: '0.3.3', version: 'next' } };
  const render = fixture(snapshot); let rejectInstall, releaseCheck; const calls = [];
  invoke = async method => { calls.push(method); if (method === 'installUpdate') return new Promise((_, reject) => { rejectInstall = reject; }); if (method === 'checkUpdate') return new Promise(resolve => { releaseCheck = resolve; }); return snapshot; };
  let tree = render(); component(tree, 'UpdateControl').props.onCheck(); tree = render();
  assert.equal(component(tree, 'UpdateControl').props.busy, true); assert.equal(component(tree, 'UpdateControl').props.installRequested, false);
  releaseCheck(); await tick(); tree = render();
  component(tree, 'UpdateControl').props.onInstall(); tree = render();
  assert.equal(component(tree, 'UpdateControl').props.installRequested, true); assert.equal(calls.filter(method => method === 'installUpdate').length, 1);
  rejectInstall(new Error('실행 중인 작업 때문에 설치를 준비할 수 없습니다.')); await tick(); tree = render();
  assert.equal(component(tree, 'UpdateControl').props.installRequested, false); assert.equal(component(tree, 'UpdateControl').props.busy, false);
  assert.match(text(tree), /실행 중인 작업 때문에 설치를 준비할 수 없습니다/);
});

test('efficiency preset applies only to the selected rule, survives reload, and is persisted by explicit save', async () => {
  const policy = { id: 'policy', name: '루틴 절약', description: '', defaultTaskKind: 'standard', rules: ['routine','standard','complex'].map(taskKind => ({ taskKind, keywords: [], connections: [{ connectionId: 'api', model: 'fixture' }] })), createdAt: '2026-01-01', updatedAt: '2026-01-02' };
  const snapshot = { ...state, policies: [policy], profiles: [{ id: 'api', name: 'API', model: 'fixture', hasKey: true }] }, disk = memoryStorage(); let render = fixture(snapshot, disk), tree = render();
  button(tree, '설정').props.onPress(); tree = render(); button(tree, '작업 정책').props.onPress(); tree = render(); component(tree, 'PolicySettings').props.onEdit(policy.id); tree = render();
  const result = { keywords: ['상태 확인'], connections: [{ connectionId: 'api', model: 'fixture' }], efficiency: { preset: 'status_check', maxHistoryTurns: 1, maxHistoryCharacters: 4000 } }, calls = [];
  invoke = async (method, args) => { calls.push([method, args]); return result; }; component(tree, 'PolicySettings').props.onApplyEfficiencyPreset('routine', 'status_check'); await tick(); tree = render();
  assert.deepEqual(calls, [['policyEfficiencyPreset', { preset: 'status_check', connections: policy.rules[0].connections }]]);
  assert.deepEqual(component(tree, 'PolicySettings').props.record.draft.rules[0], { taskKind: 'routine', ...result }); assert.deepEqual(component(tree, 'PolicySettings').props.record.draft.rules.slice(1), policy.rules.slice(1));
  render = fixture(snapshot, disk); tree = render(); button(tree, '초안 보기').props.onPress(); tree = render(); component(tree, 'DraftRecovery').props.onPolicy(policy.id); tree = render(); assert.deepEqual(component(tree, 'PolicySettings').props.record.draft.rules[0].efficiency, result.efficiency);
  invoke = async (method, args) => { calls.push([method, args]); return { ...snapshot, policies: [{ ...policy, ...args.policy }] }; }; component(tree, 'PolicySettings').props.onSave(); await tick(); assert.equal(calls.at(-1)[0], 'savePolicy'); assert.deepEqual(calls.at(-1)[1].policy.rules[0].efficiency, result.efficiency);
});

test('late efficiency discovery cannot overwrite newer draft input or another policy editor', async () => {
  for (const change of ['input', 'policy']) {
    const policy = { id: 'one', name: '기존 정책', description: '', defaultTaskKind: 'standard', rules: ['routine','standard','complex'].map(taskKind => ({ taskKind, keywords: [], connections: [{ connectionId: 'api', model: 'fixture' }] })), createdAt: '2026-01-01', updatedAt: '2026-01-02' }, second = { ...policy, id: 'two', name: '다른 정책' };
    const render = fixture({ ...state, policies: [policy, second] }); let tree = render(); button(tree, '설정').props.onPress(); tree = render(); button(tree, '작업 정책').props.onPress(); tree = render(); component(tree, 'PolicySettings').props.onEdit(policy.id); tree = render();
    let finish; invoke = async () => new Promise(resolve => { finish = resolve; }); component(tree, 'PolicySettings').props.onApplyEfficiencyPreset('routine', 'status_check'); tree = render();
    const editor = component(tree, 'PolicySettings'); if (change === 'policy') editor.props.onEdit(second.id); else editor.props.onChange({ ...editor.props.record, draft: { ...editor.props.record.draft, name: '새 입력 유지' } });
    finish({ keywords: ['상태'], connections: [], efficiency: { preset: 'status_check', maxHistoryTurns: 1, maxHistoryCharacters: 4000 } }); await tick(); tree = render();
    assert.equal(component(tree, 'PolicySettings').props.record.draft.name, change === 'policy' ? second.name : '새 입력 유지'); assert.equal(component(tree, 'PolicySettings').props.record.draft.rules[0].efficiency, undefined);
  }
});

test('agent default and per-team Rabbit project settings reach save IPC and survive local draft recovery', async () => {
  const development = { mode: 'rabbit', connectionId: 'rabbit-project' }, snapshot = { ...state, profiles: [{ id: 'api', name: 'API', model: 'fixture', hasKey: true }] }, disk = memoryStorage(); let render = fixture(snapshot, disk), tree = render();
  navClick(tree, '에이전트 목록', agent.name); tree = render(); button(tree, '에이전트 설정').props.onPress(); tree = render(); component(tree, 'DevelopmentRoutingPicker').props.onChange(development); tree = render();
  let saved; invoke = async (method, args) => { saved = [method, args]; return { ...snapshot, agents: [{ ...agent, ...args.agent }] }; }; button(tree, '에이전트 저장').props.onPress(); await tick(); assert.equal(saved[0], 'saveAgent'); assert.deepEqual(saved[1].agent.development, development);
  tree = render(); navClick(tree, '협업 팀 목록', team.name); tree = render(); button(tree, '팀 설정').props.onPress(); tree = render(); const editor = component(tree, 'TeamEditor'); editor.props.onChange({ ...editor.props.draft, development });
  render = fixture(snapshot, disk); tree = render(); button(tree, '초안 보기').props.onPress(); tree = render(); component(tree, 'DraftRecovery').props.onTeam(team.id); tree = render(); assert.deepEqual(component(tree, 'TeamEditor').props.draft.development, development);
  invoke = async (method, args) => { saved = [method, args]; return { ...snapshot, teams: [{ ...team, ...args.team }] }; }; component(tree, 'TeamEditor').props.onSave(); await tick(); assert.equal(saved[0], 'saveTeam'); assert.deepEqual(saved[1].team.development, development);
});

const appAttachmentA={id:'11111111-1111-4111-8111-111111111111',name:'submitted.txt',kind:'text',mimeType:'text/plain',bytes:4,sha256:'a'.repeat(64)};
const appAttachmentB={...appAttachmentA,id:'22222222-2222-4222-8222-222222222222',name:'next.txt'};
const attachmentList=tree=>elements(tree).find(n=>n.type?.name==='AttachmentList'&&n.props.onRemove);
test('new agent conversation keeps newly staged attachment beside the later draft after first send completes',async()=>{
 const render=fixture();let tree=render();navClick(tree,'에이전트 목록',agent.name);tree=render();
 let finish;const calls=[];invoke=async(method,args)=>{calls.push([method,args]);if(method==='selectChatAttachments')return calls.filter(c=>c[0]===method).length===1?[appAttachmentA]:[appAttachmentB];if(method==='createSession')return new Promise(resolve=>finish=resolve);return {};};
 composer(tree).onChooseAttachments();await tick();tree=render();composer(tree).onChange('first');tree=render();composer(tree).onSend();await tick();
 tree=render();composer(tree).onChange('next draft');tree=render();composer(tree).onChooseAttachments();await tick();tree=render();assert.deepEqual(attachmentList(tree).props.files,[appAttachmentA,appAttachmentB]);
 finish(session('created'));await tick();tree=render();assert.equal(composer(tree).value,'next draft');assert.deepEqual(calls.find(c=>c[0]==='send')[1].attachmentIds,[appAttachmentA.id]);
 assert.deepEqual(attachmentList(tree).props.files,[appAttachmentB]);
});
test('new team run keeps newly staged attachment beside the later draft after accepted send',async()=>{
 const render=fixture({...state,teamRuns:[]});let tree=render();navClick(tree,'협업 팀 목록',team.name);tree=render();let finish;let picks=0;
 invoke=async(method,args)=>{if(method==='selectChatAttachments')return ++picks===1?[appAttachmentA]:[appAttachmentB];if(method==='startTeamRun')return new Promise(resolve=>finish=resolve);return {};};
 component(tree,'TeamChat').props.onChooseAttachments();await tick();tree=render();component(tree,'TeamChat').props.onPrompt('first');tree=render();component(tree,'TeamChat').props.onSend();await tick();
 tree=render();component(tree,'TeamChat').props.onPrompt('next draft');tree=render();component(tree,'TeamChat').props.onChooseAttachments();await tick();tree=render();assert.deepEqual(component(tree,'TeamChat').props.attachments,[appAttachmentA,appAttachmentB]);
 finish({...completed,id:'created-run',status:'running'});await tick();tree=render();assert.equal(component(tree,'TeamChat').props.prompt,'next draft');assert.deepEqual(component(tree,'TeamChat').props.attachments,[appAttachmentB]);
});
test('reselecting the same agent or team increments the actual App composer focus request',()=>{
 const render=fixture();let tree=render();navClick(tree,'에이전트 목록',agent.name);tree=render();const agentFocus=composer(tree).focusRequest;navClick(tree,'에이전트 목록',agent.name);tree=render();assert.ok(composer(tree).focusRequest>agentFocus);
 navClick(tree,'협업 팀 목록',team.name);tree=render();const teamFocus=component(tree,'TeamChat').props.focusRequest;navClick(tree,'협업 팀 목록',team.name);tree=render();assert.ok(component(tree,'TeamChat').props.focusRequest>teamFocus);
});

test('a picker completing after first-session promotion never aliases a later new agent draft; a busy drop does not read or stage bytes',async()=>{
 const render=fixture();let tree=render();navClick(tree,'에이전트 목록',agent.name);tree=render();
 let finishCreate,finishPicker,picks=0,dropRead=false;const calls=[];const later={...appAttachmentA,id:'33333333-3333-4333-8333-333333333333',name:'separate-new-draft.txt'};
 invoke=async(method,args)=>{calls.push([method,args]);if(method==='createSession')return new Promise(resolve=>finishCreate=resolve);if(method==='selectChatAttachments')return ++picks===1?new Promise(resolve=>finishPicker=resolve):[later];return {};};
 composer(tree).onChange('first without attachments');tree=render();composer(tree).onSend();await tick();tree=render();composer(tree).onChooseAttachments();await tick();tree=render();
 const main=elements(tree).find(n=>n.type==='main'),transfer={types:['Files'],files:[{name:'not-read.txt',size:4,arrayBuffer(){dropRead=true;return Promise.resolve(new ArrayBuffer(4));}}]};
 main.props.onDragOver({dataTransfer:transfer,preventDefault(){}});assert.equal(transfer.dropEffect,'none');main.props.onDrop({dataTransfer:transfer,preventDefault(){}});await tick();assert.equal(dropRead,false);assert.ok(!calls.some(c=>c[0]==='stageChatAttachments'));
 finishCreate(session('created'));await tick();tree=render();button(elements(tree).find(n=>n.type==='header'),'새 대화').props.onPress();tree=render();assert.deepEqual(attachmentList(tree).props.files,[]);
 finishPicker([appAttachmentB]);await tick();tree=render();assert.deepEqual(attachmentList(tree).props.files,[]);composer(tree).onChooseAttachments();await tick();tree=render();assert.deepEqual(attachmentList(tree).props.files,[later]);
 const stored=JSON.parse(window.localStorage.getItem('venditbot.drafts.v1.chat-attachments'));assert.deepEqual(stored['session:created'],[appAttachmentB]);assert.deepEqual(stored['agent:agent'],[later]);
 navClick(tree,'에이전트 목록',agent.name);tree=render();assert.deepEqual(attachmentList(tree).props.files,[appAttachmentB]);assert.deepEqual(calls.find(c=>c[0]==='send'),['send',{requestId:calls.find(c=>c[0]==='send')[1].requestId,sessionId:'created',text:'first without attachments'}]);
});

test('active conversation accepts consecutive messages without cancelling its response and preserves later edits until acknowledgement',async()=>{
 const render=fixture({...state,sessions:[session('active')],queue:{running:['active'],queued:[]},activeRun:{sessionId:'active'}},memoryStorage(),{initialSessionId:'active',initialAgentId:agent.id}),calls=[];let release;
 invoke=async(method,args)=>{calls.push([method,args]);if(method==='send'&&calls.length===1)return new Promise(done=>{release=done;});return {};};
 let tree=render();assert.equal(composer(tree).queueWhileRunning,true);assert.equal(typeof composer(tree).onCancel,'function');composer(tree).onChange('첫 다음 메시지');tree=render();composer(tree).onSend();await tick();
 tree=render();composer(tree).onChange('두 번째 다음 메시지');tree=render();assert.equal(composer(tree).value,'두 번째 다음 메시지');release({});await tick();tree=render();assert.equal(composer(tree).value,'두 번째 다음 메시지');composer(tree).onSend();await tick();
 assert.deepEqual(calls.map(([method,args])=>[method,args.text]),[['send','첫 다음 메시지'],['send','두 번째 다음 메시지']]);assert.notEqual(calls[0][1].requestId,calls[1][1].requestId);assert.equal(composer(render()).value,'');
});
test('uncertain send retains draft and durable request ID across renderer reload to prevent duplicate execution',async()=>{
 const disk=memoryStorage(),snapshot={...state,sessions:[session('retry')]},props={initialSessionId:'retry',initialAgentId:agent.id};let render=fixture(snapshot,disk,props),calls=[];
 invoke=async(method,args)=>{calls.push([method,args]);throw Error('acknowledgement lost');};let tree=render();composer(tree).onChange('보관할 메시지');tree=render();composer(tree).onSend();await tick();assert.equal(composer(render()).value,'보관할 메시지');const first=calls[0][1].requestId;
 render=fixture(snapshot,disk,props);invoke=async(method,args)=>{calls.push([method,args]);return {};};tree=render();composer(tree).onSend();await tick();assert.equal(calls[1][1].requestId,first);assert.equal(composer(render()).value,'');
});

test('playbook choice uses the real policy selector and survives draft reopen and save IPC',async()=>{
 const policy={id:'manual-policy',name:'매뉴얼',description:'',defaultTaskKind:'standard',rules:['routine','standard','complex'].map(taskKind=>({taskKind,keywords:[],connections:[{connectionId:'api',model:'fixture'}]})),createdAt:'2026-01-01',updatedAt:'2026-01-02'};
 const snapshot={...state,policies:[policy],profiles:[{id:'api',name:'API',model:'fixture',hasKey:true}]},disk=memoryStorage();let render=fixture(snapshot,disk),tree=render();button(tree,'설정').props.onPress();tree=render();button(tree,'작업 정책').props.onPress();tree=render();component(tree,'PolicySettings').props.onEdit(policy.id);tree=render();
 let editor=component(tree,'PolicySettings'),view=editor.type(editor.props),picker=elements(view).find(node=>node.props['aria-label']==='업무 매뉴얼 템플릿');assert.equal(elements(picker).filter(x=>x.type==='option').length,4);picker.props.onChange({target:{value:'bug-improvement-loop'}});render();
 render=fixture(snapshot,disk);tree=render();button(tree,'초안 보기').props.onPress();tree=render();component(tree,'DraftRecovery').props.onPolicy(policy.id);tree=render();editor=component(tree,'PolicySettings');assert.equal(editor.props.record.draft.playbookTemplateId,'bug-improvement-loop');
 let request;invoke=async(method,args)=>{assert.equal(method,'savePolicy');request=args;return {...snapshot,policies:[{...policy,...args.policy,updatedAt:'2026-01-03'}]};};editor.props.onSave();await tick();assert.equal(request.policy.playbookTemplateId,'bug-improvement-loop');
});
