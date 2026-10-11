// Bounded synthetic stability exercise, not a real-time/real-provider soak test.
// Run: node --expose-gc scripts/qa-venditbot-stability.mjs
import assert from 'node:assert/strict';
import {randomUUID, createHash} from 'node:crypto';
import {spawn} from 'node:child_process';
import {mkdtempSync, mkdirSync, readFileSync, writeFileSync, renameSync, rmSync, readdirSync, statSync} from 'node:fs';
import {tmpdir, platform, arch, release} from 'node:os';
import {resolve, join, dirname} from 'node:path';
import {setImmediate as tick} from 'node:timers/promises';
import {performance} from 'node:perf_hooks';
import {build} from 'esbuild';

const repository = resolve(import.meta.dirname, '..');
const reportPath = join(repository, 'work', 'backend-stability-report.json');
const temporary = mkdtempSync(join(tmpdir(), 'venditbot-stability-'));
const hash = bytes => createHash('sha256').update(bytes).digest('hex');
const sources = ['task-queue.ts', 'local-store.ts', 'team-store.ts', 'team-coordinator.ts', 'agent-store.ts'];
const built = await build({stdin: {contents: sources.map(name => `export * from './source/venditbot/${name}';`).join('\n'), resolveDir: repository}, bundle: true, platform: 'node', format: 'esm', write: false});
const {TaskQueue, LocalSessionStore, TeamStore, TeamCoordinator, AgentStore, atomicWriteJson} = await import(`data:text/javascript;base64,${Buffer.from(built.outputFiles[0].text).toString('base64')}`);
const started = performance.now(), counters = {}, memory = [];
const report = {schema: 'venditbot.synthetic-stability.v1', startedAt: new Date().toISOString(), node: process.version, platform: platform(), arch: arch(), osRelease: release(), forcedGcAvailable: typeof global.gc === 'function', sourceHashes: Object.fromEntries(sources.map(name => [name, hash(readFileSync(join(repository, 'source/venditbot', name)))])), limitations: ['Synthetic local fixtures only; no real provider, Keychain, Electron, renderer, network, production profile, release archive or updater channel access.', 'Compressed repeated operations are not an eight-hour soak, power-loss test, or proof of no memory leak.', 'Sampled heap/RSS includes fixture objects and V8 allocation. Process high-water RSS also includes esbuild and intentional large-file boundary allocation.'], phases: []};
const count = (name, n = 1) => { counters[name] = (counters[name] ?? 0) + n; };
const sample = (label, collect = false) => { if (collect) global.gc?.(); const value = {label, elapsedMs: Math.round(performance.now() - started), ...process.memoryUsage(), maxRSSKiB: process.resourceUsage().maxRSS}; memory.push(value); return value; };
const rootFor = name => {const root = join(temporary, name); mkdirSync(root, {recursive: true, mode: 0o700}); return root;};
const defer = () => {let resolve; const promise = new Promise(done => {resolve = done;}); return {promise, resolve};};
const now = () => new Date().toISOString();
const message = (role, text, status = 'completed') => ({id: randomUUID(), role, text, status, createdAt: now()});
const assertNoTemps = root => assert.equal(readdirSync(root).filter(name => name.endsWith('.tmp')).length, 0);
const agentInput = {name: '합성 담당', instructions: '합성 저장소 검사 역할', connectionId: 'fixture-api', model: 'fixture-model'};
const unhandled = [];
const onUnhandled = error => unhandled.push(String(error));
process.on('unhandledRejection', onUnhandled);
async function phase(name, run) {
  const begin = performance.now(), before = sample(`${name}:before`, true);
  const value = await run(); await tick(); const after = sample(`${name}:after`, true);
  report.phases.push({name, durationMs: Math.round(performance.now() - begin), before, after, ...value});
  console.log(JSON.stringify({phase: name, durationMs: report.phases.at(-1).durationMs, ...value}));
}

