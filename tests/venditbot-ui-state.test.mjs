import assert from 'node:assert/strict';
import test from 'node:test';
import { build } from 'esbuild';

const built = await build({ entryPoints: [new URL('../frontend/venditbot/ui-state.ts', import.meta.url).pathname], bundle: true, platform: 'node', format: 'esm', target: 'node22', write: false });
const { reduceStateEvent, reduceApprovalEvent, needsAuthPolling, credentialStorageNote, shouldSendOnEnter, refreshAfter, SnapshotClock, sessionInProgress, sessionsForAgent, composerDraftKey, promoteSubmittedDraft, clearSubmittedDrafts, mergeAgentSnapshot, connectionRoutes, withAgentConnections, moveAgentConnection, duplicateConnectionIndex, mergeTeamSnapshot, mergeTeamRunResult, teamRunInProgress, teamDraftForRequest, moveTeamMember, UiEventBatcher, teamEditConflict, visibleHistorySessions, latestAgentConversation, latestTeamConversation, teamConversationHistory, teamContinuationId } = await import(`data:text/javascript;base64,${Buffer.from(built.outputFiles[0].text).toString('base64')}`);
const session = id => ({ id, title: id, connectionId: 'profile', model: 'fixture-model', createdAt: '2026-01-01', updatedAt: '2026-01-01', messages: [{ id: `${id}-answer`, role: 'assistant', text: '', status: 'running' }] });
const initial = () => ({ version: 'test', profiles: [], sessions: [session('first'), session('second')], activeRun: { sessionId: 'first' } });

test('large team validation allows nine and twenty distinct registered agents across independent teams', () => {
  const agents = Array.from({ length: 20 }, (_, at) => ({ id: `agent-${at}` }));
  for (const count of [9, 20]) {
    const draft = { name: '여러 팀', instructions: '', memberAgentIds: agents.slice(0, count).map(agent => agent.id), rounds: 1 };
    assert.equal(teamDraftForRequest(draft, agents).memberAgentIds.length, count); assert.equal(teamDraftForRequest({ ...draft, name: '다른 팀' }, agents).memberAgentIds.length, count);
  }
});

test('stream updates reach only the matching live message and stop after terminal state', () => {
  const original = initial();
  const next = reduceStateEvent(original, { type: 'delta', sessionId: 'first', messageId: 'first-answer', delta: '안녕' });
  assert.equal(next.sessions[0].messages[0].text, '안녕');
  assert.equal(next.sessions[1].messages[0].text, '');
  assert.equal(original.sessions[0].messages[0].text, '');
  const finished = structuredClone(next.sessions[0]); finished.messages[0].status = 'cancelled';
  const stopped = reduceStateEvent(next, { type: 'session', session: finished });
  const late = reduceStateEvent(stopped, { type: 'delta', sessionId: 'first', messageId: 'first-answer', delta: 'late' });
  assert.equal(late.sessions.find(item => item.id === 'first').messages[0].text, '안녕');
  assert.equal(late.sessions.filter(item => item.id === 'first').length, 1);
});

test('native tool updates preserve call order, update one record and retain workspace binding', () => {
  let state = initial(); state.sessions[0].workspacePath = '/fixture/workspace';
  const status = (callId, value) => ({ type: 'tool-status', sessionId: 'first', messageId: 'first-answer', callId, name: 'read_file', path: `${callId}.txt`, status: value });
  state = reduceStateEvent(state, status('one', 'running'));
  state = reduceStateEvent(state, status('two', 'running'));
  state = reduceStateEvent(state, { ...status('one', 'completed'), summary: 'done' });
  assert.deepEqual(state.sessions[0].messages[0].tools.map(tool => [tool.callId, tool.status]), [['one', 'completed'], ['two', 'running']]);
  assert.equal(state.sessions[0].workspacePath, '/fixture/workspace');
});

test('an old run-end cannot clear a newer session run or its write approvals', () => {
  const state = initial(); state.activeRun = { sessionId: 'second' };
  const event = { type: 'run-end', sessionId: 'first' };
  assert.equal(reduceStateEvent(state, event).activeRun.sessionId, 'second');
  let approvals = [];
  const approval = (approvalId, sessionId) => ({ type: 'tool-approval', approvalId, sessionId, path: '/fixture.txt', operation: 'write', preview: 'content', existing: true });
  approvals = reduceApprovalEvent(approvals, approval('old', 'first'));
  approvals = reduceApprovalEvent(approvals, approval('new', 'second'));
  approvals = reduceApprovalEvent(approvals, approval('new', 'second'));
  assert.equal(approvals.length, 2);
  approvals = reduceApprovalEvent(approvals, event);
  assert.deepEqual(approvals.map(item => item.approvalId), ['new']);
  assert.deepEqual(reduceApprovalEvent(approvals, { type: 'tool-approval-end', approvalId: 'new' }), []);
});

