import {withSuccessfulFileReceiptFixtures} from './fixtures/delegation-receipts.mjs';
import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import {mkdtemp, readFile, writeFile, rm, rename, mkdir, stat, symlink, link} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import path from 'node:path';
import {setImmediate as tick} from 'node:timers/promises';
import test from 'node:test';
import {build} from 'esbuild';
const built = await build({stdin: {contents: "export * from './source/venditbot/team-store.ts'; export * from './source/venditbot/team-coordinator.ts'; export * from './source/venditbot/task-queue.ts'; export * from './source/venditbot/agent-store.ts';", resolveDir: process.cwd()}, bundle: true, platform: 'node', format: 'esm', write: false});
const {TeamStore, TeamCoordinator: RawTeamCoordinator, TaskQueue, AgentStore} = await import(`data:text/javascript;base64,${Buffer.from(built.outputFiles[0].text).toString('base64')}`);
const TeamCoordinator=withSuccessfulFileReceiptFixtures(RawTeamCoordinator);
const input = {name: '대표', instructions: '목표를 분석하고 배분하세요.', connectionId: 'local-api', model: 'qa-model'};
const defer = () => {let resolve; const promise = new Promise(done => {resolve = done;}); return {promise, resolve};};
async function fixture(t) {
  const root = await mkdtemp(path.join(tmpdir(), 'venditbot-teams-')); const agents = new AgentStore(root), leader = agents.save(input), worker = agents.save({...input, name: '검토 담당', instructions: '독립적으로 검토하세요.'});
  const storage = [], store = new TeamStore(root, ids => storage.push(ids)), events = [], sessions = new Map(), jobs = new Map(), starts = [], errors = [];
  let coordinator;
  const queue = new TaskQueue({onChange: () => coordinator?.schedule(), onError: (id, error) => errors.push({id, error})});
  const port = {
    createSessions(run) {for (const [index, step] of run.steps.entries()) if (!sessions.has(step.sessionId)) {const member = run.memberSnapshots.find(a => a.id === step.agentId); sessions.set(step.sessionId, {id: step.sessionId, title: member.name, connectionId: member.connectionId, model: member.model, connections: member.connections, instructions: member.instructions, teamRunId: run.id, teamStepIndex: index, createdAt: run.createdAt, updatedAt: run.createdAt, messages: []});}},
    enqueue(id, prompt, hooks) {
      const done = defer(), session = sessions.get(id); session.taskStatus = 'queued'; jobs.set(id, {done, hooks, prompt});
      queue.submit(id, async signal => {starts.push(id); session.taskStatus = 'running'; hooks.started(); const abort = () => done.resolve({status: 'cancelled', text: ''}); signal.addEventListener('abort', abort, {once: true});
        try {const answer = await done.promise; session.messages.push({id: randomUUID(), role: 'assistant', createdAt: new Date().toISOString(), ...answer}); session.taskStatus = answer.status;} finally {signal.removeEventListener('abort', abort); hooks.settled(structuredClone(session));}
      });
    },
    cancelSession(id) {const waiting = queue.state().queued.includes(id); const result = queue.abort(id); if (waiting && result) {const session = sessions.get(id); session.taskStatus = 'cancelled'; jobs.get(id).hooks.settled(session, new Error('cancelled'));} return result;},
    getSession: id => {if (!sessions.has(id)) throw new Error('missing session'); return structuredClone(sessions.get(id));},
    listAgents: () => agents.list(), listModels: async members => ({agents: members.map(a => ({id: a.id}))}), resolveDelegation: async (member, options) => ({connections: options.connections ?? member.connections ?? [{connectionId: member.connectionId, model: member.model}]}),
    cloneAgent: (template, changes) => {const {id, createdAt, updatedAt, ...configuration} = template; return agents.save({...configuration, ...changes});},
    removeAgent: id => agents.remove(id), queueState: () => queue.state(), changed: run => events.push(run), teamChanged: () => events.push({type: 'teams'}),
  };
  coordinator = new TeamCoordinator(store, port);
  const team = store.saveTeam({name: '제품 팀', instructions: '근거를 제시하세요.', topic: '제품 개발', policies: '사용자에게 정직하게 보고하세요.', leaderAgentId: leader.id, memberAgentIds: [leader.id, worker.id], rounds: 1});
  const f = {port, root, file: path.join(root, 'teams.json'), agents, leader, worker, store, coordinator, queue, sessions, jobs, starts, events, storage, errors, team,
    async start() {const result = coordinator.start(team.id, '코드 품질 검토', team.memberAgentIds.map(id => agents.get(id))); await tick(); return result;},
    tools(id = queue.state().running[0]) {return coordinator.tools(id);},
    async finish(value = '검토 결과', id = queue.state().running[0]) {jobs.get(id).done.resolve({status: 'completed', text: value}); await tick(); await tick();},
  };
  t.after(async () => {coordinator.stopForQuit(); await queue.close(1000); await rm(root, {recursive: true, force: true});}); return f;
}

