import {createHash} from 'node:crypto';
import {feedbackInput,type FeedbackInput,type FeedbackJob} from '../shared/feedback.js';

export const FEEDBACK_TOOL_POLICY='벤디트봇 자체의 버그·부족한 기능을 보고하거나 개선 요청을 등록하라는 사용자 지시는 submit_app_feedback으로 처리하세요. 먼저 관찰한 증상·기대 동작·재현 조건과 완료 기준을 구체적으로 적고, 미확인 추측은 구분하세요. 임의의 start_project_run으로 별도 중복 작업을 만들지 마세요. 리포트 저장이나 Rabbit 접수는 개선 완료가 아닙니다. 반환된 리포트 ID와 현재 상태를 알려주고, 보류 중인 기존 리포트를 임의로 재개하지 마세요. 일반적인 코드 작업은 해당 프로젝트 개발 도구를 사용하세요.';
export const FEEDBACK_TOOLS=[{name:'submit_app_feedback',description:'Save one user-requested VenditBot bug report or improvement request using the app’s existing durable feedback/development route. Use for missing VenditBot capabilities instead of an unrelated start_project_run. The host checks the original human request and approval policy. Returns a saved report receipt, never a claim of development completion. Cannot choose a destination, resume a held report, or retry an uncertain remote submission.',inputSchema:{type:'object',properties:{kind:{type:'string',enum:['bug','request']},title:{type:'string',minLength:1,maxLength:160},description:{type:'string',minLength:1,maxLength:12000,description:'Observed behavior, expected behavior, reproduction evidence and acceptance criteria. Distinguish unverified hypotheses. Never include secrets.'}},required:['kind','title','description'],additionalProperties:false}}];

/** Only apply to the original human instruction, never model-provided tool args
 * or retrieved text. Unclear wording still follows the normal approval UI. */