test('failed authentication/API tests refresh state while preserving the original failure', async () => {
  let refreshed = 0; const failure = new Error('401 fixture authentication failure');
  await assert.rejects(() => refreshAfter(async () => { throw failure; }, async () => { refreshed++; }), error => error === failure);
  assert.equal(refreshed, 1);
  await assert.rejects(() => refreshAfter(async () => { throw failure; }, async () => { throw new Error('secondary refresh error'); }), error => error === failure);
  assert.equal(await refreshAfter(async () => 'verified', async () => { refreshed++; }), 'verified');
  assert.equal(refreshed, 2);
});

test('auth polling is limited to an unfinished interactive login', () => {
  for (const phase of ['disconnected', 'ready', 'authenticated', 'cancelled', 'error', 'testing']) assert.equal(needsAuthPolling({ codex: { phase } }), false);
  for (const phase of ['preparing', 'awaiting-browser']) assert.equal(needsAuthPolling({ codex: { phase }, claude: { phase: 'ready' } }), true);
});

test('credential copy reflects production keyring and explicit ephemeral modes accurately', () => {
  assert.match(credentialStorageNote('codex', 'keyring'), /전용 macOS 키체인.*재실행 후 복원/);
  assert.match(credentialStorageNote('codex', 'keyring'), /거부되면 연결을 완료하지 않습니다/);
  assert.doesNotMatch(credentialStorageNote('codex', 'keyring'), /세션 동안만/);
  assert.match(credentialStorageNote('codex', 'session'), /세션 동안만/);
  assert.doesNotMatch(credentialStorageNote('claude-code', 'provider-managed'), /Codex|세션 동안만/);
});

test('Enter sends a message only after IME composition, while Shift+Enter keeps a new line', () => {
  assert.equal(shouldSendOnEnter({ key: 'Enter', shiftKey: false }), true);
  for (const event of [{ key: 'Enter', shiftKey: true }, { key: 'Enter', shiftKey: false, isComposing: true }, { key: 'Enter', shiftKey: false, keyCode: 229 }, { key: ' ', shiftKey: false }]) assert.equal(shouldSendOnEnter(event), false);
});

test('queue state locks only its own tasks and keeps cancellation scoped to the selected session', () => {
  const state = reduceStateEvent(initial(), { type: 'queue', running: ['first'], queued: ['second'] });
  assert.equal(sessionInProgress(state, 'first'), true);
  assert.equal(sessionInProgress(state, 'second'), true);
  assert.equal(sessionInProgress(state, 'third'), false);
  const advanced = reduceStateEvent(state, { type: 'queue', running: ['second'], queued: [] });
  assert.equal(advanced.activeRun.sessionId, 'second');
  assert.equal(sessionInProgress(advanced, 'first'), false);
  assert.equal(reduceStateEvent(advanced, { type: 'run-end', sessionId: 'first' }).activeRun.sessionId, 'second');
});

test('agent task histories remain separate and preserve provider/model/effort snapshots', () => {
  const sessions = [{ ...session('one'), agentId: 'reviewer', model: 'fixture-v1', effort: 'high', updatedAt: '2026-01-01' }, { ...session('two'), agentId: 'writer', updatedAt: '2026-01-04' }, { ...session('three'), agentId: 'reviewer', model: 'fixture-v2', effort: 'low', updatedAt: '2026-01-03' }, session('standalone')];
  assert.deepEqual(sessionsForAgent(sessions, 'reviewer').map(item => [item.id, item.model, item.effort]), [['three', 'fixture-v2', 'low'], ['one', 'fixture-v1', 'high']]);
  assert.deepEqual(sessions.map(item => item.id), ['one', 'two', 'three', 'standalone']);
});