test('leader delegation ACK never waits for the child and the queue stays fair between team steps', async t => {
  const f = await fixture(t), run = await f.start(), leaderId = run.steps[0].sessionId;
  const ack = await f.tools().execute('delegate_team_task', {agentId: f.worker.id, task: '테스트를 검토하세요.'}, 'delegate-1');
  assert.equal(ack.startsAfterCurrentTurn, true); assert.deepEqual(f.starts, [leaderId]);
  const user = defer(); f.queue.submit('ordinary-user', () => user.promise);
  await f.finish('검토를 위임했습니다.'); assert.deepEqual(f.queue.state().running, ['ordinary-user']); assert.equal(f.store.getRun(run.id).steps[1].status, 'queued');
  user.resolve(); await tick(); assert.equal(f.queue.state().running[0], ack.sessionId); assert.equal(f.tools().definitions.some(d => d.name === 'delegate_team_task'), false);
  await assert.rejects(f.tools().execute('delegate_team_task', {agentId: f.leader.id, task: 'recursive'}, 'bad'), /지원/);
  assert.match(f.jobs.get(ack.sessionId).prompt, /테스트를 검토하세요/);
  await f.finish('독립 검토 결과'); const next = f.queue.state().running[0]; assert.equal(f.store.getRun(run.id).steps.at(-1).kind, 'plan');
  assert.match(f.jobs.get(next).prompt, /독립 검토 결과/); await f.finish('종합한 최종 결과');
  const detail = f.coordinator.detail(run.id); assert.equal(detail.status, 'completed'); assert.equal(detail.finalSessionId, next); assert.equal(detail.messages.filter(m => m.kind === 'result').length, 3);
  assert.equal((await stat(f.file)).mode & 0o777, 0o600); assert.deepEqual(f.errors, []);
});

test('team tools bind sender identity, reject nonmembers and deduplicate calls without repeating posts', async t => {
  const f = await fixture(t), run = await f.start(), tools = f.tools();
  const args = {text: '대표의 개인 지시', toAgentId: f.worker.id};
  const sent = await tools.execute('send_team_message', args, 'message-1'); assert.equal(sent.fromAgentId, f.leader.id); assert.equal(sent.fromAgentName, f.leader.name);
  assert.deepEqual(await tools.execute('send_team_message', args, 'message-1'), sent);
  assert.equal(f.coordinator.detail(run.id).messages.filter(m => m.id === sent.id).length, 1);
  await assert.rejects(tools.execute('send_team_message', {...args, fromAgentId: f.worker.id}, 'spoof'), /인자/);
  await assert.rejects(tools.execute('send_team_message', {text: 'external', toAgentId: 'not-member'}, 'outside'), /멤버/);
  await assert.rejects(tools.execute('send_team_message', {text: 'changed'}, 'message-1'), /중복/);
  await assert.rejects(tools.execute('read_team_task', {sessionId: 'other-run'}, 'read-other'), /이 팀/);
  await assert.rejects(tools.execute('delegate_team_task', {agentId: f.leader.id, task: 'self'}, 'self'), /대표 자신/);
  await assert.rejects(tools.execute('read_team_messages', {limit: 51}, 'large'), /1~50/);
  const page = await tools.execute('read_team_messages', {limit: 1}, 'page'); assert.equal(page.messages.length, 1); assert.equal(page.hasMore, true);
  const next = await tools.execute('read_team_messages', {afterMessageId: page.nextAfterMessageId}, 'next'); assert.equal(next.messages[0].id, sent.id);
});

