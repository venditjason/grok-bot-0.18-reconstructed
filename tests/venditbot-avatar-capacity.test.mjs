import assert from 'node:assert/strict';
import test from 'node:test';
import {mkdtemp, readFile, writeFile, readdir, realpath, rm, stat, truncate, symlink, link, mkdir, utimes} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {createHash} from 'node:crypto';
import {setImmediate as tick} from 'node:timers/promises';
import {build} from 'esbuild';

const built = await build({stdin: {contents: [
  'agent-avatar', 'default-avatar', 'agent-store', 'team-store', 'team-coordinator', 'task-queue',
].map(name => `export * from './source/venditbot/${name}.ts';`).join('\n'), resolveDir: process.cwd()}, bundle: true, platform: 'node', format: 'esm', write: false});
const {AvatarStore, randomDefaultAvatarScene, AgentStore, TeamStore, TeamCoordinator, TaskQueue} = await import('data:text/javascript;base64,' + Buffer.from(built.outputFiles[0].text).toString('base64'));
const CAPACITY = 1024 ** 3;
const scene = {background: '#7654EF', shapes: [{type: 'circle', cx: 256, cy: 256, r: 160, fill: '#FED'}]};
const png = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aN1cAAAAASUVORK5CYII=', 'base64');
const hash = bytes => createHash('sha256').update(bytes).digest('hex');
async function fixture(t, cleanup = true) {
  const root = await realpath(await mkdtemp(join(tmpdir(), 'vendit-avatar-capacity-')));
  if (cleanup) t.after(() => rm(root, {recursive: true, force: true}));
  return {root, directory: join(root, 'avatars'), avatars: new AvatarStore(root)};
}
async function sparseFile(path, bytes) {await writeFile(path, '', {mode: 0o600}); await truncate(path, bytes);}

// This uses the same real store/default-avatar/prune sequence as main's cloneAgent.
// Only inference is replaced with an abortable pending job; no credentials or network.
async function companyFixture(t) {
  const f = await fixture(t, false), agents = new AgentStore(f.root), store = new TeamStore(f.root), sessions = new Map();
  let coordinator;
  const queue = new TaskQueue({onChange: () => coordinator?.schedule()});
  const createDefaultAvatar = () => {
    f.avatars.prune([...agents.list(), ...store.listRuns().flatMap(run => run.memberSnapshots)].flatMap(agent => agent.avatarId ? [agent.avatarId] : []));
    return f.avatars.save(randomDefaultAvatarScene()).id;
  };
  const leader = agents.save({name: '대표', instructions: '합성 저장소 검증', connectionId: 'codex', model: 'synthetic-model', avatarId: createDefaultAvatar()});
  const port = {
    createSessions(run) {for (const step of run.steps) if (!sessions.has(step.sessionId)) sessions.set(step.sessionId, {id: step.sessionId, messages: [], taskStatus: 'queued'});},
    enqueue(id, _prompt, hooks) {
      queue.submit(id, async signal => {
        hooks.started();
        await new Promise(resolve => {if (signal.aborted) resolve(); else signal.addEventListener('abort', resolve, {once: true});});
        sessions.get(id).messages.push({id: 'cancelled', role: 'assistant', status: 'cancelled', text: ''});
        hooks.settled(structuredClone(sessions.get(id)));
      });
    },
    cancelSession: id => queue.abort(id), getSession: id => structuredClone(sessions.get(id)),
    listAgents: () => agents.list(), listModels: async () => ({models: []}),
    resolveDelegation: async member => ({connections: member.connections}),
    cloneAgent(template, changes) {
      const {id, createdAt, updatedAt, avatarId, ...configuration} = template;
      return agents.save({...configuration, ...changes, avatarId: createDefaultAvatar()});
    },
    removeAgent: (id, revision) => agents.remove(id, revision), queueState: () => queue.state(), changed() {}, teamChanged() {},
  };
  coordinator = new TeamCoordinator(store, port);
  const team = store.saveTeam({name: '300명 검증', instructions: '', topic: '', policies: '', leaderAgentId: leader.id, memberAgentIds: [leader.id], rounds: 1, autonomous: true});
  const run = coordinator.start(team.id, '저장소 경계를 검증하세요.', [leader]);
  await tick();
  t.after(async () => {try {coordinator.stopForQuit(); assert.equal(await queue.close(1000), true);} finally {await rm(f.root, {recursive: true, force: true});}});
  return {...f, agents, store, queue, coordinator, team, run, leader, tools: coordinator.tools(queue.state().running[0])};
}

