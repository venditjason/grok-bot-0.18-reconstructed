import assert from 'node:assert/strict';
import {mkdtemp, readFile, writeFile, rm, symlink, link, rename, mkdir, stat} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import path from 'node:path';
import test from 'node:test';
import {build} from 'esbuild';

const built = await build({entryPoints: [path.resolve('source/venditbot/agent-store.ts')], bundle: true, platform: 'node', format: 'esm', write: false});
const {AgentStore} = await import(`data:text/javascript;base64,${Buffer.from(built.outputFiles[0].text).toString('base64')}`);
async function fixture(t) { const root = await mkdtemp(path.join(tmpdir(), 'venditbot-agents-')); t.after(() => rm(root, {recursive: true, force: true})); return {root, file: path.join(root, 'agents.json')}; }
const input = {name: '검토 담당', instructions: '파일을 검토하고 설명하세요.', connectionId: 'codex', model: 'gpt-6-astra', effort: 'xhigh'};

test('agents persist private records and return independent snapshots across edit/restart/delete', async t => {
  const {root, file} = await fixture(t), store = new AgentStore(root), saved = store.save(input);
  assert.equal((await stat(file)).mode & 0o777, 0o600); assert.equal(new AgentStore(root).get(saved.id).effort, 'xhigh');
  saved.name = 'mutation'; const snapshot = store.list(); snapshot[0].instructions = 'mutation';
  assert.equal(store.get(saved.id).name, input.name); assert.equal(store.get(saved.id).instructions, input.instructions);
  const edited = store.save({...input, id: saved.id, name: '새 이름'}); assert.equal(edited.createdAt, saved.createdAt); assert.equal(store.list().length, 1);
  store.remove(saved.id); assert.deepEqual(new AgentStore(root).list(), []); assert.throws(() => store.get(saved.id));
});

test('agent store rejects malformed records and preserves every corrupt source byte', async t => {
  const {root, file} = await fixture(t), valid = new AgentStore(root).save(input);
  for (const invalid of ['not JSON', JSON.stringify({version: 2, agents: []}), JSON.stringify({version: 1, agents: [valid, valid]}), JSON.stringify({version: 1, agents: [{...valid, name: ''}]}), JSON.stringify({version: 1, agents: [{...valid, instructions: 'a'.repeat(16001)}]}), JSON.stringify({version: 1, agents: [{...valid, createdAt: 'not-date'}]})]) {
    await writeFile(file, invalid); assert.throws(() => new AgentStore(root)); assert.equal(await readFile(file, 'utf8'), invalid);
  }
  await writeFile(file, Buffer.alloc(4 * 1024 * 1024 + 1)); assert.throws(() => new AgentStore(root), /안전/);
});

test('agent store refuses symlinks and hardlinks without changing their targets', async t => {
  const {root, file} = await fixture(t), target = path.join(root, 'target.json'); const sentinel = '{"version":1,"agents":[]}';
  await writeFile(target, sentinel); await symlink(target, file); assert.throws(() => new AgentStore(root), /안전/);
  await rm(file); await link(target, file); assert.throws(() => new AgentStore(root), /안전/); assert.equal(await readFile(target, 'utf8'), sentinel);
});

test('failed agent storage commits preserve in-memory records and prior saved file', async t => {
  const {root, file} = await fixture(t), store = new AgentStore(root), agent = store.save(input), original = await readFile(file, 'utf8');
  await rename(file, `${file}.backup`); await mkdir(file);
  assert.throws(() => store.save({...input, id: agent.id, name: 'must not commit'}));
  assert.throws(() => store.remove(agent.id)); assert.equal(store.get(agent.id).name, input.name);
  assert.equal(await readFile(`${file}.backup`, 'utf8'), original);
});

