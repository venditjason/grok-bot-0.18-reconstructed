import assert from 'node:assert/strict';
import test from 'node:test';
import {mkdtemp, readFile, rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {randomUUID} from 'node:crypto';
import {setImmediate as tick} from 'node:timers/promises';
import {build} from 'esbuild';

// Independent authority/transaction fixtures: real stores, coordinator and queue;
// no Electron, provider subprocess, network, credentials or existing profile.
const built = await build({stdin: {contents: [
  "export * from './source/venditbot/team-store.ts';",
  "export * from './source/venditbot/team-coordinator.ts';",
  "export * from './source/venditbot/agent-store.ts';",
  "export * from './source/venditbot/task-queue.ts';",
  "export * from './source/venditbot/agent-management-tools.ts';",
].join('\n'), resolveDir: process.cwd()}, bundle: true, platform: 'node', format: 'esm', write: false});
const {TeamStore, TeamCoordinator, AgentStore, TaskQueue, AgentManagementTools} = await import(
  'data:text/javascript;base64,' + Buffer.from(built.outputFiles[0].text).toString('base64'));
const deferred = () => {let resolve; return {promise: new Promise(done => {resolve = done;}), resolve: value => resolve(value)};};
const configuration = {name: '대표', instructions: '저장된 역할', connectionId: 'codex', model: 'synthetic-model', effort: 'low',
  connections: [{connectionId: 'codex', model: 'synthetic-model', effort: 'low'}], workspacePath: '/synthetic/selected-workspace'};

async function fixture(t) {
  const root = await mkdtemp(join(tmpdir(), 'vendit-autonomy-security-'));
  const agents = new AgentStore(root), store = new TeamStore(root), leader = agents.save(configuration);
  const sessions = new Map(), tasks = new Map(), removed = [], queueErrors = [];
  let coordinator;
  const queue = new TaskQueue({onChange: () => coordinator?.schedule(), onError: (id, error) => queueErrors.push({id, error})});
  const port = {
    createSessions(run) {for (const step of run.steps) if (!sessions.has(step.sessionId)) sessions.set(step.sessionId, {id: step.sessionId, messages: []});},
    enqueue(id, prompt, hooks) {
      const done = deferred(); tasks.set(id, {done, prompt});
      queue.submit(id, async signal => {
        hooks.started();
        const cancel = () => done.resolve({status: 'cancelled', text: ''});
        signal.addEventListener('abort', cancel, {once: true});
        try {sessions.get(id).messages.push({id: randomUUID(), role: 'assistant', ...await done.promise});}
        finally {signal.removeEventListener('abort', cancel); hooks.settled(structuredClone(sessions.get(id)));}
      });
    },
    cancelSession: id => queue.abort(id), getSession: id => structuredClone(sessions.get(id)),
    listAgents: () => agents.list(), listModels: async () => ({models: []}),
    resolveDelegation: async member => ({connections: structuredClone(member.connections)}),
    cloneAgent(template, changes) {const {id, createdAt, updatedAt, ...rest} = template; return agents.save({...rest, ...changes});},
    removeAgent(id, expectedUpdatedAt) {removed.push({id, expectedUpdatedAt}); agents.remove(id, expectedUpdatedAt);},
    queueState: () => queue.state(), changed() {}, teamChanged() {},
  };
  coordinator = new TeamCoordinator(store, port);
  const f = {root, agents, store, leader, coordinator, queue, port, sessions, tasks, removed,
    team(members = [leader], extra = {}) {return store.saveTeam({name: '독립 검증 팀', instructions: '', topic: '', policies: '',
      memberAgentIds: members.map(a => a.id), leaderAgentId: members[0].id, rounds: 1, autonomous: true, ...extra});},
    async start(team) {const run = coordinator.start(team.id, '권한과 저장 경계를 검증하세요.', team.memberAgentIds.map(id => agents.get(id))); await tick(); return run;},
    tools(run, signal) {return coordinator.tools(run.steps[0].sessionId, signal);},
    async finish() {const id = queue.state().running[0]; assert.ok(id); tasks.get(id).done.resolve({status: 'completed', text: '합성 완료'}); await tick(); await tick();},
  };
  t.after(async () => {coordinator.stopForQuit(); assert.equal(await queue.close(1000), true); await rm(root, {recursive: true, force: true}); assert.deepEqual(queueErrors, []);});
  return f;
}

test('abort inside the host clone callback removes only the uncommitted clone at its saved revision', async t => {
  const f = await fixture(t), team = f.team(), run = await f.start(team), controller = new AbortController();
  const before = await readFile(join(f.root, 'agents.json'));
  const clone = f.port.cloneAgent; let created;
  f.port.cloneAgent = (template, changes) => {created = clone(template, changes); controller.abort(); return created;};
  await assert.rejects(f.tools(run, controller.signal).execute('add_team_member', {name: '취소된 생성'}, 'abort-during-clone'), {name: 'AbortError'});
  assert.deepEqual(f.removed, [{id: created.id, expectedUpdatedAt: created.updatedAt}]);
  assert.deepEqual(await readFile(join(f.root, 'agents.json')), before);
  assert.deepEqual(f.store.getTeam(team.id).memberAgentIds, [f.leader.id]);
  assert.deepEqual(f.store.getRun(run.id).memberSnapshots.map(a => a.id), [f.leader.id]);
  assert.equal(new AgentStore(f.root).list().length, 1);
});

test('a failing policy snapshot after clone rolls back without publishing a phantom team member', async t => {
  const f = await fixture(t), team = f.team(), run = await f.start(team), before = f.store.getTeam(team.id);
  f.port.policyForAgent = () => {throw new Error('synthetic policy lookup failed');};
  await assert.rejects(f.tools(run).execute('add_team_member', {name: '정책 오류'}, 'policy-error'), /policy lookup failed/);
  assert.deepEqual(f.store.getTeam(team.id), before);
  assert.deepEqual(f.store.getRun(run.id).activeMemberAgentIds, [f.leader.id]);
  assert.equal(f.agents.list().length, 1); assert.equal(f.removed.length, 1);
  assert.equal(new TeamStore(f.root).getTeam(team.id).memberAgentIds.length, 1);
});

test('cancellation while model selection is pending also prevents a later queued spawn', async t => {
  const f = await fixture(t), member = f.agents.save({...configuration, name: '작업자'}), team = f.team([f.leader, member]);
  const run = await f.start(team), controller = new AbortController(), entered = deferred(), release = deferred();
  f.port.resolveDelegation = async () => {entered.resolve(); await release.promise; return {connections: member.connections};};
  const tools = f.tools(run, controller.signal);
  const delegated = tools.execute('delegate_team_task', {agentId: member.id, task: '조회 중 취소'}, 'delayed');
  const spawned = tools.execute('add_team_member', {name: '실행되면 안 됨'}, 'after-delayed');
  const results = Promise.allSettled([delegated, spawned]);
  await entered.promise; controller.abort(); f.coordinator.cancel(run.id); release.resolve();
  assert.deepEqual((await results).map(r => [r.status, r.reason?.name]), [['rejected', 'AbortError'], ['rejected', 'AbortError']]);
  assert.equal(f.sessions.size, 1); assert.equal(f.agents.list().length, 2);
  assert.equal(f.store.getRun(run.id).status, 'cancelled'); assert.deepEqual(f.removed, []);
});

test('an awaited model selection cannot commit after the human changes team leadership', async t => {
  const f = await fixture(t), member = f.agents.save({...configuration, name: '새 대표'}), team = f.team([f.leader, member]);
  const run = await f.start(team), entered = deferred(), release = deferred();
  f.port.resolveDelegation = async () => {entered.resolve(); await release.promise; return {connections: member.connections};};
  const pending = f.tools(run).execute('delegate_team_task', {agentId: member.id, task: '오래된 대표 요청'}, 'stale-authority');
  const rejected = assert.rejects(pending, /설정|변경/); await entered.promise;
  f.store.saveTeam({...f.store.getTeam(team.id), leaderAgentId: member.id}); release.resolve(); await rejected;
  assert.equal(f.sessions.size, 1); assert.equal(f.store.getRun(run.id).steps.length, 1);
  assert.equal(f.store.getTeam(team.id).leaderAgentId, member.id);
  assert.equal(f.store.getRun(run.id).leaderAgentId, f.leader.id, 'historical identity remains immutable');
});

test('separate tool facades racing for the last delegation slot cannot exceed the authoritative run budget', async t => {
  const f = await fixture(t), member = f.agents.save({...configuration, name: '작업자'}), team = f.team([f.leader, member]);
  const run = await f.start(team), first = f.tools(run);
  for (let i = 0; i < 7; i++) await first.execute('delegate_team_task', {agentId: member.id, task: '예약 ' + i}, 'initial-' + i);
  const entered = deferred(), release = deferred(); let requests = 0;
  f.port.resolveDelegation = async () => {if (++requests === 2) entered.resolve(); await release.promise; return {connections: member.connections};};
  const outcomes = Promise.allSettled([first.execute('delegate_team_task', {agentId: member.id, task: '마지막 A'}, 'last-a'),
    f.tools(run).execute('delegate_team_task', {agentId: member.id, task: '마지막 B'}, 'last-b')]);
  await entered.promise; release.resolve(); const results = await outcomes;
  assert.equal(results.filter(r => r.status === 'fulfilled').length, 1);
  assert.match(results.find(r => r.status === 'rejected').reason.message, /한도/);
  assert.equal(f.store.getRun(run.id).steps.filter(s => s.kind === 'work').length, 8);
  assert.equal(f.sessions.size, 9, 'rejected attempt never creates an orphan task session');
});

test('unlinking a shared member changes only this team and preserves another queued team and its execution', async t => {
  const f = await fixture(t), shared = f.agents.save({...configuration, name: '공유 작업자'}), otherLeader = f.agents.save({...configuration, name: '다른 대표'});
  const one = f.team([f.leader, shared]), two = f.team([otherLeader, shared], {name: '다른 팀'});
  const runOne = await f.start(one), runTwo = await f.start(two), otherBefore = f.store.getTeam(two.id);
  await f.tools(runOne).execute('remove_team_member', {agentId: shared.id}, 'unlink-one');
  assert.deepEqual(f.store.getTeam(two.id), otherBefore);
  assert.deepEqual(f.store.getRun(runTwo.id).activeMemberAgentIds, [otherLeader.id, shared.id]);
  assert.equal(f.agents.get(shared.id).id, shared.id); assert.deepEqual(f.removed, []);
  await f.finish(); assert.equal(f.queue.state().running[0], runTwo.steps[0].sessionId);
  await f.tools(runTwo).execute('delegate_team_task', {agentId: shared.id, task: '다른 팀의 정상 작업'}, 'other-task');
  for (let i = 0; i < 4 && f.queue.state().running.length; i++) await f.finish();
  assert.equal(f.store.getRun(runTwo.id).status, 'completed');
  assert.equal(f.store.getRun(runTwo.id).steps.find(s => s.agentId === shared.id).status, 'completed');
  assert.equal(new AgentStore(f.root).get(shared.id).name, '공유 작업자');
});

test('the retained personal tool port cannot be used as a permanent-deletion or foreign-agent back door', async t => {
  const f = await fixture(t), foreign = f.agents.save({...configuration, name: '다른 에이전트'}), saved = await readFile(join(f.root, 'agents.json'));
  let renames = 0;
  const tools = new AgentManagementTools({agentId: f.leader.id, expectedUpdatedAt: f.leader.updatedAt,
    renameAgent(id, name, revision) {renames++; assert.equal(id, f.leader.id); assert.equal(revision, f.leader.updatedAt); return f.agents.save({...f.leader, name});}});
  for (const name of ['deleteAgent', 'delete_agent', 'remove_agent', 'remove_team_member'])
    await assert.rejects(tools.execute(name, {agentId: foreign.id}, name), /이름 변경/);
  await assert.rejects(tools.execute('rename_self', {name: '위조', agentId: foreign.id, permanent: true}, 'foreign'), /이름 변경/);
  assert.equal(renames, 0); assert.deepEqual(await readFile(join(f.root, 'agents.json')), saved);
});

test('mutating queued tool arguments cannot change which template, role or member the host authorized', async t => {
  const f = await fixture(t), member = f.agents.save({...configuration, name: '작업자'}), foreign = f.agents.save({...configuration, name: '외부 템플릿'});
  const team = f.team([f.leader, member]), run = await f.start(team), entered = deferred(), release = deferred();
  f.port.resolveDelegation = async () => {entered.resolve(); await release.promise; return {connections: member.connections};};
  const tools = f.tools(run), first = tools.execute('delegate_team_task', {agentId: member.id, task: '먼저 조회'}, 'first');
  const args = {name: '원래 생성 요청', instructions: '원래 역할'};
  const next = tools.execute('add_team_member', args, 'captured'); await entered.promise;
  args.templateAgentId = foreign.id; args.name = '바뀐 이름'; args.instructions = '바뀐 역할'; release.resolve(); await first;
  const result = await next, created = f.agents.get(result.createdAgent.id);
  assert.equal(created.name, '원래 생성 요청'); assert.equal(created.instructions, '원래 역할');
  assert.deepEqual(created.connections, f.leader.connections); assert.equal(created.workspacePath, f.leader.workspacePath);
  assert.equal(f.store.getTeam(team.id).memberAgentIds.includes(foreign.id), false);
});