test('300 autonomous spawns use real immutable default avatars and preserve live and historical images after restart/prune', async t => {
  const f = await companyFixture(t), snapshots = new Map(), spawned = [];
  snapshots.set(f.leader.avatarId, await readFile(join(f.directory, f.leader.avatarId + '.json')));
  for (let i = 0; i < 300; i++) {
    const result = await f.tools.execute('add_team_member', {name: '실제 저장 구성원 ' + i}, 'spawn-' + i);
    const agent = f.agents.get(result.createdAgent.id);
    spawned.push(agent);
    assert.ok(agent.avatarId);
    assert.equal(snapshots.has(agent.avatarId), false);
    snapshots.set(agent.avatarId, await readFile(join(f.directory, agent.avatarId + '.json')));
  }
  assert.equal(f.agents.list().length, 301);
  assert.equal(f.store.getTeam(f.team.id).memberAgentIds.length, 301);
  assert.equal(f.store.getRun(f.run.id).memberSnapshots.length, 301);
  assert.equal((await readdir(f.directory)).length, 301);

  // An administrator deleting an unlinked agent must not erase its historical photo.
  await f.tools.execute('remove_team_member', {agentId: spawned[0].id}, 'unlink');
  f.agents.remove(spawned[0].id, spawned[0].updatedAt);
  const refs = [...f.agents.list(), ...f.store.listRuns().flatMap(run => run.memberSnapshots)].flatMap(agent => agent.avatarId ? [agent.avatarId] : []);
  const previews = [];
  for (let i = 0; i < 20; i++) {
    const asset = f.avatars.save(scene); previews.push(asset);
    await utimes(join(f.directory, asset.id + '.json'), 2_000_000_000 + i, 2_000_000_000 + i);
  }
  assert.equal(f.avatars.prune(refs), 4);
  assert.equal((await readdir(f.directory)).length, 317);
  for (const asset of previews.slice(0, 4)) assert.throws(() => f.avatars.get(asset.id), {code: 'ENOENT'});
  for (const asset of previews.slice(4)) assert.deepEqual(f.avatars.get(asset.id), asset);
  assert.equal(f.avatars.prune(refs, 300), 0, 'retention option has no old 256-count ceiling');
  const restarted = new AvatarStore(f.root);
  assert.equal(new AgentStore(f.root).list().length, 300);
  assert.equal(new TeamStore(f.root).getRun(f.run.id).memberSnapshots.length, 301);
  for (const [id, original] of snapshots) {
    assert.equal(hash(await readFile(join(f.directory, id + '.json'))), hash(original));
    assert.equal(restarted.get(id).id, id);
    assert.equal((await stat(join(f.directory, id + '.json'))).mode & 0o777, 0o600);
  }
});

for (const kind of ['illustration', 'image']) test(`${kind} total serialized bytes accept exactly1GiB, reject the next write and retain original assets`, async t => {
  const {avatars, directory, root} = await fixture(t);
  const save = () => kind === 'image' ? avatars.saveImagePng(png) : avatars.save(scene);
  const first = save(), file = join(directory, first.id + '.json'), original = await readFile(file), size = original.length;
  // UUIDv4 and ISO timestamps have fixed lengths, so the next serialized record is equally sized.
  const filler = join(directory, 'synthetic-quota.bin');
  await sparseFile(filler, CAPACITY - 2 * size);
  const atLimit = save();
  assert.equal((await stat(join(directory, atLimit.id + '.json'))).size, size);
  const names = (await readdir(directory)).sort();
  assert.throws(save, /1GiB/);
  assert.deepEqual((await readdir(directory)).sort(), names, 'failure must not leave temporary or partial assets');
  assert.deepEqual(await readFile(file), original);
  assert.deepEqual(new AvatarStore(root).get(first.id), first);
  assert.deepEqual(new AvatarStore(root).get(atLimit.id), atLimit);
  await rm(filler);
  assert.ok(save().id, 'capacity failure must not poison later valid writes');
});

