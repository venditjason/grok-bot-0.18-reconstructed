import assert from 'node:assert/strict';
import test from 'node:test';
import {mkdtemp, rm, readFile, stat} from 'node:fs/promises';
import {join} from 'node:path';
import {tmpdir} from 'node:os';
import {randomUUID} from 'node:crypto';
import {setImmediate as tick} from 'node:timers/promises';
import {build} from 'esbuild';
const built = await build({stdin: {contents: "export * from './source/venditbot/chat-turn-queue.ts'; export * from './source/venditbot/task-queue.ts'; export {atomicWriteJson} from './source/venditbot/local-store.ts';", resolveDir: process.cwd()}, bundle: true, platform: 'node', format: 'esm', write: false});
const {ChatTurnQueue, TaskQueue, atomicWriteJson} = await import(`data:text/javascript;base64,${Buffer.from(built.outputFiles[0].text).toString('base64')}`);
const deferred = () => {let resolve; const promise = new Promise(done => {resolve = done;}); return {promise, resolve};};
const attachment = {id: randomUUID(), name: '요구사항.txt', kind: 'text', mimeType: 'text/plain', bytes: 12, sha256: 'a'.repeat(64)};
async function fixture(t) {
  const root = await mkdtemp(join(tmpdir(), 'vendit-turns-')), starts = [], jobs = new Map(), events = [];
  let turns, stopped = false, diskFailure = false, active = 0, peak = 0;
  const queue = new TaskQueue({onChange: () => turns?.schedule()});
  const port = {
    canRun: () => !stopped,
    state: () => queue.state(),
    start(turn, hooks) {
      const done = deferred(); jobs.set(turn.id, {done, hooks, turn});
      queue.submit(turn.sessionId, async signal => {
        let outcome = 'failed', failure;
        try {hooks.started(); active++; peak = Math.max(peak, active); starts.push(turn); outcome = await done.promise;}
        catch(error) {failure = error;}
        finally {active--; hooks.settled(signal.aborted ? 'cancelled' : outcome, failure);}
      });
    },
    cancel(id) {const waiting = queue.state().queued.includes(id) || queue.state().running.includes(id) && !starts.some(turn => turn.sessionId === id); const result = queue.abort(id); if (waiting && result) {const job = [...jobs.values()].find(item => item.turn.sessionId === id); job.hooks.settled('cancelled');} return result;},
    changed: (value, error) => events.push({value,error}),
    write(path, data) {if (diskFailure) throw Error('disk unavailable'); atomicWriteJson(path, data);},
  };
  turns = new ChatTurnQueue(root, port);
  const f = {root, port, queue, starts, jobs, events, get turns(){return turns;}, get peak(){return peak;},
    submit(text, sessionId = 'a', attachments = []) {return turns.submit({id: randomUUID(), sessionId, text, attachments});},
    async finish(id = starts.at(-1).id, status = 'completed') {jobs.get(id).done.resolve(status); await tick(); await tick();},
    reload() {turns = new ChatTurnQueue(root, port);}, stop(){stopped = true;}, disk(failed){diskFailure = failed;},
  };
  t.after(async () => {stopped = true; for (const job of jobs.values()) job.done.resolve('cancelled'); await queue.close(100); await rm(root, {recursive: true, force: true});});
  return f;
}

