import assert from 'node:assert/strict';
import test from 'node:test';
import {mkdtemp, readFile, writeFile, rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {randomUUID} from 'node:crypto';
import {setImmediate as tick} from 'node:timers/promises';
import {build} from 'esbuild';

const built = await build({stdin: {contents: [
  'shared/development-routing', 'venditbot/agent-store', 'venditbot/team-store',
  'venditbot/team-coordinator', 'venditbot/automatic-team', 'venditbot/policy-store',
].map(file => `export * from './source/${file}.ts';`).join('\n'), resolveDir: process.cwd()}, bundle: true, platform: 'node', format: 'esm', write: false});
const {validDevelopmentBinding, resolveTeamDevelopment, assertDevelopmentWriteAllowed, developmentInstructions,
  AgentStore, TeamStore, TeamCoordinator, PolicyStore, AutomaticTeamCreator, normalizeAutomaticTeamInput, automaticTeamFingerprint,
} = await import('data:text/javascript;base64,' + Buffer.from(built.outputFiles[0].text).toString('base64'));
const binding = connectionId => ({mode: 'rabbit', connectionId});
const role = {name: '대표', instructions: '요구를 정리하고 결과를 검증한다.', connectionId: 'codex', model: 'qa-model'};

async function fixture(t) {
  const root = await mkdtemp(join(tmpdir(), 'vendit-development-'));
  const agents = new AgentStore(root), store = new TeamStore(root), sessions = new Map(), jobs = new Map();
  const leader = agents.save({...role, development: binding('project-b')});
  const port = {
    createSessions(run) {for (const step of run.steps) if (!sessions.has(step.sessionId)) sessions.set(step.sessionId, {id: step.sessionId, messages: [], ...(run.development ? {development: structuredClone(run.development)} : {})});},
    enqueue(id, prompt, hooks) {jobs.set(id, {prompt, hooks}); hooks.started();},
    cancelSession() {return true;}, getSession: id => structuredClone(sessions.get(id)),
    listAgents: () => agents.list(), listModels: async () => ({}),
    resolveDelegation: async member => ({connections: [{connectionId: member.connectionId, model: member.model}]}),
    cloneAgent(template, changes) {const {id, createdAt, updatedAt, ...configuration} = template; return agents.save({...configuration, ...changes});},
    removeAgent: (id, revision) => agents.remove(id, revision), queueState: () => ({running: [], queued: []}), changed() {}, teamChanged() {},
  };
  const coordinator = new TeamCoordinator(store, port);
  t.after(async () => {coordinator.stopForQuit(); await rm(root, {recursive: true, force: true});});
  return {root, agents, leader, store, coordinator, sessions, jobs, port,
    team(name, development) {return store.saveTeam({name, instructions: '', topic: '', policies: '', leaderAgentId: leader.id, memberAgentIds: [leader.id], rounds: 1, autonomous: true, ...(development ? {development} : {})});},
    async start(team, contextRunId) {const run = coordinator.start(team.id, '기능을 확인한다.', store.getTeam(team.id).memberAgentIds.map(id => agents.get(id)), contextRunId); await tick(); return run;},
    async finish(run) {const id = run.steps[0].sessionId, session = sessions.get(id); session.messages.push({role: 'assistant', status: 'completed', text: '검증한 결과'}); jobs.get(id).hooks.settled(structuredClone(session)); await tick();},
  };
}

test('development references reject credentials and malformed targets while detached precedence fails closed', () => {
  for (const invalid of [null, [], {}, binding(''), binding('with space'), binding('x\n'), binding('x'.repeat(101)), {mode: 'local', connectionId: 'x'}, {...binding('x'), apiKey: 'synthetic-secret'}]) assert.equal(validDevelopmentBinding(invalid), false);
  const team = binding('team'), leader = binding('leader'), chosen = resolveTeamDevelopment(team, leader);
  assert.deepEqual(chosen, team); chosen.connectionId = 'changed'; assert.equal(team.connectionId, 'team');
  assert.deepEqual(resolveTeamDevelopment(undefined, leader), leader);
  assert.equal(resolveTeamDevelopment(undefined, undefined), undefined);
  assert.throws(() => resolveTeamDevelopment(binding('ok'), {mode: 'bad'}));
  assert.doesNotThrow(() => assertDevelopmentWriteAllowed(undefined));
  assert.throws(() => assertDevelopmentWriteAllowed(binding('deleted-connection')), /로컬 개발로 전환하지 않습니다/);
  assert.throws(() => assertDevelopmentWriteAllowed({mode: 'invalid'}), /Rabbit/);
  assert.match(developmentInstructions(binding('x')), /start_project_run/);
  assert.match(developmentInstructions(binding('x')), /불확실한 접수는 새 요청으로 재실행하지 마세요/);
});

test('agent and team bindings persist detached, and malformed saved bindings preserve source bytes', async t => {
  const f = await fixture(t), source = binding('project-a'), team = f.team('제품 A', source);
  source.connectionId = 'mutated'; assert.deepEqual(f.store.getTeam(team.id).development, binding('project-a'));
  assert.deepEqual(new AgentStore(f.root).get(f.leader.id).development, binding('project-b'));
  assert.deepEqual(new TeamStore(f.root).getTeam(team.id).development, binding('project-a'));
  for (const [file, key, open] of [['agents.json', 'agents', () => new AgentStore(f.root)], ['teams.json', 'teams', () => new TeamStore(f.root)]]) {
    const path = join(f.root, file), original = await readFile(path, 'utf8'), data = JSON.parse(original);
    data[key][0].development = {...binding('x'), credential: 'synthetic'};
    const malformed = JSON.stringify(data); await writeFile(path, malformed);
    assert.throws(open, /손상/); assert.equal(await readFile(path, 'utf8'), malformed);
    await writeFile(path, original);
  }
});

test('one leader across teams captures independent project scope unaffected by later team or agent edits', async t => {
  const f = await fixture(t), teamA = f.team('제품 A', binding('project-a')), teamB = f.team('제품 B');
  const runA = await f.start(teamA), runB = await f.start(teamB);
  f.store.saveTeam({...teamA, development: binding('project-c')});
  f.agents.save({...f.leader, development: binding('project-d')});
  assert.deepEqual(f.store.getRun(runA.id).development, binding('project-a'));
  assert.deepEqual(f.store.getRun(runB.id).development, binding('project-b'));
  assert.deepEqual(f.sessions.get(runA.steps[0].sessionId).development, binding('project-a'));
  assert.deepEqual(f.sessions.get(runB.steps[0].sessionId).development, binding('project-b'));
  const detached = f.store.getRun(runA.id); detached.development.connectionId = 'mutated';
  assert.deepEqual(f.store.getRun(runA.id).development, binding('project-a'));
});

test('historical completed context continues only inside its captured project, including leader default changes', async t => {
  const f = await fixture(t), team = f.team('기본 연결 팀'), run = await f.start(team);
  // Historical pre-policy run: preserve its original completion semantics without granting new runs an exemption.
  const historical=f.store.getRun(run.id);delete historical.requiredPolicy;f.store.saveRun(historical);await f.finish(run);
  const same = await f.start(team, run.id); assert.equal(same.previousRunId, run.id); await f.finish(same);assert.equal(f.store.getRun(same.id).status,'failed');assert.match(f.store.getRun(same.id).error,/개발 완료는 미검증/);
  f.agents.save({...f.leader, development: binding('project-c')});
  const count = f.store.runCount(), sessions = f.sessions.size;
  await assert.rejects(f.start(team, run.id), /개발 프로젝트가 바뀌었습니다/);
  assert.equal(f.store.runCount(), count); assert.equal(f.sessions.size, sessions);
  const fresh = await f.start(team); assert.deepEqual(fresh.development, binding('project-c')); assert.equal(fresh.context, undefined);
});

test('new roles from autonomous and explicit templates use the captured run project without changing originals', async t => {
  const f = await fixture(t), team = f.team('제품 A', binding('project-a')), run = await f.start(team);
  const tools = f.coordinator.tools(run.steps[0].sessionId), original = f.agents.get(f.leader.id);
  const spawned = await tools.execute('add_team_member', {name: '검토 담당'}, 'spawn');
  const cloned = await tools.execute('add_team_member', {templateAgentId: f.leader.id, name: '개발 PM'}, 'clone');
  for (const result of [spawned, cloned]) assert.deepEqual(f.agents.get(result.createdAgent.id).development, binding('project-a'));
  assert.deepEqual(f.agents.get(f.leader.id), original);
  assert.deepEqual(f.store.getRun(run.id).development, binding('project-a'));
  const foreign = f.agents.save({...role, name: '다른 기본값', development: binding('project-z')});
  await tools.execute('add_team_member', {templateAgentId: foreign.id}, 'link');
  assert.deepEqual(f.agents.get(foreign.id).development, binding('project-z'));
  assert.deepEqual(f.store.getRun(run.id).development, binding('project-a'));
});

test('automatic creation captures target in both leader and team and deduplicates only identical project requests', async t => {
  const f = await fixture(t), policies = new PolicyStore(f.root);
  let release; const gate = new Promise(resolve => {release = resolve;});
  const creator = new AutomaticTeamCreator(f.root, f.agents, policies, f.store, {
    async catalogs() {await gate; return {catalogs: [{connectionId: 'codex', models: [{id: 'qa-model', label: 'QA', isDefault: true, efforts: ['low'], defaultEffort: 'low'}]}], assertCurrent() {}};},
    createAvatar: id => id, changed() {},
  });
  const draft = {leaderMode: 'automatic', requestId: randomUUID(), name: '자동 제품 팀', projectBrief: '앱 요구 분석', instructions: '', policies: '', memberAgentIds: [], development: binding('project-a')};
  const captured = structuredClone(draft), normalized = normalizeAutomaticTeamInput(draft);
  assert.notEqual(automaticTeamFingerprint(normalized), automaticTeamFingerprint(normalizeAutomaticTeamInput({...draft, development: binding('project-b')})));
  assert.throws(() => normalizeAutomaticTeamInput({...draft, development: {...binding('project-a'), apiKey: 'synthetic'}}));
  const pending = creator.create(draft); draft.development.connectionId = 'mutated'; release();
  const team = await pending; assert.deepEqual(team.development, binding('project-a'));
  assert.deepEqual(f.agents.get(team.leaderAgentId).development, binding('project-a'));
  assert.equal((await creator.create(captured)).id, team.id);
  assert.throws(() => creator.create({...captured, development: binding('project-b')}), /다른 팀/);
  assert.deepEqual(new TeamStore(f.root).getTeam(team.id).development, binding('project-a'));
});