test('delayed state/auth snapshots cannot overwrite native events or newer reads', async () => {
  const clock = new SnapshotClock(); let resolveOld; let shown = 'initial';
  const old = clock.read(() => new Promise(resolve => { resolveOld = resolve; }), value => { shown = value; });
  clock.changed(); shown = 'native-delta'; resolveOld('stale snapshot'); await old;
  assert.equal(shown, 'native-delta');
  const older = clock.read(() => new Promise(resolve => { resolveOld = resolve; }), value => { shown = value; });
  await clock.read(async () => 'fresh snapshot', value => { shown = value; });
  resolveOld('older snapshot'); await older;
  assert.equal(shown, 'fresh snapshot');
  let resolveNew;
  const first = clock.read(() => new Promise(resolve => { resolveOld = resolve; }), value => { shown = value; });
  const last = clock.read(() => new Promise(resolve => { resolveNew = resolve; }), value => { shown = value; });
  resolveOld('first response'); await first;
  assert.equal(shown, 'fresh snapshot');
  resolveNew('last response'); await last;
  assert.equal(shown, 'last response');
});

test('unsaved tasks remain visible across session, terminal and queue updates until storage succeeds', () => {
  let state = reduceStateEvent(initial(), { type: 'storage', unsavedSessionIds: ['first', 'first'] });
  assert.deepEqual(state.unsavedSessionIds, ['first']);
  state = reduceStateEvent(state, { type: 'session', session: { ...session('first'), title: 'unsaved result' } });
  state = reduceStateEvent(state, { type: 'run-end', sessionId: 'first', error: 'save failed' });
  state = reduceStateEvent(state, { type: 'queue', running: ['second'], queued: [] });
  assert.deepEqual(state.unsavedSessionIds, ['first']);
  assert.equal(state.sessions.find(item => item.id === 'first').title, 'unsaved result');
  assert.deepEqual(reduceStateEvent(state, { type: 'storage', unsavedSessionIds: [] }).unsavedSessionIds, []);
});

test('task drafts survive navigation and delayed submission cannot erase newer typing', () => {
  const source = composerDraftKey('', 'reviewer'), target = composerDraftKey('one', 'reviewer'), other = composerDraftKey('two', 'writer');
  assert.equal(new Set([source, target, other, composerDraftKey('', ''), composerDraftKey('', 'writer')]).size, 5);
  let drafts = { [source]: 'submitted', [other]: 'another task' };
  drafts = promoteSubmittedDraft(drafts, source, target, 'submitted', true);
  assert.equal(drafts[source], undefined); assert.equal(drafts[target], 'submitted');
  assert.equal(clearSubmittedDrafts(drafts, [source, target], 'submitted')[other], 'another task');
  drafts[target] = 'next message typed while send resolves';
  assert.equal(clearSubmittedDrafts(drafts, [source, target], 'submitted')[target], drafts[target]);
  const changed = promoteSubmittedDraft({ [source]: 'typed while creating task' }, source, target, 'submitted', true);
  assert.equal(clearSubmittedDrafts(changed, [source, target], 'submitted')[target], 'typed while creating task');
  const navigated = promoteSubmittedDraft({ [source]: 'new draft', [other]: 'another task' }, source, target, 'submitted', false);
  const finished = clearSubmittedDrafts(navigated, [source, target], 'submitted');
  assert.deepEqual(finished, { [source]: 'new draft', [other]: 'another task' });
});

test('agent save/delete snapshots never roll back streamed messages, queue or storage state', () => {
  const live = { ...initial(), agents: [{ id: 'old' }], queue: { running: ['first'], queued: ['second'] }, unsavedSessionIds: ['first'] };
  live.sessions[0].messages[0].text = 'latest streamed text';
  const stale = { ...initial(), agents: [{ id: 'saved' }], queue: { running: [], queued: [] }, unsavedSessionIds: [] };
  const saved = mergeAgentSnapshot(live, stale);
  assert.deepEqual(saved.agents, [{ id: 'saved' }]);
  assert.equal(saved.sessions, live.sessions); assert.equal(saved.queue, live.queue); assert.equal(saved.unsavedSessionIds, live.unsavedSessionIds);
  const deleted = mergeAgentSnapshot(saved, { ...stale, agents: [] });
  assert.deepEqual(deleted.agents, []); assert.equal(deleted.sessions[0].messages[0].text, 'latest streamed text');
});