test('rapid sends persist exact FIFO text and attachments; scheduler never overlaps and fairly yields to other conversations', async t => {
  const f = await fixture(t), first = f.submit('first'), second = f.submit('second', 'a', [attachment]), third = f.submit('third'), other = f.submit('other', 'b');
  await tick(); assert.deepEqual(f.starts.map(turn => turn.text), ['first']);
  assert.deepEqual(JSON.parse(await readFile(join(f.root, 'chat-turns.json'),'utf8')).turns.map(turn => turn.text), ['first','second','third','other']);
  await f.finish(first.id); assert.deepEqual(f.starts.map(turn => turn.text), ['first','other']);
  await f.finish(other.id); assert.equal(f.starts.at(-1).id, second.id); assert.deepEqual(f.starts.at(-1).attachments, [attachment]);
  await f.finish(second.id); assert.equal(f.starts.at(-1).id, third.id); await f.finish(third.id);
  assert.equal(f.peak, 1); assert.ok(f.turns.snapshot().every(turn => turn.status === 'completed')); assert.equal((await stat(join(f.root, 'chat-turns.json'))).mode & 0o777, 0o600);
});
test('lost acknowledgement resends deduplicate even after completion; changed body is refused', async t => {
  const f = await fixture(t), first = f.submit('same'); const input = {id:first.id,sessionId:'a',text:'same',attachments:[]};
  f.turns.submit(input); await tick(); assert.equal(f.starts.length,1); await f.finish(first.id); f.turns.submit(input); await tick(); assert.equal(f.starts.length,1);
  assert.throws(()=>f.turns.submit({...input,text:'changed'}), /변경/);
});
test('failure pauses successors; explicit retry preserves original order and does not overlap', async t => {
  const f = await fixture(t), first=f.submit('first'), second=f.submit('second'); await tick(); await f.finish(first.id,'failed');
  assert.deepEqual(f.turns.snapshot().map(turn=>turn.status),['failed','paused']); assert.equal(f.starts.length,1);
  f.turns.retry(first.id); await tick(); assert.equal(f.starts.at(-1).id,first.id); await f.finish(first.id); assert.equal(f.starts.at(-1).id,second.id); await f.finish(second.id); assert.equal(f.peak,1);
});
test('explicit continue skips failed turn and permits subsequent new input without a permanent pause',async t=>{
  const f=await fixture(t),first=f.submit('first'),second=f.submit('second');await tick();await f.finish(first.id,'failed');f.turns.resume('a');await tick();assert.equal(f.starts.at(-1).id,second.id);await f.finish(second.id);const third=f.submit('third');await tick();assert.equal(f.starts.at(-1).id,third.id);await f.finish(third.id);
});
test('cancelling an active model holds the slot through cleanup and pauses following messages', async t => {
  const f=await fixture(t),first=f.submit('first'),second=f.submit('second');await tick();f.turns.cancel(first.id);await tick();assert.equal(f.starts.length,1);assert.deepEqual(f.queue.state().running,['a']);await f.finish(first.id);assert.deepEqual(f.turns.snapshot().map(turn=>turn.status),['cancelled','paused']);assert.equal(f.starts.length,1);
  f.turns.resume('a');await tick();assert.equal(f.starts.at(-1).id,second.id);await f.finish(second.id);
});
test('cancel one waiting message retains its data and allows later messages in original order', async t => {
  const f=await fixture(t),first=f.submit('first'),second=f.submit('second','a',[attachment]),third=f.submit('third');await tick();f.turns.cancel(second.id);await f.finish(first.id);assert.equal(f.starts.at(-1).id,third.id);assert.deepEqual(f.turns.snapshot().find(turn=>turn.id===second.id).attachments,[attachment]);await f.finish(third.id);
});
test('restart preserves queued input as paused and interrupted execution as failed, with no automatic provider call', async t => {
  const f=await fixture(t),first=f.submit('first'),second=f.submit('second','a',[attachment]);await tick();f.stop();f.reload();assert.deepEqual(f.turns.snapshot().map(turn=>turn.status),['failed','paused']);assert.equal(f.starts.length,1);assert.deepEqual(f.turns.snapshot()[1].attachments,[attachment]);
});
test('storage failure before acknowledgement retains caller draft and makes no provider reservation', async t => {
  const f=await fixture(t);f.disk(true);assert.throws(()=>f.submit('keep draft'),/disk/);await tick();assert.equal(f.starts.length,0);assert.equal(f.turns.snapshot().length,0);
});
test('settlement storage failure blocks following execution until explicit durable recovery', async t => {
  const f=await fixture(t),first=f.submit('first'),second=f.submit('second');await tick();f.disk(true);await f.finish(first.id);assert.match(f.turns.error(),/disk/);assert.equal(f.starts.length,1);f.disk(false);f.turns.resume('a');await tick();assert.equal(f.starts.at(-1).id,second.id);await f.finish(second.id);
});
test('quit gate prevents pending work from starting as cancellation settles',async t=>{
  const f=await fixture(t),first=f.submit('first');f.submit('second');await tick();f.stop();await f.finish(first.id);assert.equal(f.starts.length,1);
});
test('queue cap rejects excess before writing without changing accepted order',async t=>{
  const f=await fixture(t);for(let i=0;i<17;i++)f.submit(String(i));assert.throws(()=>f.submit('overflow'),/최대 16/);assert.deepEqual(f.turns.snapshot().map(turn=>turn.text),Array.from({length:17},(_,i)=>String(i)));
});

test('continuing past past failures does not consume queue capacity permanently',async t=>{
 const f=await fixture(t);for(let i=0;i<20;i++){const turn=f.submit(String(i));await tick();await f.finish(turn.id,'failed');f.turns.resume('a');}const last=f.submit('last');await tick();assert.equal(f.starts.at(-1).id,last.id);await f.finish(last.id);
});

test('a retried turn failing again revokes the earlier continue decision',async t=>{
 const f=await fixture(t),first=f.submit('first');await tick();await f.finish(first.id,'failed');f.turns.resume('a');f.turns.retry(first.id);await tick();await f.finish(first.id,'failed');const next=f.submit('new after second failure');assert.equal(next.status,'paused');await tick();assert.equal(f.starts.length,2);f.turns.resume('a');await tick();assert.equal(f.starts.at(-1).id,next.id);await f.finish(next.id);
});

test('retrying an older failure cannot skip a later unacknowledged failure',async t=>{
 const f=await fixture(t),a=f.submit('A'),b=f.submit('B'),c=f.submit('C');await tick();await f.finish(a.id,'failed');f.turns.resume('a');await tick();await f.finish(b.id,'failed');f.turns.retry(a.id);await tick();assert.equal(f.starts.at(-1).id,a.id);await f.finish(a.id);assert.equal(f.starts.length,3);assert.deepEqual(f.turns.snapshot().map(turn=>turn.status),['completed','failed','paused']);f.turns.retry(b.id);await tick();await f.finish(b.id);assert.equal(f.starts.at(-1).id,c.id);await f.finish(c.id);
});