test('agent field limits remain bounded while more than100 agents persist without a roster cap', async t => {
  const {root} = await fixture(t), store = new AgentStore(root);
  for (const invalid of [{...input, name: ''}, {...input, name: 'a'.repeat(81)}, {...input, instructions: ''}, {...input, instructions: 'a'.repeat(16001)}, {...input, effort: 'a'.repeat(41)}, {...input, connectionId: '\0'}]) assert.throws(() => store.save(invalid));
  for (let index = 0; index < 125; index++) store.save({...input, name: `agent-${index}`});
  assert.equal(store.list().length, 125); assert.equal(new AgentStore(root).list().length, 125);
  const first = store.list()[0]; store.save({...first, name: 'allowed update'}); assert.equal(store.list().length, 125);
});

test('priority routes normalize the legacy fields and stay detached across save, reads and restart', async t => {
  const {root} = await fixture(t), store = new AgentStore(root);
  const routes = [{connectionId: 'api-first', model: 'first-model'}, {connectionId: 'codex', model: 'gpt-6-astra', effort: 'xhigh'}];
  const saved = store.save({...input, connections: routes});
  assert.equal(saved.connectionId, 'api-first'); assert.equal(saved.model, 'first-model'); assert.equal(saved.effort, undefined);
  routes[0].model = 'external-mutation'; saved.connections[1].effort = 'low';
  const loaded = new AgentStore(root).get(saved.id);
  assert.equal(loaded.connections[0].model, 'first-model'); assert.equal(loaded.connections[1].effort, 'xhigh');
  const reordered = store.save({...loaded, connections: [...loaded.connections].reverse()});
  assert.equal(reordered.connectionId, 'codex'); assert.equal(reordered.effort, 'xhigh');
});

for (const editExisting of [false, true]) test(`multibyte aggregate size rejects ${editExisting ? 'edits' : 'new agents'} before creating an unreadable restart file`, async t => {
  const {root, file} = await fixture(t), store = new AgentStore(root);
  const originals = editExisting ? Array.from({length: 100}, (_, index) => store.save({...input, name: `agent-${index}`})) : [];
  let rejected = false;
  for (let index = 0; index < 100; index++) {
    const before = store.list(), bytes = index || editExisting ? await readFile(file) : undefined;
    try { store.save({...input, ...(editExisting ? {id: originals[index].id} : {}), name: `agent-${index}`, instructions: '가'.repeat(16000)}); }
    catch (error) {
      assert.match(error.message, /전체 저장 한도 4MiB/); rejected = true;
      assert.deepEqual(store.list(), before); assert.deepEqual(await readFile(file), bytes);
      assert.deepEqual(new AgentStore(root).list(), before); break;
    }
  }
  assert.equal(rejected, true); assert.ok((await stat(file)).size <= 4 * 1024 * 1024);
  const first = store.list()[0]; store.save({...first, instructions: '줄인 지시문'});
  assert.equal(new AgentStore(root).get(first.id).instructions, '줄인 지시문');
});

test('invalid priority arrays and inconsistent stored primary fields preserve prior agent data', async t => {
  const {root, file} = await fixture(t), store = new AgentStore(root), route = {connectionId: 'codex', model: 'gpt-6-astra', effort: 'xhigh'};
  const saved = store.save({...input, connections: [route]}), original = await readFile(file, 'utf8');
  for (const connections of [[], null, {}, [route, route], Array.from({length: 9}, (_, i) => ({...route, model: `m${i}`})), [{...route, model: ''}], [{...route, model: 'with space'}], [{...route, effort: '\0'}]]) {
    assert.throws(() => store.save({...input, id: saved.id, connections})); assert.equal(await readFile(file, 'utf8'), original);
    const invalid = JSON.stringify({version: 1, agents: [{...saved, connections}]}); await writeFile(file, invalid);
    assert.throws(() => new AgentStore(root)); assert.equal(await readFile(file, 'utf8'), invalid); await writeFile(file, original);
  }
  const invalid = JSON.stringify({version: 1, agents: [{...saved, model: 'different-primary'}]}); await writeFile(file, invalid);
  assert.throws(() => new AgentStore(root)); assert.equal(await readFile(file, 'utf8'), invalid);
});
