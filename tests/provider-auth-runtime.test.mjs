import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import test from 'node:test';
import { build } from 'esbuild';
const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const fixture = path.join(repoRoot, 'tests/fixtures/codex-app-server-mock.mjs');
const moduleDir = await mkdtemp(path.join(tmpdir(), 'venditbot-auth-tests-'));
const modulePath = path.join(moduleDir, 'auth.mjs');
await build({ entryPoints: [path.join(repoRoot, 'source/shared/node/provider-auth-runtime.ts')], bundle: true, platform: 'node', format: 'esm', outfile: modulePath });
const { ProviderAuthRuntime } = await import(pathToFileURL(modulePath).href);
const serverPath = path.join(moduleDir, 'server.mjs');
await build({ entryPoints: [path.join(repoRoot, 'source/shared/node/codex-app-server.ts')], bundle: true, platform: 'node', format: 'esm', outfile: serverPath });
const { CodexAppServer } = await import(pathToFileURL(serverPath).href);
const pathsPath = path.join(moduleDir, 'paths.mjs');
await build({ entryPoints: [path.join(repoRoot, 'source/shared/node/venditbot-paths.ts')], bundle: true, platform: 'node', format: 'esm', outfile: pathsPath });
const { resolveVenditBotPaths } = await import(pathToFileURL(pathsPath).href);
test.after(() => rm(moduleDir, { recursive: true, force: true }));
async function setup(t, mode = 'success', extra = {}) {
  const root = await mkdtemp(path.join(tmpdir(), 'venditbot-auth-case-'));
  const log = path.join(root, 'protocol.jsonl');
  let childEnv;
  const runtime = new ProviderAuthRuntime({
    codexExecutable: process.execPath,
    codexCredentialStore: 'ephemeral',
    paths: resolveVenditBotPaths({ homeDir: root, env: {} }),
    createCodexServer: options => { childEnv = options.env; return new CodexAppServer({ ...options, executable: process.execPath, args: [fixture], env: { ...options.env, MOCK_MODE: mode, MOCK_LOG: log, MOCK_KEYRING: options.credentialStore === 'keyring' ? '1' : '0' }, requestTimeoutMs: 500 }); },
    turnTimeoutMs: 2000, ...extra,
  });
  t.after(async () => { runtime.shutdown(); await rm(root, { recursive: true, force: true }); });
  return { runtime, env: () => childEnv, requests: async () => (await readFile(log, 'utf8')).trim().split('\n').map(JSON.parse) };
}
async function login(runtime) {
  await runtime.begin('codex');
  for (let n = 0; n < 50; n++) { if ((await runtime.status('codex')).authenticated) return; await new Promise(resolve => setTimeout(resolve, 5)); }
  throw new Error('Mock login did not complete');
}

