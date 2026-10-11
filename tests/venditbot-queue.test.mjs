import assert from 'node:assert/strict';
import {setImmediate as nextTurn} from 'node:timers/promises';
import path from 'node:path';
import test from 'node:test';
import {build} from 'esbuild';

const built = await build({entryPoints: [path.resolve('source/venditbot/task-queue.ts')], bundle: true, platform: 'node', format: 'esm', write: false});
const {TaskQueue} = await import(`data:text/javascript;base64,${Buffer.from(built.outputFiles[0].text).toString('base64')}`);
const deferred = () => { let resolve, reject; const promise = new Promise((a, b) => {resolve = a; reject = b;}); return {promise, resolve, reject}; };

test('queue reserves one provider slot, runs FIFO and reports detached snapshots', async () => {
  const first = deferred(), second = deferred(), calls = [], snapshots = [];
  const queue = new TaskQueue({onChange: state => { snapshots.push(state); state.queued.push('observer mutation'); }});
  assert.equal(queue.submit('one', async () => { calls.push('one'); await first.promise; }), 'running');
  assert.equal(queue.submit('two', async () => { calls.push('two'); await second.promise; }), 'queued');
  assert.equal(queue.submit('three', () => { calls.push('three'); }), 'queued');
  assert.deepEqual(queue.state(), {running: ['one'], queued: ['two', 'three']});
  await nextTurn(); assert.deepEqual(calls, ['one']);
  first.resolve(); await nextTurn(); assert.deepEqual(calls, ['one', 'two']);
  second.resolve(); await nextTurn(); assert.deepEqual(calls, ['one', 'two', 'three']);
  assert.deepEqual(queue.state(), {running: [], queued: []}); assert.ok(snapshots.length >= 6);
  assert.equal(await queue.close(), true);
});

test('queue caps waiting work at sixteen and rejects duplicate session IDs before effects', async () => {
  const pending = deferred(), queue = new TaskQueue();
  queue.submit('running', () => pending.promise);
  for (let index = 0; index < 16; index++) queue.submit(`waiting-${index}`, () => {});
  assert.deepEqual(queue.state().queued, Array.from({length: 16}, (_, index) => `waiting-${index}`));
  assert.throws(() => queue.submit('overflow', () => {}), /16/);
  assert.throws(() => queue.submit('running', () => {}), /이미/);
  assert.throws(() => queue.submit('waiting-3', () => {}), /이미/);
  assert.throws(() => new TaskQueue({maxQueued: 17}));
  assert.throws(() => queue.submit('', () => {}));
  assert.equal(queue.abort('waiting-3'), true); assert.equal(queue.abort('missing'), false);
  assert.equal(queue.submit('replacement', () => {}), 'queued');
  const closed = queue.close(); pending.resolve(); assert.equal(await closed, true);
});

test('aborting a queued task prevents invocation and preserves the remaining order', async () => {
  const pending = deferred(), calls = [], queue = new TaskQueue();
  queue.submit('first', () => pending.promise);
  queue.submit('cancel', () => calls.push('cancel'));
  queue.submit('last', () => calls.push('last'));
  assert.equal(queue.abort('cancel'), true); assert.equal(queue.abort('cancel'), false);
  pending.resolve(); await nextTurn(); assert.deepEqual(calls, ['last']);
  assert.equal(await queue.close(), true);
});

test('active abort retains the provider slot until settlement, even when the job ignores abort', async () => {
  const pending = deferred(), calls = [], queue = new TaskQueue(); let signal;
  queue.submit('first', value => { signal = value; return pending.promise; });
  queue.submit('second', () => calls.push('second'));
  await nextTurn(); assert.equal(queue.abort('first'), true); assert.equal(signal.aborted, true);
  await nextTurn(); assert.deepEqual(calls, []); assert.deepEqual(queue.state(), {running: ['first'], queued: ['second']});
  assert.throws(() => queue.submit('first', () => {}), /이미/);
  pending.resolve(); await nextTurn(); assert.deepEqual(calls, ['second']);
  assert.equal(await queue.close(), true);
});

test('synchronous and asynchronous job failures are reported once without stalling successors', async () => {
  const errors = [], calls = [], queue = new TaskQueue({onError: (id, error) => errors.push({id, error})});
  const sync = new Error('sync'), asyncError = new Error('async');
  queue.submit('sync', () => { throw sync; });
  queue.submit('async', async () => { throw asyncError; });
  queue.submit('last', () => calls.push('last'));
  await nextTurn(); assert.deepEqual(errors, [{id: 'sync', error: sync}, {id: 'async', error: asyncError}]);
  assert.deepEqual(calls, ['last']); assert.equal(await queue.close(), true);
});

test('throwing or rejecting observers cannot strand work or create unhandled rejections', async () => {
  const calls = []; let count = 0;
  const queue = new TaskQueue({onChange: () => { if (++count % 2) throw new Error('observer'); return Promise.reject(new Error('async observer')); }, onError: async () => { throw new Error('error observer'); }});
  queue.submit('failure', () => { throw new Error('job'); });
  queue.submit('success', () => calls.push('success'));
  await nextTurn(); await nextTurn(); assert.deepEqual(calls, ['success']); assert.equal(await queue.close(), true);
});

test('close aborts all work, remains bounded for a noncooperative job and never starts another', async () => {
  const pending = deferred(), calls = [], queue = new TaskQueue(); let signal;
  queue.submit('running', value => { signal = value; return pending.promise; });
  queue.submit('waiting', () => calls.push('waiting')); await nextTurn();
  const closed = queue.close(10); assert.strictEqual(queue.close(100), closed);
  assert.equal(signal.aborted, true); assert.deepEqual(queue.state(), {running: ['running'], queued: []});
  assert.equal(await closed, false); assert.throws(() => queue.submit('new', () => {}), /종료/);
  pending.resolve(); await nextTurn(); assert.deepEqual(calls, []); assert.equal(await queue.close(), true);
});

test('cancelling a reserved task before its microtask avoids starting it', async () => {
  const calls = [], queue = new TaskQueue();
  queue.submit('cancel', () => calls.push('cancel')); queue.abort('cancel');
  queue.submit('next', () => calls.push('next'));
  await nextTurn(); assert.deepEqual(calls, ['next']); assert.equal(await queue.close(), true);
});

test('idle observation is bounded, supports independent observers and leaves the queue usable', async () => {
  const pending = deferred(), calls = [], queue = new TaskQueue(); let signal;
  queue.submit('running', value => { signal = value; return pending.promise; });
  queue.submit('waiting', () => calls.push('must not run')); await nextTurn();
  const timedOut = queue.waitForIdle(5), settled = queue.waitForIdle(1000);
  queue.abort('waiting'); queue.abort('running');
  assert.equal(signal.aborted, true); assert.equal(await timedOut, false);
  assert.deepEqual(queue.state(), {running: ['running'], queued: []});
  pending.resolve(); assert.equal(await settled, true);
  queue.submit('resumed', () => calls.push('resumed'));
  assert.equal(await queue.waitForIdle(), true); assert.deepEqual(calls, ['resumed']);
  assert.throws(() => queue.waitForIdle(-1), /timeout/);
  assert.equal(await queue.close(), true);
});
