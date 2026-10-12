import assert from 'node:assert/strict';
import test from 'node:test';
import {mkdtempSync, readFileSync, rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {randomUUID} from 'node:crypto';
import {setImmediate as turn} from 'node:timers/promises';
import {build, transform} from 'esbuild';
import {parse} from 'acorn';
import {simple} from 'acorn-walk';
const built = await build({stdin: {contents: "export * from './source/venditbot/routine-host.ts'; export {LocalSessionStore} from './source/venditbot/local-store.ts';", resolveDir: process.cwd()}, bundle: true, platform: 'node', format: 'esm', write: false});
const {RoutineHost, LocalSessionStore} = await import('data:text/javascript;base64,' + Buffer.from(built.outputFiles[0].text+'\n//# sourceURL=venditbot-routine-host-test-bundle.mjs').toString('base64'));
const reservation = (target = {kind: 'agent', id: 'one'}) => ({dispatchId: randomUUID(), routineId: randomUUID(), routineRevision: 1, routineName: 'Review', prompt: 'Review the current project.', target, scheduledAt: '2026-10-12T00:00:00.000Z', reservedAt: '2026-10-12T00:00:01.000Z', status: 'reserved'});
function fixture(t) {
  const root = mkdtempSync(join(tmpdir(), 'vendit-routine-host-test-'));
  t.after(() => rmSync(root, {recursive: true, force: true}));
  const sessions = new LocalSessionStore(root), calls = [], runs = [], queue = {running: [], queued: []};
  const agents = new Map(['one', 'two', 'three'].map(id => [id, {id, name: id, instructions: 'Use existing routing.', connectionId: 'provider-one', model: 'model-one', effort: 'high', workspacePath: '/synthetic/workspace', connections: [{connectionId: 'provider-one', model: 'model-one', effort: 'high'}, {connectionId: 'provider-two', model: 'model-two'}], automation: {policyId: 'saved-policy'}}]));
  const teams = new Map([['team-one', {id: 'team-one', memberAgentIds: ['one', 'two']}], ['team-two', {id: 'team-two', memberAgentIds: ['two', 'three']}]]);
  let unavailable = false;
  const port = {
    sessions, agents: {get(id) {const a = agents.get(id); if (!a) throw Error('missing'); return structuredClone(a);}},
    teams: {getTeam(id) {const team = teams.get(id); if (!team) throw Error('missing'); return structuredClone(team);}, listTeams: () => structuredClone([...teams.values()]), listRuns: () => structuredClone(runs), listActiveRuns: () => structuredClone(runs.filter(r => ['running', 'queued'].includes(r.status)))},
    coordinator: {start(id, prompt, members, context, internal) {calls.push({kind: 'team', id, prompt, members, context, internal}); runs.push({id: randomUUID(), teamId: id, status: 'queued', activeMemberAgentIds: members.map(m => m.id), routineDispatchId: internal.routineDispatchId});}},
    queue: () => structuredClone(queue), unavailable: () => unavailable,
    enqueue(id, prompt, hooks) {calls.push({kind: 'agent', id, prompt, hooks}); queue.queued.push(id);},
  };
  const host = new RoutineHost(port);
  function settle(call, status = 'completed', error) {
    const s = sessions.get(call.id); s.taskStatus = status; sessions.save(s);
    queue.queued = queue.queued.filter(id => id !== call.id); queue.running = queue.running.filter(id => id !== call.id);
    call.hooks.settled(s, error);
  }
  return {root, sessions, calls, runs, queue, agents, teams, port, host, settle, setUnavailable: value => {unavailable = value;}};
}
// Exercise the real main-process authorization function without importing Electron,
// initializing a real profile, or replacing the production action-rule evaluator.
const mainCode = (await transform(readFileSync('source/venditbot/main.ts', 'utf8'), {loader: 'ts', target: 'es2024'})).code;
let authorizationNode;
simple(parse(mainCode, {ecmaVersion: 'latest', sourceType: 'module'}), {VariableDeclarator(node) {if (node.id?.name === 'authorizeAction' && node.init?.type === 'FunctionExpression') authorizationNode = node.init;}});
assert.ok(authorizationNode, 'main authorization entry point must exist');
const authBuilt = await build({stdin: {resolveDir: process.cwd(), contents: `
import {evaluateActionRules, DEFAULT_ACTION_RULES} from './source/shared/action-rules.ts';
export function authHarness(defaultMode, approval) {
 let current = {...structuredClone(DEFAULT_ACTION_RULES), defaultMode};
 let approvalTail = Promise.resolve(), requests = 0;
 const actionRules = {get: () => structuredClone(current)};
 const requestApproval = async () => {requests++; return approval();};
 const authorizeAction = ${mainCode.slice(authorizationNode.start, authorizationNode.end)};
 return {authorizeAction, calls: () => requests, setMode(mode) {current = {...current, defaultMode: mode, updatedAt: '2026-10-12T01:00:00.000Z'};}};
}`}, bundle: true, platform: 'node', format: 'esm', write: false});
const {authHarness} = await import('data:text/javascript;base64,' + Buffer.from(authBuilt.outputFiles[0].text + '\n//# sourceURL=routine-authorization-test-bundle.mjs').toString('base64'));
const request = {path: '.', operation: 'manage', tool: 'create_routine', category: 'routine'};

test('agent correlation and original routing snapshot are durably stored before enqueue', async t => {
  const f = fixture(t), r = reservation();
  const enqueue = f.port.enqueue;
  f.port.enqueue = (id, prompt, hooks) => {
    const disk = JSON.parse(readFileSync(join(f.root, 'conversations.json'), 'utf8')).sessions.find(s => s.id === id);
    assert.equal(disk.routineDispatchId, r.dispatchId);
    assert.deepEqual(disk.connections, f.agents.get('one').connections);
    assert.deepEqual(disk.policyAllowedConnections, disk.connections);
    assert.equal(disk.automation.policyId, 'saved-policy');
    assert.equal(disk.agentId, 'one');
    enqueue(id, prompt, hooks);
  };
  let settled = false;
  const result = f.host.dispatchReserved(r).then(value => {settled = true; return value;});
  await turn(); assert.equal(settled, false); assert.equal(f.calls.length, 1); assert.equal(f.host.inspectDispatch(r.dispatchId), 'running');
  f.settle(f.calls[0]); assert.deepEqual(await result, {status: 'completed'}); assert.equal(f.host.inspectDispatch(r.dispatchId), 'completed');
});
test('known unavailable or deleted targets fail before creating any session', async t => {
  const f = fixture(t); f.setUnavailable(true);
  assert.equal((await f.host.dispatchReserved(reservation())).status, 'failed'); f.setUnavailable(false); f.agents.delete('one');
  assert.equal((await f.host.dispatchReserved(reservation())).status, 'failed'); assert.equal(f.calls.length, 0); assert.equal(f.sessions.list().length, 0);
});
test('a busy recheck rejects overlap after reservation and allows unrelated targets', async t => {
  const f = fixture(t), first = f.host.dispatchReserved(reservation());
  assert.equal((await f.host.dispatchReserved(reservation())).status, 'failed');
  const other = f.host.dispatchReserved(reservation({kind: 'agent', id: 'three'})); assert.equal(f.calls.length, 2);
  for (const call of f.calls) f.settle(call); await Promise.all([first, other]);
});
test('teams preserve dispatch correlation and block same-member cross-team races', async t => {
  const f = fixture(t), r = reservation({kind: 'team', id: 'team-one'}), result = f.host.dispatchReserved(r);
  assert.equal(f.calls[0].internal.routineDispatchId, r.dispatchId); assert.equal(f.calls[0].context, undefined);
  assert.deepEqual(f.calls[0].members.map(a => a.id), ['one', 'two']);
  assert.equal((await f.host.dispatchReserved(reservation({kind: 'team', id: 'team-two'}))).status, 'failed');
  assert.equal((await f.host.dispatchReserved(reservation({kind: 'agent', id: 'two'}))).status, 'failed');
  f.runs[0].status = 'completed'; f.host.teamChanged(f.runs[0]); assert.deepEqual(await result, {status: 'completed'});
});
test('live team cancellation settles failed but the same persisted restart outcome is unknown', async t => {
  const f = fixture(t), r = reservation({kind: 'team', id: 'team-one'}), result = f.host.dispatchReserved(r);
  f.runs[0].status = 'cancelled'; f.host.teamChanged(f.runs[0]); assert.equal((await result).status, 'failed');
  assert.equal(new RoutineHost(f.port).inspectDispatch(r.dispatchId), 'unknown');
});
test('crash between durable session creation and queue admission is unknown and is never replayed', async t => {
  const f = fixture(t), r = reservation(); f.port.enqueue = () => {throw Error('admission outcome unavailable');};
  await assert.rejects(f.host.dispatchReserved(r)); assert.equal(f.sessions.list().length, 1); assert.equal(f.host.inspectDispatch(r.dispatchId), 'unknown');
  await assert.rejects(f.host.dispatchReserved(r), /재전송/); assert.equal(f.sessions.list().length, 1);
});
test('persisted completed, failed, and cancelled correlations are never reused', async t => {
  for (const status of ['completed', 'failed', 'cancelled']) {
    const f = fixture(t), r = reservation();
    const s = f.sessions.create('provider-one', 'model-one', undefined, undefined, {agentId: 'one', routineDispatchId: r.dispatchId}); s.taskStatus = status; f.sessions.save(s);
    assert.equal(f.host.inspectDispatch(r.dispatchId), status === 'cancelled' ? 'unknown' : status);
    await assert.rejects(f.host.dispatchReserved(r), /재전송/); assert.equal(f.calls.length, 0);
  }
});
test('a reloaded in-flight conversation is cancelled by the existing store and remains unknown', t => {
  const f = fixture(t), r = reservation(), s = f.sessions.create('provider-one', 'model-one', undefined, undefined, {agentId: 'one', routineDispatchId: r.dispatchId});
  s.taskStatus = 'running'; f.sessions.save(s);
  f.port.sessions = new LocalSessionStore(f.root); assert.equal(f.port.sessions.get(s.id).taskStatus, 'cancelled');
  assert.equal(new RoutineHost(f.port).inspectDispatch(r.dispatchId), 'unknown'); assert.equal(f.calls.length, 0);
});
test('queue capacity and manual agent work are honored without provider calls', async t => {
  const f = fixture(t); f.queue.queued = Array.from({length: 16}, (_, i) => 'queued-' + i);
  assert.equal((await f.host.dispatchReserved(reservation())).status, 'failed'); f.queue.queued = [];
  const s = f.sessions.create('provider-one', 'model-one', undefined, undefined, {agentId: 'one'}); f.queue.running.push(s.id);
  assert.equal((await f.host.dispatchReserved(reservation())).status, 'failed'); assert.equal(f.calls.length, 0);
});
test('settlement errors are bounded user-facing failures rather than leaked exception contents', async t => {
  const f = fixture(t), result = f.host.dispatchReserved(reservation()); f.settle(f.calls[0], 'completed', Error('sensitive provider diagnostic'));
  const outcome = await result; assert.equal(outcome.status, 'failed'); assert.ok(!outcome.error.includes('sensitive'));
});
test('deleted targets keep their visible in-flight membership fence until work settles', async t => {
  const f = fixture(t), r = reservation({kind: 'team', id: 'team-one'}), result = f.host.dispatchReserved(r);
  f.teams.delete('team-one');
  assert.equal(f.host.validateTarget(r.target), false);
  assert.equal(f.host.isTargetBusy(r.target), true);
  f.runs[0].status = 'completed'; f.host.teamChanged(f.runs[0]); await result;
  assert.equal(f.host.isTargetBusy(r.target), false);
  const agent = f.host.dispatchReserved(reservation()); f.agents.delete('one');
  assert.equal(f.host.validateTarget({kind: 'agent', id: 'one'}), false);
  assert.equal(f.host.isTargetBusy({kind: 'agent', id: 'one'}), true);
  f.settle(f.calls.find(c => c.kind === 'agent')); await agent;
  assert.equal(f.host.isTargetBusy({kind: 'agent', id: 'one'}), false);
});

test('forced ambiguity approval cannot bypass a stored deny rule', async () => {
 const auth = authHarness('deny', async () => true);
 await assert.rejects(auth.authorizeAction(request, new AbortController().signal, 'synthetic-session', true), /차단/);
 assert.equal(auth.calls(), 0);
});
test('ambiguous intent asks despite allow and rechecks a rule tightened during approval', async () => {
 let resolve; const gate = new Promise(done => {resolve = done;});
 const auth = authHarness('allow', () => gate), signal = new AbortController().signal;
 assert.equal(await auth.authorizeAction(request, signal, 'synthetic-session', false), true); assert.equal(auth.calls(), 0);
 const attempt = auth.authorizeAction(request, signal, 'synthetic-session', true); await turn(); assert.equal(auth.calls(), 1);
 auth.setMode('deny'); resolve(true); await assert.rejects(attempt, /규칙이 변경/);
});