test('duplicate login is single-flight, forged completion does not authenticate, cancel targets owned login', async t => {
  const { runtime, requests } = await setup(t, 'pending');
  const [a, b] = await Promise.all([runtime.begin('codex'), runtime.begin('codex')]);
  assert.equal(a.authUrl, b.authUrl); assert.equal(a.authenticated, false);
  assert.equal((await runtime.status('codex')).authenticated, false);
  assert.equal((await runtime.cancel('codex')).phase, 'cancelled');
  const sent = await requests();
  assert.equal(sent.filter(x => x.method === 'account/login/start').length, 1);
  assert.equal(sent.find(x => x.method === 'account/login/cancel').params.loginId, 'owned-login');
});
test('official login is authenticated but not inference-verified; logout uses same instance', async t => {
  const { runtime, requests, env } = await setup(t);
  await login(runtime);
  assert.equal(runtime.snapshot('codex').inferenceVerified, false);
  assert.equal(runtime.snapshot('codex').credentialStorage, 'session');
  assert.match(env().CODEX_HOME, /providers\/codex$/);
  assert.match(env().CLAUDE_CONFIG_DIR, /providers\/claude$/);
  assert.equal((await runtime.disconnect('codex')).authenticated, false);
  assert.equal((await requests()).filter(x => x.method === 'account/logout').length, 1);
});
test('untrusted auth URL is rejected and owned login cancelled', async t => {
  const { runtime, requests } = await setup(t, 'evil-url');
  await assert.rejects(runtime.begin('codex'), /unsupported login URL/);
  assert.equal((await requests()).filter(x => x.method === 'account/login/cancel').length, 1);
});
test('provider errors do not leak stderr or raw protocol secrets', async t => {
  const { runtime } = await setup(t, 'port-conflict');
  await assert.rejects(runtime.begin('codex'), error => !error.message.includes('SECRET_SENTINEL') && /포트/.test(error.message));
  assert.equal(runtime.snapshot('codex').phase, 'error');
});
test('stream matches thread, handles split UTF-8, preserves roles and verifies only completed turns', async t => {
  const { runtime, requests } = await setup(t); await login(runtime);
  const events = [];
  for await (const event of runtime.runCodexTurn({ messages: [{ role: 'user', content: 'old user' }, { role: 'assistant', content: 'old assistant' }, { role: 'user', content: 'new user' }] })) events.push(event);
  assert.equal(events.filter(x => x.type === 'text-delta').map(x => x.delta).join(''), 'Hello 세계');
  assert.deepEqual(events.at(-1).usage, { inputTokens: 5, outputTokens: 2, cacheReadTokens: 1 });
  assert.equal(runtime.snapshot('codex').inferenceVerified, true);
  const sent = await requests(); const history = sent.find(x => x.method === 'thread/inject_items').params.items;
  assert.deepEqual(history.map(x => x.role), ['user', 'assistant']);
  assert.deepEqual(sent.find(x => x.method === 'turn/start').params.input, [{ type: 'text', text: 'new user' }]);
  assert.equal(sent.find(x => x.method === 'thread/start').params.sandbox, 'read-only');
});
test('failed turn preserves partial stream and never reports successful completion', async t => {
  const { runtime } = await setup(t, 'failed'); await login(runtime); const events = [];
  await assert.rejects(async () => { for await (const event of runtime.runCodexTurn({ messages: [{ role: 'user', content: 'test' }] })) events.push(event); }, /실패/);
  assert.equal(events.some(x => x.type === 'text-delta'), true);
  assert.equal(events.some(x => x.type === 'done'), false);
  assert.equal(runtime.snapshot('codex').inferenceVerified, false);
});
test('turn abort sends official interrupt and unlocks next request', async t => {
  const { runtime, requests } = await setup(t, 'hanging'); await login(runtime); const controller = new AbortController();
  await assert.rejects(async () => { for await (const event of runtime.runCodexTurn({ messages: [{ role: 'user', content: 'test' }], signal: controller.signal })) if (event.type === 'text-delta') controller.abort(); }, { name: 'AbortError' });
  assert.ok((await requests()).some(x => x.method === 'turn/interrupt'));
  assert.equal(runtime.snapshot('codex').inferenceVerified, false);
});
test('app-server crash during a turn fails promptly', async t => {
  const { runtime } = await setup(t, 'crash'); await login(runtime);
  await assert.rejects(async () => { for await (const _ of runtime.runCodexTurn({ messages: [{ role: 'user', content: 'test' }] })) {} }, /exited/);
});
test('duplicate dynamic tool delivery executes external work once', async t => {
  const { runtime } = await setup(t, 'tools'); await login(runtime); let executions = 0;
  for await (const _ of runtime.runCodexTurn({ messages: [{ role: 'user', content: 'test' }], tools: [{ name: 'safe_tool', inputSchema: { type: 'object' } }], executeTool: async (_tool, args, id) => { executions++; assert.deepEqual(args, { value: 4 }); assert.equal(id, 'call-1'); return { ok: true }; } })) {}
  assert.equal(executions, 1);
});
test('distribution policy blocks Claude login without invoking a CLI', async t => {
  const { runtime } = await setup(t);
  assert.equal((await runtime.begin('claude-code')).phase, 'policy-blocked');
});

