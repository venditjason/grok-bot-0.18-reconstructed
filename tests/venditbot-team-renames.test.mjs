import assert from 'node:assert/strict';
import test from 'node:test';
import {mkdtemp, rm, rename, mkdir, readFile} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {setImmediate as tick} from 'node:timers/promises';
import {build} from 'esbuild';
const built = await build({stdin: {contents: "export * from './source/venditbot/team-store.ts'; export * from './source/venditbot/team-coordinator.ts';", resolveDir: process.cwd()}, bundle: true, platform: 'node', format: 'esm', write: false});
const {TeamStore, TeamCoordinator} = await import('data:text/javascript;base64,' + Buffer.from(built.outputFiles[0].text).toString('base64'));
const stamp = '2026-10-11T01:00:00.000Z';
const agent = (id, name) => ({id, name, instructions: '원래 역할 ' + id, connectionId: 'codex', model: 'gpt-6-luna', createdAt: stamp, updatedAt: stamp});
async function fixture(t) {
  const root = await mkdtemp(join(tmpdir(), 'venditbot-team-renames-')), file = join(root, 'teams.json');
  const initial = [agent('leader', '대표'), agent('worker', '담당자')], agents = new Map(initial.map(a => [a.id, structuredClone(a)]));
  const store = new TeamStore(root), sessions = new Map(), jobs = new Map(), events = [], revisions = [];
  let running;
  const port = {
    createSessions(run) {for (const step of run.steps) if (!sessions.has(step.sessionId)) sessions.set(step.sessionId, {id: step.sessionId, messages: [], taskStatus: 'queued'});},
    enqueue(id, prompt, hooks) {running = id; jobs.set(id, {prompt, hooks}); hooks.started();},
    cancelSession(id) {if (running === id) running = undefined; return true;},
    getSession(id) {return structuredClone(sessions.get(id));},
    listAgents() {return structuredClone([...agents.values()]);}, listModels: async () => ({}),
    resolveDelegation: async member => ({connections: [{connectionId: member.connectionId, model: member.model}]}),
    cloneAgent(template, changes) {const cloned = {...template, ...changes, id: 'clone-' + agents.size}; agents.set(cloned.id, cloned); return structuredClone(cloned);},
    removeAgent(id) {agents.delete(id);},
    renameAgent(id, name, expected) {const current = agents.get(id); if (!current || current.updatedAt !== expected) throw new Error('에이전트 설정이 변경되었습니다.'); revisions.push({id, name, expected}); const saved = {...current, name, updatedAt: new Date(Date.parse(current.updatedAt) + 1).toISOString()}; agents.set(id, saved); return structuredClone(saved);},
    queueState: () => ({running: running ? [running] : [], queued: []}), changed: run => events.push({type: 'run', run}), teamChanged: () => events.push({type: 'teams'}),
  };
  const coordinator = new TeamCoordinator(store, port);
  const team = store.saveTeam({name: '원래 팀', instructions: '팀 지침', topic: '주제', policies: '원래 정책', leaderAgentId: 'leader', memberAgentIds: ['leader', 'worker'], rounds: 1});
  const run = coordinator.start(team.id, '이름 변경 요청', initial); await tick();
  const f = {root, file, store, coordinator, team, run, agents, initial, port, events, revisions,
    tools: signal => coordinator.tools(running, signal),
    async finish(text = '완료') {const id = running; running = undefined; const session = sessions.get(id); session.messages.push({role: 'assistant', status: 'completed', text}); jobs.get(id).hooks.settled(session); await tick();},
  };
  t.after(async () => {coordinator.stopForQuit(); await rm(root, {recursive: true, force: true});});
  return f;
}