test('priority edits keep legacy first-route fields in sync without mutating stored snapshots', () => {
  const legacy = { name: 'Agent', instructions: 'Role', connectionId: 'codex', model: 'one', effort: 'high' };
  assert.deepEqual(connectionRoutes(legacy), [{ connectionId: 'codex', model: 'one', effort: 'high' }]);
  const routes = [...connectionRoutes(legacy), { connectionId: 'claude-code', model: 'two' }];
  const changed = withAgentConnections(legacy, moveAgentConnection(routes, 1, -1));
  assert.deepEqual(changed.connections, [routes[1], routes[0]]);
  assert.equal(changed.connectionId, 'claude-code'); assert.equal(changed.model, 'two'); assert.equal(changed.effort, undefined);
  assert.deepEqual(routes[0], connectionRoutes(legacy)[0]);
  assert.equal(moveAgentConnection(routes, 0, -1), routes);
  assert.equal(moveAgentConnection(routes, 1, 1), routes);
  assert.equal(duplicateConnectionIndex(routes), -1);
  assert.equal(duplicateConnectionIndex([...routes, { ...routes[0] }]), 2);
});

test('session route snapshots and attempt outcomes survive streaming and agent settings updates', () => {
  const routes = [{ connectionId: 'codex', model: 'first' }, { connectionId: 'claude-code', model: 'second', effort: 'high' }];
  const task = { ...session('first'), connections: routes, messages: [{ id: 'first-answer', role: 'assistant', text: '', status: 'running', attempts: [{ ...routes[0], status: 'failed', error: 'quota exceeded' }, { ...routes[1], status: 'running' }] }] };
  let state = reduceStateEvent(initial(), { type: 'session', session: task });
  state = reduceStateEvent(state, { type: 'delta', sessionId: 'first', messageId: 'first-answer', delta: 'response from second' });
  state = mergeAgentSnapshot(state, { agents: [{ connectionId: 'other', model: 'changed' }] });
  assert.deepEqual(state.sessions[0].connections, routes);
  assert.equal(state.sessions[0].messages[0].attempts[0].error, 'quota exceeded');
  assert.equal(state.sessions[0].messages[0].text, 'response from second');
  const completed = structuredClone(state.sessions[0]); completed.messages[0].attempts[1].status = 'completed'; completed.messages[0].status = 'completed';
  state = reduceStateEvent(state, { type: 'session', session: completed });
  assert.equal(state.sessions[0].messages[0].attempts[1].status, 'completed');
});


test('1000 streamed chunks produce one scheduled state update with identical text', () => {
  let scheduled, scheduledCount = 0, cancelledCount = 0, updates = 0, reducedEvents = 0;
  let batched = initial(), baseline = initial();
  const batcher = new UiEventBatcher(events => { updates++; reducedEvents += events.length; batched = events.reduce(reduceStateEvent, batched); }, flush => { scheduled = flush; scheduledCount++; return () => { cancelledCount++; }; });
  for (let index = 0; index < 1000; index++) {
    const event = { type: 'delta', sessionId: 'first', messageId: 'first-answer', delta: `chunk-${index}한글 ` };
    baseline = reduceStateEvent(baseline, event); batcher.push(event);
  }
  assert.equal(updates, 0); assert.equal(scheduledCount, 1);
  scheduled();
  assert.equal(updates, 1); assert.equal(reducedEvents, 1); assert.equal(cancelledCount, 1);
  assert.deepEqual(batched, baseline);
  assert.equal(batched.sessions[0].messages[0].text.split('한글 ').length - 1, 1000);
});

test('batch barriers preserve terminal cancellation, session, storage, approval and team event order', () => {
  let scheduled; const batches = []; let state = initial();
  const batcher = new UiEventBatcher(events => { batches.push(events); state = events.reduce(reduceStateEvent, state); }, flush => { scheduled = flush; return () => {}; });
  const delta = text => ({ type: 'delta', sessionId: 'first', messageId: 'first-answer', delta: text });
  batcher.push(delta('before ')); batcher.push(delta('cancel'));
  const stopped = structuredClone(state.sessions[0]); stopped.messages[0].text = 'before cancel'; stopped.messages[0].status = 'cancelled';
  batcher.push({ type: 'session', session: stopped });
  assert.deepEqual(batches.map(events => events[0].type), ['delta', 'session']);
  assert.equal(state.sessions[0].messages[0].text, 'before cancel');
  batcher.push(delta('ignored-late'));
  batcher.push({ type: 'storage', unsavedSessionIds: ['first'], unsavedTeamRunIds: ['team-run'] });
  batcher.push({ type: 'team-run', run: { id: 'team-run', status: 'cancelled' } });
  batcher.push({ type: 'tool-approval-end', approvalId: 'approval' });
  batcher.push({ type: 'run-end', sessionId: 'first' });
  scheduled();
  assert.equal(state.sessions[0].messages[0].text, 'before cancel');
  assert.equal(state.activeRun, null); assert.deepEqual(state.unsavedTeamRunIds, ['team-run']);
  assert.deepEqual(batches.flat().map(event => event.type), ['delta', 'session', 'delta', 'storage', 'team-run', 'tool-approval-end', 'run-end']);
});