test('keyring-mode mocked restart restores only its profile and logout leaves another home intact', async t => {
  const one = await setup(t, 'success', { codexCredentialStore: 'keyring' });
  const two = await setup(t, 'success', { codexCredentialStore: 'keyring' });
  await login(one.runtime); await login(two.runtime);
  one.runtime.shutdown(); two.runtime.shutdown();
  assert.equal((await one.runtime.status('codex')).authenticated, true);
  assert.equal((await two.runtime.status('codex')).authenticated, true);
  assert.equal(one.runtime.snapshot('codex').credentialStorage, 'keyring');
  assert.equal(one.runtime.snapshot('codex').inferenceVerified, false);
  await two.runtime.disconnect('codex'); two.runtime.shutdown();
  assert.equal((await two.runtime.status('codex')).authenticated, false);
  assert.equal((await one.runtime.status('codex')).authenticated, true);
  assert.equal((await one.requests()).filter(x => x.method === 'account/login/start').length, 1);
});
test('keyring rejection stays actionable across status reads and never falls back to plaintext', async t => {
  const { runtime, requests } = await setup(t, 'keyring-denied', { codexCredentialStore: 'keyring' });
  await assert.rejects(runtime.begin('codex'), error => /Keychain/.test(error.message) && !error.message.includes('SECRET_SENTINEL'));
  const status = await runtime.status('codex');
  assert.equal(status.phase, 'error'); assert.equal(status.credentialStorage, 'keyring');
  assert.match(status.error, /Keychain/);
  assert.equal((await requests()).filter(x => x.method === 'account/login/start').length, 1);
});
test('explicit shutdown wakes a blocked active turn', async t => {
  const { runtime } = await setup(t, 'hanging'); await login(runtime);
  await assert.rejects(async () => { for await (const event of runtime.runCodexTurn({ messages: [{ role: 'user', content: 'test' }] })) if (event.type === 'text-delta') runtime.shutdown(); }, /closed/);
});
test('cancel during login-start does not wait for a missing login ID and prevents stale completion', async t => {
  const {runtime,requests}=await setup(t,'slow-start');
  const attempt=runtime.begin('codex'); const rejected=assert.rejects(attempt,{name:'AbortError'});
  for(let i=0;i<80;i++){if((await requests().catch(()=>[])).some(x=>x.method==='account/login/start'))break;await new Promise(r=>setTimeout(r,5));}
  const started=performance.now(); const result=await runtime.cancel('codex');
  assert.ok(performance.now()-started<250); assert.equal(result.phase,'cancelled');
  await rejected; assert.equal(runtime.snapshot('codex').authenticated,false); assert.equal(runtime.snapshot('codex').phase,'cancelled');
});
test('concurrent official status reads are single-flight',async t=>{const {runtime,requests}=await setup(t,'slow-status');await Promise.all(Array.from({length:10},()=>runtime.status('codex')));assert.equal((await requests()).filter(x=>x.method==='account/read').length,1)});
test('duplicate logout is single-flight and blocks overlapping new login',async t=>{const {runtime,requests}=await setup(t,'slow-logout');await login(runtime);const one=runtime.disconnect('codex'),two=runtime.disconnect('codex');await assert.rejects(runtime.begin('codex'),/연결 해제/);await Promise.all([one,two]);assert.equal((await requests()).filter(x=>x.method==='account/logout').length,1);assert.equal(runtime.snapshot('codex').authenticated,false)});
test('a configured missing executable is not reported installed',()=>{const runtime=new ProviderAuthRuntime({codexExecutable:'/definitely-missing/venditbot-codex'});assert.equal(runtime.snapshot('codex').installed,false)});
test('cancel during the initial login status read reports cancellation instead of a stale transport error',async t=>{
  const {runtime,requests}=await setup(t,'slow-status');
  const attempt=runtime.begin('codex');const rejected=assert.rejects(attempt,{name:'AbortError'});
  for(let i=0;i<80;i++){if((await requests().catch(()=>[])).some(x=>x.method==='account/read'))break;await new Promise(r=>setTimeout(r,5));}
  await runtime.cancel('codex');await rejected;
  assert.equal(runtime.snapshot('codex').phase,'cancelled');
  assert.equal((await requests()).some(x=>x.method==='account/login/start'),false);
});
test('cancel during thread preparation returns promptly and never starts a model turn',async t=>{
  const {runtime,requests}=await setup(t,'slow-thread');await login(runtime);
  const controller=new AbortController();
  const turn=(async()=>{for await(const _ of runtime.runCodexTurn({messages:[{role:'user',content:'test'}],signal:controller.signal})){} })();
  const rejected=assert.rejects(turn,{name:'AbortError'});
  for(let i=0;i<80;i++){if((await requests()).some(x=>x.method==='thread/start'))break;await new Promise(r=>setTimeout(r,5));}
  const started=performance.now();controller.abort();await rejected;
  assert.ok(performance.now()-started<250);
  assert.equal((await requests()).some(x=>x.method==='turn/start'),false);
});
test('a timed-out interrupt invalidates the closed transport and reconnects the same keyring profile',async t=>{
  const {runtime,requests}=await setup(t,'stuck-interrupt',{codexCredentialStore:'keyring'});await login(runtime);
  const controller=new AbortController();
  await assert.rejects(async()=>{for await(const event of runtime.runCodexTurn({messages:[{role:'user',content:'test'}],signal:controller.signal}))if(event.type==='text-delta')controller.abort()},{name:'AbortError'});
  assert.equal((await runtime.status('codex')).authenticated,true);
  assert.equal((await requests()).filter(x=>x.method==='initialize').length,2);
  assert.equal((await requests()).filter(x=>x.method==='account/login/start').length,1);
});
test('official model catalog follows pagination, hides hidden rows and caches without exposing mutable state',async t=>{
  const {runtime,requests}=await setup(t,'catalog-pages');
  const [one,two]=await Promise.all([runtime.listModels('codex'),runtime.listModels('codex')]);
  assert.deepEqual(one.models.map(x=>x.id),['mock-codex-model','second']);assert.deepEqual(one,two);
  assert.deepEqual(one.models[0].efforts,['low','high']);assert.equal(one.models[0].defaultEffort,'low');
  assert.equal(one.models[1].defaultEffort,undefined);assert.deepEqual(one.models[1].efforts,[]);
  one.models[0].efforts.push('forged');assert.equal((await runtime.listModels('codex')).models[0].efforts.includes('forged'),false);
  assert.equal((await requests()).filter(x=>x.method==='model/list').length,2);
  await runtime.listModels('codex',{refresh:true});
  const pages=(await requests()).filter(x=>x.method==='model/list');assert.equal(pages.length,4);
  assert.ok(pages.every(x=>x.params.includeHidden===false));assert.equal(pages[1].params.cursor,'page-2');
});
test('Codex uses catalog defaults and validates model and effort before starting inference',async t=>{
  const {runtime,requests}=await setup(t);await login(runtime);
  for(const options of [{model:'invented-model'},{model:'mock-codex-model',effort:'ultra'}])await assert.rejects(async()=>{for await(const _ of runtime.runCodexTurn({messages:[{role:'user',content:'test'}],...options})){}},/모델/);
  assert.equal((await requests()).some(x=>x.method==='thread/start'),false);
  for await(const _ of runtime.runCodexTurn({messages:[{role:'user',content:'test'}]})){}
  const turn=(await requests()).find(x=>x.method==='turn/start');assert.equal(turn.params.model,'mock-codex-model');assert.equal(turn.params.effort,'low');
});
test('explicit Codex effort and per-agent instructions apply only to their own turn',async t=>{
  const {runtime,requests}=await setup(t);await login(runtime);
  for await(const _ of runtime.runCodexTurn({messages:[{role:'user',content:'test'}],model:'mock-codex-model',effort:'high',systemInstructions:'OWNED_AGENT_INSTRUCTIONS'})){}
  for await(const _ of runtime.runCodexTurn({messages:[{role:'user',content:'test'}]})){}
  const sent=await requests();const threads=sent.filter(x=>x.method==='thread/start');const turns=sent.filter(x=>x.method==='turn/start');
  assert.match(threads[0].params.baseInstructions,/OWNED_AGENT_INSTRUCTIONS/);assert.doesNotMatch(threads[1].params.baseInstructions,/OWNED_AGENT_INSTRUCTIONS/);
  assert.equal(turns[0].params.effort,'high');assert.equal(turns[1].params.effort,'low');
});
test('model catalogs invalidate after account lifecycle changes',async t=>{
  const {runtime,requests}=await setup(t);await runtime.listModels('codex');await login(runtime);await runtime.listModels('codex');
  assert.equal((await requests()).filter(x=>x.method==='model/list').length,2);
  await runtime.disconnect('codex');await runtime.listModels('codex');
  assert.equal((await requests()).filter(x=>x.method==='model/list').length,3);
});
