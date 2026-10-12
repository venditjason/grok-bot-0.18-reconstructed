import {jsonRequest,record,abort,type FetchPort} from './app-connectors/protocol.js';
import {FEEDBACK_REPOSITORY,type FeedbackDraftProof} from '../shared/feedback.js';
import type {FeedbackRecord} from './feedback-store.js';
import type {RabbitRunRecord} from './rabbit-store.js';
import {feedbackGithubInput} from './feedback-github-proof.js';
const hex=(v:unknown,n:number):v is string=>typeof v==='string'&&new RegExp(`^[a-f0-9]{${n}}$`).test(v);
const id=(v:unknown):v is string=>typeof v==='string'&&/^[a-zA-Z0-9][a-zA-Z0-9_.:/-]{0,199}$/.test(v);
/** Only a completed authenticated Rabbit event can supply native test evidence.
 * A model report or GitHub PR body is never a validation receipt. */
export async function readFeedbackDraftProof(fetcher:FetchPort,job:FeedbackRecord,run:RabbitRunRecord,signal:AbortSignal):Promise<FeedbackDraftProof|undefined>{
 job=structuredClone(job);run=structuredClone(run);
 const input=feedbackGithubInput(job,run);if(!input||!run.receipt||!job.binding)return;
 const results=(run.events?.items??[]).filter(e=>e.run_id===run.receipt!.run_id&&e.project_id===run.receipt!.project_id&&e.type.startsWith('task.execution.')).map(e=>e.data.result).filter(r=>r?.status==='pr_opened');
 if(!results.length)return;
 let accepted:Record<string,unknown>|undefined;
 for(const result of results){
  if(result!.summary.exit_code!==0)return;
  const v=result!.verification;
  if(!v||typeof v!=='object'||Array.isArray(v))return;
  const proof=v as Record<string,unknown>;
  if(proof.version!==1||proof.status!=='passed'||proof.tests!==true||proof.diff_reviewed!==true||proof.process_exit_confirmed!==true||proof.repository_id!==run.request.repository_id||proof.base_ref!==input.baseRef||proof.head_sha!==input.headSha||!hex(proof.base_sha,40)||proof.base_sha!==result!.base_sha)return;
  if(!['binding_sha256','candidate_sha256','validation_policy_sha256','command_manifest_sha256'].every(k=>hex(proof[k],64))||!['verification_id','check_run_id','review_id'].every(k=>id(proof[k])))return;
  if(accepted&&JSON.stringify(accepted)!==JSON.stringify(proof))return;
  accepted=proof;
 }
 if(!accepted)return;
 // This repository is public. Read only its fixed GitHub endpoint; no stored
 // account token, arbitrary host, PR text or URLs from model output are used.
 const url=`https://github.com/${FEEDBACK_REPOSITORY}/pull/${input.prNumber}`;
 const get=()=>jsonRequest(fetcher,'github',`https://api.github.com/repos/${FEEDBACK_REPOSITORY}/pulls/${input.prNumber}`,{method:'GET',headers:{Accept:'application/vnd.github+json','X-GitHub-Api-Version':'2022-11-28'}},signal);
 const valid=(p:Record<string,unknown>)=>{const head=record(p.head),base=record(p.base);return p.number===input.prNumber&&p.html_url===url&&p.state==='open'&&p.draft===true&&p.merged===false&&head.sha===input.headSha&&record(head.repo).full_name===FEEDBACK_REPOSITORY&&record(base.repo).full_name===FEEDBACK_REPOSITORY&&base.ref===input.baseRef;};
 if(!valid(await get()))return;
 if(!valid(await get()))return;abort(signal);
 return {repository:FEEDBACK_REPOSITORY,prUrl:url,headSha:input.headSha,verificationId:accepted.verification_id as string,checksPassed:true,draft:true};
}
