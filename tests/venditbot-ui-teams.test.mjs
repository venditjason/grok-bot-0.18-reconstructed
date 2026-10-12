import assert from 'node:assert/strict';
import test from 'node:test';
import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { build } from 'esbuild';
const passthrough = tag => ({ children }) => React.createElement(tag, {}, children);
globalThis.window = { React, ReactDOM: { createRoot: () => ({ render() {} }) }, VDS: {
  VDSProvider: passthrough(React.Fragment), Button: ({ children, disabled, className, title, 'aria-label': label, 'aria-current': current }) => React.createElement('button', { disabled, className, title, 'aria-label': label, 'aria-current': current }, children), Badge: passthrough('span'), Icon: () => null,
  TextInput: ({ label, value, readOnly }) => React.createElement('label', {}, label, React.createElement('input', { 'aria-label': label, value, readOnly: readOnly ?? true })),
  TextArea: props => React.createElement('textarea', { 'aria-label': props['aria-label'], defaultValue: props.value }), Checkbox: () => React.createElement('input', { type: 'checkbox' }),
  Dialog: { Root: ({ open, children }) => open ? children : null, Portal: passthrough(React.Fragment), Content: passthrough('div'), Header: () => null, Footer: () => null },
} };
globalThis.document = { getElementById: () => ({}) };
async function bundle(path) { const built = await build({ entryPoints: [new URL(path, import.meta.url).pathname], bundle: true, platform: 'node', format: 'esm', jsx: 'transform', jsxFactory: 'React.createElement', jsxFragment: 'React.Fragment', write: false }); return await import(`data:text/javascript;base64,${Buffer.from(built.outputFiles[0].text).toString('base64')}`); }
const { App } = await bundle('../frontend/venditbot/app.tsx');
const { TeamEditor } = await bundle('../frontend/venditbot/teams-ui.tsx');
const { Markdown, MarkdownContent } = await bundle('../frontend/venditbot/markdown-view.tsx');
const { AgentAvatar, AgentAvatarEditor, defaultAvatarDataUrl } = await bundle('../frontend/venditbot/agent-avatar.tsx');
const { AgentSidebarCards, TeamSidebarCards } = await bundle('../frontend/venditbot/sidebar-profiles.tsx');
const agents = ['planner', 'reviewer'].map((id, index) => ({ id, name: index ? '검토자' : '기획자', instructions: 'role', connectionId: 'codex', model: 'fixture-model', createdAt: '2026-01-01', updatedAt: '2026-01-01' }));
const team = { id: 'team', name: '기획 검토 팀', instructions: '근거를 공유하고 검토합니다.', topic: '제품 기획', leaderAgentId: 'planner', policies: '근거가 있는 결정', memberAgentIds: ['planner', 'reviewer'], rounds: 2, createdAt: '2026-01-01', updatedAt: '2026-01-01' };
const run = { id: 'run', teamId: team.id, teamName: team.name, topic: team.topic, leaderAgentId: team.leaderAgentId, policies: team.policies, goal: '리포트를 함께 완성하세요.', status: 'running', rounds: 2, createdAt: '2026-01-01', updatedAt: '2026-01-02', members: agents.map(({ id, name }) => ({ id, name })), messageCount: 3, steps: [
  { sessionId: 'planner-work', agentId: 'planner', agentName: '기획자', round: 1, kind: 'plan', task: '요청을 분석해 검토자에게 위임', status: 'completed' },
  { sessionId: 'reviewer-work', agentId: 'reviewer', agentName: '검토자', round: 1, kind: 'work', status: 'running' },
  { sessionId: 'summary', agentId: 'planner', agentName: '기획자', round: 2, kind: 'summary', status: 'pending' },
] };
const detail = { ...run, messages: [
  { id: 'user', fromAgentName: '나', text: '참고 자료를 포함해 주세요.', kind: 'user', createdAt: '2026-01-01' },
  { id: 'member', fromAgentId: 'planner', fromAgentName: '기획자', toAgentId: 'reviewer', text: '이 가정을 검토해 주세요.', kind: 'agent', sessionId: 'planner-work', createdAt: '2026-01-01' },
  { id: 'result', fromAgentId: 'planner', fromAgentName: '기획자', text: '기획자 완료 결과', kind: 'result', sessionId: 'planner-work', createdAt: '2026-01-01' },
] };
const session = { id: 'reviewer-work', title: '검토자 작업', connectionId: 'codex', model: 'fixture-model', agentId: 'reviewer', teamRunId: 'run', teamStepIndex: 1, createdAt: '2026-01-01', updatedAt: '2026-01-02', messages: [{ id: 'answer', role: 'assistant', status: 'running', text: '현재 검토하고 있습니다.' }] };
const state = { version: 'fixture', profiles: [], agents, teams: [team], teamRuns: [run], sessions: [session], queue: { running: ['reviewer-work'], queued: [] }, activeRun: { sessionId: 'reviewer-work' } };
const render = props => renderToStaticMarkup(React.createElement(App, { initialState: state, ...props }));
const noop = () => {};
function treeElements(node) { if (Array.isArray(node)) return node.flatMap(treeElements); if (!React.isValidElement(node)) return []; return [node, ...treeElements(node.props.children)]; }
const buttonNamed = (tree, name) => tree.find(item => item.props.onPress && React.Children.toArray(item.props.children).join('') === name);