try {
  await phase('queue-repeat-cancel-failure', async () => {
    let observerCalls = 0, executing = 0, maxExecuting = 0, errors = 0;
    const observerViolations = [];
    const queue = new TaskQueue({onChange: state => {
      // Queue intentionally swallows observer throws; record violations outside
      // the observer so an assertion cannot be swallowed by the unit under test.
      if (state.running.length > 1 || state.queued.length > 16) observerViolations.push(structuredClone(state));
      state.queued.push('detached observer mutation');
      if (++observerCalls % 19 === 0) throw new Error('synthetic observer throw');
      if (observerCalls % 23 === 0) return Promise.reject(new Error('synthetic observer rejection'));
    }, onError: () => {errors++; if (errors % 11 === 0) return Promise.reject(new Error('synthetic error observer rejection'));}});
    for (let cycle = 0; cycle < 600; cycle++) {
      const gate = defer(), starts = [], expected = [], prefix = `${cycle}:`;
      queue.submit(prefix + '0', async () => {starts.push(0); executing++; maxExecuting = Math.max(maxExecuting, executing); try {await gate.promise;} finally {executing--;}}); count('queueAccepted');
      for (let index = 1; index <= 16; index++) {
        queue.submit(prefix + index, () => {
          starts.push(index); executing++; maxExecuting = Math.max(maxExecuting, executing);
          try {if (index === 3) throw new Error('synthetic sync failure'); if (index === 5) return Promise.reject(new Error('synthetic async failure'));}
          finally {executing--;}
        }); count('queueAccepted');
      }
      assert.throws(() => queue.submit(prefix + 'overflow', () => {}), /16/); count('queueOverflowRejected');
      assert.throws(() => queue.submit(prefix + '0', () => {}), /이미/); count('queueDuplicateRejected');
      for (let index = 1; index <= 16; index++) if (index % 3 === 1) {assert.equal(queue.abort(prefix + index), true); count('queueWaitingCancelled');} else expected.push(index);
      queue.submit(prefix + 'replacement', () => {starts.push(17);}); count('queueAccepted'); expected.push(17);
      if (cycle % 3 === 1) {assert.equal(queue.abort(prefix + '0'), true); count('queueReservedCancelled');}
      else {
        await tick(); expected.unshift(0); assert.equal(await queue.waitForIdle(0), false);
        if (cycle % 3 === 0) {queue.abort(prefix + '0'); count('queueRunningCancelled'); await tick(); assert.deepEqual(starts, [0]);}
      }
      const observers = [queue.waitForIdle(2000), queue.waitForIdle(2000), queue.waitForIdle(2000)]; gate.resolve();
      assert.deepEqual(await Promise.all(observers), [true, true, true]); assert.deepEqual(starts, expected); assert.deepEqual(queue.state(), {running: [], queued: []});
      count('queueInvoked', starts.length);
      if (cycle % 100 === 0) sample(`queue-cycle-${cycle}`, true);
    }
    assert.equal(maxExecuting, 1); assert.equal(errors, 1200); assert.deepEqual(observerViolations, []); assert.equal(await queue.close(), true);
    for (let cycle = 0; cycle < 120; cycle++) {
      const gate = defer(), closed = new TaskQueue(); let waitingInvoked = false;
      closed.submit('active', () => gate.promise); closed.submit('waiting', () => {waitingInvoked = true;}); count('queueAccepted', 2); await tick();
      assert.equal(await closed.close(1), false); assert.throws(() => closed.submit('late', () => {}), /종료/); gate.resolve(); await tick();
      assert.equal(await closed.close(), true); assert.equal(waitingInvoked, false); count('queueBoundedCloseCycles');
    }
    await tick(); assert.deepEqual(unhandled, []);
    return {cycles: 600, closeCycles: 120, maxConcurrentJobs: maxExecuting, capturedJobFailures: errors, observerCallbacks: observerCalls};
  });

  await phase('session-save-restart-recovery', async () => {
    const root = rootFor('sessions'), file = join(root, 'conversations.json'); let store = new LocalSessionStore(root);
    for (let cycle = 0; cycle < 600; cycle++) {
      const s = store.create('fixture-api', 'fixture-model', undefined, undefined, {connections: [{connectionId: 'fixture-api', model: 'fixture-model'}], agentId: 'fixture-agent', agentName: '합성 역할', instructions: '고정 역할'});
      s.taskStatus = cycle % 2 ? 'queued' : 'running'; s.queuedPrompt = `미완료 요청 ${cycle}`;
      s.messages = [message('user', `입력 ${cycle}`), {...message('assistant', `부분 응답 ${cycle}`, 'running'), tools: [{callId: randomUUID(), name: 'write_file', status: 'running', input: {path: 'synthetic.txt'}, output: {approved: true}}], attempts: [{connectionId: 'fixture-api', model: 'fixture-model', status: 'running'}]}];
      store.save(s); count('sessionInterruptedSaves');
      store = new LocalSessionStore(root); count('sessionRestarts'); const recovered = store.get(s.id);
      assert.equal(recovered.taskStatus, 'cancelled'); assert.equal(recovered.messages[1].status, 'failed'); assert.equal(recovered.messages[1].tools[0].status, 'failed'); assert.equal(recovered.messages[1].attempts[0].status, 'failed');
      assert.equal(recovered.messages[1].text, `부분 응답 ${cycle}`); assert.equal(recovered.instructions, '고정 역할');
      if (cycle % 5 === 0) {
        const bytes = readFileSync(file), old = store.get(s.id), backup = file + '.backup'; renameSync(file, backup); mkdirSync(file);
        try {assert.throws(() => store.save({...recovered, title: '저장되면 안 됨'})); assert.deepEqual(store.get(s.id), old); assert.deepEqual(readFileSync(backup), bytes); count('sessionStorageFailures');}
        finally {rmSync(file, {recursive: true}); renameSync(backup, file);}
      }
      recovered.messages.push(message('user', `명시적 재시도 ${cycle}`), message('assistant', `완료 응답 ${cycle}`)); recovered.taskStatus = 'completed'; store.save(recovered);
      const restarted = new LocalSessionStore(root); count('sessionRestarts'); assert.deepEqual(restarted.get(s.id), store.get(s.id));
      const detached = store.get(s.id); detached.messages[0].text = '외부 변경'; assert.notEqual(store.get(s.id).messages[0].text, detached.messages[0].text);
      const all = store.list(); if (all.length > 8) store.remove(all.at(-1).id);
      assertNoTemps(root); if (cycle % 100 === 0) sample(`session-cycle-${cycle}`, true);
    }
    assert.equal(statSync(file).mode & 0o777, 0o600); return {cycles: 600, restartReads: 1200, injectedWriteFailures: 120, retainedSessions: store.list().length, finalFileBytes: statSync(file).size};
  });

  await phase('company-team-real-queue-and-durable-stores', async () => {
    const root = rootFor('teams'), agents = new AgentStore(root), leader = agents.save(agentInput), worker = agents.save({...agentInput, name: '합성 팀원'}), sessions = new LocalSessionStore(root), store = new TeamStore(root), jobs = new Map(), errors = [];
    const team = store.saveTeam({name: '합성 회사', topic: '반복 검증', instructions: '순서대로 수행', policies: '원본 보존', leaderAgentId: leader.id, memberAgentIds: [leader.id, worker.id], rounds: 1});
    let coordinator, executing = 0, maxExecuting = 0;
    const queue = new TaskQueue({onChange: () => coordinator?.schedule(), onError: (id, error) => errors.push({id, error: String(error)})});
    const port = {
      createSessions(run) {
        const existing = new Set(sessions.list().map(s => s.id));
        const prepared = run.steps.flatMap((step, index) => {
          if (existing.has(step.sessionId)) return []; const member = run.memberSnapshots.find(a => a.id === step.agentId);
          return [{id: step.sessionId, title: member.name, connectionId: member.connectionId, model: member.model, instructions: member.instructions, teamRunId: run.id, teamStepIndex: index, createdAt: run.createdAt, updatedAt: run.createdAt, messages: []}];
        });
        if (prepared.length) {sessions.createPrepared(prepared); count('teamSessionsCreated', prepared.length);}
      },
      enqueue(id, prompt, hooks) {
        const gate = defer(), job = {gate, hooks, prompt, started: false}; jobs.set(id, job);
        queue.submit(id, async signal => {
          job.started = true; executing++; maxExecuting = Math.max(maxExecuting, executing); count('teamProviderFixtureInvocations');
          const session = sessions.get(id), aborted = () => gate.resolve({text: '취소된 합성 응답', status: 'cancelled'});
          signal.addEventListener('abort', aborted, {once: true});
          try {hooks.started(); session.messages.push(message('user', prompt)); const answer = await gate.promise; session.messages.push(message('assistant', answer.text, answer.status)); session.taskStatus = answer.status; sessions.save(session);}
          finally {signal.removeEventListener('abort', aborted); executing--; jobs.delete(id); hooks.settled(sessions.get(id));}
        });
      },
      cancelSession(id) {const job = jobs.get(id), cancelled = queue.abort(id); if (cancelled && job && !job.started) {jobs.delete(id); job.hooks.settled(sessions.get(id));} return cancelled;},
      getSession: id => sessions.get(id), listAgents: () => agents.list(), listModels: async () => ({}), resolveDelegation: async (member, options) => ({connections: options.connections ?? [{connectionId: member.connectionId, model: member.model}]}),
      cloneAgent: (template, changes) => {const {id, createdAt, updatedAt, ...input} = template; return agents.save({...input, ...changes});}, removeAgent: id => agents.remove(id), queueState: () => queue.state(), changed() {}, teamChanged() {},
    };
    coordinator = new TeamCoordinator(store, port);
    const finish = async (text, status = 'completed') => {const id = queue.state().running[0]; assert.ok(jobs.has(id)); jobs.get(id).gate.resolve({text, status}); await tick(); await tick();};
    let completed = 0, cancelled = 0, workerFailures = 0, lastCompleted;
    for (let cycle = 0; cycle < 240; cycle++) {
      const run = coordinator.start(team.id, `합성 목표 ${cycle}`, [leader, worker], cycle % 8 === 0 ? lastCompleted : undefined); count('teamRunsStarted');
      if (cycle % 4 === 1) {coordinator.cancel(run.id); await tick(); cancelled++; count('teamReservedCancellations');}
      else {
        await tick(); const tools = coordinator.tools(run.steps[0].sessionId);
        const posted = await tools.execute('send_team_message', {text: `멤버 지시 ${cycle}`, toAgentId: worker.id}, 'message');
        assert.deepEqual(await tools.execute('send_team_message', {text: `멤버 지시 ${cycle}`, toAgentId: worker.id}, 'message'), posted); count('teamDeduplicatedToolRetries');
        const delegated = await tools.execute('delegate_team_task', {agentId: worker.id, task: `합성 위임 ${cycle}`, taskKind: 'routine'}, 'delegate'); assert.equal(delegated.startsAfterCurrentTurn, true);
        if (cycle % 4 === 2) {
          coordinator.stopForQuit(); await tick(); await tick(); assert.equal(store.getRun(run.id).status, 'cancelled'); coordinator.resumeAfterQuit(); cancelled++; count('teamQuitResumeCycles');
          await assert.rejects(tools.execute('send_team_message', {text: 'late'}, 'late'), /더 이상/);
        } else {
          const ordinary = defer(); queue.submit(`ordinary-${cycle}`, () => ordinary.promise);
          await finish('합성 위임 확인'); assert.deepEqual(queue.state().running, [`ordinary-${cycle}`]); count('teamFairnessChecks'); ordinary.resolve(); await tick();
          assert.equal(queue.state().running[0], delegated.sessionId);
          const failed = cycle % 5 === 0; await finish(failed ? '합성 공급자 실패' : `합성 팀원 결과 ${cycle}`, failed ? 'failed' : 'completed');
          if (failed) {workerFailures++; assert.match(jobs.get(queue.state().running[0]).prompt, /완료하지 못했습니다/);}
          else assert.match(jobs.get(queue.state().running[0]).prompt, new RegExp(`합성 팀원 결과 ${cycle}`));
          await finish(`합성 최종 결과 ${cycle}`); completed++; lastCompleted = run.id;
          assert.equal(store.getRun(run.id).status, 'completed'); assert.equal(store.getRun(run.id).steps.length, 3);
        }
      }
      assert.equal(await queue.waitForIdle(2000), true); assert.equal(jobs.size, 0);
      const restarted = new TeamStore(root); count('teamRestartReads'); assert.deepEqual(restarted.getRun(run.id), store.getRun(run.id)); assert.equal(restarted.activeRunCount(), 0);
      const summaries = coordinator.summaries(); summaries[0].members[0].name = '외부 변경'; assert.notEqual(store.getRun(summaries[0].id).memberSnapshots[0].name, '외부 변경');
      while (store.runCount() > 8) {const old = store.listRuns().at(-1); store.removeRun(old.id); for (const step of old.steps) sessions.remove(step.sessionId);}
      assertNoTemps(root); if (cycle % 40 === 0) sample(`team-cycle-${cycle}`, true);
    }
    coordinator.stopForQuit(); assert.equal(await queue.close(2000), true); assert.deepEqual(errors, []); assert.equal(maxExecuting, 1);
    return {cycles: 240, completedRuns: completed, cancelledRuns: cancelled, delegatedProviderFailuresRecovered: workerFailures, restartReads: 240, maxConcurrentTeamJobs: maxExecuting, retainedRuns: store.runCount(), retainedSessions: sessions.list().length};
  });

  await phase('team-restart-and-failed-save-recovery', async () => {
    const root = rootFor('team-restarts'), agents = new AgentStore(root), member = agents.save(agentInput); let store = new TeamStore(root);
    const team = store.saveTeam({name: '복구 팀', topic: '', instructions: '', policies: '', leaderAgentId: member.id, memberAgentIds: [member.id], rounds: 1}), file = join(root, 'teams.json');
    for (let cycle = 0; cycle < 400; cycle++) {
      const timestamp = now(), run = {id: randomUUID(), teamId: team.id, teamName: team.name, teamUpdatedAt: team.updatedAt, goal: `합성 복구 ${cycle}`, instructions: '', topic: '', policies: '', leaderAgentId: member.id, activeMemberAgentIds: [member.id], memberSnapshots: [member], additions: 0, status: cycle % 2 ? 'queued' : 'running', rounds: 1, createdAt: timestamp, updatedAt: timestamp, steps: [{sessionId: randomUUID(), agentId: member.id, agentName: member.name, round: 1, kind: 'plan', status: cycle % 2 ? 'pending' : 'running'}], messages: []};
      store.saveRun(run); store = new TeamStore(root); count('teamInterruptedRestartReads');
      const recovered = store.getRun(run.id); assert.equal(recovered.status, 'cancelled'); assert.equal(recovered.steps[0].status, 'cancelled'); assert.match(recovered.error, /자동 재실행하지/);
      if (cycle % 4 === 0) {
        const prior = readFileSync(file), backup = file + '.backup'; renameSync(file, backup); mkdirSync(file);
        const retained = {...recovered, error: `보존할 새 상태 ${cycle}`}; assert.throws(() => store.saveRun(retained)); assert.equal(store.getRun(run.id).error, retained.error); assert.deepEqual(store.unsavedIds(), [run.id]); assert.deepEqual(readFileSync(backup), prior);
        rmSync(file, {recursive: true}); renameSync(backup, file); store.saveRun(store.getRun(run.id)); assert.deepEqual(store.unsavedIds(), []); assert.equal(new TeamStore(root).getRun(run.id).error, retained.error); count('teamStorageFailureRecoveries');
      }
      while (store.runCount() > 8) store.removeRun(store.listRuns().at(-1).id);
      assertNoTemps(root); if (cycle % 100 === 0) sample(`team-recovery-${cycle}`, true);
    }
    return {cycles: 400, interruptedRestarts: 400, injectedWriteFailuresRecovered: 100, retainedRuns: store.runCount()};
  });

  await phase('actual-process-restart-after-durable-commit', async () => {
    const root = rootFor('process-restarts'), modulePath = join(temporary, 'compiled-stores.mjs'), runner = join(temporary, 'restart-child.mjs');
    writeFileSync(modulePath, built.outputFiles[0].text, {mode: 0o600});
    writeFileSync(runner, `
import assert from 'node:assert/strict';
import {existsSync,readFileSync,writeFileSync,writeSync} from 'node:fs';
import {join} from 'node:path';
import {randomUUID} from 'node:crypto';
import {LocalSessionStore,TeamStore,AgentStore} from './compiled-stores.mjs';
const [root,indexText,totalText]=process.argv.slice(2), index=Number(indexText), total=Number(totalText), file=join(root,'checkpoint.json');
const sessions=new LocalSessionStore(root), teams=new TeamStore(root), agents=new AgentStore(root);
if(existsSync(file)) {
 const prior=JSON.parse(readFileSync(file,'utf8')); assert.equal(prior.cycle,index-1);
 const session=sessions.get(prior.sessionId), run=teams.getRun(prior.runId);
 assert.equal(session.taskStatus,'cancelled'); assert.equal(session.messages[0].status,'failed'); assert.equal(session.messages[0].text,'durable-'+(index-1));
 assert.equal(run.status,'cancelled'); assert.equal(run.steps[0].status,'cancelled'); assert.match(run.error,/자동 재실행하지/);
}
if(index<total) {
 const member=agents.list()[0]??agents.save({name:'합성 대표',instructions:'합성 역할',connectionId:'fixture',model:'fixture'});
 const team=teams.listTeams()[0]??teams.saveTeam({name:'합성 팀',topic:'',instructions:'',policies:'',leaderAgentId:member.id,memberAgentIds:[member.id],rounds:1});
 const s=sessions.create('fixture','fixture'), now=new Date().toISOString(); s.taskStatus='running'; s.messages=[{id:randomUUID(),role:'assistant',text:'durable-'+index,status:'running',createdAt:now}]; sessions.save(s);
 const run={id:randomUUID(),teamId:team.id,teamName:team.name,teamUpdatedAt:team.updatedAt,goal:'합성 목표',instructions:'',topic:'',policies:'',leaderAgentId:member.id,activeMemberAgentIds:[member.id],memberSnapshots:[member],additions:0,status:'running',rounds:1,createdAt:now,updatedAt:now,steps:[{sessionId:s.id,agentId:member.id,agentName:member.name,round:1,kind:'plan',status:'running'}],messages:[]}; teams.saveRun(run);
 while(sessions.list().length>4)sessions.remove(sessions.list().at(-1).id);
 while(teams.runCount()>4)teams.removeRun(teams.listRuns().find(r=>r.id!==run.id).id);
 writeFileSync(file,JSON.stringify({cycle:index,sessionId:s.id,runId:run.id}),{mode:0o600,flush:true});
}
writeSync(1,JSON.stringify({index,maxRSSKiB:process.resourceUsage().maxRSS})+'\\n');
if(index<total&&index%2===0)process.kill(process.pid,'SIGKILL');
`, {mode: 0o600});
    let maxChildRssKiB = 0;
    for (let index = 0; index <= 100; index++) {
      const result = await new Promise((resolve, reject) => {
        const child = spawn(process.execPath, [runner, root, String(index), '100'], {cwd: temporary, env: {PATH: '/usr/bin:/bin'}, stdio: ['ignore', 'pipe', 'pipe']});
        let stdout = '', stderr = ''; const timer = setTimeout(() => {child.kill('SIGKILL'); reject(new Error(`Synthetic restart child ${index} exceeded 5s`));}, 5000);
        child.stdout.on('data', chunk => {stdout += chunk;}); child.stderr.on('data', chunk => {stderr += chunk;});
        child.once('error', error => {clearTimeout(timer); reject(error);}); child.once('close', (code, signal) => {clearTimeout(timer); resolve({code, signal, stdout, stderr});});
      });
      assert.equal(result.stderr, '');
      if (index < 100 && index % 2 === 0) {assert.equal(result.signal, 'SIGKILL'); count('ownedFixtureAbruptStops');} else assert.equal(result.code, 0);
      const output = JSON.parse(result.stdout); assert.equal(output.index, index); maxChildRssKiB = Math.max(maxChildRssKiB, output.maxRSSKiB); count('realProcessStarts');
      if (index % 20 === 0) sample(`process-restart-${index}`, true);
    }
    assertNoTemps(root); return {processStarts: 101, recoveredPreviousCommits: 100, deliberateOwnedProcessKills: 50, ordinaryExits: 51, maxChildRssKiB, limitation: 'SIGKILL occurs after synchronous durable commits and checkpoint write, not during filesystem rename or a real OS power failure.'};
  });

  await phase('aggregate-and-record-boundaries', async () => {
    const root = rootFor('boundaries'), sessions = new LocalSessionStore(root), initial = sessions.create('fixture-api', 'fixture-model');
    for (let batch = 0; batch < 39; batch++) sessions.createPrepared(Array.from({length: 25}, () => ({...initial, id: randomUUID()})));
    sessions.createPrepared(Array.from({length: 24}, () => ({...initial, id: randomUUID()}))); assert.equal(sessions.list().length, 1000);
    assert.throws(() => sessions.create('fixture-api', 'fixture-model'), /1,000/); assert.equal(new LocalSessionStore(root).list().length, 1000); count('boundaryChecks');
    const messages = Array.from({length: 20000}, () => message('user', 'm')); const expanded = {...initial, messages}; sessions.save(expanded); assert.equal(new LocalSessionStore(root).get(initial.id).messages.length, 20000);
    const before = readFileSync(join(root, 'conversations.json')); assert.throws(() => sessions.save({...expanded, messages: [...messages, message('user', 'overflow')]})); assert.deepEqual(readFileSync(join(root, 'conversations.json')), before); count('boundaryChecks');
    sessions.save({...initial, messages: [message('assistant', '가'.repeat(2000000))]}); assert.equal(new LocalSessionStore(root).get(initial.id).messages[0].text.length, 2000000);
    assert.throws(() => sessions.save({...initial, messages: [message('assistant', 'x'.repeat(2000001))]})); count('boundaryChecks');
    const largeRoot = rootFor('large-file'), largeStore = new LocalSessionStore(largeRoot), largeSession = largeStore.create('fixture-api', 'fixture-model'), largeFile = join(largeRoot, 'conversations.json'), original = readFileSync(largeFile);
    assert.throws(() => largeStore.save({...largeSession, messages: Array.from({length: 34}, () => message('assistant', 'x'.repeat(2000000)))}), /저장 한도/);
    assert.deepEqual(readFileSync(largeFile), original); assert.deepEqual(largeStore.get(largeSession.id), largeSession); assertNoTemps(largeRoot); count('boundaryChecks'); sample('after-64MiB-rejection');
    const teamRoot = rootFor('team-bounds'), agents = new AgentStore(teamRoot), member = agents.save(agentInput), teams = new TeamStore(teamRoot);
    const input = {name: '경계 팀', topic: '', instructions: '', policies: '', leaderAgentId: member.id, memberAgentIds: [member.id], rounds: 1};
    for (let index = 0; index < 50; index++) teams.saveTeam({...input, name: `팀 ${index}`}); assert.throws(() => teams.saveTeam(input), /50/); count('boundaryChecks');
    const team = teams.listTeams()[0], timestamp = now(), base = {id: randomUUID(), teamId: team.id, teamName: team.name, teamUpdatedAt: team.updatedAt, goal: '경계 목표', instructions: '', topic: '', policies: '', leaderAgentId: member.id, activeMemberAgentIds: [member.id], memberSnapshots: [member], additions: 0, status: 'completed', rounds: 1, createdAt: timestamp, updatedAt: timestamp, steps: [{sessionId: randomUUID(), agentId: member.id, agentName: member.name, round: 1, kind: 'plan', status: 'completed'}], messages: []};
    for (let index = 0; index < 200; index++) teams.saveRun({...base, id: randomUUID()}); assert.throws(() => teams.saveRun({...base, id: randomUUID()}), /200/); assert.equal(new TeamStore(teamRoot).runCount(), 200); count('boundaryChecks');
    const crowded = teams.listRuns()[0]; crowded.messages = Array.from({length: 200}, () => ({id: randomUUID(), fromAgentName: '사용자', text: '가'.repeat(8000), kind: 'user', createdAt: timestamp})); teams.saveRun(crowded);
    assert.equal(new TeamStore(teamRoot).getRun(crowded.id).messages.length, 200); assert.throws(() => teams.saveRun({...crowded, messages: [...crowded.messages, {...crowded.messages[0], id: randomUUID()}]})); assert.throws(() => teams.saveRun({...crowded, messages: [{...crowded.messages[0], text: 'x'.repeat(8001)}]})); count('boundaryChecks');
    const snapshot = teams.listSummaries(); assert.equal(snapshot[0].messages, undefined); snapshot[0].members[0].name = '외부 변경'; assert.notEqual(teams.listSummaries()[0].members[0].name, '외부 변경');
    const agentRoot = rootFor('agent-bounds'), agentStore = new AgentStore(agentRoot); let rejected = false;
    for (let index = 0; index < 100; index++) {const prior = agentStore.list(); try {agentStore.save({...agentInput, name: `대용량 역할 ${index}`, instructions: '가'.repeat(16000)});} catch (error) {assert.match(error.message, /4MiB/); assert.deepEqual(new AgentStore(agentRoot).list(), prior); rejected = true; break;}}
    assert.equal(rejected, true); count('boundaryChecks');
    for (const directory of [root, largeRoot, teamRoot, agentRoot]) assertNoTemps(directory);
    return {sessionCap: 1000, messageCap: 20000, individualMessageCharacterCap: 2000000, rejectedAggregateSerializedBytesAtLeast: 68000000, teamsCap: 50, runsCap: 200, roomMessageCap: 200, roomMessageCharacterCap: 8000, agentUtf8LimitBytes: 4194304, retainedLargeAgents: agentStore.list().length};
  });
  await tick(); await tick(); assert.deepEqual(unhandled, []); report.passed = true;
} catch (error) {
  report.passed = false; report.failure = {name: error.name, message: error.message, stack: error.stack}; console.error(error); process.exitCode = 1;
} finally {
  sample('final-after-gc', true); report.finishedAt = new Date().toISOString(); report.durationMs = Math.round(performance.now() - started); report.counters = counters; report.memorySamples = memory; report.unhandledRejections = unhandled;
  report.maxRSSKiB = process.resourceUsage().maxRSS; report.sampledPeakRssBytes = Math.max(...memory.map(m => m.rss)); report.sampledPeakHeapUsedBytes = Math.max(...memory.map(m => m.heapUsed));
  rmSync(temporary, {recursive: true, force: true}); report.temporaryProfileRemoved = true; mkdirSync(dirname(reportPath), {recursive: true}); writeFileSync(reportPath, JSON.stringify(report, null, 2) + '\n', {mode: 0o600});
  process.removeListener('unhandledRejection', onUnhandled); console.log(JSON.stringify({passed: report.passed, durationMs: report.durationMs, maxRSSKiB: report.maxRSSKiB, reportPath}));
}
