import assert from 'node:assert/strict';
import test from 'node:test';
import {build} from 'esbuild';
const built = await build({entryPoints: ['source/venditbot/agent-management-tools.ts'], bundle: true, platform: 'node', format: 'esm', write: false});
const {AgentManagementTools, AGENT_MANAGEMENT_TOOLS, normalizeManagedName} = await import('data:text/javascript;base64,' + Buffer.from(built.outputFiles[0].text).toString('base64'));
function fixture() {
  const original = {id: 'bound-agent', name: '이전 이름', instructions: '유지할 역할', connectionId: 'codex', model: 'original-model', updatedAt: '2026-10-11T01:00:00.000Z'};
  let agent = structuredClone(original), writes = 0;
  const controller = new AbortController();
  const tools = new AgentManagementTools({agentId: agent.id, expectedUpdatedAt: agent.updatedAt, signal: controller.signal, renameAgent: (id, name, revision) => {
    assert.equal(id, agent.id); if (revision !== agent.updatedAt) throw new Error('에이전트 설정이 변경되었습니다.');
    writes++; agent = {...agent, name, updatedAt: new Date(Date.parse(agent.updatedAt) + 1).toISOString()}; return structuredClone(agent);
  }});
  return {tools, original, controller, agent: () => structuredClone(agent), writes: () => writes, edit: value => agent = {...agent, ...value}};
}

test('personal rename tool is available without a workspace and can only update the bound agent name', async () => {
  const f = fixture(); assert.deepEqual(f.tools.definitions, AGENT_MANAGEMENT_TOOLS);
  const result = await f.tools.execute('rename_self', {name: '  새 이름  '}, 'call-1');
  assert.deepEqual(result, {renamed: true, agent: {id: f.original.id, name: '새 이름', updatedAt: '2026-10-11T01:00:00.001Z'}});
  assert.equal(f.agent().instructions, f.original.instructions); assert.equal(f.agent().model, f.original.model);
  assert.equal(f.original.name, '이전 이름');
  await assert.rejects(f.tools.execute('rename_self', {name: '다른 이름', agentId: 'foreign'}, 'call-2'), /새 이름만/);
  await assert.rejects(f.tools.execute('rename_team', {name: '권한 없음'}, 'call-3'), /새 이름만/);
  assert.equal(f.writes(), 1);
});

test('managed names trim before checking the 1–80 limit and reject controls or malformed input', async () => {
  assert.equal(normalizeManagedName('  ' + '가'.repeat(80) + '  '), '가'.repeat(80));
  for (const name of ['', ' \t ', '가'.repeat(81), 'bad\0name', 'bad\nname', null, 1, {}]) assert.throws(() => normalizeManagedName(name));
  const f = fixture(); for (const raw of [null, [], {}, {name: ''}, {name: 'ok', instructions: 'override'}]) await assert.rejects(f.tools.execute('rename_self', raw, 'call-' + JSON.stringify(raw)));
  assert.equal(f.writes(), 0);
});

test('same call ID returns its original promise and conflicting retries cannot repeat a committed rename', async () => {
  const f = fixture(); const first = f.tools.execute('rename_self', {name: '이름 1'}, 'call-1');
  assert.equal(first, f.tools.execute('rename_self', {name: '이름 1'}, 'call-1'));
  const saved = await first; f.controller.abort();
  assert.deepEqual(await f.tools.execute('rename_self', {name: '이름 1'}, 'call-1'), saved);
  await assert.rejects(f.tools.execute('rename_self', {name: '이름 2'}, 'call-1'), /일치하지/); assert.equal(f.writes(), 1);
});

test('consecutive self renames serialize and advance only their own successful CAS revision', async () => {
  const f = fixture(); const one = f.tools.execute('rename_self', {name: '하나'}, 'one'), two = f.tools.execute('rename_self', {name: '둘'}, 'two');
  await Promise.all([one, two]); assert.equal(f.agent().name, '둘'); assert.equal(f.writes(), 2);
  assert.equal(f.agent().updatedAt, '2026-10-11T01:00:00.002Z');
});

test('cancellation before the queued mutation prevents any rename', async () => {
  const f = fixture(); const pending = f.tools.execute('rename_self', {name: '취소됨'}, 'cancelled'); f.controller.abort();
  await assert.rejects(pending, {name: 'AbortError'}); assert.equal(f.writes(), 0); assert.deepEqual(f.agent(), f.original);
});

test('a concurrent user role edit makes the bound revision stale and stays intact', async () => {
  const f = fixture(); f.edit({instructions: '사용자가 변경한 역할', updatedAt: '2026-10-11T01:00:01.000Z'});
  await assert.rejects(f.tools.execute('rename_self', {name: '덮어쓰면 안 됨'}, 'stale'), /설정이 변경/);
  await assert.rejects(f.tools.execute('rename_self', {name: '덮어쓰면 안 됨'}, 'stale'), /설정이 변경/);
  assert.equal(f.writes(), 0); assert.equal(f.agent().instructions, '사용자가 변경한 역할'); assert.equal(f.agent().name, f.original.name);
});

test('a storage failure is cached and a new call can safely retry against the unchanged revision', async () => {
  let tries = 0; const revision = '2026-10-11T01:00:00.000Z';
  const tools = new AgentManagementTools({agentId: 'bound', expectedUpdatedAt: revision, renameAgent: (id, name, expected) => {
    assert.equal(expected, revision); if (++tries === 1) throw new Error('storage failed'); return {id, name, updatedAt: '2026-10-11T01:00:00.001Z'};
  }});
  await assert.rejects(tools.execute('rename_self', {name: '이름'}, 'one'), /storage failed/);
  await assert.rejects(tools.execute('rename_self', {name: '이름'}, 'one'), /storage failed/); assert.equal(tries, 1);
  assert.equal((await tools.execute('rename_self', {name: '이름'}, 'two')).renamed, true); assert.equal(tries, 2);
});

test('identity binding is copied so later host option edits cannot retarget a tool', async () => {
  const options = {agentId: 'bound', expectedUpdatedAt: '2026-10-11T01:00:00.000Z', renameAgent: (id, name) => ({id, name, updatedAt: '2026-10-11T01:00:00.001Z'})};
  const tools = new AgentManagementTools(options); options.agentId = 'different-agent';
  assert.equal((await tools.execute('rename_self', {name: '새 이름'}, 'bound-call')).agent.id, 'bound');
});

test('queued rename executes the captured arguments used for deduplication', async () => {
  const f = fixture(), args = {name: '호출 시 이름'};
  const result = f.tools.execute('rename_self', args, 'captured'); args.name = '대기 중 변경';
  assert.equal((await result).agent.name, '호출 시 이름');
  assert.equal((await f.tools.execute('rename_self', {name: '호출 시 이름'}, 'captured')).agent.name, '호출 시 이름'); assert.equal(f.writes(), 1);
});