test('leader team rename commits team and current run revision atomically, preserving historical snapshots and later edits', async t => {
  const f = await fixture(t), tools = f.tools(), before = f.store.getRun(f.run.id);
  const historical = {...structuredClone(before), id: 'past-run', status: 'completed', finalSessionId: before.steps[0].sessionId}; historical.steps[0].status = 'completed'; f.store.saveRun(historical);
  const result = await tools.execute('rename_team', {name: '  새 팀 이름  '}, 'rename-team');
  assert.equal(result.renamed, true); assert.equal(f.store.getTeam(f.team.id).name, '새 팀 이름');
  const renamed = f.store.getRun(f.run.id); assert.equal(renamed.teamName, '새 팀 이름'); assert.equal(renamed.teamUpdatedAt, f.store.getTeam(f.team.id).updatedAt); assert.notEqual(renamed.teamUpdatedAt, before.teamUpdatedAt);
  assert.equal(f.store.getRun(historical.id).teamName, '원래 팀'); assert.deepEqual(renamed.memberSnapshots, before.memberSnapshots); assert.deepEqual(renamed.steps, before.steps);
  assert.deepEqual(await tools.execute('rename_team', {name: '  새 팀 이름  '}, 'rename-team'), result);
  await tools.execute('update_team_policy', {policies: '이름 변경 후 정책'}, 'policy-after');
  await tools.execute('add_team_member', {templateAgentId: 'worker', name: '추가 멤버'}, 'add-after');
  assert.equal(f.store.getTeam(f.team.id).policies, '이름 변경 후 정책'); assert.equal(f.store.getTeam(f.team.id).name, '새 팀 이름'); assert.equal(f.store.getTeam(f.team.id).memberAgentIds.length, 3);
  const disk = JSON.parse(await readFile(f.file, 'utf8')); assert.equal(disk.teams[0].name, '새 팀 이름'); assert.equal(disk.runs.find(r => r.id === f.run.id).teamUpdatedAt, disk.teams[0].updatedAt);
  assert.ok(f.events.some(event => event.type === 'teams'));
});

test('member rename changes only the saved agent name and owns its subsequent CAS revision', async t => {
  const f = await fixture(t), before = f.store.getRun(f.run.id), tools = f.tools();
  const args = {agentId: 'worker', name: '새 담당자'}, first = tools.execute('rename_team_member', args, 'member-1');
  assert.equal(first, tools.execute('rename_team_member', args, 'member-1')); const result = await first;
  assert.equal(result.agent.name, '새 담당자'); assert.equal(f.revisions.length, 1); assert.equal(f.agents.get('worker').instructions, f.initial[1].instructions);
  assert.deepEqual(f.store.getRun(f.run.id).memberSnapshots, before.memberSnapshots); assert.deepEqual(f.store.getRun(f.run.id).steps, before.steps); assert.deepEqual(f.store.getRun(f.run.id).messages[0], before.messages[0]);
  await f.tools().execute('rename_team_member', {agentId: 'worker', name: '최종 담당자'}, 'member-2');
  assert.equal(f.agents.get('worker').name, '최종 담당자'); assert.equal(f.revisions[1].expected, result.agent.updatedAt);
  await assert.rejects(tools.execute('rename_team_member', {agentId: 'worker', name: '다른 요청'}, 'member-1'), /중복/); assert.equal(f.revisions.length, 2);
  await tools.execute('rename_team_member', {agentId: 'leader', name: '새 대표'}, 'self-as-leader'); assert.equal(f.agents.get('leader').name, '새 대표');
});

test('foreign and removed agents cannot be renamed and worker tasks receive no rename privileges', async t => {
  const f = await fixture(t), tools = f.tools(); f.agents.set('foreign', agent('foreign', '다른 팀'));
  await assert.rejects(tools.execute('rename_team_member', {agentId: 'foreign', name: '탈취'}, 'foreign'), /현재 팀/);
  await tools.execute('remove_team_member', {agentId: 'worker'}, 'remove');
  await assert.rejects(tools.execute('rename_team_member', {agentId: 'worker', name: '제외됨'}, 'removed'), /현재 팀/);
  await tools.execute('add_team_member', {templateAgentId: 'worker'}, 'readd');
  await tools.execute('delegate_team_task', {agentId: 'worker', task: '작업'}, 'delegate'); await f.finish();
  const workerTools = f.tools(); assert.equal(workerTools.definitions.some(tool => tool.name.startsWith('rename_')), false);
  await assert.rejects(workerTools.execute('rename_team', {name: '권한 탈취'}, 'worker-team'), /지원하지/);
  await assert.rejects(workerTools.execute('rename_team_member', {agentId: 'worker', name: '권한 탈취'}, 'worker-member'), /지원하지/);
  assert.equal(f.revisions.length, 0); assert.equal(f.store.getTeam(f.team.id).name, f.team.name);
});

