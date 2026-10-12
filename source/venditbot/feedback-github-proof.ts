import {jsonRequest,record,fail,abort,type FetchPort} from './app-connectors/protocol.js';
import {FEEDBACK_REPOSITORY,type FeedbackMergeProof} from '../shared/feedback.js';
import type {FeedbackRecord} from './feedback-store.js';
import type {RabbitRunRecord} from './rabbit-store.js';
export type FeedbackGithubInput={prNumber:number;headSha:string;baseRef:string};
const sha=(v:unknown):v is string=>typeof v==='string'&&/^[a-f0-9]{40}$/.test(v);
/** Consumes only the exact PR/head emitted by this accepted Rabbit request. */
export function feedbackGithubInput(job:FeedbackRecord,run:RabbitRunRecord):FeedbackGithubInput|undefined {
 if(job.route!=='rabbit'||!job.binding||job.id!==run.id||!run.receipt||(job.remoteRunId!==undefined&&job.remoteRunId!==run.receipt.run_id)||run.detail?.state!=='completed'||run.request.repository_id!==job.binding.rabbitRepositoryId||run.connectionId!==job.binding.rabbitConnectionId||run.request.base_ref!==job.binding.baseBranch||run.events?.has_more)return;
 const results=(run.events?.items??[]).filter(e=>e.run_id===run.receipt!.run_id&&e.project_id===run.receipt!.project_id&&e.type.startsWith('task.execution.')).map(e=>e.data.result).filter(r=>r?.status==='pr_opened');
 const unique=new Map(results.map(r=>[JSON.stringify([r!.pr_number,r!.head_sha,r!.pr_url]),r!]));if(unique.size!==1)return;const result=[...unique.values()][0]!;
 if(!Number.isSafeInteger(result.pr_number)||!result.pr_number||result.pr_number<1||!sha(result.head_sha)||result.pr_url!==`https://github.com/${FEEDBACK_REPOSITORY}/pull/${result.pr_number}`)return;
 return {prNumber:result.pr_number,headSha:result.head_sha,baseRef:job.binding.baseBranch};
}
/** Four bounded read-only requests, fixed repository, no external URLs or model
 * proof accepted. Missing/failed checks remain unverified; never merges a PR. */
export async function readFeedbackGithubProof(fetcher:FetchPort,token:string,args:Record<string,unknown>,signal:AbortSignal):Promise<{proof:FeedbackMergeProof|null}> {
 if(Object.keys(args).some(k=>!['prNumber','headSha','baseRef'].includes(k))||!Number.isSafeInteger(args.prNumber)||Number(args.prNumber)<1||!sha(args.headSha)||typeof args.baseRef!=='string'||!args.baseRef||args.baseRef.length>200||!/^[A-Za-z0-9_./-]+$/.test(args.baseRef)||args.baseRef.startsWith('-')||args.baseRef.includes('..'))fail('리포트 PR 검증 입력을 확인하세요.');
 const root=`https://api.github.com/repos/${FEEDBACK_REPOSITORY}`,url=`https://github.com/${FEEDBACK_REPOSITORY}/pull/${args.prNumber}`;
 const get=(path:string)=>jsonRequest(fetcher,'github',root+path,{method:'GET',headers:{Authorization:`Bearer ${token}`,Accept:'application/vnd.github+json','X-GitHub-Api-Version':'2022-11-28'}},signal);
 const validate=(p:Record<string,unknown>)=>{const head=record(p.head),base=record(p.base);return p.number===args.prNumber&&p.html_url===url&&p.state==='closed'&&p.merged===true&&p.draft===false&&sha(p.merge_commit_sha)&&head.sha===args.headSha&&record(head.repo).full_name===FEEDBACK_REPOSITORY&&record(base.repo).full_name===FEEDBACK_REPOSITORY&&base.ref===args.baseRef&&typeof p.merged_at==='string'&&Number.isFinite(Date.parse(p.merged_at));};
 const first=await get(`/pulls/${args.prNumber}`);if(!validate(first))return {proof:null};
 const checks=await get(`/commits/${args.headSha}/check-runs?per_page=100&filter=latest`);
 if(!Array.isArray(checks.check_runs)||checks.total_count!==checks.check_runs.length||checks.check_runs.length<1||checks.check_runs.length>100)return {proof:null};
 const rows=checks.check_runs.map(record);
 // The repository's existing check job runs npm run check, which includes its tests.
 if(!rows.some(c=>c.name==='check'&&record(c.app).slug==='github-actions')||rows.some(c=>c.head_sha!==args.headSha||c.status!=='completed'||c.conclusion!=='success'||typeof c.completed_at!=='string'||!Number.isFinite(Date.parse(c.completed_at))||Date.parse(c.completed_at)>Date.parse(first.merged_at as string)))return {proof:null};
 const status=await get(`/commits/${args.headSha}/status?per_page=100`);
 if(status.sha!==args.headSha||!Array.isArray(status.statuses)||status.total_count!==status.statuses.length||status.statuses.length>100||status.statuses.some(s=>{const x=record(s);return x.state!=='success'||typeof x.updated_at!=='string'||!Number.isFinite(Date.parse(x.updated_at))||Date.parse(x.updated_at)>Date.parse(first.merged_at as string);})||(status.statuses.length>0&&status.state!=='success'))return {proof:null};
 const final=await get(`/pulls/${args.prNumber}`);abort(signal);if(!validate(final)||first.merge_commit_sha!==final.merge_commit_sha||first.merged_at!==final.merged_at)return {proof:null};
 return {proof:{repository:FEEDBACK_REPOSITORY,prUrl:url,headSha:args.headSha as string,mergeSha:final.merge_commit_sha as string,checksPassed:true,merged:true}};
}
/** Unwraps only the fixed host operation output, never arbitrary model content. */
export function feedbackGithubProofResponse(value:unknown):FeedbackMergeProof|undefined {const outer=record(value);if(outer.app!=='github'||outer.operation!=='read_feedback_pr_verification'||outer.truncated!==false||typeof outer.text!=='string')return;const result=record(JSON.parse(outer.text));return result.proof===null?undefined:record(result.proof) as unknown as FeedbackMergeProof;}
