import assert from 'node:assert/strict';
import {mkdtemp,readFile,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import path from 'node:path';
import {fileURLToPath,pathToFileURL} from 'node:url';
import {randomUUID} from 'node:crypto';
import test from 'node:test';
import {build} from 'esbuild';
const root=path.resolve(path.dirname(fileURLToPath(import.meta.url)),'..');
const scratch=await mkdtemp(path.join(tmpdir(),'vendit-provider-delivery-'));
await build({stdin:{contents:`export * from './source/shared/node/provider-auth-runtime.ts';export * from './source/shared/node/codex-app-server.ts';export * from './source/shared/node/provider-failures.ts';export * from './source/shared/provider-turns.ts';export * from './source/shared/node/venditbot-paths.ts';`,resolveDir:root,loader:'ts'},bundle:true,platform:'node',format:'esm',outfile:path.join(scratch,'all.mjs')});
const {ProviderAuthRuntime,CodexAppServer,CodexRequestFailure,codexTurnFailure,providerTurnFailure,safeProviderFailure,validSafeProviderFailure,resolveVenditBotPaths}=await import(pathToFileURL(path.join(scratch,'all.mjs')));
test.after(()=>rm(scratch,{recursive:true,force:true}));
const delay=ms=>new Promise(r=>setTimeout(r,ms));
async function setup(t,mode){
 const dir=await mkdtemp(path.join(scratch,'case-')),log=path.join(dir,'wire.jsonl');let server;
 const runtime=new ProviderAuthRuntime({codexExecutable:process.execPath,codexCredentialStore:'ephemeral',paths:resolveVenditBotPaths({homeDir:dir,env:{}}),turnTimeoutMs:3000,createCodexServer:o=>(server=new CodexAppServer({...o,executable:process.execPath,args:[path.join(root,'tests/fixtures/codex-app-server-mock.mjs')],env:{...o.env,MOCK_MODE:mode,MOCK_LOG:log},requestTimeoutMs:120}))});
 t.after(async()=>{runtime.shutdown();await server?.closeAndWait();});
 await runtime.begin('codex');for(let n=0;n<100&&!runtime.snapshot('codex').authenticated;n++)await delay(5);
 assert.equal((await runtime.status('codex')).authenticated,true);
 return {runtime,server:()=>server,wire:async()=>{try{return(await readFile(log,'utf8')).trim().split('\n').filter(Boolean).map(JSON.parse);}catch{return[];}}};
}
const options=()=>({clientConversationId:randomUUID(),attemptId:randomUUID(),messages:[{role:'user',content:'synthetic initial'}]});
const input=(o,d,extra={})=>({clientConversationId:o.clientConversationId,attemptId:o.attemptId,expectedTurnId:d.turnId,clientMessageId:randomUUID(),text:'synthetic steer',...extra});
async function end(iterator,c){c.abort();await assert.rejects(async()=>{for await(const _ of iterator){}},{name:'AbortError'});}
test('official structured errors preserve only fixed codes/HTTP and never raw text, extensions or auto retry',()=>{
 for(const [info,code,status] of [['serverOverloaded','overloaded'],['usageLimitExceeded','usage-limit'],['rateLimitExceeded','rate-limit'],['sessionBudgetExceeded','usage-limit'],['contextWindowExceeded','context-limit'],[{httpConnectionFailed:{httpStatusCode:503}},'service-unavailable',503],[{responseStreamDisconnected:{httpStatusCode:401}},'authentication',401],['SECRET_SENTINEL','unknown'],[{SECRET_SENTINEL:'serverOverloaded'},'unknown'],[{httpConnectionFailed:{httpStatusCode:Infinity}},'connection']]){
  const error=codexTurnFailure({message:'SECRET_SENTINEL',additionalDetails:'SECRET_SENTINEL',codexErrorInfo:info});const safe=safeProviderFailure(error);
  assert.equal(safe.code,code);assert.equal(safe.httpStatus,status);assert.equal(safe.outcome,'unknown');assert.equal(safe.autoRetry,false);assert.equal(validSafeProviderFailure(safe),true);assert.ok(!JSON.stringify(error).includes('SECRET_SENTINEL'));assert.ok(!error.message.includes('SECRET_SENTINEL'));
 }
 assert.equal(safeProviderFailure({safe:{provider:'codex'}}),undefined);
 assert.equal(validSafeProviderFailure({...safeProviderFailure(codexTurnFailure({})),message:'SECRET_SENTINEL'}),false);
 assert.ok(!providerTurnFailure(Error('SECRET_SENTINEL'),'codex','stream',true).message.includes('SECRET_SENTINEL'));
});
test('terminal error is safely classified, no done and one model start; internal retry notification waits on same turn',async t=>{
 for(const [mode,code] of [['terminal-error','overloaded'],['failed-info','service-unavailable']]){const x=await setup(t,mode),events=[];await assert.rejects(async()=>{for await(const e of x.runtime.runCodexTurn(options()))events.push(e);},e=>safeProviderFailure(e)?.code===code&&safeProviderFailure(e)?.outcome==='unknown');assert.equal(events.some(e=>e.type==='done'),false);assert.equal((await x.wire()).filter(e=>e.method==='turn/start').length,1);}
 const x=await setup(t,'retry-success'),events=[];for await(const e of x.runtime.runCodexTurn(options()))events.push(e);
 assert.deepEqual(events.map(e=>e.type),['provider-status','text-delta','done']);assert.equal(events[0].status,'retrying');assert.equal(events[0].failure.code,'overloaded');assert.equal(events[2].text,'2');assert.equal((await x.wire()).filter(e=>e.method==='turn/start').length,1);
});
test('preflight model refusal is not-sent; lost turn/start ACK is unknown with no second start',async t=>{
 const x=await setup(t,'success');await assert.rejects(async()=>{for await(const _ of x.runtime.runCodexTurn({...options(),model:'unavailable'})){}},e=>safeProviderFailure(e)?.outcome==='not-sent');assert.equal((await x.wire()).filter(e=>e.method==='turn/start').length,0);
 const y=await setup(t,'start-lost-ack');await assert.rejects(async()=>{for await(const _ of y.runtime.runCodexTurn(options())){}},e=>safeProviderFailure(e)?.outcome==='unknown'&&safeProviderFailure(e)?.code==='timeout');assert.equal((await y.wire()).filter(e=>e.method==='turn/start').length,1);
});
test('same active tuple + durable UUID steers once, duplicates share ACK, changed text conflicts and another attempt never writes',async t=>{
 const x=await setup(t,'steer'),o=options(),c=new AbortController(),changes=[];const iter=x.runtime.runCodexTurn({...o,signal:c.signal,onActiveTurn:v=>changes.push(v)});await iter.next();const d=x.runtime.getActiveTurn();assert.equal(d.capability,'steer');const i=input(o,d);
 const [a,b]=await Promise.all([x.runtime.steer(i),x.runtime.steer(i)]);assert.deepEqual(a,b);assert.deepEqual(a,{state:'accepted',clientConversationId:o.clientConversationId,attemptId:o.attemptId,clientMessageId:i.clientMessageId,turnId:d.turnId});
 assert.equal((await x.runtime.steer({...i,text:'different'})).state,'conflict-before-wire');
 for(const mismatch of [{attemptId:randomUUID()},{clientConversationId:randomUUID()},{expectedTurnId:'other'}])assert.equal((await x.runtime.steer({...i,...mismatch})).state,'not-active-before-wire');
 const sent=(await x.wire()).filter(r=>r.method==='turn/steer');assert.equal(sent.length,1);assert.deepEqual(sent[0].params,{threadId:d.threadId,expectedTurnId:d.turnId,clientUserMessageId:i.clientMessageId,input:[{type:'text',text:i.text}]});assert.equal((await x.wire()).filter(r=>r.method==='turn/start').length,1);
 await end(iter,c);assert.equal(x.runtime.getActiveTurn(),null);assert.equal(changes.at(-1),null);
});
test('steer ACK loss, mismatch and RPC rejection are unknown, duplicate never resends or starts another turn',async t=>{
 for(const mode of ['steer-lost','steer-mismatch','steer-error']){const x=await setup(t,mode),o=options(),c=new AbortController(),iter=x.runtime.runCodexTurn({...o,signal:c.signal});await iter.next();const i=input(o,x.runtime.getActiveTurn()),a=await x.runtime.steer(i);assert.equal(a.state,'unknown');assert.equal(a.safeProviderFailure.outcome,'unknown');assert.ok(!JSON.stringify(a).includes('SECRET_SENTINEL'));assert.deepEqual(await x.runtime.steer(i),a);assert.equal((await x.wire()).filter(r=>r.method==='turn/steer').length,1);assert.equal((await x.wire()).filter(r=>r.method==='turn/start').length,1);await end(iter,c);}
});
test('steer cancellation after wire is unknown without interrupting original turn; pre-abort writes zero',async t=>{
 const x=await setup(t,'steer-lost'),o=options(),c=new AbortController(),iter=x.runtime.runCodexTurn({...o,signal:c.signal});await iter.next();const d=x.runtime.getActiveTurn(),cancelled=new AbortController();cancelled.abort();assert.equal((await x.runtime.steer(input(o,d),cancelled.signal)).state,'not-active-before-wire');
 const sc=new AbortController(),i=input(o,d),pending=x.runtime.steer(i,sc.signal);for(let n=0;n<100;n++){if((await x.wire()).some(r=>r.method==='turn/steer'))break;await delay(2);}sc.abort();assert.equal((await pending).state,'unknown');assert.equal((await x.wire()).some(r=>r.method==='turn/interrupt'),false);assert.deepEqual(await x.runtime.steer(i),await pending);await end(iter,c);
});
test('terminal event closes capability synchronously while consumer is paused; early terminal before start ACK never opens it',async t=>{
 const x=await setup(t,'terminal-paused'),o=options(),seen=[],iter=x.runtime.runCodexTurn({...o,onActiveTurn:d=>seen.push(d)});await iter.next();const d=x.runtime.getActiveTurn();assert.ok(d);for(let n=0;n<100&&x.runtime.getActiveTurn();n++)await delay(3);assert.equal(x.runtime.getActiveTurn(),null);assert.equal((await x.runtime.steer(input(o,d))).state,'not-active-before-wire');for await(const _ of iter){}assert.equal((await x.wire()).filter(r=>r.method==='turn/steer').length,0);assert.equal(seen.at(-1),null);
 const y=await setup(t,'terminal-before-ack'),opened=[];for await(const _ of y.runtime.runCodexTurn({...options(),onActiveTurn:d=>opened.push(d)})){}assert.equal(opened.some(Boolean),false);
});
test('terminal before steer ACK keeps input unknown and never migrates it to a new turn',async t=>{
 const x=await setup(t,'steer-terminal'),o=options(),iter=x.runtime.runCodexTurn(o);await iter.next();const i=input(o,x.runtime.getActiveTurn());const result=await x.runtime.steer(i);assert.equal(result.state,'unknown');assert.deepEqual(await x.runtime.steer(i),result);for await(const _ of iter){}assert.deepEqual(await x.runtime.steer(i),result);assert.equal(x.runtime.getActiveTurn(),null);assert.equal((await x.wire()).filter(r=>r.method==='turn/start').length,1);
});
test('legacy callers expose no capability and no steer write',async t=>{const x=await setup(t,'steer'),c=new AbortController(),iter=x.runtime.runCodexTurn({messages:[{role:'user',content:'synthetic'}],signal:c.signal});await iter.next();assert.equal(x.runtime.getActiveTurn(),null);assert.equal((await x.runtime.steer(input(options(),{turnId:'turn-1'}))).state,'not-active-before-wire');await end(iter,c);});
test('transport observed request distinguishes pre-abort/closed from write timeout and keeps callback count exact',async t=>{
 const x=await setup(t,'steer-lost'),s=x.server(),c=new AbortController();c.abort();let writes=0;
 await assert.rejects(s.requestObserved('turn/steer',{}, {signal:c.signal,onWriteAttempt:()=>writes++}),e=>e instanceof CodexRequestFailure&&e.outcome==='not-sent');assert.equal(writes,0);
 await assert.rejects(s.requestObserved('turn/steer',{}, {timeoutMs:30,onWriteAttempt:()=>writes++}),e=>e.outcome==='unknown'&&e.kind==='timeout');assert.equal(writes,1);
 await s.closeAndWait();await assert.rejects(s.requestObserved('turn/steer',{}, {onWriteAttempt:()=>writes++}),e=>e.outcome==='not-sent');assert.equal(writes,1);
});
test('transport backpressure is a write attempt, and rejected streams never become not-sent',async()=>{
 const {EventEmitter}=await import('node:events'),{PassThrough,Writable}=await import('node:stream');
 const child=new EventEmitter(),frames=[],returns=[];child.stdout=new PassThrough();child.stderr=new PassThrough();child.pid=999999;child.exitCode=null;child.signalCode=null;
 child.stdin=new Writable({highWaterMark:1,write(chunk,_encoding,callback){const m=JSON.parse(String(chunk));frames.push(m);if(m.method==='initialize')queueMicrotask(()=>child.stdout.write(JSON.stringify({id:m.id,result:{}})+'\n'));setTimeout(callback,5);}});
 const write=child.stdin.write.bind(child.stdin);child.stdin.write=(...args)=>{const accepted=write(...args);returns.push(accepted);return accepted;};
 child.kill=()=>{child.exitCode=0;child.emit('exit',0);return true;};
 const server=new CodexAppServer({executable:'synthetic',cwd:root,env:{},spawnProcess:()=>child});
 await server.start();let attempts=0;
 const keepAlive=setTimeout(()=>{},1000);
 try {await assert.rejects(server.requestObserved('turn/steer',{threadId:'t'},{timeoutMs:30,onWriteAttempt:()=>attempts++}),e=>e.outcome==='unknown'&&e.kind==='timeout');assert.equal(attempts,1);assert.ok(returns.includes(false));assert.equal(frames.filter(f=>f.method==='turn/steer').length,1);}finally{clearTimeout(keepAlive);await server.closeAndWait();}
});

test('unconfirmed initial turn status exposes no steering capability',async t=>{const x=await setup(t,'steer-unconfirmed'),c=new AbortController(),iter=x.runtime.runCodexTurn({...options(),signal:c.signal});await iter.next();assert.equal(x.runtime.getActiveTurn(),null);assert.equal((await x.runtime.steer(input(options(),{turnId:'turn-1'}))).state,'not-active-before-wire');await end(iter,c);});


test('thread and turn identities match durable nonempty 256-character NUL-free bounds before capability admission',async t=>{
 for(const mode of ['thread-empty','thread-long','thread-nul','turn-empty','turn-long','turn-nul']){
  const x=await setup(t,mode),opened=[];
  await assert.rejects(async()=>{for await(const _ of x.runtime.runCodexTurn({...options(),onActiveTurn:v=>opened.push(v)})){}},e=>safeProviderFailure(e)?.code==='protocol'&&safeProviderFailure(e)?.outcome===(mode.startsWith('thread-')?'not-sent':'unknown'));
  assert.equal(opened.some(Boolean),false);assert.equal(x.runtime.getActiveTurn(),null);
  assert.equal((await x.wire()).filter(r=>r.method==='turn/start').length,mode.startsWith('thread-')?0:1);
  assert.equal((await x.wire()).filter(r=>r.method==='turn/steer').length,0);
 }
 const x=await setup(t,'steer-boundary'),o=options(),c=new AbortController(),iter=x.runtime.runCodexTurn({...o,signal:c.signal});await iter.next();const d=x.runtime.getActiveTurn();assert.equal(d.threadId.length,256);assert.equal(d.turnId.length,256);
 assert.equal((await x.runtime.steer(input(o,d,{expectedTurnId:'u\0'}))).state,'conflict-before-wire');assert.equal((await x.runtime.steer(input(o,d,{clientConversationId:'c\0'}))).state,'conflict-before-wire');
 assert.equal((await x.runtime.steer(input(o,d))).state,'accepted');assert.equal((await x.wire()).filter(r=>r.method==='turn/steer').length,1);await end(iter,c);
});