test('cancellation immediately before queued rename commits neither team nor agent changes', async t => {
  for (const [name, args] of [['rename_team', {name: '취소'}], ['rename_team_member', {agentId: 'worker', name: '취소'}]]) {
    const f = await fixture(t), controller = new AbortController(), tools = f.tools(controller.signal);
    const pending = tools.execute(name, args, 'cancel'); controller.abort(); await assert.rejects(pending, {name: 'AbortError'});
    assert.equal(f.store.getTeam(f.team.id).name, f.team.name); assert.equal(f.agents.get('worker').name, f.initial[1].name); assert.equal(f.revisions.length, 0);
  }
});

test('stale team role or membership revisions reject renames before changing saved agents', async t => {
  const f = await fixture(t), tools = f.tools();
  f.store.saveTeam({...f.store.getTeam(f.team.id), leaderAgentId: 'worker'});
  await assert.rejects(tools.execute('rename_team_member', {agentId: 'worker', name: '권한 없음'}, 'stale-member'), /대표 권한/);
  await assert.rejects(tools.execute('rename_team', {name: '이전 대표'}, 'stale-team'), /변경/);
  assert.equal(f.revisions.length, 0); assert.equal(f.store.getTeam(f.team.id).name, f.team.name);
  assert.equal(f.store.getRun(f.run.id).messages.some(message => message.text.includes('저장된 이름을')), false);
});

test('an agent role edit invalidates rename CAS without a false success notice', async t => {
  const f = await fixture(t); f.agents.set('worker', {...f.agents.get('worker'), instructions: '새 역할', updatedAt: '2026-10-11T01:01:00.000Z'});
  await assert.rejects(f.tools().execute('rename_team_member', {agentId: 'worker', name: '이전 역할의 요청'}, 'stale-role'), /설정이 변경/);
  assert.equal(f.agents.get('worker').instructions, '새 역할'); assert.equal(f.agents.get('worker').name, f.initial[1].name);
  assert.equal(f.store.getRun(f.run.id).messages.some(message => message.text.includes('저장된 이름을')), false);
});

test('failed team storage does not claim a team rename succeeded or alter its definition', async t => {
  const f = await fixture(t); await rename(f.file, f.file + '.backup'); await mkdir(f.file);
  await assert.rejects(f.tools().execute('rename_team', {name: '저장 실패'}, 'failure'));
  assert.equal(f.store.getTeam(f.team.id).name, f.team.name); assert.equal(f.store.getRun(f.run.id).teamName, f.team.name);
  assert.equal(f.store.getRun(f.run.id).messages.some(message => message.text.includes('팀 이름을')), false);
});

test('a committed agent rename survives later audit storage failure with an explicit unsaved warning', async t => {
  const f = await fixture(t), tools = f.tools(); await rename(f.file, f.file + '.backup'); await mkdir(f.file);
  const result = await tools.execute('rename_team_member', {agentId: 'worker', name: '영구 저장 이름'}, 'committed');
  assert.equal(result.renamed, true); assert.match(result.warning, /팀 변경 기록.*저장하지 못/); assert.equal(f.agents.get('worker').name, '영구 저장 이름');
  assert.ok(f.store.unsavedIds().includes(f.run.id)); assert.deepEqual(await tools.execute('rename_team_member', {agentId: 'worker', name: '영구 저장 이름'}, 'committed'), result); assert.equal(f.revisions.length, 1);
});

test('rename tools reject unexpected keys, blank and oversized names', async t => {
  const f = await fixture(t), tools = f.tools();
  for (const [name, args] of [['rename_team', {name: ' ', teamId: 'other'}], ['rename_team', {name: ''}], ['rename_team', {name: 'n'.repeat(81)}], ['rename_team_member', {agentId: 'worker', name: 'ok', instructions: 'escalation'}], ['rename_team_member', {agentId: 'worker', name: 'bad\nname'}]]) await assert.rejects(tools.execute(name, args, JSON.stringify(args)));
  assert.equal(f.revisions.length, 0); assert.equal(f.store.getTeam(f.team.id).name, f.team.name);
});
