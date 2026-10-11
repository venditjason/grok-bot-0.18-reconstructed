import assert from 'node:assert/strict';
import { mkdtemp, readFile, writeFile, rm, stat, symlink } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { randomUUID, randomBytes, createCipheriv, createDecipheriv } from 'node:crypto';
import { build } from 'esbuild';
const built = await build({entryPoints: [new URL('../source/venditbot/local-store.ts', import.meta.url).pathname], bundle: true, platform:'node',format:'esm',target:'node22',write:false});
const {LocalSessionStore,EncryptedSecretStore,completedHistory,sessionMarkdown,safeError} = await import(`data:text/javascript;base64,${Buffer.from(built.outputFiles[0].text).toString('base64')}`);
const temporary = async fn => {const root = await mkdtemp(path.join(tmpdir(),'venditbot-store-')); try {await fn(root);} finally {await rm(root,{recursive:true,force:true});}};
const msg = (role,text,status='completed') => ({id:randomUUID(),role,text,status,createdAt:new Date().toISOString()});

test('conversation persistence is private, detached from caller mutation, and recovers interrupted runs without replay', () => temporary(async root => {
  const store = new LocalSessionStore(root), session = store.create('codex','',root);
  session.messages.push(msg('user','hello'), {...msg('assistant','partial','running'),tools:[{callId:'a',name:'write_file',status:'running'}]}); store.save(session);
  session.title = 'caller changed'; assert.equal(store.get(session.id).title,'새 대화');
  const recovered = new LocalSessionStore(root).get(session.id);
  assert.equal(recovered.messages[1].status,'failed'); assert.equal(recovered.messages[1].tools[0].status,'failed');
  assert.equal((await stat(path.join(root,'conversations.json'))).mode & 0o777,0o600);
  assert.match(sessionMarkdown(recovered), /partial/); assert.match(sessionMarkdown(recovered), /failed/);
  store.remove(session.id); assert.equal(new LocalSessionStore(root).list().length,0);
}));
test('malformed conversation files are preserved rather than silently truncated', () => temporary(async root => {
  const file = path.join(root,'conversations.json'), invalid = JSON.stringify({version:1,sessions:[{id:'a',title:'Bad',connectionId:'codex',messages:[null]}]});
  await writeFile(file,invalid); assert.throws(()=>new LocalSessionStore(root),/손상/); assert.equal(await readFile(file,'utf8'),invalid);
}));
test('completed history excludes failed or cancelled prompts and partial assistant replies', () => temporary(async root => {
  const session = new LocalSessionStore(root).create('codex','');
  session.messages = [msg('user','one'),msg('assistant','first'),msg('user','bad'),msg('assistant','partial','failed'),msg('user','cancel'),msg('assistant','','cancelled'),msg('user','retry'),msg('assistant','','running')];
  assert.deepEqual(completedHistory(session,session.messages.at(-2).id),[{role:'user',content:'one'},{role:'assistant',content:'first'},{role:'user',content:'retry'}]);
}));
test('secrets use encryption port, survive restart, never serialize plaintext, and refuse unavailable secure storage', () => temporary(async root => {
  const key = randomBytes(32);
  const encryption = {isAsyncEncryptionAvailable:async()=>true, async encryptStringAsync(value){const iv=randomBytes(12),c=createCipheriv('aes-256-gcm',key,iv); const data=Buffer.concat([c.update(value),c.final()]);return Buffer.concat([iv,c.getAuthTag(),data]);},async decryptStringAsync(value){const c=createDecipheriv('aes-256-gcm',key,value.subarray(0,12));c.setAuthTag(value.subarray(12,28));return {result:Buffer.concat([c.update(value.subarray(28)),c.final()]).toString(),shouldReEncrypt:false};}};
  await new EncryptedSecretStore(root,encryption).write('VENDITBOT_TEST','dummy-personal-secret');
  const data=await readFile(path.join(root,'credentials.encrypted.json'),'utf8');assert.doesNotMatch(data,/dummy-personal-secret/);
  const store = new EncryptedSecretStore(root,encryption);assert.equal(await store.read('VENDITBOT_TEST'),'dummy-personal-secret');assert.equal(store.has('VENDITBOT_TEST'),true);
  const locked=new EncryptedSecretStore(root,{...encryption,isAsyncEncryptionAvailable:async()=>false});await assert.rejects(locked.write('VENDITBOT_TEST','replacement'),/보안 저장소/);await assert.rejects(locked.read('VENDITBOT_TEST'),/보안 저장소/);
  assert.equal(await store.read('VENDITBOT_TEST'),'dummy-personal-secret');store.remove('VENDITBOT_TEST');assert.equal(store.has('VENDITBOT_TEST'),false);
}));
test('dangling symlinks cannot redirect private conversation or credential storage', () => temporary(async root => {
  await symlink(path.join(root,'victim'),path.join(root,'conversations.json'));assert.throws(()=>new LocalSessionStore(root),/안전하지/);
  await symlink(path.join(root,'victim'),path.join(root,'credentials.encrypted.json'));
  await assert.rejects(new EncryptedSecretStore(root,{isAsyncEncryptionAvailable:async()=>true,encryptStringAsync:async()=>Buffer.from('dummy'),decryptStringAsync:async()=>({result:'',shouldReEncrypt:false})}).write('TEST','key'),/안전하지/);
}));
test('errors redact bearer tokens, SDK keys and JWT values',()=> {assert.equal(safeError(new Error('Bearer abcdef sk-1234567890 sess-abcdefghij eyJhbGciOiJub25lIn0.eyJmb28iOjF9.signature')),'Bearer [보호됨] [보호된 키] [보호된 키] [보호된 토큰]');});

