import {feedbackInput,FEEDBACK_REPOSITORY,type FeedbackInput,type FeedbackJob,type FeedbackSnapshot,type FeedbackBinding,type FeedbackAgent,type FeedbackMergeProof} from '../shared/feedback.js';
import {FeedbackStore,type FeedbackRecord,validateFeedbackBinding} from './feedback-store.js';
export type FeedbackProgress={state:'running'|'blocked'|'failed'|'ready_for_validation'|'unknown';message?:string};
export type FeedbackRemote={state:'accepted'|'rejected'|'unknown';recordId:string;runId?:string;message?:string};
export interface FeedbackHostPort {
 binding():FeedbackBinding|undefined;
 discoverBinding?():Promise<FeedbackBinding|undefined>;
 ensureAgent():FeedbackAgent;
 prepareRemote(job:FeedbackRecord):Promise<{ready:boolean;canFallback:boolean;message?:string}>;
 submitRemote(job:FeedbackRecord):Promise<FeedbackRemote>;
 observeRemote(job:FeedbackRecord):Promise<FeedbackProgress>;
 localAvailable(job:FeedbackRecord):boolean;
 dispatchLocal(job:FeedbackRecord):Promise<FeedbackAgent>;
 observeLocal(job:FeedbackRecord):Promise<FeedbackProgress>;
 verifyMerge(job:FeedbackRecord):Promise<FeedbackMergeProof|undefined>;
 assertMutable():void;
 changed(snapshot:FeedbackSnapshot):void;
}
const publicJob=(r:FeedbackRecord):FeedbackJob=>{const {binding:_binding,dispatch:_dispatch,remoteRunId:_run,...job}=r;return {...job,canResume:r.dispatch==='not_started'&&r.status==='blocked'};};
const mergeProof=(p:FeedbackMergeProof)=>p.repository===FEEDBACK_REPOSITORY&&p.merged===true&&p.checksPassed===true&&/^[a-f0-9]{40}$/i.test(p.headSha)&&/^[a-f0-9]{40}$/i.test(p.mergeSha)&&/^https:\/\/github\.com\/venditjason\/grok-bot-0\.18-reconstructed\/pull\/[1-9]\d*$/.test(p.prUrl);
/** Owns durable dispatch boundaries. Polling never repeats a submit or local queue
 * start. Ordinary chat completion is not development validation or merge proof. */