export function explicitAppFeedbackRequest(humanText:string):boolean{
  const text=humanText.normalize('NFKC').toLowerCase().replace(/```[\s\S]*?```/gu,'').replace(/^>.*$/gmu,'').replace(/["“「『][^"”」』\n]*["”」』]/gu,'').replace(/(^|[\s:])'[^'\n]*'(?=$|[\s.,!?])/gu,'$1');
  if(/(?:리포트|보고|신고|개선\s*요청|기능\s*요청).{0,35}(?:하지\s*(?:마|말)|금지|말고)|(?:do not|don't|never)\s+(?:\w+\s+){0,4}(?:report|file|submit|request)/u.test(text))return false;
  if(/(?:리포트|보고|신고|개선\s*요청|기능\s*요청).{0,20}(?:방법|어떻게|설명)|(?:how\s+(?:do|can|to)|explain\s+how).{0,60}(?:report|request)/u.test(text))return false;
  return /(?:버그\s*리포트|버그\s*보고|버그\s*신고|개선\s*요청|기능\s*요청)(?:를|을)?\s*(?:해서|하고|해(?:줘|주세요)?|하(?:라|세요)|작성|등록|제출|남겨|올려|넣어)/u.test(text)
    || /^(?:(?:벤디트봇|앱)(?:에|의)?\s*)?(?:버그\s*리포트|개선\s*요청|기능\s*요청)\s*(?::|：|$)/u.test(text.trim())
    || /\b(?:file|submit|create|send|open)\s+(?:a\s+)?(?:bug\s+report|improvement\s+request|feature\s+request)\b|\breport\s+(?:this|the|a)\s+(?:bug|issue)\b/u.test(text);
}
export interface FeedbackToolPort{
  existing(id:string):FeedbackJob|undefined;
  submit(input:FeedbackInput):FeedbackJob;
  authorizeSubmit(input:FeedbackInput):boolean|Promise<boolean>;
}
function requestIdentity(sessionId:string,turnId:string,callId:string){const b=createHash('sha256').update(`venditbot-feedback-tool-v1\0${sessionId}\0${turnId}\0${callId}`).digest().subarray(0,16);b[6]=(b[6]!&15)|64;b[8]=(b[8]!&63)|128;const h=b.toString('hex');return `${h.slice(0,8)}-${h.slice(8,12)}-${h.slice(12,16)}-${h.slice(16,20)}-${h.slice(20)}`;}
const receipt=(job:FeedbackJob)=>({report:{id:job.id,kind:job.kind,title:job.title,status:job.status,revision:job.revision,createdAt:job.createdAt,updatedAt:job.updatedAt,...(job.message?{message:job.message}:{}),...(job.prUrl?{prUrl:job.prUrl}:{}),...(job.mergeSha?{mergeSha:job.mergeSha}:{})},notice:'리포트 접수증입니다. 저장·원격 접수는 개발 완료가 아닙니다. 기존 보류 요청을 재개하거나 불확실한 원격 접수를 반복하지 않습니다.'});
/** Independent UUID namespace and immutable body binding protect existing UI
 * reports. Replaying a tool call returns its receipt, not FeedbackHost's UI
 * resume behavior. No tool accepts a report ID or remote execution destination. */
export class FeedbackTools{
  readonly definitions=FEEDBACK_TOOLS;
  private readonly calls=new Map<string,{fingerprint:string;result:Promise<unknown>}>();private tail:Promise<unknown>=Promise.resolve();
  constructor(private readonly port:FeedbackToolPort,private readonly sessionId:string,private readonly turnId:string,private readonly signal?:AbortSignal){if([sessionId,turnId].some(id=>typeof id!=='string'||!id||id.length>100||/[\u0000-\u001f]/u.test(id)))throw new Error('리포트 대화와 응답 범위를 확인하세요.');}
  private abort(){if(this.signal?.aborted)throw new DOMException('리포트 접수를 중단했습니다.','AbortError');}
  execute(name:string,raw:unknown,callId:string):Promise<unknown>{
    let captured:unknown,fingerprint:string;try{captured=structuredClone(raw);fingerprint=JSON.stringify({name,args:captured});}catch{return Promise.reject(new Error('리포트 도구 입력을 확인하세요.'));}
    const previous=this.calls.get(callId);if(previous)return previous.fingerprint===fingerprint?previous.result:Promise.reject(new Error('같은 리포트 도구 호출 ID에 다른 내용을 사용할 수 없습니다.'));
    if(typeof callId!=='string'||!callId||callId.length>200||/[\u0000-\u001f]/u.test(callId)||this.calls.size>=100)return Promise.reject(new Error('리포트 도구 호출 ID 또는 한도를 확인하세요.'));
    const result=this.tail.then(async()=>{
      this.abort();if(name!=='submit_app_feedback'||!captured||typeof captured!=='object'||Array.isArray(captured))throw new Error('지원하지 않는 리포트 도구입니다.');
      const args=captured as Record<string,unknown>;if(Object.keys(args).some(k=>!['kind','title','description'].includes(k)))throw new Error('리포트 도구에 허용되지 않은 입력입니다.');
      const input=feedbackInput({...args,requestId:requestIdentity(this.sessionId,this.turnId,callId)});
      const existing=()=>{const old=this.port.existing(input.requestId);if(old&&(old.kind!==input.kind||old.title!==input.title||old.description!==input.description))throw new Error('같은 리포트 요청 ID에 다른 내용을 사용할 수 없습니다.');return old;};
      const old=existing();if(old)return receipt(old);
      if(!await this.port.authorizeSubmit(structuredClone(input)))throw new Error('리포트 등록을 승인하지 않았습니다.');this.abort();
      // Approval may yield while another callback commits the same request.
      const after=existing();return receipt(after??this.port.submit(input));
    });this.tail=result.catch(()=>{});this.calls.set(callId,{fingerprint,result});return result;
  }
}