test('the total-byte budget preserves capacity previously available for256 maximum-size raster records', async t => {
  const {avatars, directory} = await fixture(t), first = avatars.saveImagePng(png);
  const record = JSON.parse(await readFile(join(directory, first.id + '.json'), 'utf8'));
  record.png = Buffer.alloc(2 * 1024 * 1024).toString('base64');
  const oldWorstCase = 256 * Buffer.byteLength(JSON.stringify(record, null, 2));
  assert.ok(oldWorstCase > 680 * 1024 * 1024 && oldWorstCase < CAPACITY);
  await sparseFile(join(directory, 'synthetic-old-capacity.bin'), oldWorstCase);
  assert.ok(avatars.saveImagePng(png).id);
  assert.ok(avatars.save(scene).id);
});

test('unexpected symlinks, hardlinks and directories cannot evade capacity accounting or broaden prune deletion', async t => {
  const {avatars, directory, root} = await fixture(t), original = avatars.save(scene), sentinel = join(root, 'outside.json');
  const bytes = await readFile(join(directory, original.id + '.json')); await writeFile(sentinel, bytes);
  const suspicious = join(directory, 'unrecognized-entry');
  for (const create of [() => symlink(sentinel, suspicious), () => link(sentinel, suspicious), () => mkdir(suspicious)]) {
    await create();
    assert.throws(() => avatars.save(scene), /안전/);
    assert.throws(() => avatars.saveImagePng(png), /안전/);
    assert.equal(avatars.prune([original.id], 0), 0);
    assert.deepEqual(await readFile(sentinel), bytes);
    assert.deepEqual(await readFile(join(directory, original.id + '.json')), bytes);
    await rm(suspicious, {recursive: true});
  }
});

test('a full avatar byte budget rejects autonomous cloning without changing agents/team/original image, then recovers', async t => {
  const f = await companyFixture(t), beforeAgents = f.agents.list(), beforeTeam = f.store.getTeam(f.team.id), beforeRun = f.store.getRun(f.run.id);
  const image = join(f.directory, f.leader.avatarId + '.json'), original = await readFile(image), filler = join(f.directory, 'synthetic-full.bin');
  await sparseFile(filler, CAPACITY);
  await assert.rejects(f.tools.execute('add_team_member', {name: '용량 초과'}, 'full'), /1GiB/);
  assert.deepEqual(f.agents.list(), beforeAgents);
  assert.deepEqual(f.store.getTeam(f.team.id), beforeTeam);
  const afterRun = f.store.getRun(f.run.id);
  assert.deepEqual({...afterRun, messages: beforeRun.messages, updatedAt: beforeRun.updatedAt}, beforeRun);
  assert.deepEqual(afterRun.messages.slice(0, beforeRun.messages.length), beforeRun.messages);
  assert.equal(afterRun.messages.length, beforeRun.messages.length + 1);
  assert.match(afterRun.messages.at(-1).text, /1GiB/, 'the team keeps an explicit failure audit without a phantom member');
  assert.deepEqual(await readFile(image), original);
  assert.equal((await readdir(f.directory)).length, 2);
  await rm(filler);
  const recovered = await f.tools.execute('add_team_member', {name: '정상 생성'}, 'recovered');
  assert.ok(f.avatars.get(f.agents.get(recovered.createdAgent.id).avatarId));
  assert.equal(f.agents.list().length, 2);
});