test('routing context includes only current human goals and visible additional instructions', async t => {
  const f = await fixture(t), previous = await f.start(); await f.finish('과거 결과에만 있는 등록 프로젝트');
  const run = f.coordinator.start(f.team.id, '별도 로컬 문서 작성', f.team.memberAgentIds.map(id => f.agents.get(id)), previous.id); await tick();
  const leaderSession = run.steps[0].sessionId;
  f.coordinator.postUser(run.id, '전체 사용자 추가 지시'); f.coordinator.postUser(run.id, '팀원에게만 보내는 사용자 지시', f.worker.id);
  await f.tools().execute('send_team_message', {text: '모델이 언급한 등록 프로젝트'}, 'routing-model-message');
  const work = await f.tools().execute('delegate_team_task', {agentId: f.worker.id, task: '대표가 생성한 등록 프로젝트 작업 문구'}, 'routing-delegation');
  assert.deepEqual(f.coordinator.userTaskContext(leaderSession), {goal: '별도 로컬 문서 작성', userInstructions: ['전체 사용자 추가 지시']});
  assert.deepEqual(f.coordinator.userTaskContext(work.sessionId), {goal: '별도 로컬 문서 작성', userInstructions: ['전체 사용자 추가 지시', '팀원에게만 보내는 사용자 지시']});
  const detached = f.coordinator.userTaskContext(work.sessionId); detached.userInstructions.push('외부 수정'); assert.equal(f.coordinator.userTaskContext(work.sessionId).userInstructions.length, 2);
  assert.equal(f.coordinator.userTaskContext('unknown-session'), undefined);
  await f.finish('대표 출력의 등록 프로젝트'); await f.finish('팀원 결과의 등록 프로젝트');
  const nextLeader = f.queue.state().running[0]; assert.deepEqual(f.coordinator.userTaskContext(nextLeader), {goal: '별도 로컬 문서 작성', userInstructions: ['전체 사용자 추가 지시']}); await f.finish();
});

test('leader adds template clones and updates persistent team policy while previous snapshots stay fixed', async t => {
  const f = await fixture(t), run = await f.start(), tools = f.tools();
  const template = (await tools.execute('list_available_agents', {}, 'list')).agents.find(a => a.id === f.worker.id); assert.equal(template.workspacePath, undefined); assert.equal(template.connections[0].model, 'qa-model');
  const added = await tools.execute('add_team_member', {templateAgentId: f.worker.id, name: '보안 담당', instructions: '보안을 검토하세요.'}, 'add');
  assert.equal(f.agents.get(added.createdAgent.id).connectionId, f.worker.connectionId); assert.equal(f.store.getTeam(f.team.id).memberAgentIds.length, 3);
  await tools.execute('update_team_policy', {policies: '위험을 먼저 보고하세요.'}, 'policy'); assert.equal(f.store.getTeam(f.team.id).policies, '위험을 먼저 보고하세요.');
  f.agents.save({...f.worker, instructions: '이후 편집된 역할', model: 'changed-model'});
  assert.equal(f.store.getRun(run.id).memberSnapshots.find(a => a.id === f.worker.id).instructions, '독립적으로 검토하세요.');
  await tools.execute('remove_team_member', {agentId: f.worker.id}, 'remove'); assert.ok(!f.store.getTeam(f.team.id).memberAgentIds.includes(f.worker.id));
  assert.ok(f.store.getRun(run.id).memberSnapshots.some(a => a.id === f.worker.id));
  await assert.rejects(tools.execute('remove_team_member', {agentId: f.leader.id}, 'remove-leader'), /대표/);
  assert.ok(f.coordinator.detail(run.id).messages.some(m => m.kind === 'system' && m.text.includes('정책')));
  f.store.saveTeam({...f.store.getTeam(f.team.id), policies: '사용자가 직접 변경'});
  await assert.rejects(tools.execute('update_team_policy', {policies: '오래된 대표 덮어쓰기'}, 'stale'), /변경/);
  assert.equal(f.store.getTeam(f.team.id).policies, '사용자가 직접 변경');
});