export class FeedbackHost {
 private readonly pending=new Map<string,Promise<void>>();private timer:ReturnType<typeof setInterval>|undefined;private stopped=false;
 constructor(private readonly store:FeedbackStore,private readonly port:FeedbackHostPort){}
 snapshot():FeedbackSnapshot {let configured=false;try{const b=this.port.binding();if(b){validateFeedbackBinding(b);configured=true;}}catch{}
 const jobs=this.store.list().map(publicJob),agentId=jobs.find(j=>j.agentId)?.agentId;return {jobs,configured,...(agentId?{agentId}:{}),...(configured?{}:{configurationMessage:'요청은 보관할 수 있습니다. 실행하려면 벤디트봇 저장소의 Rabbit 프로젝트 연결을 설정하세요.'})};}
 private emit(){try{this.port.changed(this.snapshot());}catch{/* UI observers cannot invalidate a durable receipt. */}}
 private change(id:string,patch:Parameters<FeedbackStore['update']>[2]):FeedbackRecord {const r=this.store.get(id),saved=this.store.update(id,r.revision,patch);this.emit();return saved;}
 submit(value:unknown):FeedbackJob {this.port.assertMutable();const input=feedbackInput(value),old=this.store.list().find(r=>r.id===input.requestId);
 const binding=old?.binding??this.port.binding();const job=this.store.create(input,binding);this.emit();
 if(!old||(old.dispatch==='not_started'&&old.status==='blocked'))void this.launch(job.id,()=>this.dispatch(job.id)).catch(()=>{});return publicJob(job);}
 openAgent():FeedbackAgent {this.port.assertMutable();return this.port.ensureAgent();}
 private launch(id:string,fn:()=>Promise<void>):Promise<void>{const old=this.pending.get(id);if(old)return old;
 const p=Promise.resolve().then(fn).catch(()=>{const r=this.store.get(id);if(r.status!=='merged')this.change(id,{...(r.status==='validating'?{dispatch:'settled' as const}:{}),status:['remote_submitting','local_dispatching'].includes(r.dispatch)?'unknown':'blocked',message:'실행 결과를 확인하지 못했습니다. 기존 요청을 보존했으며 자동 재접수하지 않습니다.'});}).finally(()=>this.pending.delete(id));this.pending.set(id,p);return p;}
 private async dispatch(id:string):Promise<void>{
  this.port.assertMutable();let r=this.store.get(id);if(r.dispatch!=='not_started'||r.status==='merged')return;
  let agent:FeedbackAgent;try{agent=this.port.ensureAgent();}catch{this.change(id,{status:'blocked',message:'요청은 저장했습니다. 리포트 에이전트에서 사용할 AI 연결을 먼저 선택하세요.'});return;}
  r=this.change(id,{...agent,status:'queued',message:'저장된 요청의 실행 준비 상태를 확인합니다.'});
  const binding=r.binding??this.port.binding()??await this.port.discoverBinding?.();this.port.assertMutable();if(!binding){this.change(id,{status:'blocked',message:'요청은 저장했습니다. 벤디트봇 저장소의 Rabbit 프로젝트 연결 설정이 필요합니다.'});return;}
  validateFeedbackBinding(binding);if(!r.binding)r=this.store.bind(id,r.revision,binding);
  if(binding.rabbitConnectionId){
   const readiness=await this.port.prepareRemote(r);this.port.assertMutable();
   if(readiness.ready){r=this.change(id,{route:'rabbit',dispatch:'remote_submitting',status:'queued',message:'Rabbit 접수를 시도합니다. 접수는 완료를 뜻하지 않습니다.'});
    const result=await this.port.submitRemote(r);
    if(result.recordId!==id)throw new Error('remote_record_binding_mismatch');
    if(result.state==='accepted'&&result.runId){this.change(id,{dispatch:'remote_accepted',remoteRunId:result.runId,status:'running',message:'Rabbit 접수증을 저장했습니다. 실제 실행 상태를 조회합니다.'});return;}
    this.change(id,{status:result.state==='unknown'?'unknown':'blocked',message:result.state==='unknown'?'Rabbit 접수 결과가 불확실합니다. 같은 작업을 로컬에서 중복 실행하지 않습니다.':'Rabbit에서 접수하지 못했습니다. 서버 준비 상태 또는 승인 요청을 확인하세요.'});return;
   }
   if(!readiness.canFallback||!binding.allowLocalFallback){this.change(id,{status:'blocked',message:readiness.message??'Rabbit 실행 준비가 완료되지 않았습니다. 요청은 보존했습니다.'});return;}
  }
  if(!binding.allowLocalFallback||!this.port.localAvailable(r)){this.change(id,{status:'blocked',message:'요청은 저장했습니다. 테스트·Git·PR 병합 권한을 갖춘 개발 실행기가 준비되지 않았습니다. 일반 채팅 응답을 개발 완료로 처리하지 않습니다.'});return;}
  this.port.assertMutable();r=this.change(id,{route:'local',dispatch:'local_dispatching',status:'queued',message:'검증된 로컬 개발 실행기에 예약합니다.'});
  const local=await this.port.dispatchLocal(r);this.change(id,{...local,dispatch:'local_started',status:'running',message:'로컬 개발 작업이 접수되었습니다. 검증 및 병합 증빙을 기다립니다.'});
 }
 async refresh(id:string):Promise<FeedbackJob>{this.store.get(id);await this.launch(id,()=>this.observe(id));return publicJob(this.store.get(id));}
 private async observe(id:string):Promise<void>{this.port.assertMutable();const r=this.store.get(id);
  if(r.status==='merged'||r.dispatch==='not_started')return;
  const progress:FeedbackProgress=await (r.route==='rabbit'?this.port.observeRemote(r):r.route==='local'?this.port.observeLocal(r):Promise.resolve({state:'unknown' as const}));
  if(progress.state==='ready_for_validation'){
   let current=this.change(id,{status:'validating',message:'실행 결과는 도착했습니다. 실제 테스트 결과와 동일 PR의 병합 증빙을 확인합니다.'});
   const proof=await this.port.verifyMerge(current);if(!proof){this.change(id,{status:'blocked',dispatch:'settled',message:'실행 결과만 확인했습니다. 테스트 성공과 PR 병합을 검증할 실행기/권한이 없어 완료 처리하지 않았습니다.'});return;}
   if(!mergeProof(proof))throw new Error('invalid_verified_merge_proof');
   this.change(id,{status:'merged',dispatch:'settled',prUrl:proof.prUrl,mergeSha:proof.mergeSha,message:'테스트와 해당 PR의 실제 병합 증빙을 확인했습니다.'});return;
  }
  this.change(id,{status:progress.state,...(progress.message?{message:progress.message.slice(0,2000)}:{}),...(progress.state==='failed'?{dispatch:'settled' as const}:{})});
 }
 sync():void{this.emit();}
 start():void{if(this.timer)return;this.stopped=false;const tick=()=>{if(this.stopped)return;this.emit();for(const r of this.store.list()){if(r.dispatch==='not_started'&&r.status==='queued'){if(this.pending.size<4)void this.launch(r.id,()=>this.dispatch(r.id)).catch(()=>{});continue;}if(['remote_accepted','local_started','remote_submitting','local_dispatching'].includes(r.dispatch)&&!['merged','failed'].includes(r.status))void this.refresh(r.id).catch(()=>{});}};tick();this.timer=setInterval(tick,15000);this.timer.unref?.();}
 stop():void{this.stopped=true;if(this.timer)clearInterval(this.timer);this.timer=undefined;}
 isBusy():boolean{return this.pending.size>0;}
}
