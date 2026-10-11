import assert from 'node:assert/strict';
import test from 'node:test';
import {randomUUID} from 'node:crypto';
import {build} from 'esbuild';
const built=await build({entryPoints:['source/venditbot/avatar-jobs.ts'],bundle:true,platform:'node',format:'esm',write:false});
const {AvatarJobs}=await import(`data:text/javascript;base64,${Buffer.from(built.outputFiles[0].text).toString('base64')}`);
test('image jobs scope cancellation and reject terminal resurrection or duplicate owner jobs',()=>{
 const events=[],jobs=new AvatarJobs([],job=>events.push(job)),a=jobs.begin(),b=jobs.begin();assert.throws(()=>jobs.begin(randomUUID(),a.job.ownerKey),/이미/);assert.throws(()=>jobs.cancel(),/선택/);
 jobs.cancel(a.job.requestId);assert.equal(a.signal.aborted,true);assert.equal(b.signal.aborted,false);assert.equal(jobs.update(a.job.requestId,{phase:'running'}).phase,'cancelled');assert.equal(jobs.update(a.job.requestId,{phase:'completed',assetId:randomUUID()}).phase,'cancelled');
 jobs.update(b.job.requestId,{phase:'completed',assetId:randomUUID()});const list=jobs.list();list[1].phase='failed';assert.equal(jobs.get(b.job.requestId).phase,'completed');assert.equal(events.filter(e=>e.phase==='completed').length,1);
});
test('restart cancels validating queued and running image metadata and permits a fresh owner request',()=>{
 for(const phase of ['validating','queued','running']){const record={requestId:randomUUID(),ownerKey:`agent:${randomUUID()}`,phase},jobs=new AvatarJobs([{avatarRequest:record}],()=>{});assert.equal(jobs.list()[0].phase,'cancelled');assert.equal(record.phase,phase);assert.equal(jobs.active().length,0);assert.equal(jobs.begin(randomUUID(),record.ownerKey).job.phase,'validating');}
});
test('image job bound is 17 active owners and cancellation releases capacity without crossing owners',()=>{
 const jobs=new AvatarJobs([],()=>{}),pending=Array.from({length:17},()=>jobs.begin());assert.throws(()=>jobs.begin(),/16/);jobs.cancel(pending[4].job.requestId);assert.equal(jobs.begin().job.phase,'validating');assert.equal(pending.filter(p=>p.signal.aborted).length,1);
});
test('a rejected optional clone image remains visible without consuming or cancelling a full queue',()=>{
 const events=[],jobs=new AvatarJobs([],job=>events.push(job)),pending=Array.from({length:17},()=>jobs.begin()),id=randomUUID(),owner=`agent:${randomUUID()}`;
 const failed=jobs.recordFailure(id,owner,'복제 성공 · 사진 변형 대기열 가득 참');assert.equal(failed.phase,'failed');assert.equal(jobs.active().length,17);assert.equal(events.at(-1).requestId,id);assert.equal(pending.some(p=>p.signal.aborted),false);
 failed.error='external mutation';assert.notEqual(jobs.get(id).error,failed.error);assert.throws(()=>jobs.recordFailure(id,`agent:${randomUUID()}`,'wrong owner'),/일치/);
 assert.throws(()=>jobs.recordFailure(randomUUID(),pending[0].job.ownerKey,'replace active'),/이미/);assert.equal(jobs.get(pending[0].job.requestId).phase,'validating');
 jobs.cancel(pending[0].job.requestId);const retried=jobs.begin(randomUUID(),owner);assert.equal(retried.job.phase,'validating');assert.equal(jobs.list().filter(job=>job.ownerKey===owner).length,1);
 for(let i=0;i<1100;i++)jobs.recordFailure(randomUUID(),`agent:${randomUUID()}`,'optional request rejected');assert.equal(jobs.list().length,1000);assert.equal(jobs.active().length,17);
});
test('500 bounded cycles reject request 18, isolate cancellations and recover every interrupted owner',()=>{
 const start=performance.now(),initial=process.memoryUsage().heapUsed;let accepted=0,cancelled=0;
 for(let cycle=0;cycle<500;cycle++){
  const jobs=new AvatarJobs([],()=>{}),pending=Array.from({length:17},()=>jobs.begin());accepted+=pending.length;assert.throws(()=>jobs.begin(),/16/);
  for(let i=0;i<pending.length;i++){const p=pending[i];if(i%3===0){jobs.cancel(p.job.requestId);cancelled++;jobs.update(p.job.requestId,{phase:'completed',assetId:randomUUID()});assert.equal(jobs.get(p.job.requestId).phase,'cancelled');}else jobs.update(p.job.requestId,{phase:i%3===1?'queued':'running',sessionId:randomUUID()});}
  const restart=new AvatarJobs(jobs.list().map(avatarRequest=>({avatarRequest})),()=>{});assert.equal(restart.active().length,0);assert.equal(restart.list().length,17);for(const job of restart.list())assert.equal(job.phase,'cancelled');
 }
 assert.equal(accepted,8500);assert.equal(cancelled,3000);console.log(JSON.stringify({fixture:'avatar-owner-registry',cycles:500,accepted,cancelled,elapsedMs:Math.round(performance.now()-start),heapDeltaBytes:process.memoryUsage().heapUsed-initial,rssBytes:process.memoryUsage().rss,nativeProviderCalls:0}));
});