test('batching preserves interleaved message order and flushes pending text when disposed', () => {
  const emitted = []; const original = { type: 'delta', sessionId: 'first', messageId: 'first-answer', delta: 'a' };
  const batcher = new UiEventBatcher(events => emitted.push(...events), () => () => {});
  batcher.push(original); batcher.push({ ...original, delta: 'b' });
  batcher.push({ ...original, sessionId: 'second', messageId: 'second-answer', delta: 'c' });
  batcher.push({ ...original, delta: 'd' }); batcher.dispose(); batcher.dispose();
  assert.equal(original.delta, 'a');
  assert.deepEqual(emitted.map(event => [event.sessionId, event.delta]), [['first', 'ab'], ['second', 'c'], ['first', 'd']]);
});

test('pending batched text invalidates older snapshots before the next paint', async () => {
  let resolveOld, scheduled; let state = initial(); const clock = new SnapshotClock();
  const old = clock.read(() => new Promise(resolve => { resolveOld = resolve; }), value => { state = value; });
  const batcher = new UiEventBatcher(events => { state = events.reduce(reduceStateEvent, state); }, flush => { scheduled = flush; return () => {}; });
  clock.changed(); batcher.push({ type: 'delta', sessionId: 'first', messageId: 'first-answer', delta: 'new text' });
  resolveOld({ ...initial(), sessions: [] }); await old; scheduled();
  assert.equal(state.sessions[0].messages[0].text, 'new text');
});

test('company team validation permits a sole leader and preserves distinct members and policies', () => {
  const agents = [{ id: 'planner' }, { id: 'reviewer' }];
  const draft = { name: ' 팀 ', instructions: '', memberAgentIds: ['planner', 'reviewer'], rounds: 2 };
  assert.equal(teamDraftForRequest(draft, agents).name, '팀');
  assert.equal(teamDraftForRequest({ ...draft, leaderAgentId: 'reviewer', topic: ' 조사 ', policies: ' 근거 검토 ' }, agents).leaderAgentId, 'reviewer');
  assert.deepEqual(teamDraftForRequest({ ...draft, memberAgentIds: ['planner'] }, agents).memberAgentIds, ['planner']);
  assert.equal(teamDraftForRequest(draft, agents).rounds, 1);
  assert.deepEqual(moveTeamMember(draft.memberAgentIds, 1, -1), ['reviewer', 'planner']);
  assert.deepEqual(draft.memberAgentIds, ['planner', 'reviewer']);
  assert.equal(moveTeamMember(draft.memberAgentIds, 0, -1), draft.memberAgentIds);
  for (const patch of [{ name: ' ' }, { memberAgentIds: [] }, { memberAgentIds: ['planner', 'planner'] }, { memberAgentIds: ['planner', 'deleted'] }, { leaderAgentId: 'deleted' }]) assert.throws(() => teamDraftForRequest({ ...draft, ...patch }, agents));
});

test('team events and settings acknowledgements cannot roll back streamed sessions or newer team runs', () => {
  const live = { ...initial(), teams: [{ id: 'old-team' }], teamRuns: [{ id: 'run', updatedAt: '2026-01-02', messageCount: 5, status: 'running' }], unsavedTeamRunIds: ['run'] };
  const saved = mergeTeamSnapshot(live, { teams: [{ id: 'new-team' }], sessions: [], teamRuns: [] });
  assert.equal(saved.sessions, live.sessions); assert.equal(saved.teamRuns, live.teamRuns); assert.equal(saved.unsavedTeamRunIds, live.unsavedTeamRunIds);
  assert.deepEqual(saved.teams, [{ id: 'new-team' }]);
  assert.equal(mergeTeamRunResult(saved, { id: 'run', updatedAt: '2026-01-01', messageCount: 1 }), saved);
  assert.equal(mergeTeamRunResult(saved, { id: 'run', updatedAt: '2026-01-02', messageCount: 1 }), saved);
  const finished = reduceStateEvent(saved, { type: 'team-run', run: { id: 'run', updatedAt: '2026-01-03', status: 'completed' } });
  assert.equal(finished.teamRuns[0].status, 'completed'); assert.equal(finished.sessions, live.sessions);
  assert.equal(teamRunInProgress(live.teamRuns[0]), true); assert.equal(teamRunInProgress(finished.teamRuns[0]), false);
  assert.deepEqual(reduceStateEvent(finished, { type: 'storage', unsavedSessionIds: [], unsavedTeamRunIds: [] }).unsavedTeamRunIds, []);
});