test('team sidebar, ordered member cards and team-specific work history are visible', () => {
  const html = render({ initialView: 'teams' });
  assert.match(html, /aria-label="협업 팀 목록"/); assert.match(html, /aria-label="에이전트 목록"/);
  assert.match(html, /기획자.*대표.*검토자/); assert.match(html, /제품 기획/);
  assert.match(html, /팀 작업 1개 · 진행 1개/); assert.match(html, /최근 팀 작업/);
  const single = render({ initialView: 'team', initialTeamId: 'team' });
  assert.match(single, /팀 대표에게 메시지/); assert.match(single, /<button>팀 설정<\/button>/);
  assert.match(single, /리포트를 함께 완성하세요/); assert.doesNotMatch(single, /팀 운영 지침|팀 작업 목표/);
});

test('team editor adds saved agents, selects a representative and edits topic and operating policies', () => {
  let draft = { name: '새 팀', instructions: '', memberAgentIds: [], rounds: 1 }, saved = 0;
  const getTree = () => treeElements(TeamEditor({ draft, agents, onChange: next => { draft = next; }, onSave: () => saved++, onCancel: noop }));
  assert.equal(buttonNamed(getTree(), '팀 저장').props.disabled, true);
  getTree().find(item => item.props['aria-label'] === '팀 멤버 추가').props.onChange({ target: { value: 'planner' } });
  const remaining = getTree().find(item => item.props['aria-label'] === '팀 멤버 추가');
  assert.doesNotMatch(renderToStaticMarkup(remaining), /value="planner"/);
  remaining.props.onChange({ target: { value: 'reviewer' } });
  assert.equal(buttonNamed(getTree(), '팀 저장').props.disabled, false);
  buttonNamed(getTree(), '2번 멤버 위로').props.onPress(); assert.deepEqual(draft.memberAgentIds, ['reviewer', 'planner']);
  getTree().find(item => item.props['aria-label'] === '팀 대표').props.onChange({ target: { value: 'reviewer' } }); assert.equal(draft.leaderAgentId, 'reviewer');
  getTree().find(item => item.props['aria-label'] === '팀 주제').props.onChange({ target: { value: '시장 조사' } }); assert.equal(draft.topic, '시장 조사');
  getTree().find(item => item.props['aria-label'] === '팀 운영 지침').props.onChange({ target: { value: '근거 확인' } }); assert.equal(draft.policies, '근거 확인');
  buttonNamed(getTree(), '팀 저장').props.onPress(); assert.equal(saved, 1);
  buttonNamed(getTree(), '1번 멤버 제외').props.onPress(); assert.deepEqual(draft.memberAgentIds, ['planner']); assert.equal(draft.leaderAgentId, 'planner');
  assert.equal(buttonNamed(getTree(), '팀 저장').props.disabled, false);
  const html = renderToStaticMarkup(React.createElement(TeamEditor, { draft: { ...draft, memberAgentIds: Array.from({ length: 8 }, (_, index) => `member-${index}`) }, agents, onChange: noop, onSave: noop, onCancel: noop }));
  assert.doesNotMatch(html, /aria-label="팀 멤버 추가"[^>]*disabled=""/);
});

test('team work shows shared and directed messages, current response and member links', () => {
  const html = render({ initialView: 'team-run', initialTeamRunId: 'run', initialTeamDetails: { run: detail } });
  assert.match(html, /팀 작업 중단/); assert.match(html, /aria-label="멤버 작업 진행"/); assert.match(html, /대표 계획 · 위임 · 결과 종합/);
  assert.match(html, /요청을 분석해 검토자에게 위임/); assert.match(html, /현재 팀 구성과 운영 지침/); assert.match(html, /현재 검토하고 있습니다/); assert.match(html, /기획자 → 검토자/); assert.match(html, /이 가정을 검토해 주세요/);
  assert.match(html, /원본 작업 열기/); assert.match(html, /팀 메시지 받는 멤버/); assert.match(html, /팀에 추가 메시지/); assert.match(html, /팀 메시지 전달/);
  assert.match(html, /팀 기록 내보내기/); assert.doesNotMatch(html, /팀 작업 삭제/);
});