test('delegations cap at eight, planning caps at three and final summary has no leader mutation tools', async t => {
  const f = await fixture(t), run = await f.start();
  for (let cycle = 1; cycle <= 3; cycle++) {
    assert.equal(f.store.getRun(run.id).steps.find(s => s.sessionId === f.queue.state().running[0]).kind, 'plan');
    const count = cycle === 3 ? 6 : 1;
    for (let i = 0; i < count; i++) await f.tools().execute('delegate_team_task', {agentId: f.worker.id, task: `작업 ${cycle}-${i}`}, `delegate-${i}`);
    if (cycle === 3) await assert.rejects(f.tools().execute('delegate_team_task', {agentId: f.worker.id, task: 'overflow'}, 'overflow'), /8개/);
    await assert.rejects(f.tools().execute('remove_team_member', {agentId: f.worker.id}, `remove-${cycle}`), /끝나지/);
    await f.finish('계획'); for (let i = 0; i < count; i++) await f.finish('작업 결과');
  }
  assert.equal(f.store.getRun(run.id).steps.at(-1).kind, 'summary'); assert.deepEqual(f.tools().definitions.map(tool => tool.name).sort(), ['accept_team_result', 'list_team_members', 'read_team_messages', 'read_team_task', 'send_team_message']);
  await f.finish('최종 종합'); assert.equal(f.store.getRun(run.id).steps.length, 12); assert.equal(f.coordinator.detail(run.id).status, 'completed');
});

test('cancel stops queued and future steps; restart marks unfinished teams cancelled without rerunning', async t => {
  const f = await fixture(t), run = await f.start(); await f.tools().execute('delegate_team_task', {agentId: f.worker.id, task: '취소할 작업'}, 'delegate');
  const restart = new TeamStore(f.root); assert.equal(restart.getRun(run.id).status, 'cancelled'); assert.ok(restart.getRun(run.id).steps.every(s => s.status === 'cancelled'));
  const cancelled = f.coordinator.cancel(run.id); assert.equal(cancelled.status, 'cancelled'); await tick(); assert.equal(f.starts.length, 1); assert.deepEqual(f.queue.state(), {running: [], queued: []});
  await assert.rejects(f.tools(run.steps[0].sessionId).execute('send_team_message', {text: 'late'}, 'late'), /더 이상/);
  assert.throws(() => f.coordinator.postUser(run.id, 'late'), /종료/);
});

test('long results have an explicit excerpt and bounded full-result pagination, never silent loss', async t => {
  const f = await fixture(t), run = await f.start(), leaderId = run.steps[0].sessionId;
  const child = await f.tools().execute('delegate_team_task', {agentId: f.worker.id, task: '긴 결과'}, 'delegate');
  const content = '가'.repeat(80_000); await f.finish(content);
  const first = await f.tools().execute('read_team_task', {sessionId: leaderId}, 'read-1'); assert.equal(first.text.length, 32768); assert.equal(first.totalCharacters, 80000);
  const second = await f.tools().execute('read_team_task', {sessionId: leaderId, offset: first.nextOffset}, 'read-2'); assert.equal(second.text.length, 32768);
  const last = await f.tools().execute('read_team_task', {sessionId: leaderId, offset: second.nextOffset}, 'read-3'); assert.equal(first.text + second.text + last.text, content); assert.equal(last.nextOffset, undefined);
  const result = f.coordinator.detail(run.id).messages.find(m => m.kind === 'result'); assert.match(result.text, /긴 결과의 일부/); assert.match(result.text, new RegExp(leaderId)); assert.ok(result.text.length <= 8000); assert.equal(f.queue.state().running[0], child.sessionId);
});

