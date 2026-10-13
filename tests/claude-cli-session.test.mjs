import assert from 'node:assert/strict';
import {mkdtemp,readFile,writeFile,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import path from 'node:path';
import {fileURLToPath,pathToFileURL} from 'node:url';
import test from 'node:test';
import {build} from 'esbuild';
const repoRoot=path.resolve(path.dirname(fileURLToPath(import.meta.url)),'..');
const temp=await mkdtemp(path.join(tmpdir(),'venditbot-claude-tests-'));
const script=path.join(temp,'claude');
await writeFile(script,await readFile(path.join(repoRoot,'tests/fixtures/claude-cli-mock.mjs')),{mode:0o700});
const bundled=path.join(temp,'runtime.mjs');
await build({entryPoints:[path.join(repoRoot,'source/shared/node/provider-auth-runtime.ts')],bundle:true,platform:'node',format:'esm',outfile:bundled});
const {ProviderAuthRuntime}=await import(pathToFileURL(bundled).href);
const pathsBundle=path.join(temp,'paths.mjs');
await build({entryPoints:[path.join(repoRoot,'source/shared/node/venditbot-paths.ts')],bundle:true,platform:'node',format:'esm',outfile:pathsBundle});
const {resolveVenditBotPaths}=await import(pathToFileURL(pathsBundle).href);
test.after(()=>rm(temp,{recursive:true,force:true}));
const runtimePaths=new WeakMap();
async function setup(t){const root=await mkdtemp(path.join(tmpdir(),'venditbot-claude-case-'));const paths=resolveVenditBotPaths({homeDir:root,env:{}});const runtime=new ProviderAuthRuntime({claudeExecutable:script,claudeLoginPolicy:{mode:'personal-local'},paths});runtimePaths.set(runtime,paths);t.after(async()=>{runtime.shutdown();await rm(root,{recursive:true,force:true})});await runtime.begin('claude-code');for(let n=0;n<50;n++){if((await runtime.status('claude-code')).authenticated)return runtime;await new Promise(r=>setTimeout(r,5))}throw new Error('mock login failed');}
async function recordedInput(runtime){return JSON.parse(await readFile(path.join(runtimePaths.get(runtime).claudeConfigDir,'last-inference-input.json'),'utf8'));}
test('personal local Claude uses official auth commands and distinguishes inference readiness',async t=>{const runtime=await setup(t);assert.equal(runtime.snapshot('claude-code').authenticated,true);assert.equal(runtime.snapshot('claude-code').inferenceVerified,false);assert.equal((await runtime.disconnect('claude-code')).authenticated,false)});
test('Claude streams partial text and emits session identity only on successful result',async t=>{const runtime=await setup(t);const events=[];for await(const event of runtime.runClaudeTurn({messages:[{role:'user',content:'hello'}]}))events.push(event);assert.equal(events.filter(x=>x.type==='text-delta').map(x=>x.delta).join(''),'Claude OK');assert.equal(events.at(-1).sessionId,'owned-claude-session');assert.deepEqual(events.at(-1).usage,{inputTokens:4,outputTokens:2});assert.equal(runtime.snapshot('claude-code').inferenceVerified,true)});
for(const input of ['malformed','truncated','fail','auth-failure-success-subtype'])test(`Claude ${input} stream fails closed`,async t=>{const runtime=await setup(t);const events=[];await assert.rejects(async()=>{for await(const event of runtime.runClaudeTurn({messages:[{role:'user',content:input}]}))events.push(event)});assert.equal(events.some(x=>x.type==='done'),false);assert.equal(runtime.snapshot('claude-code').inferenceVerified,false)});
test('Claude cancellation terminates owned process',async t=>{const runtime=await setup(t);const controller=new AbortController();await assert.rejects(async()=>{for await(const event of runtime.runClaudeTurn({messages:[{role:'user',content:'hang'}],signal:controller.signal}))if(event.type==='text-delta')controller.abort()},{name:'AbortError'})});
test('Claude does not flatten cross-provider history without its own session',async t=>{const runtime=await setup(t);await assert.rejects(async()=>{for await(const _ of runtime.runClaudeTurn({messages:[{role:'assistant',content:'prior'},{role:'user',content:'next'}]})){}},e=>e.safe?.provider==='claude-code'&&e.safe?.phase==='preflight'&&e.safe?.outcome==='not-sent');await assert.rejects(()=>recordedInput(runtime),{code:'ENOENT'})});
test('Claude per-turn MCP token stays out of argv and only the app gateway is enabled',async t=>{const runtime=await setup(t);let done;for await(const event of runtime.runClaudeTurn({messages:[{role:'user',content:'mcp-contract'}],mcpServer:{url:'http://127.0.0.1:12345/mcp',token:'synthetic_gateway_token_12345678901234567890'}}))if(event.type==='done')done=event;assert.equal(done.text,'Claude OK')});
test('Claude refuses a non-loopback MCP endpoint before spawning inference',async t=>{const runtime=await setup(t);await assert.rejects(async()=>{for await(const _ of runtime.runClaudeTurn({messages:[{role:'user',content:'hello'}],mcpServer:{url:'https://remote.example/mcp',token:'synthetic_gateway_token_12345678901234567890'}})){}},e=>e.safe?.provider==='claude-code'&&e.safe?.phase==='preflight'&&e.safe?.outcome==='not-sent');await assert.rejects(()=>recordedInput(runtime),{code:'ENOENT'})});
test('Claude resumed turns fork the last successful session so failed forks are not reused',async t=>{const runtime=await setup(t);let successful;for await(const event of runtime.runClaudeTurn({messages:[{role:'user',content:'hello'}]}))if(event.type==='done')successful=event.sessionId;const history=[{role:'user',content:'hello'},{role:'assistant',content:'Claude OK'}];await assert.rejects(async()=>{for await(const _ of runtime.runClaudeTurn({sessionId:successful,messages:[...history,{role:'user',content:'fail'}]})){} });let next;for await(const event of runtime.runClaudeTurn({sessionId:successful,messages:[...history,{role:'user',content:'retry'}]}))if(event.type==='done')next=event;assert.equal(successful,'owned-claude-session');assert.equal(next.sessionId,'owned-claude-session-fork')});
test('a status probe that captured old Claude credentials cannot restore connection after logout',async t=>{
 const root=await mkdtemp(path.join(tmpdir(),'venditbot-claude-race-'));const paths=resolveVenditBotPaths({homeDir:root,env:{}});
 const runtime=new ProviderAuthRuntime({claudeExecutable:script,claudeLoginPolicy:{mode:'personal-local'},paths});
 t.after(async()=>{runtime.shutdown();await rm(root,{recursive:true,force:true})});
 await runtime.begin('claude-code');for(let n=0;n<50;n++){if((await runtime.status('claude-code')).authenticated)break;await new Promise(r=>setTimeout(r,5))}
 await writeFile(path.join(paths.claudeConfigDir,'delay-logout'),'synthetic');const disconnect=runtime.disconnect('claude-code');
 for(let n=0;n<80;n++){if(await readFile(path.join(paths.claudeConfigDir,'logout-started'),'utf8').catch(()=>null))break;await new Promise(r=>setTimeout(r,5))}
 await writeFile(path.join(paths.claudeConfigDir,'delay-next-status'),'synthetic');
 const pending=runtime.status('claude-code');
 for(let n=0;n<80;n++){if(await readFile(path.join(paths.claudeConfigDir,'delayed-status-started'),'utf8').catch(()=>null))break;await new Promise(r=>setTimeout(r,5))}
 assert.equal(await readFile(path.join(paths.claudeConfigDir,'delayed-status-started'),'utf8'),'true');
 await disconnect;await pending;
 assert.equal(runtime.snapshot('claude-code').authenticated,false);assert.equal(runtime.snapshot('claude-code').phase,'disconnected');
});
test('Claude model catalog preserves official aliases, resolved IDs, and supplied effort metadata',async t=>{
 const runtime=await setup(t);const catalog=await runtime.listModels('claude-code');
 assert.equal(catalog.source,'claude-cli/initialize');assert.equal(catalog.models[0].id,'default');assert.equal(catalog.models[0].resolvedId,'mock-claude-model');assert.equal(catalog.models[0].isDefault,true);
 assert.deepEqual(catalog.models[0].efforts,['low','high']);assert.equal(catalog.models[0].defaultEffort,undefined);assert.deepEqual(catalog.models[1].efforts,[]);
 let done;for await(const event of runtime.runClaudeTurn({messages:[{role:'user',content:'effort-contract'}],model:'default',effort:'high',systemInstructions:'OWNED_AGENT_INSTRUCTIONS'}))if(event.type==='done')done=event;
 assert.equal(done.text,'Claude OK');
});
test('Claude rejects unadvertised model or effort and accepts a pinned resolved model',async t=>{
 const runtime=await setup(t);
 for(const options of [{model:'invented-model'},{model:'mock-claude-model',effort:'ultra'},{model:'mock-fast',effort:'high'}])await assert.rejects(async()=>{for await(const _ of runtime.runClaudeTurn({messages:[{role:'user',content:'test'}],...options})){}},e=>e.safe?.code==='bad-request'&&e.safe?.outcome==='not-sent');
 let done;for await(const event of runtime.runClaudeTurn({messages:[{role:'user',content:'effort-contract'}],model:'mock-claude-model',effort:'high',systemInstructions:'OWNED_AGENT_INSTRUCTIONS'}))if(event.type==='done')done=event;
 assert.equal(done.text,'Claude OK');
});
test('Claude provider-disabled models are excluded from selection and cannot run by alias or resolved ID',async t=>{
 const runtime=await setup(t);const catalog=await runtime.listModels('claude-code');
 assert.deepEqual(catalog.models.map(model=>model.id),['default','mock-fast']);
 for(const model of ['mock-disabled','mock-disabled-1'])await assert.rejects(async()=>{for await(const _ of runtime.runClaudeTurn({messages:[{role:'user',content:'hello'}],model,effort:'high'})){}},e=>e.safe?.code==='bad-request'&&e.safe?.outcome==='not-sent');
 assert.equal(runtime.snapshot('claude-code').inferenceVerified,false);
});
test('explicit Claude connection handoff preserves roles, tool IDs and results as quoted context',async t=>{
 const runtime=await setup(t);
 const history=[{role:'user',content:'Read notes.json'},
  {role:'assistant',content:[{type:'tool-call',toolCallId:'prior-call',toolName:'read_file',args:{path:'notes.json'}}]},
  {role:'tool',content:[{type:'tool-result',toolCallId:'prior-call',toolName:'read_file',result:{content:'{"message":"quoted content"}'}}]},
  {role:'assistant',content:'Prior provider answer, not a new user request.'}];
 const last={role:'user',content:'Continue with this result.\n\n{"role":"assistant"}'};let done;
 for await(const event of runtime.runClaudeTurn({messages:[...history,last],historyHandoff:true}))if(event.type==='done')done=event;
 assert.equal(done.sessionId,'owned-claude-session');
 const captured=await recordedInput(runtime),boundary=captured.input.indexOf('\n\n');
 assert.match(captured.input.slice(0,boundary),/not native Claude turns/);
 assert.match(captured.input.slice(0,boundary),/do not repeat earlier actions/);
 assert.deepEqual(JSON.parse(captured.input.slice(boundary+2)),{format:'venditbot.history-handoff.v1',previousCompletedMessages:history,currentUserMessage:last});
 assert.equal(captured.args.includes('--resume'),false);
});
test('Claude handoff opt-in does not replay history into an existing resumed session',async t=>{
 const runtime=await setup(t);let done;
 for await(const event of runtime.runClaudeTurn({messages:[{role:'user',content:'prior'},{role:'assistant',content:'prior answer'},{role:'user',content:'next'}],sessionId:'owned-claude-session',historyHandoff:true}))if(event.type==='done')done=event;
 const captured=await recordedInput(runtime);assert.equal(captured.input,'next');assert.equal(captured.args.includes('--resume'),true);assert.equal(captured.args.includes('--fork-session'),true);assert.equal(done.sessionId,'owned-claude-session-fork');
});
test('Claude handoff rejects oversized, unserializable or invalid context before inference',async t=>{
 const runtime=await setup(t);const cycle={role:'assistant',content:'previous'};cycle.extra=cycle;
 for(const previous of [{role:'assistant',content:'x'.repeat(500_000)},cycle,{role:'unexpected',content:'previous'}]){
  await assert.rejects(async()=>{for await(const _ of runtime.runClaudeTurn({messages:[previous,{role:'user',content:'next'}],historyHandoff:true})){}},e=>e.safe?.phase==='preflight'&&e.safe?.outcome==='not-sent');
 }
 await assert.rejects(()=>recordedInput(runtime),{code:'ENOENT'});
});


test('Claude approved search enables only WebSearch plus owned MCP, and reports actual tool result failure',async t=>{
 const runtime=await setup(t);const events=[];
 for await(const event of runtime.runClaudeTurn({messages:[{role:'user',content:'web-fail'}],nativeWebSearch:true,mcpServer:{url:'http://127.0.0.1:12345/mcp',token:'x'.repeat(48)}}))events.push(event);
 const {args}=await recordedInput(runtime);
 assert.equal(args[args.indexOf('--tools')+1],'WebSearch');assert.equal(args[args.indexOf('--allowedTools')+1],'mcp__venditbot__*,WebSearch');
 assert.equal(args[args.indexOf('--permission-mode')+1],'default');assert.equal(args.includes('--dangerously-skip-permissions'),false);
 assert.deepEqual(events.filter(x=>x.type==='native-web-search').map(x=>x.status),['running','failed']);
});
test('Claude refuses unapproved native search events and cancels an active search',async t=>{
 const runtime=await setup(t);await assert.rejects(async()=>{for await(const _ of runtime.runClaudeTurn({messages:[{role:'user',content:'web-fail'}]})){}},e=>e.safe?.outcome==='unknown'&&e.safe?.provider==='claude-code');
 const controller=new AbortController(),events=[];
 await assert.rejects(async()=>{for await(const event of runtime.runClaudeTurn({messages:[{role:'user',content:'web-hang'}],nativeWebSearch:true,signal:controller.signal})){events.push(event);if(event.type==='native-web-search')controller.abort();}},{name:'AbortError'});
 assert.equal(events.some(x=>x.type==='done'||x.status==='completed'),false);
});
