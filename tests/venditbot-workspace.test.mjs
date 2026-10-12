import assert from 'node:assert/strict';
import { chmod, link, mkdir, mkdtemp, readFile, readdir, rename, rm, symlink, writeFile } from 'node:fs/promises';
import { homedir, tmpdir } from 'node:os';
import path from 'node:path';
import { request } from 'node:http';
import { setImmediate as nextTurn } from 'node:timers/promises';
import test from 'node:test';
import { build } from 'esbuild';

const built = await build({ entryPoints: [path.resolve('source/venditbot/workspace-tools.ts')], bundle: true, platform: 'node', format: 'esm', write: false, target: 'node22' });
const { WorkspaceExecutor, normalizeWorkspace, startMcpGateway } = await import(`data:text/javascript;base64,${Buffer.from(built.outputFiles[0].text).toString('base64')}`);
async function temporary(t) {
  const root = await mkdtemp(path.join(tmpdir(), 'venditbot-workspace-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  return root;
}
const deferred = () => { let resolve, reject; const promise = new Promise((a, b) => { resolve = a; reject = b; }); return { promise, resolve, reject }; };

test('workspace roots reject whole homes and provider credentials while allowing a temporary project', async t => {
  const root = await temporary(t);
  assert.equal(normalizeWorkspace(root), await import('node:fs').then(fs => fs.realpathSync(root)));
  for (const forbidden of ['.codex', '.claude', '.grokbot', '.cursor', '.ssh', '.aws', 'node_modules']) {
    const target = path.join(root, forbidden);
    await mkdir(target);
    assert.throws(() => normalizeWorkspace(target), /자격증명/);
    assert.throws(() => new WorkspaceExecutor(target, async () => false), /자격증명/);
  }
  assert.throws(() => normalizeWorkspace(homedir()), /프로젝트/);
  assert.throws(() => new WorkspaceExecutor('/', async () => false), /프로젝트/);
});

test('reads reject traversal, credentials, symlinks, hard links, non-UTF8 and oversized files', async t => {
  const root = await temporary(t);
  const outside = await temporary(t);
  await writeFile(path.join(root, 'safe.txt'), '안녕하세요');
  await writeFile(path.join(root, '.env'), 'SECRET=hidden');
  await writeFile(path.join(outside, 'outside.txt'), 'private');
  await symlink(outside, path.join(root, 'escape'));
  await symlink(path.join(root, 'safe.txt'), path.join(root, 'alias.txt'));
  await link(path.join(outside, 'outside.txt'), path.join(root, 'hardlink.txt'));
  await writeFile(path.join(root, 'big.txt'), Buffer.alloc(128 * 1024 + 1, 'a'));
  await writeFile(path.join(root, 'invalid.txt'), Buffer.from([0xff]));
  await writeFile(path.join(root, 'binary.txt'), Buffer.from([0, 1]));
  const executor = new WorkspaceExecutor(root, async () => false);
  assert.equal((await executor.execute('read_file', {path: 'safe.txt'}, 'ok')).content, '안녕하세요');
  let id = 0;
  for (const target of ['../outside.txt', '/etc/passwd', '.env', 'escape/outside.txt', 'alias.txt', 'hardlink.txt', 'big.txt', 'invalid.txt', 'binary.txt']) await assert.rejects(executor.execute('read_file', {path: target}, `denied-${id++}`));
});

test('listing/search omit credential and linked trees and return bounded literal matches', async t => {
  const root = await temporary(t);
  await mkdir(path.join(root, '.git'));
  await mkdir(path.join(root, 'node_modules'));
  await writeFile(path.join(root, '.env'), 'needle');
  await writeFile(path.join(root, 'file.txt'), 'needle [literal]\n'.repeat(100));
  await symlink(path.join(root, 'file.txt'), path.join(root, 'linked.txt'));
  const executor = new WorkspaceExecutor(root, async () => false);
  const list = await executor.execute('list_files', {path: '.'}, 'list');
  assert.deepEqual(list.entries.map(entry => entry.name), ['file.txt']);
  const results = await executor.execute('search_files', {path: '.', query: '[literal]'}, 'search');
  assert.equal(results.matches.length, 80);
  assert.equal(results.truncated, true);
  assert.ok(results.matches.every(match => match.path === 'file.txt'));
  await assert.rejects(executor.execute('read_file', {path: 'file.txt', outside: true}, 'unknown-arg'), /인자/);
});

test('writes require approval, preserve deduplication and reject changed duplicate arguments', async t => {
  const root = await temporary(t);
  let approvals = 0;
  const executor = new WorkspaceExecutor(root, async request => { approvals++; assert.equal(request.preview, 'approved content'); return true; });
  const first = executor.execute('write_file', {path: 'new.txt', content: 'approved content'}, 'write-1');
  const duplicate = executor.execute('write_file', {path: 'new.txt', content: 'approved content'}, 'write-1');
  assert.strictEqual(first, duplicate);
  assert.equal((await first).written, true);
  assert.equal(approvals, 1);
  assert.equal(await readFile(path.join(root, 'new.txt'), 'utf8'), 'approved content');
  await assert.rejects(executor.execute('write_file', {path: 'new.txt', content: 'different'}, 'write-1'), /중복/);
  const denied = new WorkspaceExecutor(root, async () => false);
  assert.equal((await denied.execute('write_file', {path: 'denied.txt', content: 'no'}, 'deny')).written, false);
  await assert.rejects(readFile(path.join(root, 'denied.txt')), {code: 'ENOENT'});
});

test('write approval is invalidated by content, inode, permissions or parent replacement', async t => {
  const root = await temporary(t);
  for (const kind of ['content', 'inode', 'mode', 'parent']) {
    const directory = path.join(root, kind); await mkdir(directory);
    const target = path.join(directory, 'file.txt'); await writeFile(target, 'original', {mode: 0o600});
    const executor = new WorkspaceExecutor(root, async () => {
      if (kind === 'content') await writeFile(target, 'changed');
      if (kind === 'inode') { await writeFile(`${target}.replacement`, 'original'); await rename(`${target}.replacement`, target); }
      if (kind === 'mode') await chmod(target, 0o755);
      if (kind === 'parent') { await rename(directory, `${directory}-old`); await mkdir(directory); await writeFile(target, 'original'); }
      return true;
    });
    await executor.execute('read_file', {path: `${kind}/file.txt`}, `read-${kind}`);
    await assert.rejects(executor.execute('write_file', {path: `${kind}/file.txt`, content: 'tool write'}, kind), /변경/);
    assert.notEqual(await readFile(target, 'utf8'), 'tool write');
  }
  assert.ok((await readdir(root, {recursive: true})).every(file => !file.includes('.venditbot-')));
});

test('development overwrites require a successful whole-file read in this executor, not search or prior turns', async t => {
  const root=await temporary(t),file=path.join(root,'existing.txt');await writeFile(file,'original needle');let writes=0;
  const executor=new WorkspaceExecutor(root,async()=>{writes++;return true;});
  await assert.rejects(executor.execute('write_file',{path:'existing.txt',content:'unread'},'unread'),/read_file/);
  await executor.execute('search_files',{path:'.',query:'needle'},'search');
  await assert.rejects(executor.execute('write_file',{path:'existing.txt',content:'snippet'},'snippet'),/read_file/);
  assert.equal(writes,0);assert.equal(await readFile(file,'utf8'),'original needle');
  await executor.execute('read_file',{path:'existing.txt'},'read');
  assert.equal((await executor.execute('write_file',{path:'existing.txt',content:'first approved'},'first')).written,true);
  await assert.rejects(executor.execute('write_file',{path:'existing.txt',content:'second unread'},'second'),/read_file/);
  await executor.execute('read_file',{path:'existing.txt'},'read'); // replayed old content is not a fresh observation
  await assert.rejects(executor.execute('write_file',{path:'existing.txt',content:'cached read'},'cached'),/read_file/);
  await executor.execute('read_file',{path:'existing.txt'},'fresh');
  assert.equal((await executor.execute('write_file',{path:'existing.txt',content:'second approved'},'next')).written,true);
  const nextTurnExecutor=new WorkspaceExecutor(root,async()=>true);
  await assert.rejects(nextTurnExecutor.execute('write_file',{path:'existing.txt',content:'previous turn'},'old-turn'),/read_file/);
  assert.equal(await readFile(file,'utf8'),'second approved');assert.equal(writes,2);
});

test('read evidence is invalidated by edits, inode replacement or mode changes before write authorization',async t=>{
  for(const kind of ['content','inode','mode']){
    const root=await temporary(t),file=path.join(root,'file.txt');await writeFile(file,'original');let approvals=0;const executor=new WorkspaceExecutor(root,async()=>{approvals++;return true;});
    await executor.execute('read_file',{path:'file.txt'},'read');
    if(kind==='content')await writeFile(file,'other work');
    if(kind==='inode'){await rename(file,path.join(root,'kept.txt'));await writeFile(file,'original');}
    if(kind==='mode')await chmod(file,0o600);
    await assert.rejects(executor.execute('write_file',{path:'file.txt',content:'overwrite'},'write'),/읽은 뒤 파일이 변경/);assert.equal(approvals,0);
    await executor.execute('read_file',{path:'file.txt'},'fresh');assert.equal((await executor.execute('write_file',{path:'file.txt',content:'reviewed'},'retry')).written,true);
  }
});

test('denied reads never seed overwrite authorization and read-approval races preserve the observed version',async t=>{
  const root=await temporary(t),file=path.join(root,'file.txt');await writeFile(file,'original');
  const denied=new WorkspaceExecutor(root,async()=>true,undefined,async request=>request.operation!=='read');
  await assert.rejects(denied.execute('read_file',{path:'file.txt'},'read'),/읽기/);
  await assert.rejects(denied.execute('write_file',{path:'file.txt',content:'unread'},'write'),/read_file/);
  const raced=new WorkspaceExecutor(root,async()=>true,undefined,async request=>{if(request.operation==='read')await writeFile(file,'changed while read approved');return true;});
  const result=await raced.execute('read_file',{path:'file.txt'},'read');assert.equal(result.content,'original');
  await assert.rejects(raced.execute('write_file',{path:'file.txt',content:'overwrite'},'write'),/읽은 뒤 파일이 변경/);assert.equal(await readFile(file,'utf8'),'changed while read approved');
});

test('tool queue serializes distinct approvals and aborts pending approval without a later write', async t => {
  const root = await temporary(t);
  const first = deferred(), second = deferred(); let count = 0;
  const executor = new WorkspaceExecutor(root, async () => ++count === 1 ? first.promise : second.promise);
  const one = executor.execute('write_file', {path: 'one.txt', content: '1'}, 'one');
  const two = executor.execute('write_file', {path: 'two.txt', content: '2'}, 'two');
  await nextTurn(); assert.equal(count, 1);
  first.resolve(true); await one; await nextTurn(); assert.equal(count, 2);
  second.resolve(true); await two;
  const controller = new AbortController(); const pending = deferred();
  const cancellable = new WorkspaceExecutor(root, async () => pending.promise, controller.signal);
  const cancelled = cancellable.execute('write_file', {path: 'cancelled.txt', content: 'never'}, 'cancelled');
  await nextTurn(); controller.abort();
  await assert.rejects(cancelled, {name: 'AbortError'});
  pending.resolve(true); await nextTurn();
  await assert.rejects(readFile(path.join(root, 'cancelled.txt')), {code: 'ENOENT'});
});

test('replacing the workspace root with a same-path directory invalidates its executor', async t => {
  const base = await temporary(t); const root = path.join(base, 'project'); await mkdir(root);
  const executor = new WorkspaceExecutor(root, async () => false);
  await rename(root, path.join(base, 'original')); await mkdir(root); await writeFile(path.join(root, 'file.txt'), 'other');
  await assert.rejects(executor.execute('read_file', {path: 'file.txt'}, 'read'), /변경/);
});

async function rpc(gateway, method, params, headers = {}) {
  const result = await fetch(gateway.url, {method: 'POST', headers: {'Content-Type': 'application/json', Authorization: `Bearer ${gateway.token}`, ...headers}, body: JSON.stringify({jsonrpc: '2.0', id: 1, method, ...(params ? {params} : {})})});
  return {status: result.status, body: await result.text()};
}

test('MCP loopback gateway authenticates and rejects browser origins and malformed calls', async t => {
  const calls = [];
  const gateway = await startMcpGateway(async (...args) => { calls.push(args); return {ok: true}; });
  t.after(() => gateway.close());
  assert.match(gateway.url, /^http:\/\/127\.0\.0\.1:\d+\/mcp$/);
  assert.equal((await rpc(gateway, 'tools/list', null, {Authorization: 'Bearer wrong'})).status, 403);
  assert.equal((await rpc(gateway, 'tools/list', null, {Origin: 'https://untrusted.example'})).status, 403);
  assert.equal(JSON.parse((await rpc(gateway, 'tools/list')).body).result.tools.length, 4);
  const called = JSON.parse((await rpc(gateway, 'tools/call', {name: 'read_file', arguments: {path: 'a.txt'}})).body);
  assert.equal(called.result.isError, undefined);
  assert.deepEqual(calls, [['read_file', {path: 'a.txt'}, 'mcp-1']]);
});

test('MCP preserves Korean UTF-8 split across separate HTTP body chunks', async t => {
  let received;
  const gateway = await startMcpGateway(async (_name, args) => { received = args; return {ok: true}; });
  t.after(() => gateway.close());
  const body = Buffer.from(JSON.stringify({jsonrpc: '2.0', id: 3, method: 'tools/call', params: {name: 'write_file', arguments: {path: '한글.txt', content: '한국어 내용'}}}));
  const split = body.indexOf(Buffer.from('한')) + 1;
  const response = await new Promise((resolve, reject) => {
    const req = request(gateway.url, {method: 'POST', headers: {Authorization: `Bearer ${gateway.token}`, 'Content-Type': 'application/json'}}, res => { let text = ''; res.on('data', data => { text += data; }); res.on('end', () => resolve({status: res.statusCode, text})); });
    req.on('error', reject); req.write(body.subarray(0, split)); setTimeout(() => req.end(body.subarray(split)), 10);
  });
  assert.equal(response.status, 200);
  assert.deepEqual(received, {path: '한글.txt', content: '한국어 내용'});
});

test('MCP pre-abort does not start and active abort closes the listener idempotently', async () => {
  const cancelled = new AbortController(); cancelled.abort();
  await assert.rejects(startMcpGateway(async () => ({}), cancelled.signal), {name: 'AbortError'});
  const controller = new AbortController(); const gateway = await startMcpGateway(async () => ({}), controller.signal);
  controller.abort();
  await Promise.all([gateway.close(), gateway.close()]);
  await assert.rejects(fetch(gateway.url));
});

test('MCP can advertise only team tools without granting any workspace capability', async t => {
  const calls = [], definitions = [{name: 'send_team_message', description: 'team message', inputSchema: {type: 'object', properties: {text: {type: 'string'}}}}];
  const gateway = await startMcpGateway(async (...args) => {calls.push(args); return {sent: true};}, undefined, definitions); t.after(() => gateway.close());
  definitions.push({name: 'write_file', description: 'mutated outside', inputSchema: {}});
  assert.deepEqual(JSON.parse((await rpc(gateway, 'tools/list')).body).result.tools.map(t => t.name), ['send_team_message']);
  const denied = JSON.parse((await rpc(gateway, 'tools/call', {name: 'write_file', arguments: {path: 'x', content: 'x'}})).body); assert.equal(denied.result.isError, true); assert.equal(calls.length, 0);
  const sent = JSON.parse((await rpc(gateway, 'tools/call', {name: 'send_team_message', arguments: {text: '팀 메시지'}})).body); assert.equal(sent.result.isError, undefined); assert.equal(calls[0][0], 'send_team_message');
});
