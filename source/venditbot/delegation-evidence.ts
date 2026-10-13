import {createHash} from 'node:crypto';
import {REQUIRED_POLICY, type ActionReceipt} from '../shared/required-delegation-policy.js';
import {normalizeRabbitRunInput, rabbitUuid, type RabbitRunInput} from '../shared/rabbit-project-api.js';
import type {ToolRecord, ChatSession} from './local-store.js';
export type RabbitAcceptance = {kind:'rabbit_verified_pr';connectionId:string;input:RabbitRunInput};
export type DelegationContract = {inputReferences: string[]; expectedArtifact: string; ownedFiles: string[]; acceptance: {kind: 'file_content_sha256' | 'file_write_sha256'; path: string; sha256: string} | RabbitAcceptance};
const path = (v: unknown): v is string => typeof v==='string' && v.length>0 && v.length<=1000 && !v.includes('\0') && !v.startsWith('/') && !v.includes('\\') && v.split('/').every(x=>x && x!=='.' && x!=='..');
export function delegationContract(value: unknown): DelegationContract {
 if(!value||typeof value!=='object'||Array.isArray(value))throw Error('위임에는 입력·산출물·파일 소유권·수용 증거 계약이 필요합니다.');
 const x=value as DelegationContract, a=x.acceptance;
 if(!Array.isArray(x.inputReferences)||!x.inputReferences.length||x.inputReferences.length>20||x.inputReferences.some(s=>typeof s!=='string'||!s.trim()||s.length>1000)||typeof x.expectedArtifact!=='string'||!x.expectedArtifact.trim()||x.expectedArtifact.length>2000||!Array.isArray(x.ownedFiles)||x.ownedFiles.length>100||!x.ownedFiles.every(path)||new Set(x.ownedFiles.map(s=>s.normalize('NFC').toLowerCase())).size!==x.ownedFiles.length||!a)throw Error('위임의 입력·산출물·파일 소유권 수용 계약을 확인하세요.');
 if(a.kind==='rabbit_verified_pr'){const input=normalizeRabbitRunInput(a.input);if(!input.repository_id||input.workflow_template==='review_only'||x.ownedFiles.length)throw Error('Rabbit 개발 수용에는 명시한 저장소와 개발 PR 템플릿이 필요하며 로컬 파일 소유권은 비워 두세요.');return structuredClone({inputReferences:x.inputReferences,expectedArtifact:x.expectedArtifact,ownedFiles:[],acceptance:{kind:a.kind,connectionId:rabbitUuid(a.connectionId),input}});}
 if(!['file_content_sha256','file_write_sha256'].includes(a.kind)||!path(a.path)||typeof a.sha256!=='string'||!/^[a-f0-9]{64}$/.test(a.sha256)||a.kind==='file_write_sha256'&&!x.ownedFiles.includes(a.path))throw Error('지원되는 위임 수용 증거는 정확한 파일 내용 SHA-256과 경로입니다. 미지원 검사는 완료로 간주하지 않습니다.');
 return structuredClone({inputReferences:x.inputReferences,expectedArtifact:x.expectedArtifact,ownedFiles:x.ownedFiles,acceptance:{kind:a.kind,path:a.path,sha256:a.sha256}});
}
/** Only human input and frozen host configuration may raise this floor; model contracts never lower it. */
export function requiresDevelopmentVerification(input: {humanRequests: readonly string[]; development?: unknown; templateIds?: readonly (string | undefined)[]}): boolean {
 if(input.development || input.templateIds?.some(id=>id==='evidence-development'||id==='bug-improvement-loop'))return true;
 return input.humanRequests.some(text=>/(?:버그|오류|결함|코드|소스|기능|앱|프로그램|API|테스트).{0,40}(?:수정|개발|구현|고쳐|고치|추가|개선|만들)|(?:개발|구현|수정).{0,40}(?:코드|소스|기능|앱|프로그램|API)|\b(?:fix|repair|implement|develop|code|build)\b.{0,60}\b(?:bug|code|app|feature|software|api)\b|\b(?:bug|code|app|feature|software|api)\b.{0,60}\b(?:fix|repair|implement|develop)\b/i.test(text));
}
export const DEVELOPMENT_VERIFICATION_UNAVAILABLE = '파일 내용 확인·산출물 저장만 검증했습니다. 개발·버그수정 완료에는 동일 과업의 Rabbit trusted checker/reviewer 영수증이 필요하며 이 작업에 해당 영수증이 없습니다. 개발 완료는 미검증입니다.';
export function ownsOverlap(a: string[], b: string[]): boolean { const fold=(s:string)=>s.normalize('NFC').toLowerCase();return a.some(x=>b.some(y=>{const p=fold(x),q=fold(y);return p===q||p.startsWith(q+'/')||q.startsWith(p+'/');})); }
/** Inputs are host-owned tool records, never a model report argument. */
export function actionReceipt(tools: readonly ToolRecord[] = []): ActionReceipt {
 const toolCallIds=tools.map(t=>t.callId), failed=tools.some(t=>t.status!=='completed'||(t.output&&typeof t.output==='object'&&('error' in t.output||('written' in t.output&&t.output.written===false))));
 if(failed)return {policy:{...REQUIRED_POLICY},status:'failed',reason:'실패·거절 또는 종료 미확인 도구가 있습니다. 모델의 완료 문구로 바꾸지 않습니다.',toolCallIds};
 const remote=tools.some(t=>['start_project_run','get_project_run','submit_app_feedback'].includes(t.name));
 return {policy:{...REQUIRED_POLICY},status:remote?'blocked':'unverified',reason:remote?'원격 접수·조회 기록은 별도 검증 영수증 없이 개발 완료로 인정하지 않습니다.':'응답 및 도구 기록을 보존했습니다. 작업 수용 계약의 별도 검증 전에는 행동 완료를 보증하지 않습니다.',toolCallIds};
}
export function verifyDelegatedResult(session: ChatSession, contract: DelegationContract, currentArtifact?: () => boolean) {
 const c=delegationContract(contract), answer=session.messages.at(-1);
 if(answer?.role!=='assistant'||answer.status!=='completed'||!answer.requiredPolicy||answer.requiredPolicy.sha256!==REQUIRED_POLICY.sha256)throw Error('해당 위임의 필수 정책·완료 응답 영수증이 없습니다.');
 const tools=answer.tools??[], state=actionReceipt(tools);if(state.status==='failed'||state.status==='blocked')throw Error(state.reason);
 const a=c.acceptance;if(a.kind==='rabbit_verified_pr')throw Error('Rabbit 수용은 호스트의 새 권위 조회가 필요합니다.');const read=tools.findLast(t=>t.name==='read_file'&&t.status==='completed'&&t.input?.path===a.path);
 const out=read?.output as {path?:unknown;content?:unknown}|undefined;
 if(!read||out?.path!==a.path||typeof out.content!=='string'||createHash('sha256').update(out.content).digest('hex')!==a.sha256)throw Error('현재 자식 실행의 파일 읽기 영수증이 수용 경로·내용 해시와 일치하지 않습니다.');
 if(tools.slice(tools.indexOf(read)+1).some(t=>t.name==='write_file'&&t.input?.path===a.path))throw Error('수용 읽기 뒤 파일 변경 시도가 있습니다. 최종 내용을 다시 읽어 검증하세요.');
 if(a.kind==='file_write_sha256'){
  const index=tools.indexOf(read),write=tools.slice(0,index).findLast(t=>t.name==='write_file'&&t.input?.path===a.path&&typeof t.input.content==='string'&&createHash('sha256').update(t.input.content).digest('hex')===a.sha256),result=write?.output as {written?:unknown;approved?:unknown;path?:unknown}|undefined;
  if(!write||result?.written!==true||result.approved!==true||result.path!==a.path)throw Error('승인된 저장 뒤 동일 파일을 다시 읽은 영수증이 필요합니다.');
 }
 if(!currentArtifact || currentArtifact()!==true)throw Error('현재 파일이 수용 내용과 다르거나 안전하게 확인할 수 없습니다.');
 const binding={sessionId:session.id,messageId:answer.id,contract:c,callId:read.callId,contentSha256:a.sha256,policySha256:REQUIRED_POLICY.sha256};
 return {scope:'file_artifact' as const,sessionId:session.id,messageId:answer.id,callId:read.callId,sha256:createHash('sha256').update(JSON.stringify(binding)).digest('hex')};
}