test('leader team membership and policy updates preserve active session text and run snapshots', () => {
  const live = { ...initial(), teamRuns: [{ id: 'run', status: 'running' }], unsavedTeamRunIds: ['run'] };
  live.sessions[0].messages[0].text = 'live text';
  const next = reduceStateEvent(live, { type: 'teams', teams: [{ id: 'team', memberAgentIds: ['leader', 'new-agent'], policies: 'review sources' }], agents: [{ id: 'leader' }, { id: 'new-agent' }] });
  assert.equal(next.sessions, live.sessions); assert.equal(next.teamRuns, live.teamRuns); assert.equal(next.unsavedTeamRunIds, live.unsavedTeamRunIds);
  assert.equal(next.teams[0].policies, 'review sources'); assert.equal(next.agents[1].id, 'new-agent');
});


test('team editor detects representative changes without mutating the local draft and accepts a reloaded revision', () => {
  const original = { id: 'team', name: 'Original', memberAgentIds: ['leader'], updatedAt: '2026-01-01' };
  const draft = { ...original, name: 'My unsaved name' };
  assert.equal(teamEditConflict(draft, original.updatedAt, [original]), undefined);
  const latest = { ...original, memberAgentIds: ['leader', 'new-member'], policies: 'Leader updated', updatedAt: '2026-01-02' };
  assert.match(teamEditConflict(draft, original.updatedAt, [latest]), /팀 구성이 변경/);
  assert.equal(draft.name, 'My unsaved name'); assert.deepEqual(draft.memberAgentIds, ['leader']);
  assert.equal(teamEditConflict(latest, latest.updatedAt, [latest]), undefined);
  assert.match(teamEditConflict(draft, original.updatedAt, []), /삭제/);
  assert.equal(teamEditConflict({ name: 'New', memberAgentIds: [] }, '', []), undefined);
});

test('internal avatar history is hidden while every unsaved avatar remains recoverable', () => {
  const chat = session('chat'), avatar = { ...session('avatar'), purpose: 'avatar' }, another = { ...session('another-avatar'), purpose: 'avatar' };
  assert.deepEqual(visibleHistorySessions({ sessions: [avatar, chat, another] }).map(item => item.id), ['chat']);
  assert.deepEqual(visibleHistorySessions({ sessions: [avatar, chat, another], unsavedSessionIds: ['avatar', 'another-avatar'] }).map(item => item.id), ['avatar', 'chat', 'another-avatar']);
  assert.equal(avatar.messages.length, 1);
});


test('direct agent entry selects only its latest ordinary conversation', () => {
  const ordinary = { ...session('normal'), agentId: 'agent', updatedAt: '2026-01-02' };
  const all = [ordinary, { ...ordinary, id: 'old', updatedAt: '2026-01-01' }, { ...ordinary, id: 'team', updatedAt: '2026-01-04', teamRunId: 'run' }, { ...ordinary, id: 'avatar', updatedAt: '2026-01-05', purpose: 'avatar' }, { ...ordinary, id: 'another', agentId: 'other', updatedAt: '2026-01-06' }];
  assert.equal(latestAgentConversation(all, 'agent').id, 'normal');
  assert.equal(latestAgentConversation(all, 'new-agent'), undefined);
});

