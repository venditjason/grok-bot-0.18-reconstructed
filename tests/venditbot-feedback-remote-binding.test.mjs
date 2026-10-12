import test from 'node:test';
import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import {build} from 'esbuild';
const built=await build({stdin:{contents:"export * from './source/venditbot/feedback-draft-proof.ts';export * from './source/venditbot/feedback-github-proof.ts';export * from './source/venditbot/feedback-main-adapter.ts';",resolveDir:process.cwd()},bundle:true,platform:'node',format:'esm',write:false});
const {readFeedbackDraftProof,feedbackGithubInput,FeedbackMainAdapter}=await import('data:text/javascript;base64,'+Buffer.from(built.outputFiles[0].text).toString('base64'));
const repositoryName='venditjason/grok-bot-0.18-reconstructed',head='a'.repeat(40),base='b'.repeat(40),url=`https://github.com/${repositoryName}/pull/12`;
function fixture(){
 const id=randomUUID(),project=randomUUID(),remote=randomUUID(),repository=randomUUID(),connection=randomUUID();
 const job={id,kind:'bug',title:'Fix',description:'Fixture only',status:'running',dispatch:'remote_accepted',route:'rabbit',remoteRunId:remote,binding:{repository:repositoryName,baseBranch:'main',allowLocalFallback:false,rabbitConnectionId:connection,rabbitRepositoryId:repository}};
 const verification={version:1,status:'passed',verification_id:randomUUID(),check_run_id:randomUUID(),review_id:randomUUID(),binding_sha256:'c'.repeat(64),candidate_sha256:'d'.repeat(64),repository_id:repository,base_ref:'main',base_sha:base,head_sha:head,validation_policy_sha256:'e'.repeat(64),command_manifest_sha256:'f'.repeat(64),tests:true,diff_reviewed:true,process_exit_confirmed:true};
 const result={status:'pr_opened',base_sha:base,summary:{exit_code:0},pr_number:12,pr_url:url,head_sha:head,verification};
 const adapter=Object.create(FeedbackMainAdapter.prototype);
 const run={id,connectionId:connection,phase:'accepted',receipt:{run_id:remote,project_id:project},request:{repository_id:repository,base_ref:'main',objective:adapter.objective(job)},detail:{state:'completed'},events:{has_more:false,items:[{run_id:remote,project_id:project,type:'task.execution.pr_opened',data:{result}}]}};
 const pr={number:12,html_url:url,state:'open',draft:true,merged:false,head:{sha:head,repo:{full_name:repositoryName}},base:{ref:'main',repo:{full_name:repositoryName}}};
 return {job,run,adapter,pr};
}
test('restored report and Rabbit receipt with different remote IDs refuse before any external proof read',async()=>{
 const f=fixture();f.job.remoteRunId=randomUUID();let requests=0;
 const fetcher=async()=>{requests++;throw Error('must not read mismatched PR');};
 assert.equal(feedbackGithubInput(f.job,f.run),undefined);
 assert.equal(await readFeedbackDraftProof(fetcher,f.job,f.run,new AbortController().signal),undefined);
 assert.throws(()=>f.adapter.checkRemoteRecord(f.run,f.job));assert.equal(requests,0);
});
test('a saved remote ID requires a receipt, including during observation after restart',async()=>{
 const f=fixture();delete f.run.receipt;let requests=0;
 assert.throws(()=>f.adapter.checkRemoteRecord(f.run,f.job));
 assert.equal(await readFeedbackDraftProof(async()=>{requests++;throw Error('unexpected');},f.job,f.run,new AbortController().signal),undefined);
 assert.equal(requests,0);
});
for(const historical of [false,true])test(`exact request binding preserves ${historical?'historical missing remote ID':'matching remote ID'} compatibility`,async()=>{
 const f=fixture();if(historical)delete f.job.remoteRunId;let requests=0;
 f.adapter.checkRemoteRecord(f.run,f.job);assert.deepEqual(feedbackGithubInput(f.job,f.run),{prNumber:12,headSha:head,baseRef:'main'});
 const proof=await readFeedbackDraftProof(async(_url,init)=>{requests++;assert.equal(init.method,'GET');return new Response(JSON.stringify(f.pr));},f.job,f.run,new AbortController().signal);
 assert.equal(proof.headSha,head);assert.equal(requests,2);
});
test('matching remote ID does not bypass original request and repository binding',()=>{
 for(const changed of ['objective','repository','connection']){
  const f=fixture();if(changed==='objective')f.run.request.objective='unrelated request';if(changed==='repository')f.run.request.repository_id=randomUUID();if(changed==='connection')f.run.connectionId=randomUUID();
  assert.throws(()=>f.adapter.checkRemoteRecord(f.run,f.job));
 }
});