const deferredSecret = () => { let resolve; const promise = new Promise(done => {resolve = done;}); return {promise, resolve}; };
const syntheticEncryption = () => ({isAsyncEncryptionAvailable: async () => true, encryptStringAsync: async value => Buffer.from(`encrypted:${value}`), decryptStringAsync: async value => ({result: value.toString().slice(10), shouldReEncrypt: false})});
test('Keychain timeout preserves exact credential bytes and late encryption cannot commit or queue repeated native prompts', () => temporary(async root => {
  const encryption = syntheticEncryption(), store = new EncryptedSecretStore(root, encryption, 20), file = path.join(root, 'credentials.encrypted.json');
  await store.write('TEST', 'old-key'); const original = await readFile(file), gate = deferredSecret(); let calls = 0, commits = 0;
  encryption.encryptStringAsync = async () => {calls++; return gate.promise;};
  await assert.rejects(store.write('TEST', 'replacement', {afterCommit: () => commits++}), /응답 시간이 초과/);
  assert.deepEqual(await readFile(file), original); assert.equal(store.isPending(), true);
  await assert.rejects(store.write('TEST', 'later'), /이전.*처리 중/); assert.equal(calls, 1);
  gate.resolve(Buffer.from('encrypted:too-late')); await new Promise(setImmediate);
  assert.equal(store.isPending(), false); assert.equal(commits, 0); assert.deepEqual(await readFile(file), original);
  encryption.encryptStringAsync = syntheticEncryption().encryptStringAsync; await store.write('TEST', 'retry'); assert.equal(await store.read('TEST'), 'retry');
}));
test('timed-out lazy Keychain initialization never starts later encryption or modifies credentials', () => temporary(async root => {
  const encryption = syntheticEncryption(), store = new EncryptedSecretStore(root, encryption, 20), gate = deferredSecret(); let calls = 0;
  encryption.isAsyncEncryptionAvailable = () => gate.promise; encryption.encryptStringAsync = async () => {calls++; return Buffer.from('unexpected');};
  await assert.rejects(store.write('TEST', 'replacement'), /응답 시간이 초과/); gate.resolve(true); await new Promise(setImmediate);
  assert.equal(calls, 0); assert.equal(store.isPending(), false); await assert.rejects(readFile(path.join(root, 'credentials.encrypted.json')), {code:'ENOENT'});
}));
test('aborted and stale decryptions cannot return old keys or rewrite a rotation hint', () => temporary(async root => {
  const encryption = syntheticEncryption(), store = new EncryptedSecretStore(root, encryption, 50), file = path.join(root, 'credentials.encrypted.json'); await store.write('TEST', 'original');
  const original = await readFile(file), gate = deferredSecret(), controller = new AbortController(); encryption.decryptStringAsync = () => gate.promise;
  const pending = store.read('TEST', controller.signal); await new Promise(setImmediate); controller.abort(); await assert.rejects(pending, {name:'AbortError'});
  gate.resolve({result:'late-original', shouldReEncrypt:true}); await new Promise(setImmediate); assert.deepEqual(await readFile(file), original);
  const stale = deferredSecret(); encryption.decryptStringAsync = () => stale.promise; const read = store.read('TEST'); await new Promise(setImmediate); store.remove('TEST');
  stale.resolve({result:'original', shouldReEncrypt:false}); await assert.rejects(read, /변경/); assert.equal(store.has('TEST'), false);
}));
test('concurrent credential deletion invalidates a pending write and synchronous settings failure restores ciphertext without decrypting', () => temporary(async root => {
  const encryption = syntheticEncryption(), store = new EncryptedSecretStore(root, encryption, 50), file = path.join(root, 'credentials.encrypted.json'); await store.write('TEST', 'original');
  encryption.decryptStringAsync = async () => {throw new Error('must never decrypt a replaced key');};
  const original = await readFile(file); await assert.rejects(store.write('TEST', 'replacement', {afterCommit: () => {throw new Error('settings write failed');}}), /settings write failed/); assert.deepEqual(await readFile(file), original);
  const gate = deferredSecret(); encryption.encryptStringAsync = () => gate.promise; const pending = store.write('TEST', 'late'); await new Promise(setImmediate); store.remove('TEST'); gate.resolve(Buffer.from('encrypted:late'));
  await assert.rejects(pending, /변경/); assert.equal(store.has('TEST'), false);
}));