test('team continuations follow explicit same-team lineage and a fresh chat has no inherited context', () => {
  const first = { id: 'first', teamId: 'team', status: 'completed', createdAt: '2026-01-01', updatedAt: '2026-01-01' };
  const next = { ...first, id: 'next', previousRunId: 'first', createdAt: '2026-01-02', updatedAt: '2026-01-02' };
  const failed = { ...first, id: 'failed', status: 'failed', previousRunId: 'next', createdAt: '2026-01-03', updatedAt: '2026-01-03' };
  const other = { ...next, id: 'other', teamId: 'unrelated', updatedAt: '2026-01-04' }, all = [first, next, failed, other];
  assert.equal(latestTeamConversation(all, 'team').id, 'failed');
  assert.deepEqual(teamConversationHistory(all, 'next').map(run => run.id), ['first', 'next']);
  assert.equal(teamContinuationId(all, failed), 'next'); assert.equal(teamContinuationId(all, next), 'next'); assert.equal(teamContinuationId(all), undefined);
  assert.deepEqual(teamConversationHistory(all, 'other').map(run => run.id), ['other']);
  assert.deepEqual(teamConversationHistory([{ ...first, previousRunId: 'next' }, next], 'next').map(run => run.id), ['first', 'next']);
});

test('update events flush preceding streamed text and preserve every conversation and recovery record', () => {
  let state = { ...initial(), unsavedSessionIds: ['first'], update: { phase: 'idle', currentVersion: '0.2.0' } }, flush;
  const batcher = new UiEventBatcher(events => { state = events.reduce(reduceStateEvent, state); }, callback => { flush = callback; return () => { flush = undefined; }; });
  batcher.push({ type: 'delta', sessionId: 'first', messageId: 'first-answer', delta: '보존할 응답' });
  batcher.push({ type: 'update', update: { phase: 'available', currentVersion: '0.2.0', version: '0.2.1' } });
  assert.equal(state.sessions[0].messages[0].text, '보존할 응답'); assert.deepEqual(state.unsavedSessionIds, ['first']);
  assert.equal(state.activeRun.sessionId, 'first'); assert.equal(state.update.version, '0.2.1'); assert.equal(flush, undefined);
});


test('failed or cancelled fresh team conversations never inherit unrelated completed work', () => {
  const complete = { id: 'complete', teamId: 'team', status: 'completed', createdAt: '2026-01-01', updatedAt: '2026-01-01' };
  for (const status of ['failed', 'cancelled']) {
    const selected = { ...complete, id: status, status, createdAt: '2026-01-02' };
    assert.equal(teamContinuationId([complete, selected], selected), undefined);
    assert.equal(teamContinuationId([complete, selected], { ...selected, previousRunId: 'missing' }), undefined);
    assert.equal(teamContinuationId([{ ...complete, teamId: 'other' }, selected], { ...selected, previousRunId: 'complete' }), undefined);
    assert.equal(teamContinuationId([{ ...complete, previousRunId: selected.id }, selected], { ...selected, previousRunId: 'complete' }), undefined);
  }
});

test('bounded stream stress: 10000 deltas across 1000-session history preserve text, barriers, and historic references', t => {
  const oldMessage = index => ({ id: `history-${index}`, role: index % 2 ? 'assistant' : 'user', text: `unchanged-${index}`, status: 'completed' });
  const history = Array.from({ length: 1000 }, (_, index) => ({ ...session(`history-session-${index}`), messages: Array.from({ length: 100 }, (_, at) => oldMessage(at)) }));
  const live = { ...session('live'), messages: [...Array.from({ length: 2000 }, (_, index) => oldMessage(index)), { id: 'live-answer', role: 'assistant', text: '', status: 'running', attempts: [{ connectionId: 'codex', model: 'fixture', status: 'running' }] }] };
  let state = { ...initial(), sessions: [live, ...history], activeRun: { sessionId: 'live' } }, scheduled, updates = 0, deltaUpdates = 0;
  const batcher = new UiEventBatcher(events => { updates++; if (events.some(event => event.type === 'delta')) deltaUpdates++; state = events.reduce(reduceStateEvent, state); }, flush => { scheduled = flush; return () => { scheduled = undefined; }; });
  let expected = '';
  for (let index = 0; index < 10000; index++) {
    const delta = `${index}가`; expected += delta; batcher.push({ type: 'delta', sessionId: 'live', messageId: 'live-answer', delta });
    if (index % 1000 === 999) batcher.push({ type: 'tool-status', sessionId: 'live', messageId: 'live-answer', callId: `tool-${index}`, name: 'read_file', status: 'completed', summary: `${index}` });
    if (index === 4999) batcher.push({ type: 'storage', unsavedSessionIds: ['live'] });
  }
  assert.equal(deltaUpdates, 10); assert.equal(updates, 21); assert.equal(scheduled, undefined);
  const answer = state.sessions[0].messages.at(-1); assert.equal(answer.text, expected); assert.equal(answer.tools.length, 10); assert.deepEqual(state.unsavedSessionIds, ['live']);
  assert.equal(state.sessions[0].messages[100], live.messages[100]); assert.equal(state.sessions[1000], history[999]);
  batcher.push({ type: 'session', session: { ...state.sessions[0], taskStatus: 'cancelled', messages: state.sessions[0].messages.map(message => message.id === 'live-answer' ? { ...message, status: 'cancelled' } : message) } });
  batcher.push({ type: 'run-end', sessionId: 'live' });
  for (let index = 0; index < 100; index++) batcher.push({ type: 'delta', sessionId: 'live', messageId: 'live-answer', delta: 'late' });
  batcher.dispose(); assert.equal(state.sessions[0].messages.at(-1).text, expected); assert.equal(state.activeRun, null); assert.deepEqual(state.unsavedSessionIds, ['live']);
  t.diagnostic(`bounded synthetic run: 1001 sessions, 102001 messages, 10000 deltas → ${deltaUpdates - 1} active delta updates; 100 late cancelled deltas ignored`);
});