test('final result is selected by summary session, not an earlier member result', () => {
  const completed = { ...run, status: 'completed', finalSessionId: 'summary', messageCount: 4, steps: run.steps.map(step => ({ ...step, status: 'completed' })) };
  const completedDetail = { ...detail, ...completed, messages: [...detail.messages, { id: 'final', fromAgentName: '기획자', kind: 'result', sessionId: 'summary', text: '리더가 종합한 최종 결과', createdAt: '2026-01-03' }] };
  const html = render({ initialView: 'team-run', initialTeamRunId: 'run', initialState: { ...state, teamRuns: [completed] }, initialTeamDetails: { run: completedDetail } });
  assert.match(html, /aria-label="팀 최종 결과".*리더가 종합한 최종 결과/);
  assert.match(html, /최종 결과 열기/); assert.match(html, /팀 작업 삭제/);
  assert.doesNotMatch(html, /팀에 추가 메시지|팀 작업 중단/);
});

test('team member sessions use the shared-message route instead of an editable ordinary composer', () => {
  const html = render({ initialView: 'chat', initialSessionId: 'reviewer-work' });
  assert.match(html, /팀 대화로 이동/); assert.match(html, /팀 작업 중단/);
  assert.doesNotMatch(html, /aria-label="메시지"/);
  const orphan = render({ initialView: 'chat', initialSessionId: 'reviewer-work', initialState: { ...state, teamRuns: [], queue: { running: [], queued: [] }, activeRun: null } });
  assert.match(orphan, /팀 작업의 멤버 기록입니다/); assert.doesNotMatch(orphan, /팀 대화로 이동|aria-label="메시지"/);
});

test('team recovery banner persists in all views and history remains accessible after team deletion', () => {
  for (const initialView of ['teams', 'team-edit', 'team', 'team-run', 'chat', 'settings', 'agents']) {
    const html = render({ initialView, initialTeamId: 'team', initialTeamRunId: 'run', initialState: { ...state, unsavedTeamRunIds: ['run'] } });
    assert.match(html, /aria-label="저장되지 않은 팀 작업"/); assert.match(html, /앱 종료 전 팀 기록을 내보내세요/); assert.match(html, /팀 기록 내보내기/);
  }
  const html = render({ initialView: 'teams', initialState: { ...state, teams: [] } });
  assert.match(html, /최근 팀 작업/); assert.match(html, /리포트를 함께 완성하세요/); assert.match(html, /팀 작업 열기/);
});

test('large shared history initially renders only fifty recent messages', () => {
  const longDetail = { ...detail, messages: Array.from({ length: 100 }, (_, index) => ({ id: `message-${index}`, fromAgentName: '기획자', text: `unique-message-${index}-end`, kind: 'agent', createdAt: '2026-01-01' })) };
  const html = render({ initialView: 'team-run', initialTeamRunId: 'run', initialTeamDetails: { run: longDetail } });
  assert.match(html, /이전 팀 메시지 더 보기 \(50\)/); assert.doesNotMatch(html, /unique-message-0-end/); assert.match(html, /unique-message-99-end/);
});

test('memoized Markdown skips unchanged text even when native snapshots clone its parent', () => {
  assert.equal(Markdown.$$typeof, Symbol.for('react.memo')); assert.equal(Markdown.type, MarkdownContent);
  assert.equal(Markdown.compare({ text: '# Same history' }, { text: '# Same history' }), true);
  assert.equal(Markdown.compare({ text: 'older' }, { text: 'newer' }), false);
  assert.match(renderToStaticMarkup(React.createElement(Markdown, { text: '# Shared result\n\n**Ready**' })), /Shared result.*<strong>Ready<\/strong>/);
});