test('route snapshots and attempt recovery survive restart without replay or shared caller references', () => temporary(async root => {
  const store = new LocalSessionStore(root), connections = [{connectionId:'primary',model:'one'},{connectionId:'backup',model:'two'}];
  const session = store.create('primary','one',undefined,undefined,{connections,agentId:'owner',agentName:'Owner',instructions:'Keep role'});
  connections[0].model='mutated'; assert.equal(store.get(session.id).connections[0].model,'one');
  session.taskStatus='running'; session.messages=[msg('user','request'),{...msg('assistant','','running'),attempts:[{connectionId:'primary',model:'one',status:'failed',error:'401'},{connectionId:'backup',model:'two',status:'running'}]}]; store.save(session);
  const recovered = new LocalSessionStore(root).get(session.id);
  assert.equal(recovered.taskStatus,'cancelled'); assert.deepEqual(recovered.messages[1].attempts.map(a=>a.status),['failed','failed']);
  assert.equal(recovered.messages[1].attempts[0].error,'401'); assert.match(recovered.messages[1].attempts[1].error,/자동 재실행하지/);
  assert.deepEqual(recovered.connections,[{connectionId:'primary',model:'one'},{connectionId:'backup',model:'two'}]);
}));

test('malformed route and attempt records preserve the original conversation file', () => temporary(async root => {
  const store = new LocalSessionStore(root), session = store.create('primary','one'), file=path.join(root,'conversations.json');
  const route={connectionId:'primary',model:'one'};
  for (const extra of [{connections:[]},{connections:[route,route]},{connections:[{...route,model:'bad model'}]},{connections:Array.from({length:9},(_,i)=>({...route,model:`m${i}`}))},{messages:[{...msg('assistant','reply'),attempts:[{...route,status:'unknown'}]}]},{messages:[{...msg('assistant','reply'),attempts:[{...route,status:'completed',error:42}]}]}]) {
    const raw=JSON.stringify({version:1,sessions:[{...session,...extra}]}); await writeFile(file,raw);
    assert.throws(()=>new LocalSessionStore(root),/손상/); assert.equal(await readFile(file,'utf8'),raw);
  }
}));