test('retrying snapshots yield, cancel scheduled work and allow only the newest reader to apply', async t => {
  const timers = new Map(); let serial = 0;
  t.mock.method(globalThis, 'setTimeout', callback => { timers.set(++serial, callback); return serial; });
  t.mock.method(globalThis, 'clearTimeout', id => timers.delete(id));
  const clock = new SnapshotClock(); let finish, shown = 'native', reads = 0;
  const old = clock.read(() => { reads++; return new Promise(resolve => { finish = resolve; }); }, value => { shown = value; }, true);
  clock.changed(); finish('stale'); await Promise.resolve();
  assert.equal(timers.size, 1); assert.equal(reads, 1); assert.equal(shown, 'native');
  await clock.read(async () => 'newer authoritative state', value => { shown = value; }, true);
  await old; assert.equal(timers.size, 0); assert.equal(reads, 1); assert.equal(shown, 'newer authoritative state');
  const pending = clock.read(async () => { clock.changed(); return 'invalidated'; }, value => { shown = value; }, true);
  await Promise.resolve(); assert.equal(timers.size, 1);
  clock.cancel(); await pending; assert.equal(timers.size, 0); assert.equal(shown, 'newer authoritative state');
});

test('a superseded in-flight reader cannot retry or overwrite a newer applied snapshot', async () => {
  const clock = new SnapshotClock(); let finish, reads = 0, shown;
  const old = clock.read(() => { reads++; return new Promise(resolve => { finish = resolve; }); }, value => { shown = value; }, true);
  clock.changed(); await clock.read(async () => 'current', value => { shown = value; }, true);
  finish('old'); await old; assert.equal(reads, 1); assert.equal(shown, 'current');
});


test('active input and provider retry status remain scoped to the current conversation and answer', () => {
 let state=initial();
 state=reduceStateEvent(state,{type:'active-input',sessionId:'first',capability:'steer'});
 assert.equal(state.activeRun.inputCapability,'steer');
 assert.equal(reduceStateEvent(state,{type:'active-input',sessionId:'second',capability:'fifo'}),state);
 state=reduceStateEvent(state,{type:'queue',running:['first'],queued:[]});assert.equal(state.activeRun.inputCapability,'steer');
 state=reduceStateEvent(state,{type:'provider-status',sessionId:'first',messageId:'first-answer',status:'retrying'});
 assert.equal(state.sessions[0].messages[0].providerStatus,'retrying');assert.equal(state.sessions[1].messages[0].providerStatus,undefined);
 state=reduceStateEvent(state,{type:'delta',sessionId:'first',messageId:'first-answer',delta:'ok'});assert.equal(state.sessions[0].messages[0].providerStatus,undefined);
 state=reduceStateEvent(state,{type:'queue',running:['second'],queued:[]});assert.equal(state.activeRun.inputCapability,undefined);
 state.sessions[0].messages[0].status='completed';
 assert.equal(reduceStateEvent(state,{type:'provider-status',sessionId:'first',messageId:'first-answer',status:'retrying'}).sessions[0].messages[0].providerStatus,undefined);
});
