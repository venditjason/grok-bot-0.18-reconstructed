import {execFileSync} from 'node:child_process';
import {realpathSync} from 'node:fs';
import {join} from 'node:path';
import {atomicWriteJson,connectionRoutes,type LocalSessionStore,type ConnectionRoute} from './local-store.js';
import type {AgentStore} from './agent-store.js';
import type {RabbitHost} from './rabbit-host.js';
import type {RabbitStore,RabbitRunRecord} from './rabbit-store.js';
import {FeedbackStore,readFeedbackPrivate,validateFeedbackBinding,type FeedbackRecord} from './feedback-store.js';
import {FeedbackHost,type FeedbackProgress} from './feedback-host.js';
import {FEEDBACK_REPOSITORY,type FeedbackBinding,type FeedbackAgent,type FeedbackMergeProof,type FeedbackSnapshot} from '../shared/feedback.js';
const instructions='[venditbot-system-report-v1]\n당신은 고정 리포트 에이전트입니다. 사용자의 버그와 기능 요청을 정리하고 저장된 실행 상태를 정확히 설명하세요. 대상 저장소는 venditjason/grok-bot-0.18-reconstructed입니다. 리포트 저장, 원격 접수, 모델 답변은 개발 완료나 병합이 아닙니다. 테스트·실제 PR 병합 증빙을 확인하기 전에는 완료라고 말하지 마세요. 원격 접수 결과가 불확실하면 로컬 중복 실행을 금지합니다. 자격 증명이나 Keychain 값을 요구·출력하지 마세요.';
export interface FeedbackDevelopmentExecutor {
 /** Must prove scoped native code/test/Git/PR capability; normal WorkspaceTools are insufficient. */
 available(job:FeedbackRecord):boolean;
 dispatch(job:FeedbackRecord):Promise<FeedbackAgent>;
 observe(job:FeedbackRecord):Promise<FeedbackProgress>;
 verifyMerge(job:FeedbackRecord):Promise<FeedbackMergeProof|undefined>;
}
export type FeedbackMainOptions={root:string;agents:AgentStore;sessions:LocalSessionStore;rabbit:RabbitHost;rabbitStore:RabbitStore;defaultRoute():ConnectionRoute|undefined;assertMutable():void;changed(snapshot:FeedbackSnapshot):void;developmentExecutor?:FeedbackDevelopmentExecutor;isSessionBusy?:(id:string)=>boolean;verifyRabbitMerge?:(job:FeedbackRecord,run:RabbitRunRecord)=>Promise<FeedbackMergeProof|undefined>;inspectWorkspace?:(binding:FeedbackBinding)=>void};
type Configuration={version:1;binding?:FeedbackBinding;agentId?:string;sessionId?:string};
export function inspectFeedbackWorkspace(binding:FeedbackBinding):void {
 validateFeedbackBinding(binding);
 if(binding.workspacePath===undefined)return; // Strict remote-only binding was validated above.
 const root=realpathSync(binding.workspacePath);
 if(root!==binding.workspacePath)throw new Error('리포트 작업 폴더는 실제 Git 저장소 경로여야 합니다.');
 const command=(args:string[])=>execFileSync('/usr/bin/git',['-C',root,...args],{encoding:'utf8',timeout:5000,maxBuffer:16384,stdio:['ignore','pipe','pipe']}).trim();
 if(realpathSync(command(['rev-parse','--show-toplevel']))!==root)throw new Error('리포트 작업 폴더는 저장소 최상위여야 합니다.');
 const origin=command(['remote','get-url','origin']);
 if(!['https://github.com/'+FEEDBACK_REPOSITORY,'https://github.com/'+FEEDBACK_REPOSITORY+'.git','git@github.com:'+FEEDBACK_REPOSITORY+'.git','git@github.com:'+FEEDBACK_REPOSITORY,'ssh://git@github.com/'+FEEDBACK_REPOSITORY+'.git'].includes(origin))throw new Error('리포트 Git origin이 벤디트봇 저장소와 다릅니다.');
 command(['check-ref-format','--branch',binding.baseBranch]);
}
export class FeedbackMainAdapter {
 readonly store:FeedbackStore;readonly host:FeedbackHost;
 private readonly configurationFile:string;private configurationRaw:string|undefined;private configuration:Configuration={version:1};
 constructor(private readonly options:FeedbackMainOptions){
  this.store=new FeedbackStore(options.root);this.configurationFile=join(options.root,'feedback-configuration.json');this.configurationRaw=readFeedbackPrivate(this.configurationFile);
  if(this.configurationRaw!==undefined){const x=JSON.parse(this.configurationRaw) as Configuration;if(x.version!==1||Object.keys(x).some(k=>!['version','binding','agentId','sessionId'].includes(k)))throw new Error('리포트 설정 형식이 손상되었습니다. 원본을 보존했습니다.');if(x.binding)validateFeedbackBinding(x.binding);for(const v of [x.agentId,x.sessionId])if(v!==undefined&&(typeof v!=='string'||!v||v.length>100||/[\u0000-\u001f]/.test(v)))throw new Error('리포트 에이전트 설정을 확인하세요.');this.configuration=x;}
  this.host=new FeedbackHost(this.store,{
   binding:()=>this.configuration.binding?structuredClone(this.configuration.binding):undefined,
   discoverBinding:()=>this.discoverConfiguration(),
   ensureAgent:()=>this.ensureAgent(),
   prepareRemote:job=>this.prepareRemote(job),
   submitRemote:async job=>{
    const b=this.checkedBinding(job);if(!b.rabbitConnectionId||!b.rabbitRepositoryId)throw new Error('Rabbit 설정이 없습니다.');
    const run=await options.rabbit.start(b.rabbitConnectionId,{objective:this.objective(job),repository_id:b.rabbitRepositoryId,base_ref:b.baseBranch,workflow_template:job.kind==='bug'?'bugfix_pr':'feature_pr',acceptance_criteria:['요청에 맞는 코드 또는 문서 변경을 완성한다.','관련 테스트와 타입 검사 결과를 증빙하고 실패를 숨기지 않는다.','지정된 벤디트봇 저장소에 PR을 만들고 실제 병합 여부를 확인한다.'],attachments:[],constraints:{environment:'development',max_parallel_tasks:4,timeout_seconds:3600,api_cost_limit_usd:0}},job.id,{sessionId:job.sessionId!,agentId:job.agentId!});
    return this.remoteReceipt(run,job);
   },
   observeRemote:async job=>{let r:RabbitRunRecord;try{r=options.rabbitStore.getRun(job.id);}catch{return {state:'unknown',message:'기존 Rabbit 접수 기록을 찾지 못했습니다. 자동 재전송하지 않습니다.'};}
    this.checkRemoteRecord(r,job);
    if(r.receipt)r=await options.rabbit.refresh(r.id,undefined,true);
    if(r.unresolvedSubmission||r.phase==='unknown'||r.phase==='submitting')return {state:'unknown',message:'Rabbit 접수 결과가 불확실합니다. 기존 요청을 보존합니다.'};
    if(r.phase==='rejected')return {state:'blocked',message:'Rabbit이 작업을 접수하지 않았습니다. 서버 준비 상태 또는 승인 요청을 확인하세요.'};
    if(!r.receipt)return {state:'unknown'};
    if(r.detail?.state==='completed'&&r.events?.has_more)return {state:'running',message:'Rabbit 실행 결과의 남은 이벤트 페이지를 확인 중입니다. 아직 검증 완료가 아닙니다.'};
    if(r.detail?.state==='completed')return {state:'ready_for_validation'};
    if(r.detail&&['failed','cancelled'].includes(r.detail.state))return {state:'failed',message:'Rabbit 작업이 실패 또는 취소되었습니다. 자동 재실행하지 않습니다.'};
    if(r.detail?.block_reason)return {state:'blocked',message:'Rabbit 작업이 서버 준비 또는 승인 조건을 기다립니다.'};
    return {state:'running',message:'Rabbit 접수증이 있으며 실제 실행 상태를 확인 중입니다.'};
   },
   localAvailable:job=>!!options.developmentExecutor?.available(job),
   dispatchLocal:async job=>{this.checkedBinding(job);if(!options.developmentExecutor)throw new Error('개발 실행기가 없습니다.');return options.developmentExecutor.dispatch(job);},
   observeLocal:job=>options.developmentExecutor?.observe(job)??Promise.resolve({state:'unknown',message:'기존 로컬 실행을 확인할 개발 실행기가 없습니다.'}),
   verifyMerge:async job=>{if(job.route==='rabbit'){const run=options.rabbitStore.getRun(job.id);this.checkRemoteRecord(run,job);return options.verifyRabbitMerge?.(job,run);}return options.developmentExecutor?.verifyMerge(job);},
   assertMutable:()=>options.assertMutable(),
   changed:snapshot=>{this.syncConversation(snapshot);options.changed(snapshot);}
  });
 }
 private inspect(b:FeedbackBinding){(this.options.inspectWorkspace??inspectFeedbackWorkspace)(b);}
 private checkedBinding(job:FeedbackRecord):FeedbackBinding {if(!job.binding)throw new Error('리포트 실행 설정이 없습니다.');this.inspect(job.binding);return job.binding;}
 saveConfiguration(binding:FeedbackBinding):FeedbackSnapshot {this.options.assertMutable();validateFeedbackBinding(binding);this.inspect(binding);
  if(binding.rabbitConnectionId){const c=this.options.rabbitStore.getConnection(binding.rabbitConnectionId);if(!c.enabledForAgents)throw new Error('Rabbit 연결의 에이전트 사용을 허용하세요.');}
  this.save({...this.configuration,binding:structuredClone(binding)});this.options.changed(this.host.snapshot());return this.host.snapshot();}
 /** Runs only as part of an explicit report/configuration request. Reads existing
  * agent/session workspaces and approved Rabbit repository lists; never scans disk. */
 async discoverConfiguration(workspacePath?:string):Promise<FeedbackBinding|undefined> {
  this.options.assertMutable();if(this.configuration.binding)return structuredClone(this.configuration.binding);
  const candidates=workspacePath?[workspacePath]:[...this.options.agents.list(),...this.options.sessions.list()].map(x=>x.workspacePath).filter((x):x is string=>!!x);
  const paths=[...new Set(candidates)].filter(path=>{try{this.inspect({repository:FEEDBACK_REPOSITORY,workspacePath:path,baseBranch:'main',allowLocalFallback:false});return true;}catch{return false;}});
  if(workspacePath&&paths.length!==1)return;
  const connections=this.options.rabbitStore.listConnections().filter(c=>c.enabledForAgents);if(connections.length>4)return;
  const matches:FeedbackBinding[]=[];
  for(const c of connections){let result;try{result=await this.options.rabbit.test(c,undefined,true);}catch{return;}
   this.options.assertMutable();const current=this.options.rabbitStore.getConnection(c.id);if(JSON.stringify(current)!==JSON.stringify(c)||!current.enabledForAgents)return;
   for(const repository of result.repositories){if(repository.status!=='ready'||!['https://github.com/'+FEEDBACK_REPOSITORY,'https://github.com/'+FEEDBACK_REPOSITORY+'.git'].includes(repository.url.replace(/\/$/,'')))continue;
    const binding:FeedbackBinding={repository:FEEDBACK_REPOSITORY,...(paths.length===1?{workspacePath:paths[0]!}:{}),baseBranch:repository.default_branch,allowLocalFallback:false,rabbitConnectionId:c.id,rabbitRepositoryId:repository.id};this.inspect(binding);matches.push(binding);}
  }
  if(matches.length!==1)return;if(this.configuration.binding)return structuredClone(this.configuration.binding);
  this.saveConfiguration(matches[0]!);return structuredClone(matches[0]!);
 }
 private save(value:Configuration){if(readFeedbackPrivate(this.configurationFile)!==this.configurationRaw)throw new Error('리포트 설정이 다른 곳에서 변경되었습니다. 원본을 보존했습니다.');atomicWriteJson(this.configurationFile,value);this.configurationRaw=JSON.stringify(value,null,2);this.configuration=value;}
 ensureAgent():FeedbackAgent {
  this.options.assertMutable();let agent;
  if(this.configuration.agentId){try{agent=this.options.agents.get(this.configuration.agentId);}catch{/* A deleted agent is replaced only through this explicit report action. */}}
  if(!agent){const candidates=this.options.agents.list().filter(a=>a.instructions===instructions);if(candidates.length>1)throw new Error('리포트 에이전트가 중복되었습니다. 설정을 확인하세요.');agent=candidates[0];}
  if(!agent){const route=this.options.defaultRoute();if(!route)throw new Error('리포트 에이전트에서 사용할 AI 연결을 먼저 설정하세요.');
   agent=this.options.agents.save({name:'리포트',instructions,...route,...(this.configuration.binding?.workspacePath?{workspacePath:this.configuration.binding.workspacePath}:{})});}
  const routes=connectionRoutes(agent);let session=this.configuration.sessionId?this.options.sessions.list().find(s=>s.id===this.configuration.sessionId&&s.agentId===agent.id):undefined;
  if(!session)session=this.options.sessions.list().find(s=>s.agentId===agent.id&&s.title==='리포트');
  if(!session){const first=routes[0]!;session=this.options.sessions.create(first.connectionId,first.model,agent.workspacePath,first.effort,{connections:routes,agentId:agent.id,agentName:'리포트',instructions});session.title='리포트';this.options.sessions.save(session);}
  this.save({...this.configuration,agentId:agent.id,sessionId:session.id});return {agentId:agent.id,sessionId:session.id};
 }
 private objective(job:FeedbackRecord):string{return '[벤디트봇 리포트 '+job.id+'] '+job.title+'\n\n'+job.description+'\n\n대상 저장소: '+FEEDBACK_REPOSITORY+'. 요청 범위 안에서 구현하고 관련 테스트를 실행하세요. 자격 증명과 사용자 파일을 수정하거나 출력하지 마세요. 테스트 증빙 없이 병합 완료를 주장하지 마세요.';}
 /** Observation compatibility only: 0.4.2 appended this sentence to every request.
  * Keep exact historical receipts readable, but never add it to a new submission. */
 private legacyObjective(job:FeedbackRecord):string{return '[벤디트봇 리포트 '+job.id+'] '+job.title+'\n\n'+job.description+'\n\n대상 저장소: '+FEEDBACK_REPOSITORY+'. 요청 범위 안에서 구현하고 관련 테스트를 실행하세요. iOS 구현과 설치·이전 안내는 apps/ios/docs/development-instructions.md를 기준으로 apps/ios 안에서 작성하세요. 자격 증명과 사용자 파일을 수정하거나 출력하지 마세요. 테스트 증빙 없이 병합 완료를 주장하지 마세요.';}
 private async prepareRemote(job:FeedbackRecord){const b=this.checkedBinding(job);if(!b.rabbitConnectionId)return {ready:false,canFallback:true};
  const c=this.options.rabbitStore.getConnection(b.rabbitConnectionId);if(!c.enabledForAgents)return {ready:false,canFallback:false,message:'Rabbit 연결이 에이전트 실행을 허용하지 않습니다.'};
  try{const check=await this.options.rabbit.test(c,undefined,true),repository=check.repositories.find(r=>r.id===b.rabbitRepositoryId);
   if(!repository||repository.status!=='ready'||!['https://github.com/'+FEEDBACK_REPOSITORY,'https://github.com/'+FEEDBACK_REPOSITORY+'.git'].includes(repository.url.replace(/\/$/,'')))return {ready:false,canFallback:false,message:'Rabbit에 등록된 정확한 벤디트봇 저장소가 준비되지 않았습니다.'};
   return {ready:true,canFallback:false};
  }catch{return {ready:false,canFallback:false,message:'Rabbit 저장소 조회 또는 승인을 확인하지 못했습니다. 아직 작업을 제출하지 않았습니다.'};}
 }
 private checkRemoteRecord(run:RabbitRunRecord,job:FeedbackRecord){const b=job.binding;if(!b||run.id!==job.id||run.connectionId!==b.rabbitConnectionId||run.request.repository_id!==b.rabbitRepositoryId||run.request.base_ref!==b.baseBranch||![this.objective(job),this.legacyObjective(job)].includes(run.request.objective))throw new Error('리포트와 Rabbit 기록의 저장소 또는 요청이 다릅니다.');}
 private remoteReceipt(run:RabbitRunRecord,job:FeedbackRecord){this.checkRemoteRecord(run,job);return {recordId:run.id,state:run.receipt?'accepted' as const:run.unresolvedSubmission||['unknown','submitting'].includes(run.phase)?'unknown' as const:'rejected' as const,...(run.receipt?{runId:run.receipt.run_id}:{})};}
 private syncConversation(snapshot:FeedbackSnapshot){for(const job of snapshot.jobs){if(!job.sessionId||this.options.isSessionBusy?.(job.sessionId))continue;try{const s=this.options.sessions.get(job.sessionId);if(s.agentId!==job.agentId)continue;
  if(!s.messages.some(m=>m.id===job.id))s.messages.push({id:job.id,role:'user',text:job.title+'\n\n'+job.description,createdAt:job.createdAt,status:'completed'});
  const id=job.id+'-status',text='리포트 상태: '+job.status+'\n'+(job.message??'')+(job.prUrl?'\n'+job.prUrl:''),prior=s.messages.find(m=>m.id===id);
  if(prior?.text===text)continue;if(prior)prior.text=text;else s.messages.push({id,role:'assistant',text,createdAt:job.updatedAt,status:'completed'});
  this.options.sessions.save(s);
 }catch{/* Report outbox is authoritative if the optional conversation cannot be updated. */}}}
}
