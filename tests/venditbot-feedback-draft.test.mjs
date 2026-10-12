import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync,rmSync} from 'node:fs';
import {randomUUID} from 'node:crypto';
import {build} from 'esbuild';
const built=await build({stdin:{contents:"export * from './source/venditbot/feedback-draft-proof.ts';export * from './source/venditbot/feedback-store.ts';export * from './source/venditbot/feedback-host.ts';",resolveDir:process.cwd()},bundle:true,platform:'node',format:'esm',write:false});
const {readFeedbackDraftProof,FeedbackStore,FeedbackHost}=await import('data:text/javascript;base64,'+Buffer.from(built.outputFiles[0].text).toString('base64'));
const repo='venditjason/grok-bot-0.18-reconstructed',head='a'.repeat(40),base='b'.repeat(40),prUrl=`https://github.com/${repo}/pull/12`;
function fixture(){const id=randomUUID(),project=randomUUID(),remote=randomUUID(),repository=randomUUID(),connection=randomUUID();const binding={repository:repo,baseBranch:'main',allowLocalFallback:false,rabbitConnectionId:connection,rabbitRepositoryId:repository};
 const job={id,kind:'bug',title:'Fix',description:'Fix with tests',status:'running',dispatch:'remote_accepted',route:'rabbit',binding,remoteRunId:remote};
 const verification={version:1,status:'passed',verification_id:randomUUID(),check_run_id:randomUUID(),review_id:randomUUID(),binding_sha256:'c'.repeat(64),candidate_sha256:'d'.repeat(64),repository_id:repository,base_ref:'main',base_sha:base,head_sha:head,validation_policy_sha256:'e'.repeat(64),command_manifest_sha256:'f'.repeat(64),tests:true,diff_reviewed:true,process_exit_confirmed:true};
 const result={status:'pr_opened',base_sha:base,summary:{exit_code:0},pr_number:12,pr_url:prUrl,head_sha:head,verification};
 const run={id,connectionId:connection,receipt:{run_id:remote,project_id:project},request:{repository_id:repository,base_ref:'main'},detail:{state:'completed'},events:{has_more:false,items:[{run_id:remote,project_id:project,type:'task.execution.completed',data:{result}}]}};
 const pr={number:12,html_url:prUrl,state:'open',draft:true,merged:false,head:{sha:head,repo:{full_name:repo}},base:{ref:'main',repo:{full_name:repo}}};return {job,run,verification,result,pr};}
for(const mutation of ['none','missing','self-report','wrong-repo','wrong-head','unexited','tests-failed','review-missing','wrong-project','unread-pages','contradictory-receipts'])test(`draft proof requires trusted complete exact Rabbit receipt: ${mutation}`,async()=>{
 const f=fixture();let calls=0;
 if(mutation==='missing')delete f.result.verification;
 if(mutation==='self-report'){f.result.summary={report:{verification:f.verification}};delete f.result.verification;}
 if(mutation==='wrong-repo')f.verification.repository_id=randomUUID();if(mutation==='wrong-head')f.verification.head_sha=base;
 if(mutation==='unexited')f.verification.process_exit_confirmed=false;if(mutation==='tests-failed')f.verification.tests=false;if(mutation==='review-missing')delete f.verification.review_id;
 if(mutation==='wrong-project')f.run.events.items[0].project_id=randomUUID();if(mutation==='unread-pages')f.run.events.has_more=true;
 if(mutation==='contradictory-receipts'){const event=structuredClone(f.run.events.items[0]);event.data.result.verification.check_run_id=randomUUID();f.run.events.items.push(event);}
 const fetcher=async(url,init)=>{calls++;assert.equal(url,`https://api.github.com/repos/${repo}/pulls/12`);assert.equal(init.method,'GET');assert.equal(init.redirect,'manual');assert.equal(new Headers(init.headers).has('Authorization'),false);return new Response(JSON.stringify(f.pr));};
 const proof=await readFeedbackDraftProof(fetcher,f.job,f.run,new AbortController().signal);assert.equal(!!proof,mutation==='none');assert.equal(calls,mutation==='none'?2:0);if(proof){assert.equal(proof.draft,true);assert.equal(proof.headSha,head);assert.equal(proof.verificationId,f.verification.verification_id);assert.equal(proof.merged,undefined);}
});
for(const mutation of ['head-moved','wrong-base','closed','non-draft','other-repository','redirect'])test(`current GitHub PR must remain exact open draft: ${mutation}`,async()=>{
 const f=fixture();let calls=0;const fetcher=async()=>{calls++;const p=structuredClone(f.pr);if(mutation==='head-moved'&&calls===2)p.head.sha=base;if(mutation==='wrong-base')p.base.ref='other';if(mutation==='closed')p.state='closed';if(mutation==='non-draft')p.draft=false;if(mutation==='other-repository')p.head.repo.full_name='other/repo';if(mutation==='redirect')return new Response('',{status:302,headers:{location:'https://other.test'}});return new Response(JSON.stringify(p));};
 if(mutation==='redirect')await assert.rejects(readFeedbackDraftProof(fetcher,f.job,f.run,new AbortController().signal));else assert.equal(await readFeedbackDraftProof(fetcher,f.job,f.run,new AbortController().signal),undefined);assert.ok(calls<=2);
});
test('verified draft survives restart without resubmission or false merge, then exact merge can be recorded',async t=>{
 const f=fixture(),root=mkdtempSync('/private/tmp/vendit-feedback-draft-');t.after(()=>rmSync(root,{recursive:true,force:true}));let posts=0,draft=true;
 const port={binding:()=>f.job.binding,ensureAgent:()=>({agentId:'agent',sessionId:'session'}),prepareRemote:async()=>({ready:true,canFallback:false}),submitRemote:async j=>{posts++;return {state:'accepted',recordId:j.id,runId:f.job.remoteRunId};},observeRemote:async()=>({state:'ready_for_validation'}),localAvailable:()=>false,dispatchLocal:async()=>{throw Error('unexpected');},observeLocal:async()=>({state:'unknown'}),verifyDraft:async()=>draft?{repository:repo,prUrl,headSha:head,verificationId:f.verification.verification_id,checksPassed:true,draft:true}:undefined,verifyMerge:async()=>draft?undefined:{repository:repo,prUrl,headSha:head,mergeSha:base,checksPassed:true,merged:true},assertMutable(){},changed(){}};
 const input={requestId:f.job.id,kind:'bug',title:'Fix',description:'Fix with tests'},store=new FeedbackStore(root),host=new FeedbackHost(store,port);host.submit(input);await host.refresh(input.requestId);await host.refresh(input.requestId);assert.equal(store.get(input.requestId).status,'ready_for_review');assert.equal(store.get(input.requestId).mergeSha,undefined);assert.equal(store.get(input.requestId).dispatch,'settled');
 const recovered=new FeedbackStore(root),after=new FeedbackHost(recovered,port);after.submit(input);assert.equal(posts,1);assert.equal(recovered.get(input.requestId).status,'ready_for_review');draft=false;await after.refresh(input.requestId);assert.equal(recovered.get(input.requestId).status,'merged');assert.equal(posts,1);
});
