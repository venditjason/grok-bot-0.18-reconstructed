import assert from 'node:assert/strict';
import test from 'node:test';
import {randomUUID} from 'node:crypto';
import {mkdtemp, rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {setImmediate as tick} from 'node:timers/promises';
import {build} from 'esbuild';

// Real coordinator, durable team store and serial task queue; only inference and
// Electron are omitted. All records live in private synthetic temporary roots.
const built = await build({stdin: {contents: "export * from './source/venditbot/team-store.ts'; export * from './source/venditbot/team-coordinator.ts'; export * from './source/venditbot/task-queue.ts';", resolveDir: process.cwd()}, bundle: true, platform: 'node', format: 'esm', write: false});
const {TeamStore, TeamCoordinator, TaskQueue} = await import('data:text/javascript;base64,' + Buffer.from(built.outputFiles[0].text).toString('base64'));
const deferred = () => {let resolve; const promise = new Promise(done => resolve = done); return {promise, resolve};};
async function fixture(t, initialCount) {
  const root = await mkdtemp(join(tmpdir(), 'venditbot-030-teams-'));
  const stamp = new Date().toISOString(), agents = Array.from({length: 100}, (_, i) => ({id: 'agent-' + i, name: '구성원 ' + i, instructions: '고유 역할 ' + i, connectionId: 'api-qa', model: 'qa-model', createdAt: stamp, updatedAt: stamp}));
  const store = new TeamStore(root), sessions = new Map(), jobs = new Map(), starts = [], errors = [];
  let coordinator;
  const queue = new TaskQueue({onChange: () => coordinator?.schedule(), onError: (id, error) => errors.push({id, error: String(error)})});
  const port = {
    createSessions(run) {for (const step of run.steps) if (!sessions.has(step.sessionId)) sessions.set(step.sessionId, {id: step.sessionId, taskStatus: 'queued', messages: []});},
    enqueue(id, prompt, hooks) {
      const done = deferred(), session = sessions.get(id); jobs.set(id, {done, prompt});
      queue.submit(id, async signal => {starts.push(id); hooks.started(); const abort = () => done.resolve({status: 'cancelled', text: ''}); signal.addEventListener('abort', abort, {once: true});
        try {const result = await done.promise; session.messages.push({id: randomUUID(), role: 'assistant', createdAt: new Date().toISOString(), ...result}); session.taskStatus = result.status;}
        finally {signal.removeEventListener('abort', abort); hooks.settled(structuredClone(session));}
      });
    },
    cancelSession(id) {return queue.abort(id);}, getSession(id) {return structuredClone(sessions.get(id));},
    listAgents: () => structuredClone(agents), listModels: async () => ({connections: []}),
    resolveDelegation: async member => ({connections: [{connectionId: member.connectionId, model: member.model}]}),
    cloneAgent() {throw new Error('This fixture adds existing owned agents only.');}, removeAgent() {throw new Error('Unexpected agent deletion.');},
    queueState: () => queue.state(), changed() {}, teamChanged() {},
  };
  coordinator = new TeamCoordinator(store, port);
  const team = store.saveTeam({name: '규모 검증 팀', instructions: '독립 검증', topic: '', policies: '', leaderAgentId: agents[0].id, memberAgentIds: agents.slice(0, initialCount).map(a => a.id), rounds: 1});
  const run = coordinator.start(team.id, '모든 구성원에게 한 번씩 위임하세요.', agents.slice(0, initialCount)); await tick();
  const f = {root, agents, store, queue, coordinator, team, run, starts, errors, sessions, jobs,
    tools() {const id = queue.state().running[0]; assert.ok(id, 'a simulated inference turn must be running'); return coordinator.tools(id);},
    async finish(text = '완료') {const id = queue.state().running[0]; assert.ok(id, 'a simulated inference turn must be running'); jobs.get(id).done.resolve({status: 'completed', text}); await tick(); await tick();},
    async finishUntilSettled() {for (let i = 0; i < 110 && queue.state().running.length; i++) await this.finish(); assert.equal(queue.state().running.length, 0);},
  };
  t.after(async () => {coordinator.stopForQuit(); await queue.close(1000); await rm(root, {recursive: true, force: true});}); return f;
}

for (const count of [9, 20, 100]) test(`${count} existing members can all receive work and finish within the 200-message room`, async t => {
  const f = await fixture(t, count), tools = f.tools();
  for (const member of f.agents.slice(1, count)) await tools.execute('delegate_team_task', {agentId: member.id, task: member.instructions}, 'delegate-' + member.id);
  await f.finishUntilSettled(); const result = f.store.getRun(f.run.id);
  assert.equal(result.status, 'completed', result.error); assert.equal(result.steps.filter(step => step.kind === 'work').length, count - 1);
  assert.equal(result.steps.every(step => step.status === 'completed'), true); assert.ok(result.messages.length <= 200);
  assert.equal(new Set(f.starts).size, f.starts.length); assert.deepEqual(f.errors, []);
});

test('a ninth member can be added, delegated and persisted with its role snapshot', async t => {
  const f = await fixture(t, 8), tools = f.tools(), ninth = f.agents[8];
  await tools.execute('add_team_member', {templateAgentId: ninth.id}, 'ninth');
  await tools.execute('delegate_team_task', {agentId: ninth.id, task: '아홉 번째 구성원 작업'}, 'ninth-work');
  await f.finishUntilSettled(); const saved = f.store.getRun(f.run.id);
  assert.equal(saved.status, 'completed'); assert.equal(saved.memberSnapshots.find(a => a.id === ninth.id).instructions, ninth.instructions); assert.equal(f.store.getTeam(f.team.id).memberAgentIds.length, 9);
});

test('growing a two-member team to 100 reserves room for every result and the final leader answer', async t => {
  const f = await fixture(t, 2), firstPlan = f.tools();
  for (const member of f.agents.slice(2)) await firstPlan.execute('add_team_member', {templateAgentId: member.id}, 'add-' + member.id);
  await firstPlan.execute('delegate_team_task', {agentId: f.agents[1].id, task: '첫 작업'}, 'first-work');
  await f.finish('첫 계획'); await f.finish('첫 구성원 결과');
  const nextPlan = f.tools();
  for (const member of f.agents.slice(2)) await nextPlan.execute('delegate_team_task', {agentId: member.id, task: '각 구성원 작업'}, 'work-' + member.id);
  await f.finishUntilSettled(); const saved = f.store.getRun(f.run.id);
  assert.equal(saved.status, 'completed', saved.error);
  assert.equal(saved.steps.filter(step => step.kind === 'work' && step.status === 'completed').length, 99); assert.ok(saved.messages.length <= 200);
  assert.equal(saved.steps.at(-1).agentId, f.agents[0].id); assert.equal(saved.steps.at(-1).status, 'completed');
});

test('one saved agent can serve two teams without sharing run state or cancellation', async t => {
  const f = await fixture(t, 2);
  const secondTeam = f.store.saveTeam({...f.team, id: undefined, name: '독립 팀'});
  const second = f.coordinator.start(secondTeam.id, '독립적인 두 번째 목표', f.agents.slice(0, 2)); await tick();
  f.coordinator.cancel(second.id); await tick();
  assert.equal(f.store.getRun(second.id).status, 'cancelled'); assert.equal(f.store.getRun(f.run.id).status, 'running');
  await f.tools().execute('delegate_team_task', {agentId: f.agents[1].id, task: '원래 팀 작업'}, 'independent'); await f.finishUntilSettled();
  assert.equal(f.store.getRun(f.run.id).status, 'completed'); assert.equal(f.store.getRun(second.id).status, 'cancelled');
  assert.deepEqual(f.store.getRun(f.run.id).memberSnapshots, f.store.getRun(second.id).memberSnapshots);
});
test('team tools capture immutable input before their queued microtask and replay by the accepted value',async t=>{
 const f=await fixture(t,2),tools=f.tools(),args={agentId:f.agents[1].id,task:'승인된 원래 작업'};
 const pending=tools.execute('delegate_team_task',args,'captured');args.agentId=f.agents[0].id;args.task='뒤늦은 변조';const result=await pending;
 assert.equal(f.store.getRun(f.run.id).steps.find(s=>s.sessionId===result.sessionId).task,'승인된 원래 작업');assert.deepEqual(await tools.execute('delegate_team_task',{agentId:f.agents[1].id,task:'승인된 원래 작업'},'captured'),result);
 await assert.rejects(tools.execute('delegate_team_task',args,'captured'),/일치/);await f.finishUntilSettled();assert.equal(f.store.getRun(f.run.id).status,'completed');
});
