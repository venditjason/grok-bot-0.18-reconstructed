import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp, rm} from 'node:fs/promises';
import {randomUUID} from 'node:crypto';
import {join, resolve} from 'node:path';
import {tmpdir} from 'node:os';
import {build} from 'esbuild';
const directory=tmpdir(),repo=process.cwd();
let transport=async()=>{throw Error('No synthetic transport installed');};
const originalFetch=globalThis.fetch;
globalThis.fetch=(...args)=>transport(...args);
const output=await build({stdin:{contents:"export {RabbitHost} from './source/venditbot/rabbit-host.ts'; export {RabbitStore} from './source/venditbot/rabbit-store.ts';",resolveDir:repo},bundle:true,platform:'node',format:'esm',write:false});
const {RabbitHost,RabbitStore}=await import('data:text/javascript;base64,'+Buffer.from(output.outputFiles[0].text).toString('base64'));
globalThis.fetch=originalFetch;
const projectId=randomUUID(),key='rabbit_'+'q'.repeat(43);
const input={objective:'synthetic project work',acceptance_criteria:['return a result']};
async function fixture(t){
 const root=await mkdtemp(join(directory,'synthetic-rabbit-retry-'));t.after(()=>rm(root,{recursive:true,force:true}));
 const store=new RabbitStore(root),connection=store.saveConnection({name:'synthetic',baseUrl:'https://rabbit.invalid',projectId,baseRef:'main',workflowTemplate:'review_only',maxParallelTasks:1,timeoutSeconds:60,enabledForAgents:true});
 let approve=true;const host=new RabbitHost({store,secrets:{read:async()=>key,has:()=>true,revision:()=> 'synthetic-key-revision'},authorize:async()=>approve,changed(){},assertMutable(){}});
 const source={sessionId:randomUUID(),agentId:randomUUID()};
 let sends=0;transport=async()=>{sends++;throw Error('response lost after possible acceptance');};
 const record=await host.start(connection.id,input,randomUUID(),source);
 assert.equal(record.phase,'unknown');assert.equal(sends,1);
 return {root,store,host,source,record,deny(){approve=false;},get sends(){return sends;},setTransport(next){transport=async(...args)=>{sends++;return next(...args);};}};
}
test('declining a retry approval cannot resolve an earlier unknown remote submission',async t=>{
 const f=await fixture(t);f.deny();const retried=await f.host.retry(f.record.id);
 assert.equal(f.sends,1,'a denied retry must not issue a second POST');
 assert.equal(retried.phase,'unknown','earlier dispatched request remains unresolved even if the retry is denied');
 assert.throws(()=>f.host.assertLocalWrite('follow-up work',f.source),/로컬 중복 실행/);
 assert.equal(new RabbitStore(f.root).getRun(f.record.id).phase,'unknown');
});
for(const status of [400,401,404,409,422])test(`retry HTTP${status} cannot erase uncertainty about an earlier POST`,async t=>{
 const f=await fixture(t);f.setTransport(()=>Response.json({error:{code:status===409?'idempotency_conflict':'invalid_api_key'}},{status}));
 const retried=await f.host.retry(f.record.id);assert.equal(f.sends,2);
 assert.equal(retried.phase,'unknown');assert.equal(retried.idempotencyKey,f.record.idempotencyKey);
 assert.throws(()=>f.host.assertLocalWrite('follow-up work',f.source),/로컬 중복 실행/);
});

test('uncertainty survives retry-in-progress and restart; the same validated receipt clears it',async t=>{
 const f=await fixture(t);const pending=f.store.beginSubmission(f.record.id);
 assert.equal(pending.unresolvedSubmission,true);assert.equal(pending.phase,'submitting');
 const recovered=new RabbitStore(f.root);assert.equal(recovered.getRun(pending.id).phase,'unknown');
 recovered.failSubmission(pending.id,{uncertain:false,error:'retry was cancelled before dispatch'});
 assert.equal(recovered.getRun(pending.id).phase,'unknown');recovered.beginSubmission(pending.id);
 const remote=randomUUID(),receipt={run_id:remote,project_id:projectId,state:'queued',created_at:new Date().toISOString(),poll_url:`https://rabbit.invalid/v1/runs/${remote}`,events_url:`https://rabbit.invalid/v1/runs/${remote}/events`};
 const accepted=recovered.completeSubmission(pending.id,receipt);assert.equal(accepted.phase,'accepted');assert.equal(accepted.unresolvedSubmission,undefined);
 assert.equal(recovered.failSubmission(pending.id,{uncertain:true,error:'late error'}).phase,'accepted');
 assert.deepEqual(new RabbitStore(f.root).getRun(pending.id),accepted);
});
test('a first pre-dispatch denial remains definitely rejected, without erasing a different uncertain run',async t=>{
 const f=await fixture(t);const first=f.store.prepareRun(f.record.connectionId,{...input,objective:'another task'});
 const rejected=f.store.failSubmission(first.id,{uncertain:false,error:'not approved'});
 assert.equal(rejected.phase,'rejected');assert.equal(rejected.unresolvedSubmission,undefined);
 assert.equal(f.store.getRun(f.record.id).phase,'unknown');
});
for(const interrupted of ['prepared','submitting'])test(`a recovered first ${interrupted} submission remains uncertain after a definite retry error`,async t=>{
 const root=await mkdtemp(join(directory,'synthetic-rabbit-recovery-'));t.after(()=>rm(root,{recursive:true,force:true}));
 const original=new RabbitStore(root),connection=original.saveConnection({name:'recovery',baseUrl:'https://rabbit.invalid',projectId,baseRef:'main',workflowTemplate:'review_only',maxParallelTasks:1,timeoutSeconds:60,enabledForAgents:true});
 const record=original.prepareRun(connection.id,input);if(interrupted==='submitting')original.beginSubmission(record.id);
 const recovered=new RabbitStore(root);assert.equal(recovered.getRun(record.id).phase,'unknown');
 const retry=recovered.beginSubmission(record.id);assert.equal(retry.unresolvedSubmission,true);
 const failed=recovered.failSubmission(record.id,{uncertain:false,error:'retry rejected before any new POST'});
 assert.equal(failed.phase,'unknown');assert.equal(failed.idempotencyKey,record.idempotencyKey);assert.deepEqual(failed.request,record.request);
 assert.equal(new RabbitStore(root).getRun(record.id).phase,'unknown');
});