test('room and active-run limits reject overflow without unbounded queuing', async t => {
  const f = await fixture(t), run = await f.start();
  for (let i = 0; i < 167; i++) f.coordinator.postUser(run.id, `message-${i}`);
  assert.throws(() => f.coordinator.postUser(run.id, 'overflow'), /한도/); assert.equal(f.coordinator.detail(run.id).messages.length, 168);
  for (let i = 0; i < 3; i++) f.coordinator.start(f.team.id, `목표${i}`, [f.leader, f.worker]);
  assert.throws(() => f.coordinator.start(f.team.id, 'five', [f.leader, f.worker]), /4개/); await tick(); assert.equal(f.queue.state().queued.length, 3);
  assert.throws(() => f.store.removeTeam(f.team.id), /중단/);
});

test('failed progress writes preserve exportable run data and block future work', async t => {
  const f = await fixture(t), run = await f.start(); await rename(f.file, `${f.file}.backup`); await mkdir(f.file);
  await f.finish('저장 불가 최종 답변');
  assert.equal(f.coordinator.detail(run.id).status, 'completed'); assert.ok(f.store.unsavedIds().includes(run.id)); assert.match(JSON.stringify(f.coordinator.detail(run.id)), /저장 불가 최종 답변/);
  assert.deepEqual(f.queue.state(), {running: [], queued: []}); assert.ok(f.storage.length);
  await rm(f.file, {recursive: true}); f.store.saveRun(f.store.getRun(run.id)); assert.deepEqual(f.store.unsavedIds(), []); assert.deepEqual(f.storage.at(-1), []);
});

test('team storage validates corrupt references and rejects symlink/hardlink targets without altering originals', async t => {
  const f = await fixture(t), run = await f.start(); await f.finish('done'); const original = await readFile(f.file, 'utf8'), data = JSON.parse(original);
  for (const mutate of [d => d.teams[0].leaderAgentId = 'missing', d => d.runs[0].steps[0].agentId = 'missing', d => d.runs[0].messages[0].fromAgentId = f.worker.id, d => d.runs[0].activeMemberAgentIds.push(f.worker.id), d => d.runs[0].memberSnapshots[0].connections = []]) {
    const invalid = structuredClone(data); mutate(invalid); const bytes = JSON.stringify(invalid); await writeFile(f.file, bytes); assert.throws(() => new TeamStore(f.root)); assert.equal(await readFile(f.file, 'utf8'), bytes);
  }
  await rm(f.file); const target = `${f.file}.target`; await writeFile(target, original); await symlink(target, f.file); assert.throws(() => new TeamStore(f.root), /안전/);
  await rm(f.file); await link(target, f.file); assert.throws(() => new TeamStore(f.root), /안전/); assert.equal(await readFile(target, 'utf8'), original);
});

