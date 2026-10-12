import {createHash} from 'node:crypto';
import {RoutineError,normalizeRoutineInput,routineId,type Routine,type RoutineTarget,type SaveRoutineRequest} from '../shared/routines.js';
const schema=(properties:Record<string,unknown>,required=Object.keys(properties))=>({type:'object',properties,required,additionalProperties:false});
const schedule={oneOf:[schema({kind:{const:'interval'},minutes:{type:'integer',minimum:1,maximum:525600}}),schema({kind:{const:'calendar'},time:{type:'string',pattern:'^(?:[01][0-9]|2[0-3]):[0-5][0-9]$'},timezone:{type:'string'},weekdays:{type:'array',minItems:1,maxItems:7,uniqueItems:true,items:{type:'integer',minimum:0,maximum:6}}},['kind','time','timezone'])]};
const fields={name:{type:'string',minLength:1,maxLength:100},prompt:{type:'string',minLength:1,maxLength:20000},target:{type:'string',enum:['self','team'],description:'Yourself, or the current team only while you remain its leader.'},schedule,enabled:{type:'boolean'}};
const mutation={userRequest:{type:'string',minLength:1,maxLength:2000,description:'The explicit current human request to create/change/delete this routine. The host verifies authorization; model assertions do not grant permission.'}};
const id={type:'string'},expectedRevision={type:'integer',minimum:1};
export const ROUTINE_TOOLS=[
 {name:'list_routines',description:'List routines targeting this agent, and the current team only while you are its leader. Does not create, run or resume work.',inputSchema:schema({})},
 {name:'create_routine',description:'Create a recurring routine only at the user’s explicit request. It runs while this app remains open through the normal model routing queue. No immediate run, external cron, listener, credentials or provider override.',inputSchema:schema({...fields,...mutation})},
 {name:'update_routine',description:'Update an owned routine at the user’s explicit request using its exact listed revision. Preserves current running work and does not replay missed work.',inputSchema:schema({id,expectedRevision,...fields,...mutation})},
 {name:'set_routine_enabled',description:'Enable or pause future occurrences at the user’s explicit request. Enabling after an unknown result acknowledges it without replay; it does not stop current work.',inputSchema:schema({id,expectedRevision,enabled:{type:'boolean'},...mutation})},
 {name:'delete_routine',description:'Delete future scheduling at the user’s explicit request and exact revision. Refuses while work is active or its outcome is unknown; pause future scheduling first.',inputSchema:schema({id,expectedRevision,...mutation})},
];
export interface RoutineToolSource {sessionId:string;agentId:string;teamId?:string}
export interface RoutineToolPort {
 list():Routine[];
 save(request:SaveRoutineRequest):Routine;
 setEnabled(id:string,enabled:boolean,expectedRevision:number):Routine;
 remove(id:string,expectedRevision:number):{id:string;deleted:true};
 isCurrentTeamLeader(agentId:string,teamId:string):boolean;
 authorizeMutation(name:string,args:Readonly<Record<string,unknown>>):boolean|Promise<boolean>;
}
function requestIdentity(sessionId:string,callId:string){const b=createHash('sha256').update('venditbot-routine-v1\0'+sessionId+'\0'+callId).digest().subarray(0,16);b[6]=(b[6]!&15)|64;b[8]=(b[8]!&63)|128;const h=b.toString('hex');return `${h.slice(0,8)}-${h.slice(8,12)}-${h.slice(12,16)}-${h.slice(16,20)}-${h.slice(20)}`;}
/** The host binds the current identity and human authorization; tool arguments
 * cannot select another agent/team or grant themselves leader authority. */
