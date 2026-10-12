import {normalizeRoutineInput,routineLimits,type Routine,type RoutineInput} from '../../source/shared/routines';
export type RoutineForm = {id?:string;name:string;prompt:string;targetKind:'agent'|'team';targetId:string;scheduleKind:'interval'|'calendar';minutes:string;time:string;timezone:string;weekdays:number[];enabled:boolean};
export type RoutineEdit = {draft:RoutineForm;expectedRevision?:number;requestId:string};
export type RoutineFilter={kind:'agent'|'team';id:string};
const object=(v:unknown):v is Record<string,unknown>=>!!v&&typeof v==='object'&&!Array.isArray(v);
const string=(v:unknown,n:number):v is string=>typeof v==='string'&&v.length<=n&&!v.includes('\0');
export function routineEditDrafts(value:unknown):Record<string,RoutineEdit>|undefined{
 if(!object(value)||Object.keys(value).length>201)return;
 const result:Record<string,RoutineEdit>={};
 for(const [key,record]of Object.entries(value)){
  if(!/^[\w-]{1,100}$/.test(key)||['__proto__','constructor','prototype'].includes(key)||!object(record)||!object(record.draft))return;
  const d=record.draft;
  if(!string(record.requestId,100)||!record.requestId||(record.expectedRevision!==undefined&&(!Number.isSafeInteger(record.expectedRevision)||Number(record.expectedRevision)<1))||!string(d.name,routineLimits.name)||!string(d.prompt,routineLimits.prompt)||!['agent','team'].includes(String(d.targetKind))||!string(d.targetId,100)||!['interval','calendar'].includes(String(d.scheduleKind))||!string(d.minutes,12)||!string(d.time,20)||!string(d.timezone,100)||typeof d.enabled!=='boolean'||!Array.isArray(d.weekdays)||d.weekdays.length>7||d.weekdays.some(day=>!Number.isInteger(day)||day<0||day>6)||new Set(d.weekdays).size!==d.weekdays.length||(d.id!==undefined&&!string(d.id,100)))return;
  result[key]={requestId:record.requestId,...(record.expectedRevision!==undefined?{expectedRevision:Number(record.expectedRevision)}:{}),draft:{...(d.id?{id:String(d.id)}:{}),name:d.name,prompt:d.prompt,targetKind:d.targetKind as 'agent'|'team',targetId:d.targetId,scheduleKind:d.scheduleKind as 'interval'|'calendar',minutes:d.minutes,time:d.time,timezone:d.timezone,weekdays:[...d.weekdays],enabled:d.enabled}};
 }
 return result;
}
export function blankRoutine(filter?:RoutineFilter):RoutineEdit{
 let timezone='Asia/Seoul';try{timezone=Intl.DateTimeFormat().resolvedOptions().timeZone||timezone;}catch{}
 return {requestId:crypto.randomUUID(),draft:{name:'',prompt:'',targetKind:filter?.kind??'agent',targetId:filter?.id??'',scheduleKind:'calendar',minutes:'60',time:'09:00',timezone,weekdays:[0,1,2,3,4,5,6],enabled:true}};
}
export function editRoutine(routine:Routine):RoutineEdit{
 const base=blankRoutine(routine.target);return {...base,expectedRevision:routine.revision,draft:{...base.draft,id:routine.id,name:routine.name,prompt:routine.prompt,enabled:routine.enabled,scheduleKind:routine.schedule.kind,...(routine.schedule.kind==='interval'?{minutes:String(routine.schedule.minutes)}:{time:routine.schedule.time,timezone:routine.schedule.timezone,weekdays:routine.schedule.weekdays??[0,1,2,3,4,5,6]})}};
}
export function routineInput(d:RoutineForm):RoutineInput{
 if(!d.name.trim()||!d.prompt.trim()||!d.targetId)throw Error('루틴 이름, 요청 내용, 실행할 대상을 입력해 주세요.');
 if(d.name.trim().length>routineLimits.name||d.prompt.length>routineLimits.prompt)throw Error('루틴 입력이 너무 깁니다.');
 let schedule:RoutineInput['schedule'];
 if(d.scheduleKind==='interval'){
  const minutes=Number(d.minutes);if(!/^\d+$/.test(d.minutes)||!Number.isSafeInteger(minutes)||minutes<1||minutes>525600)throw Error('반복 간격은 1~525600분의 정수로 입력해 주세요.');schedule={kind:'interval',minutes};
 }else{
  if(!/^([01]\d|2[0-3]):[0-5]\d$/.test(d.time)||!d.weekdays.length)throw Error('실행 시각과 하나 이상의 요일을 선택해 주세요.');
  try{new Intl.DateTimeFormat('ko-KR',{timeZone:d.timezone}).format();}catch{throw Error('유효한 시간대를 입력해 주세요. 예: Asia/Seoul');}
  schedule={kind:'calendar',time:d.time,timezone:d.timezone,...(d.weekdays.length===7?{}:{weekdays:[...d.weekdays].sort()})};
 }
 return normalizeRoutineInput({...(d.id?{id:d.id}:{}),name:d.name.trim(),prompt:d.prompt,target:{kind:d.targetKind,id:d.targetId},schedule,enabled:d.enabled});
}