test('team follow-up context is restricted to completed runs of the same team and bounded to three quoted results', async t => {
  const f = await fixture(t); let prior = await f.start();
  assert.throws(() => f.coordinator.start(f.team.id, 'early', [f.leader, f.worker], prior.id), /완료/);
  await f.finish('첫 대표 결과'.repeat(2000));
  for (let turn = 0; turn < 4; turn++) {
    const next = f.coordinator.start(f.team.id, `후속 목표 ${turn}`, [f.leader, f.worker], prior.id); await tick();
    const saved = f.store.getRun(next.id); assert.equal(saved.previousRunId, prior.id); assert.ok(saved.context.length <= 3); assert.ok(JSON.stringify(saved.context).length <= 32000);
    assert.match(f.jobs.get(next.steps[0].sessionId).prompt, /previousCompletedRuns/); assert.match(f.jobs.get(next.steps[0].sessionId).prompt, /현재 goal만 새 사용자 명령/);
    assert.equal(f.coordinator.summaries().find(r => r.id === next.id).context, undefined);
    await f.finish(`대표 답변 ${turn}`.repeat(2000)); prior = next;
  }
  const latest = f.store.getRun(prior.id); assert.equal(latest.context.length, 3); assert.ok(latest.context.every(c => c.excerpt));
  const other = f.store.saveTeam({...f.team, id: undefined, name: '다른 회사'});
  assert.throws(() => f.coordinator.start(other.id, '다른 팀 엿보기', [f.leader, f.worker], prior.id), /같은 팀/);
  const summaries = f.coordinator.summaries(); summaries[0].steps[0].agentName = 'mutated'; summaries[0].members[0].name = 'mutated';
  assert.notEqual(f.store.getRun(prior.id).steps[0].agentName, 'mutated'); assert.notEqual(f.coordinator.summaries()[0].members[0].name, 'mutated');
});

test('async model discovery cannot commit a delegation after cancellation and preserves messages posted during lookup', async t => {
  const f = await fixture(t), first = await f.start(), gate = defer();
  f.port.resolveDelegation = async member => {await gate.promise; return {connections: [{connectionId: member.connectionId, model: member.model}]};};
  const pending = f.tools().execute('delegate_team_task', {agentId: f.worker.id, task: '지연된 모델 조회'}, 'delayed'); await tick(); f.coordinator.cancel(first.id); gate.resolve(); await assert.rejects(pending, /변경/); await tick(); assert.equal(f.store.getRun(first.id).steps.length, 1);
  const next = await f.start(), secondGate = defer(); f.port.resolveDelegation = async member => {await secondGate.promise; return {connections: [{connectionId: member.connectionId, model: member.model}]};};
  const nextPending = f.tools().execute('delegate_team_task', {agentId: f.worker.id, task: '경합 중 모델 조회'}, 'second'); await tick(); f.coordinator.postUser(next.id, '조회 중 추가된 사용자 지시'); secondGate.resolve(); await nextPending;
  assert.ok(f.coordinator.detail(next.id).messages.some(m => m.text === '조회 중 추가된 사용자 지시')); assert.equal(f.store.getRun(next.id).steps.length, 2);
});

test('team attachments are persisted, scoped by recipient and snapshotted without granting model attachment authority',async t=>{
 const f=await fixture(t);const a={id:randomUUID(),name:'shared.txt',kind:'text',mimeType:'text/plain',bytes:4,sha256:'a'.repeat(64)},privateFile={...a,id:randomUUID(),name:'private.txt'};
 const run=f.coordinator.start(f.team.id,'review files',f.team.memberAgentIds.map(id=>f.agents.get(id)),undefined,undefined,[a]);await tick();const leader=run.steps[0].sessionId;
 assert.deepEqual(f.coordinator.attachmentsFor(leader),[a]);f.coordinator.postUser(run.id,'private evidence',f.worker.id,[privateFile]);
 const work=await f.tools().execute('delegate_team_task',{agentId:f.worker.id,task:'review private evidence'},'attachment-delegation');
 assert.deepEqual(f.coordinator.attachmentsFor(leader),[a]);assert.deepEqual(f.coordinator.attachmentsFor(work.sessionId),[a,privateFile]);
 const read=f.coordinator.attachmentsFor(work.sessionId);read[0].name='changed';assert.equal(f.coordinator.attachmentsFor(work.sessionId)[0].name,'shared.txt');
 assert.deepEqual(new TeamStore(f.root).getRun(run.id).messages.filter(m=>m.kind==='user').map(m=>m.attachments),[[a],[privateFile]]);
 await assert.rejects(f.tools().execute('send_team_message',{text:'spoof',attachments:[privateFile]},'spoof-attachment'),/인자/);
});