test('avatar editor clearly uses the first text-model connection and offers preview, regenerate and cancellation', () => {
  const base = { name: '기획자', hasAvatar: false, prompt: '파란 로봇', connectionLabel: 'Codex · fixture-model · high', available: true, onPrompt: noop, onGenerate: noop, onCancel: noop, onRemove: noop };
  const html = renderToStaticMarkup(React.createElement(AgentAvatarEditor, base));
  assert.match(html, /AI 프로필 일러스트/); assert.match(html, /Codex · fixture-model · high/); assert.match(html, /텍스트 모델로 만드는 프로필 일러스트/);
  assert.match(html, /에이전트 저장으로 적용/); assert.match(html, /일러스트 생성<\/button>/);
  const unavailable = renderToStaticMarkup(React.createElement(AgentAvatarEditor, { ...base, available: false }));
  assert.match(unavailable, /<button disabled="">일러스트 생성<\/button>/);
  const failed = renderToStaticMarkup(React.createElement(AgentAvatarEditor, { ...base, hasAvatar: true, error: '연결 실패 fixture' }));
  assert.match(failed, /일러스트 다시 생성/); assert.match(failed, /프로필 사진 해제/); assert.match(failed, /role="alert">연결 실패 fixture/);
  const running = renderToStaticMarkup(React.createElement(AgentAvatarEditor, { ...base, busy: true }));
  assert.match(running, /일러스트 생성 취소/); assert.doesNotMatch(running, /일러스트 다시 생성/);
  const asset = renderToStaticMarkup(React.createElement(AgentAvatar, { name: '기획자', url: 'data:image/svg+xml;base64,PHN2Zy8+' }));
  assert.match(asset, /<img src="data:image\/svg\+xml;base64,PHN2Zy8\+"/);
  const fallback = renderToStaticMarkup(React.createElement(AgentAvatar, { name: '기획자' })); assert.match(fallback, /src="data:image\/svg\+xml,/); assert.doesNotMatch(fallback, /aria-hidden="true">기<\/span>/);
});

test('avatar editor generation, cancellation and removal buttons call the matching actions', () => {
  const calls = [];
  const props = { name: 'Agent', hasAvatar: true, prompt: 'robot', connectionLabel: 'Claude', available: true, onPrompt: text => calls.push(text), onGenerate: () => calls.push('generate'), onCancel: () => calls.push('cancel'), onRemove: () => calls.push('remove') };
  const tree = treeElements(AgentAvatarEditor(props));
  buttonNamed(tree, '일러스트 다시 생성').props.onPress(); buttonNamed(tree, '프로필 사진 해제').props.onPress();
  buttonNamed(treeElements(AgentAvatarEditor({ ...props, busy: true })), '일러스트 생성 취소').props.onPress();
  tree.find(item => item.props['aria-label'] === '프로필 일러스트 프롬프트').props.onChange({ target: { value: 'new prompt' } });
  assert.deepEqual(calls, ['generate', 'remove', 'cancel', 'new prompt']);
});


test('a changed team keeps editable draft text while blocking save and offering explicit reload', () => {
  let reloads = 0;
  const props = { draft: { ...team, name: 'My unsaved draft' }, agents, conflict: '편집 중 팀 구성이 변경되었습니다.', onChange: noop, onSave: noop, onCancel: noop, onReload: () => reloads++ };
  const tree = treeElements(TeamEditor(props));
  assert.equal(buttonNamed(tree, '팀 저장').props.disabled, true);
  buttonNamed(tree, '최신 설정 다시 불러오기').props.onPress(); assert.equal(reloads, 1);
  const html = renderToStaticMarkup(React.createElement(TeamEditor, props));
  assert.match(html, /role="alert"/); assert.match(html, /My unsaved draft/);
  const deleted = renderToStaticMarkup(React.createElement(TeamEditor, { ...props, onReload: undefined }));
  assert.doesNotMatch(deleted, /최신 설정 다시 불러오기/);
});

test('saved avatar transcripts stay out of recent chats and unsaved ones offer read-only recovery', () => {
  const avatar = { ...session, id: 'avatar', title: 'Hidden avatar transcript', teamRunId: undefined, purpose: 'avatar' };
  const snapshot = { ...state, sessions: [avatar], queue: { running: [], queued: [] }, activeRun: null };
  assert.doesNotMatch(render({ initialState: snapshot, initialView: 'agents' }), /Hidden avatar transcript/);
  const html = render({ initialState: { ...snapshot, unsavedSessionIds: ['avatar'] }, initialView: 'chat', initialSessionId: 'avatar' });
  assert.match(html, /Hidden avatar transcript/); assert.match(html, /저장되지 않은 작업/); assert.match(html, /프로필 이미지 생성 기록/); assert.match(html, /내보내기/);
  assert.doesNotMatch(html, /aria-label="메시지"/);
});


test('team conversation shows representative answers and keeps its composer after completion', () => {
  const completed = { ...run, status: 'completed', finalSessionId: 'summary', steps: run.steps.map(step => ({ ...step, status: 'completed' })) };
  const summary = { ...session, id: 'summary', messages: [{ id: 'final', role: 'assistant', status: 'completed', text: '대표의 전체 최종 답변입니다.' }] };
  const html = render({ initialView: 'team', initialTeamId: 'team', initialTeamRunId: 'run', initialState: { ...state, teamRuns: [completed], sessions: [session, summary] }, initialTeamDetails: { run: { ...detail, ...completed } } });
  assert.match(html, /팀 대표에게 메시지/); assert.match(html, /대표의 전체 최종 답변입니다/); assert.match(html, /이전 완료 대화를 이어서/);
  assert.match(html, /진행 상황 · 멤버 대화/); assert.match(html, /<button>팀 설정<\/button>/);
  assert.doesNotMatch(html, /aria-label="멤버 작업 진행"|팀 운영 지침|팀 작업 목표/);
  const active = render({ initialView: 'team', initialTeamId: 'team', initialTeamRunId: 'run', initialTeamDetails: { run: detail } });
  assert.match(active, /추가 지시 보내기/); assert.match(active, /팀 작업 중단/); assert.match(active, /검토자에게 업무를 맡겼습니다/);
  assert.doesNotMatch(active, /현재 검토하고 있습니다/);
});

test('Codex image mode provides a gated native-image choice and retains text illustration', () => {
  const modes = [];
  const base = { name: 'Agent', hasAvatar: false, prompt: 'robot', connectionLabel: 'Codex', available: true, imageAvailable: true, mode: 'image', onMode: mode => modes.push(mode), onPrompt: noop, onGenerate: noop, onCancel: noop, onRemove: noop };
  const html = renderToStaticMarkup(React.createElement(AgentAvatarEditor, base));
  assert.match(html, /AI 이미지 · Codex · 추천/); assert.match(html, /Codex의 이미지 생성 도구/); assert.match(html, /이미지 생성<\/button>/);
  const picker = treeElements(AgentAvatarEditor(base)).find(item => item.props['aria-label'] === '프로필 이미지 생성 방식');
  picker.props.onChange({ target: { value: 'illustration' } }); assert.deepEqual(modes, ['illustration']);
  const loggedOut = renderToStaticMarkup(React.createElement(AgentAvatarEditor, { ...base, available: false }));
  assert.match(loggedOut, /aria-label="프로필 이미지 생성 방식"[^>]*disabled=""/); assert.match(loggedOut, /<button disabled="">이미지 생성<\/button>/);
  const other = renderToStaticMarkup(React.createElement(AgentAvatarEditor, { ...base, imageAvailable: false, connectionLabel: 'Claude' }));
  assert.doesNotMatch(other, /프로필 이미지 생성 방식|Codex의 이미지 생성 도구/); assert.match(other, /일러스트 생성<\/button>/);
});


test('portrait sidebar cards show two-level team identity and accessible direct-chat actions', () => {
  const chosen = [], urls = { avatar1: 'data:image/png;base64,fixture1', avatar2: 'data:image/png;base64,fixture2' };
  const pictured = agents.map((agent, index) => ({ ...agent, avatarId: `avatar${index + 1}` }));
  const props = { agents: pictured, selectedId: 'planner', avatarUrl: id => urls[id], onOpen: id => chosen.push(id) };
  const agentHtml = renderToStaticMarkup(React.createElement(AgentSidebarCards, props));
  assert.match(agentHtml, /agent-photo-grid/); assert.match(agentHtml, /agent-photo-tile/); assert.match(agentHtml, /aria-label="기획자 대화 열기, 소속 팀 0개" aria-current="page"/);
  assert.match(agentHtml, /agent-avatar-large/); assert.match(agentHtml, /fixture1/); assert.match(agentHtml, /agent-photo-name/);
  const card = treeElements(AgentSidebarCards(props)).find(item => item.props['aria-label']?.startsWith('검토자 대화 열기')); card.props.onPress(); assert.deepEqual(chosen, ['reviewer']);
  const teamProps = { teams: [team], agents: pictured, selectedId: team.id, avatarUrl: props.avatarUrl, onOpen: props.onOpen, onCreate: noop };
  const teamHtml = renderToStaticMarkup(React.createElement(TeamSidebarCards, teamProps));
  assert.match(teamHtml, /team-photo-name.*기획 검토 팀/); assert.match(teamHtml, /team-leader-name.*기획자/); assert.match(teamHtml, /title="검토자" aria-label="검토자 팀원"/);
  assert.match(teamHtml, /team-member-portraits/); assert.match(teamHtml, /fixture1/); assert.match(teamHtml, /fixture2/);
  const memberArea = teamHtml.slice(teamHtml.indexOf('class="team-member-portraits"')); assert.doesNotMatch(memberArea, />검토자</);
  treeElements(TeamSidebarCards(teamProps)).find(item => item.props['aria-label']?.startsWith('기획 검토 팀 대화 열기')).props.onPress(); assert.deepEqual(chosen, ['reviewer', 'team']);
});

test('local portrait fallbacks stay stable, differ by identity, and do not embed user markup', () => {
  assert.equal(defaultAvatarDataUrl('agent-1'), defaultAvatarDataUrl('agent-1'));
  assert.ok(new Set(Array.from({ length: 12 }, (_, index) => defaultAvatarDataUrl(`agent-${index}`))).size > 4);
  const svg = decodeURIComponent(defaultAvatarDataUrl('<script>unsafe</script>').split(',')[1]);
  assert.match(svg, /<svg/); assert.doesNotMatch(svg, /script|unsafe|href|onload/);
});

test('an agent can join multiple teams and twenty-member teams keep every registered member selectable', () => {
  const many = Array.from({ length: 20 }, (_, index) => ({ ...agents[0], id: `member-${index}`, name: `팀원 ${index}` }));
  let draft = { ...team, memberAgentIds: many.slice(0, 8).map(agent => agent.id), leaderAgentId: many[0].id };
  const get = () => treeElements(TeamEditor({ draft, agents: many, onChange: next => { draft = next; }, onSave: noop, onCancel: noop }));
  for (const agent of many.slice(8)) { const picker = get().find(node => node.props['aria-label'] === '팀 멤버 추가'); assert.equal(!!picker.props.disabled, false); picker.props.onChange({ target: { value: agent.id } }); }
  assert.equal(draft.memberAgentIds.length, 20); assert.equal(new Set(draft.memberAgentIds).size, 20); assert.equal(get().find(node => node.props['aria-label'] === '팀 멤버 추가').props.disabled, true);
  const shared = { ...team, id: 'another-team', name: '두 번째 팀', memberAgentIds: [many[0].id] };
  const cards = renderToStaticMarkup(React.createElement(AgentSidebarCards, { agents: many, teams: [draft, shared], avatarUrl: noop, onOpen: noop }));
  assert.match(cards, /팀원 0 대화 열기, 소속 팀 2개/); assert.match(cards, /기획 검토 팀, 두 번째 팀/);
  const newDraft = { ...team, id: 'third', memberAgentIds: [] };
  const picker = treeElements(TeamEditor({ draft: newDraft, agents: many, onChange: noop, onSave: noop, onCancel: noop })).find(node => node.props['aria-label'] === '팀 멤버 추가');
  assert.match(renderToStaticMarkup(picker), /value="member-0"/);
});

test('agent and team cards expose context, keyboard and whole-card dragging with stable IDs', () => {
  const menus = [], props = { agents, teams: [team], avatarUrl: noop, onOpen: noop, onMenu: id => menus.push(id), onReorder: noop };
  const cards = treeElements(AgentSidebarCards(props)), card = cards.find(node => node.props.onContextMenu), trigger = cards.find(node => node.type?.name === 'SidebarProfileCard');
  const currentTarget = { getBoundingClientRect: () => ({ left: 20, bottom: 120, width: 80 }) };
  let prevented = 0; card.props.onContextMenu({ currentTarget, clientX: 40, clientY: 80, preventDefault() { prevented++; } }); card.props.onKeyDown({ currentTarget, key: 'F10', shiftKey: true, preventDefault() { prevented++; } });
  assert.deepEqual(menus, ['planner', 'planner']); assert.equal(prevented, 2);
  assert.equal(trigger.props.kind, 'agent'); assert.equal(trigger.props.id, 'planner'); assert.deepEqual(trigger.props.itemIds, ['planner', 'reviewer']);
  assert.equal(cards[0].props['data-sidebar-list'], 'agent'); assert.equal(cards.filter(node => node.props['data-sidebar-id'])[1].props['data-sidebar-id'], 'reviewer');
  const teams = treeElements(TeamSidebarCards({ ...props, onCreate: noop })); teams.find(node => node.props.onContextMenu).props.onKeyDown({ currentTarget, key: 'ContextMenu', preventDefault() {} }); assert.equal(menus.at(-1), team.id); assert.equal(teams[0].props['data-sidebar-list'], 'team');
});


test('team step details expose exact task-specific model routes and effort without changing agent settings', () => {
  const routed = { ...run, steps: run.steps.map(step => step.kind !== 'work' ? step : { ...step, taskKind: 'routine', connections: [{ connectionId: 'codex', model: 'fixture-gpt-6-luna', effort: 'low' }, { connectionId: 'claude-code', model: 'fixture-sonnet-5-5', effort: 'low' }] }) };
  const html = render({ initialView: 'team-run', initialTeamRunId: 'run', initialState: { ...state, teamRuns: [routed] } });
  assert.match(html, /루틴 작업/); assert.match(html, /aria-label="선택한 실행 모델"/); assert.match(html, /1. fixture-gpt-6-luna · low/); assert.match(html, /2. fixture-sonnet-5-5 · low/);
  assert.equal(agents[1].model, 'fixture-model');
  const editor = renderToStaticMarkup(React.createElement(TeamEditor, { draft: team, agents, onChange: noop, onSave: noop, onCancel: noop }));
  assert.match(editor, /업무 난이도에 따라 모델·추론 강도를 선택/); assert.match(editor, /사용 가능한 경제형 모델을 우선 고려/);
});

test('update control distinguishes development, available, busy, installing and error states', async () => {
  const { UpdateControl } = await bundle('../frontend/venditbot/update-control.tsx');
  const calls = [], props = { onCheck: () => calls.push('check'), onInstall: () => calls.push('install') };
  const html = update => renderToStaticMarkup(React.createElement(UpdateControl, { ...props, update }));
  assert.equal(html(undefined), '');
  const dev = html({ phase: 'development', currentVersion: '0.2.1-dev' }); assert.match(dev, /개발·검증용/); assert.match(dev, /정식 앱과 별도 프로필/); assert.doesNotMatch(dev, /<button/);
  const available = { phase: 'available', currentVersion: '0.2.0', version: '0.2.1' };
  assert.match(html(available), /0.2.1 업데이트/); assert.match(html(available), /대화와 설정을 유지/);
  buttonNamed(treeElements(UpdateControl({ ...props, update: available })), '0.2.1 업데이트').props.onPress(); assert.deepEqual(calls, ['install']);
  for (const blocked of [{ working: true }, { unsaved: true }]) {
    const markup = renderToStaticMarkup(React.createElement(UpdateControl, { ...props, update: available, ...blocked }));
    assert.match(markup, /<button disabled="">0.2.1 업데이트<\/button>/);
    assert.match(markup, blocked.working ? /작업 완료 후 업데이트/ : /저장되지 않은 기록을 먼저 보관/);
  }
  const installing = html({ ...available, phase: 'installing' }); assert.match(installing, /<button disabled="">업데이트 설치 중<\/button>/);
  const failed = html({ ...available, phase: 'error', error: '검증 실패 fixture' }); assert.match(failed, /업데이트 다시 확인/); assert.match(failed, /role="alert">검증 실패 fixture/);
  buttonNamed(treeElements(UpdateControl({ ...props, update: { phase: 'idle', currentVersion: '0.2.0' } })), '업데이트 확인').props.onPress(); assert.deepEqual(calls, ['install', 'check']);
});

test('failed fresh team chat does not claim it will inherit earlier completed context', () => {
  const failed = { ...run, status: 'failed', steps: [] };
  const html = render({ initialView: 'team', initialTeamId: team.id, initialTeamRunId: failed.id, initialState: { ...state, teamRuns: [failed] } });
  assert.match(html, /요청을 수정해 다시 보낼 수 있습니다/); assert.doesNotMatch(html, /이전 완료 대화를 이어서/);
});

test('stored orphan drafts remain readable and updater presents an explicit draft blocking reason', async () => {
  const { DraftRecovery } = await bundle('../frontend/venditbot/draft-recovery.tsx');
  const html = renderToStaticMarkup(React.createElement(DraftRecovery, { prompts: { 'session:deleted': '삭제된 대화에 남긴 미전송 전문' }, teamPrompts: {}, agentEdits: {}, teamEdits: {}, onPrompt: noop, onAgent: noop, onTeam: noop }));
  assert.match(html, /삭제된 대화에 남긴 미전송 전문/); assert.match(html, /초안 내용/); assert.match(html, /계속 작성/);
  const { UpdateControl } = await bundle('../frontend/venditbot/update-control.tsx');
  const blocked = renderToStaticMarkup(React.createElement(UpdateControl, { update: { phase: 'available', currentVersion: '0.2.0', version: '0.2.1' }, blockedReason: '초안을 저장한 뒤 업데이트하세요.', onCheck: noop, onInstall: noop }));
  assert.match(blocked, /<button disabled="">0.2.1 업데이트<\/button>/); assert.match(blocked, /role="status">초안을 저장한 뒤 업데이트하세요/);
});

test('damaged original recovery is readable text and never becomes executable markup', async () => {
  const { DraftRecovery } = await bundle('../frontend/venditbot/draft-recovery.tsx');
  const html = renderToStaticMarkup(React.createElement(DraftRecovery, { originals: [{ key: 'one', label: '대화', text: '<script>run()</script>', preserved: false, onPreserve: noop }], prompts: {}, teamPrompts: {}, agentEdits: {}, teamEdits: {}, onPrompt: noop, onAgent: noop, onTeam: noop }));
  assert.match(html, /원본 보관 후 계속/); assert.match(html, /&lt;script&gt;run\(\)&lt;\/script&gt;/); assert.doesNotMatch(html, /<script>/);
});


test('sidebar cards render one native button per profile without a separate menu trigger', () => {
  for (const [kind, component, props, id] of [
    ['agent', AgentSidebarCards, { agents, teams: [team] }, 'planner'],
    ['team', TeamSidebarCards, { teams: [team], agents, onCreate: noop }, 'team'],
  ]) {
    const input = { ...props, avatarUrl: noop, onOpen: noop, onMenu: noop, onReorder: noop };
    const tree = treeElements(component(input)), handle = tree.find(item => item.type?.name === 'SidebarProfileCard');
    assert.equal(handle.props.id, id); assert.equal(handle.props.kind, kind);
    assert.ok(tree.every(item => !item.props.draggable && !item.props.onDragStart && !item.props.onDrop && !item.props.onDragOver));
    const html = renderToStaticMarkup(React.createElement(component, input));
    assert.match(html, /<button type="button" draggable="false" class="(?:agent|team)-photo-tile sidebar-profile-button/); assert.match(html, /aria-description="카드를 드래그하여 같은 목록/); assert.doesNotMatch(html, /sidebar-drag-handle|agent-menu-trigger|···/);
  }
});

test('automatic representative mode needs a project brief, permits zero initial members and exposes the security boundary', () => {
  let draft = {name: '예약 앱 팀', instructions: '', memberAgentIds: [], rounds: 1};
  const getTree = () => treeElements(TeamEditor({draft, agents: [], onChange: next => {draft = next;}, onSave: noop, onCancel: noop, onSelectWorkspace: noop}));
  getTree().find(item => item.props['aria-label'] === '대표 구성 방식').props.onChange({target: {value: 'automatic'}});
  assert.equal(draft.leaderMode, 'automatic'); assert.equal(draft.autonomous, true); assert.match(draft.requestId, /^[a-f0-9-]{36}$/);
  assert.equal(buttonNamed(getTree(), '대표와 팀 함께 만들기').props.disabled, true);
  getTree().find(item => item.props['aria-label'] === '자동 대표 프로젝트 내용').props.onChange({target: {value: '모바일 예약 앱을 구현하고 테스트한다.'}});
  assert.equal(buttonNamed(getTree(), '대표와 팀 함께 만들기').props.disabled, false);
  assert.equal(getTree().some(item => item.props['aria-label'] === '팀 대표'), false);
  const html = renderToStaticMarkup(React.createElement(TeamEditor, {draft, agents: [], onChange: noop, onSave: noop, onCancel: noop}));
  assert.match(html, /예약 앱 팀 대표/); assert.match(html, /관리자 보안·승인 규칙은 변경할 수 없습니다/); assert.match(html, /추가 AI 호출 없이/);
  const id = draft.requestId;
  getTree().find(item => item.props['aria-label'] === '대표 구성 방식').props.onChange({target: {value: 'existing'}});
  assert.equal(draft.requestId, id); assert.equal(buttonNamed(getTree(), '팀 저장').props.disabled, true);
});


test('automatic representative save locks all draft edits but leaves cancellation available', () => {
  const draft = { name: 'Project', instructions: '', policies: '', projectBrief: 'Deliver the project', leaderMode: 'automatic', requestId: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa', leaderAgentId: 'planner', memberAgentIds: ['planner'], rounds: 1 };
  let edits = 0, cancelled = 0;
  const tree = treeElements(TeamEditor({draft, agents, busy: true, onChange: () => edits++, onSave: noop, onCancel: () => cancelled++, onSelectWorkspace: noop}));
  const fields = tree.filter(item => item.props.onChange && ('value' in item.props));
  assert.ok(fields.length >= 6);
  for (const field of fields) { assert.equal(field.props.disabled, true); field.props.onChange({target: {value: 'mutated'}}); }
  assert.equal(edits, 0);
  assert.equal(tree.some(item => item.props.kind === 'vendit' && item.props.children === '대표'), false);
  const cancel = tree.find(item => item.props.onPress && item.props.children === '취소');
  assert.equal(cancel.props.disabled, undefined); cancel.props.onPress(); assert.equal(cancelled, 1);
  const manual = treeElements(TeamEditor({draft: {...draft, leaderMode: 'existing'}, agents, onChange: noop, onSave: noop, onCancel: noop}));
  assert.equal(manual.some(item => item.props.kind === 'vendit' && item.props.children === '대표'), true);
});
