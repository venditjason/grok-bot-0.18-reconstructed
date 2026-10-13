import {createHash} from 'node:crypto';
import {REQUIRED_POLICY} from '../shared/required-delegation-policy.js';
import {normalizeRabbitRunInput, rabbitEventCursorSequence, type RabbitRunDetail, type RabbitEventPage, type RabbitRunEvent, type RabbitExecutionManual, type RabbitPublishedVerification, type RabbitRunInput} from '../shared/rabbit-project-api.js';
import {delegationContract, type DelegationContract, type RabbitAcceptance} from './delegation-evidence.js';
import type {ChatSession} from './local-store.js';
import type {RabbitRunRecord, RabbitRunSource} from './rabbit-store.js';
export const delegationDigest=(value:unknown)=>createHash('sha256').update(JSON.stringify(value)).digest('hex');
export type PublishedCandidateProof={scope:'published_candidate_verified';sessionId:string;messageId:string;callId:string;sha256:string;recordId:string;runId:string;projectId:string;runRevision:number;requestSha256:string;contractSha256:string;policySha256:string;executionManual:RabbitExecutionManual;tasks:{taskId:string;eventId:string;prUrl:string;verification:RabbitPublishedVerification}[]};
/** One durable request identity per child contract, independent of model call IDs. */
export function delegatedRabbitIntent(contract:DelegationContract, source:RabbitRunSource, connectionId:string, input:RabbitRunInput){
 const c=delegationContract(contract),a=c.acceptance;
 if(a.kind!=='rabbit_verified_pr'||connectionId!==a.connectionId||JSON.stringify(normalizeRabbitRunInput(input))!==JSON.stringify(a.input)||!source.teamRunId||!source.agentId)throw Error('위임에 고정된 Rabbit 프로젝트·원본 요청과 다릅니다.');
 const contractSha256=delegationDigest(c),hex=createHash('sha256').update(`venditbot-delegated-rabbit-v1\0${source.sessionId}`).digest('hex');
 const id=`${hex.slice(0,8)}-${hex.slice(8,12)}-4${hex.slice(13,16)}-a${hex.slice(17,20)}-${hex.slice(20,32)}`;
 return {id,source:{...source,delegation:{contractSha256,policySha256:REQUIRED_POLICY.sha256}}};
}
export function ownedDelegatedRecord(records:RabbitRunRecord[], session:ChatSession, contract:DelegationContract){
 const c=delegationContract(contract),a=c.acceptance;
 if(a.kind!=='rabbit_verified_pr')throw Error('Rabbit 수용 계약이 아닙니다.');
 const matches=records.filter(r=>r.source?.sessionId===session.id);
 if(matches.length!==1)throw Error('이 자식의 유일한 저장된 원격 요청을 확인할 수 없습니다. 새 요청을 만들지 마세요.');
 const record=matches[0]!,expected=delegatedRabbitIntent(c,{sessionId:session.id,...(session.agentId?{agentId:session.agentId}:{}),...(session.teamRunId?{teamRunId:session.teamRunId}:{})},a.connectionId,a.input);
 if(record.id!==expected.id||JSON.stringify(record.source)!==JSON.stringify(expected.source)||record.connectionId!==a.connectionId||JSON.stringify(record.request)!==JSON.stringify(a.input))throw Error('자식·팀·요청·정책 바인딩이 저장된 원격 요청과 다릅니다.');
 if(record.phase!=='accepted'||!record.receipt||record.unresolvedSubmission)throw Error('원격 접수 결과가 미확인입니다. 기존 ID를 보존하며 자동 재접수하지 않습니다.');
 const answer=session.messages.at(-1);
 if(answer?.role!=='assistant'||answer.status!=='completed'||answer.requiredPolicy?.sha256!==REQUIRED_POLICY.sha256)throw Error('자식의 정책·응답 기록을 확인할 수 없습니다.');
 // Proves the durable request originated in this child; model output is never read.
 const call=answer.tools?.find(t=>t.name==='start_project_run'&&t.input?.connectionId===a.connectionId);
 if(!call||call.status!=='completed')throw Error('동일 자식의 실제 원격 접수 도구 기록이 없습니다.');
 if(answer.tools?.some(t=>!['list_project_connections','list_project_repositories','start_project_run','get_project_run','read_file','list_directory','search_files','send_team_message','read_team_messages','list_team_members','read_team_task'].includes(t.name)||t.status!=='completed'))throw Error('원격 개발 계약 밖의 행동 또는 미확인 도구 실패가 있습니다.');
 return {record,acceptance:a,answer,call};
}
const stopped=(signal:AbortSignal)=>{if(signal.aborted)throw new DOMException('Rabbit 수용 확인이 중단되었습니다. 원격 작업은 취소되지 않습니다.','AbortError');};
export type RabbitEvidenceReads={detail():Promise<RabbitRunDetail>;events(cursor?:string):Promise<RabbitEventPage>;pin(detail:RabbitRunDetail):void;current():void};
/** Read-only, complete bounded history at one revision. No POST or model-provided proof. */
export async function verifyRabbitPublication(session:ChatSession, contract:DelegationContract, records:RabbitRunRecord[], reads:RabbitEvidenceReads, signal:AbortSignal):Promise<PublishedCandidateProof>{
 const {record,acceptance:a,answer,call}=ownedDelegatedRecord(records,session,contract), receipt=record.receipt!;
 stopped(signal);reads.current();const before=await reads.detail();stopped(signal);reads.current();
 if(before.run_id!==receipt.run_id||before.project_id!==receipt.project_id||before.project_id!==record.connectionSnapshot.projectId||before.objective!==a.input.objective||before.environment!=='development'||before.max_parallel_tasks!==a.input.constraints.max_parallel_tasks||before.timeout_seconds!==a.input.constraints.timeout_seconds)throw Error('동일 요청의 원격 완료 상태가 아직 확인되지 않았습니다. 접수·대기·실패는 완료 증거가 아닙니다.');
 const manual=before.execution_manual;
 if(!manual||manual.required.id!=='delegation-loop-required'||manual.required.version!==1||manual.selected?.id!==a.input.playbook_template_id||record.manualPin&&JSON.stringify(record.manualPin)!==JSON.stringify(manual))throw Error('서버 필수·선택 실행 매뉴얼 pin이 요청 또는 최초 관측과 다릅니다.');
 reads.pin(before); // Persist the first manual even while the execution is still pending.
 if(before.state!=='completed')throw Error('원격 실행이 아직 완료되지 않았거나 실패·취소되었습니다. 기존 자식 ID로만 다시 조회하세요.');
 const items:RabbitRunEvent[]=[],seen=new Set<string>();let cursor:string|undefined,complete=false;
 for(let pages=0;pages<10;pages++){
  stopped(signal);reads.current();const page=await reads.events(cursor);stopped(signal);reads.current();
  if(page.run_revision!==before.run_revision)throw Error('이벤트 조회 중 Rabbit revision이 바뀌었습니다. 새 조회가 필요합니다.');
  for(const event of page.items){if(event.run_id!==receipt.run_id||event.project_id!==receipt.project_id||seen.has(event.id)||event.sequence<=(items.at(-1)?.sequence??0))throw Error('Rabbit 이벤트 전체 범위·순서가 일치하지 않습니다.');seen.add(event.id);items.push(event);}
  if(cursor===page.next_cursor&&page.has_more||!page.items.length&&page.has_more)throw Error('Rabbit 이벤트 페이지가 진행되지 않습니다.');
  if(rabbitEventCursorSequence(page.next_cursor,receipt.run_id)!==(items.at(-1)?.sequence??0))throw Error('Rabbit 페이지 cursor가 마지막 이벤트와 다릅니다.');
  cursor=page.next_cursor;if(!page.has_more){complete=true;break;}
 }
 if(!complete)throw Error('Rabbit 전체 이벤트 조회 한도에 도달했습니다. 일부 이력으로 개발 완료를 승인하지 않습니다.');
 const after=await reads.detail();stopped(signal);reads.current();
 if(JSON.stringify(before)!==JSON.stringify(after)||cursor!==after.event_cursor||after.last_event_id!==items.at(-1)?.id||rabbitEventCursorSequence(cursor,receipt.run_id)!==(items.at(-1)?.sequence??0))throw Error('Rabbit detail/events/detail revision 또는 최종 cursor가 일치하지 않습니다.');
 // Each execution task must have an authoritative, successful publication result.
 // Intermediate events (started etc.) are not success and cannot replace the final proof.
 const taskEvents=items.filter(e=>e.type.startsWith('task.execution.'));
 const taskIds=new Set(taskEvents.map(e=>e.data.task_id));
 if(!taskIds.size||taskIds.size>100||taskIds.has(null)||taskIds.has(undefined))throw Error('검증 대상 task 식별자를 확인할 수 없습니다.');
 const tasks:PublishedCandidateProof['tasks']=[];
 for(const taskId of taskIds){
  const events=taskEvents.filter(e=>e.data.task_id===taskId),resultEvent=events.at(-1)!,r=resultEvent.data.result,v=r?.verification;
  if(!['task.execution.completed','task.execution.pr_opened'].includes(resultEvent.type)||!r||r.status!=='pr_opened'||r.summary.exit_code!==0||!r.pr_url||!v||v.version!==1||v.status!=='passed'||v.tests!==true||v.diff_reviewed!==true||v.process_exit_confirmed!==true||v.repository_id!==a.input.repository_id||v.base_ref!==a.input.base_ref||v.base_sha!==r.base_sha||v.head_sha!==r.head_sha)throw Error('해당 task의 권위 checker/reviewer·정확한 PR head 게시 증거가 없습니다.');
  tasks.push({taskId:taskId!,eventId:resultEvent.id,prUrl:r.pr_url,verification:structuredClone(v)});
 }
 const binding={scope:'published_candidate_verified' as const,sessionId:session.id,messageId:answer.id,callId:call.callId,recordId:record.id,runId:receipt.run_id,projectId:receipt.project_id,runRevision:after.run_revision,requestSha256:delegationDigest({request:record.request,idempotencyKey:record.idempotencyKey}),contractSha256:delegationDigest(delegationContract(contract)),policySha256:REQUIRED_POLICY.sha256,executionManual:structuredClone(manual),tasks};
 return {...binding,sha256:delegationDigest(binding)};
}