export class RoutineTools {
 readonly definitions=ROUTINE_TOOLS;private readonly source:RoutineToolSource;private readonly calls=new Map<string,{fingerprint:string;result:Promise<unknown>}>();private tail:Promise<unknown>=Promise.resolve();
 constructor(private readonly port:RoutineToolPort,source:RoutineToolSource,private readonly signal?:AbortSignal){if(!routineId(source.sessionId)||!routineId(source.agentId)||(source.teamId!==undefined&&!routineId(source.teamId))||typeof port.authorizeMutation!=='function')throw new RoutineError('routine_tool_scope','루틴 도구의 실행 범위를 확인하세요.');this.source=structuredClone(source);}
 private abort(){if(this.signal?.aborted)throw new DOMException('루틴 변경을 중단했습니다.','AbortError');}
 private owns(target:RoutineTarget){return target.kind==='agent'?target.id===this.source.agentId:!!this.source.teamId&&target.id===this.source.teamId&&this.port.isCurrentTeamLeader(this.source.agentId,this.source.teamId);}
 private target(raw:unknown):RoutineTarget{if(raw==='self')return {kind:'agent',id:this.source.agentId};if(raw==='team'&&this.source.teamId&&this.port.isCurrentTeamLeader(this.source.agentId,this.source.teamId))return {kind:'team',id:this.source.teamId};throw new RoutineError('routine_tool_scope','본인 또는 현재 이끄는 팀의 루틴만 변경할 수 있습니다.');}
 execute(name:string,raw:unknown,callId:string):Promise<unknown>{
  let captured:unknown,fingerprint:string;try{captured=structuredClone(raw);fingerprint=JSON.stringify({name,args:captured});}catch{return Promise.reject(new RoutineError('routine_invalid_input','루틴 도구 입력을 확인하세요.'));}
  const prior=this.calls.get(callId);if(prior)return prior.fingerprint===fingerprint?prior.result:Promise.reject(new RoutineError('routine_call_conflict','같은 도구 호출 ID의 루틴 내용이 다릅니다.'));
  if(typeof callId!=='string'||!callId||callId.length>200||/[\u0000-\u001f]/.test(callId)||this.calls.size>=100)return Promise.reject(new RoutineError('routine_call_limit','루틴 도구 호출 ID 또는 한도를 확인하세요.'));
  const result=this.tail.then(async()=>{
   this.abort();const definition=this.definitions.find(v=>v.name===name);
   if(!definition||!captured||typeof captured!=='object'||Array.isArray(captured))throw new RoutineError('routine_invalid_input','루틴 도구 입력을 확인하세요.');
   const args=captured as Record<string,unknown>;if(Object.keys(args).some(k=>!Object.hasOwn(definition.inputSchema.properties,k)))throw new RoutineError('routine_invalid_input','루틴 도구에 허용되지 않은 입력입니다.');
   if(name==='list_routines')return {routines:this.port.list().filter(r=>this.owns(r.target))};
   if(typeof args.userRequest!=='string'||!args.userRequest.trim()||args.userRequest.length>2000)throw new RoutineError('routine_user_request_required','사용자의 명시적인 루틴 변경 요청이 필요합니다.');
   const current=()=>{const r=this.port.list().find(r=>r.id===args.id);if(!r||!this.owns(r.target))throw new RoutineError('routine_tool_scope','본인 또는 현재 이끄는 팀의 루틴만 변경할 수 있습니다.');return r;};
   if(name!=='create_routine'){current();if(!Number.isSafeInteger(args.expectedRevision)||Number(args.expectedRevision)<1)throw new RoutineError('routine_revision_required','현재 루틴 버전을 지정하세요.');}
   const input=name==='create_routine'||name==='update_routine'?normalizeRoutineInput({...(name==='update_routine'?{id:args.id}:{}),name:args.name,prompt:args.prompt,target:this.target(args.target),schedule:args.schedule,enabled:args.enabled}):undefined;
   if(name==='set_routine_enabled'&&typeof args.enabled!=='boolean')throw new RoutineError('routine_invalid_input','활성 상태를 확인하세요.');
   if(!await this.port.authorizeMutation(name,structuredClone(args)))throw new RoutineError('routine_not_authorized','루틴 변경이 승인되지 않았습니다.');
   this.abort();if(name!=='create_routine')current();if(input&&!this.owns(input.target))throw new RoutineError('routine_tool_scope','루틴 변경 권한이 바뀌었습니다.');
   if(input)return {routine:this.port.save({routine:input,...(name==='create_routine'?{requestId:requestIdentity(this.source.sessionId,callId)}:{expectedRevision:Number(args.expectedRevision)})})};
   if(name==='set_routine_enabled')return {routine:this.port.setEnabled(String(args.id),args.enabled as boolean,Number(args.expectedRevision))};
   return this.port.remove(String(args.id),Number(args.expectedRevision));
  });this.tail=result.catch(()=>{});this.calls.set(callId,{fingerprint,result});return result;
 }
}
