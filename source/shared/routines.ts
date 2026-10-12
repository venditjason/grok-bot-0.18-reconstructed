export type RoutineTarget = {kind:'agent'|'team';id:string};
export type RoutineSchedule = {kind:'interval';minutes:number}|{kind:'calendar';time:string;timezone:string;weekdays?:number[]};
export type RoutineStatus = 'reserved'|'running'|'completed'|'failed'|'unknown'|'skipped';
export interface RoutineInput {id?:string;name:string;prompt:string;target:RoutineTarget;schedule:RoutineSchedule;enabled:boolean}
export interface Routine extends Omit<RoutineInput,'id'> {id:string;revision:number;createdAt:string;updatedAt:string;nextRunAt?:string;lastRunAt?:string;lastStatus?:RoutineStatus;lastError?:string}
export interface SaveRoutineRequest {routine:RoutineInput;expectedRevision?:number;requestId?:string}
export const routineLimits={routines:200,name:100,prompt:20000,teamPrompt:8000,intervalMinutes:525600,storeBytes:16*1024*1024,receipts:10000} as const;
export class RoutineError extends Error {
 constructor(readonly code:string,message:string,readonly latest?:Routine){super(message);this.name='RoutineError';}
}
const object=(v:unknown):v is Record<string,unknown>=>!!v&&typeof v==='object'&&!Array.isArray(v);
const keys=(v:Record<string,unknown>,allowed:string[])=>Object.keys(v).every(k=>allowed.includes(k));
export const routineId=(v:unknown):v is string=>typeof v==='string'&&v.length>0&&v.length<=100&&!/[\u0000-\u0020\u007f]/.test(v);
export const routineTimestamp=(v:unknown):v is string=>typeof v==='string'&&v.length<=40&&Number.isFinite(Date.parse(v))&&new Date(v).toISOString()===v;
export function normalizeRoutineTarget(value:unknown):RoutineTarget {
 if(!object(value)||!keys(value,['kind','id'])||!['agent','team'].includes(String(value.kind))||!routineId(value.id))throw new RoutineError('routine_invalid_target','루틴을 실행할 에이전트 또는 팀을 선택하세요.');
 return {kind:value.kind as RoutineTarget['kind'],id:value.id};
}
export function normalizeRoutineSchedule(value:unknown):RoutineSchedule {
 if(!object(value))throw new RoutineError('routine_invalid_schedule','루틴 일정을 확인하세요.');
 if(value.kind==='interval'&&keys(value,['kind','minutes'])&&Number.isSafeInteger(value.minutes)&&Number(value.minutes)>=1&&Number(value.minutes)<=routineLimits.intervalMinutes)return {kind:'interval',minutes:Number(value.minutes)};
 if(value.kind==='calendar'&&keys(value,['kind','time','timezone','weekdays'])&&typeof value.time==='string'&&/^(?:[01][0-9]|2[0-3]):[0-5][0-9]$/.test(value.time)&&typeof value.timezone==='string'&&value.timezone.length<=100){
  let timezone:string;try{timezone=new Intl.DateTimeFormat('en-US',{timeZone:value.timezone}).resolvedOptions().timeZone;}catch{throw new RoutineError('routine_invalid_timezone','유효한 시간대를 선택하세요.');}
  if(value.weekdays!==undefined&&(!Array.isArray(value.weekdays)||!value.weekdays.length||value.weekdays.length>7||value.weekdays.some(d=>!Number.isInteger(d)||d<0||d>6)||new Set(value.weekdays).size!==value.weekdays.length))throw new RoutineError('routine_invalid_weekdays','요일은 일요일 0부터 토요일 6까지 중복 없이 선택하세요.');
  return {kind:'calendar',time:value.time,timezone,...(value.weekdays===undefined?{}:{weekdays:[...value.weekdays as number[]].sort((a,b)=>a-b)})};
 }
 throw new RoutineError('routine_invalid_schedule','간격은 1분 이상 정수로, 시각은 HH:mm 형식으로 입력하세요.');
}
export function normalizeRoutineInput(value:unknown):RoutineInput {
 if(!object(value)||!keys(value,['id','name','prompt','target','schedule','enabled'])||(value.id!==undefined&&!routineId(value.id))||typeof value.name!=='string'||!value.name.trim()||value.name.trim().length>routineLimits.name||/[\u0000-\u001f\u007f]/.test(value.name)||typeof value.prompt!=='string'||!value.prompt.trim()||value.prompt.length>routineLimits.prompt||value.prompt.includes('\0')||typeof value.enabled!=='boolean')throw new RoutineError('routine_invalid_input','루틴 이름, 작업 내용, 실행 대상과 일정을 확인하세요.');
 const target=normalizeRoutineTarget(value.target);if(target.kind==='team'&&value.prompt.length>routineLimits.teamPrompt)throw new RoutineError('routine_team_prompt_limit','팀 루틴의 작업 내용은 8,000자 이내로 입력하세요.');
 return {...(value.id===undefined?{}:{id:value.id}),name:value.name.trim(),prompt:value.prompt.trim(),target,schedule:normalizeRoutineSchedule(value.schedule),enabled:value.enabled};
}
export function validRoutine(value:unknown):value is Routine {
 if(!object(value)||!keys(value,['id','name','prompt','target','schedule','enabled','revision','createdAt','updatedAt','nextRunAt','lastRunAt','lastStatus','lastError'])||!routineId(value.id)||!Number.isSafeInteger(value.revision)||Number(value.revision)<1||!routineTimestamp(value.createdAt)||!routineTimestamp(value.updatedAt)||(value.nextRunAt!==undefined&&!routineTimestamp(value.nextRunAt))||(value.lastRunAt!==undefined&&!routineTimestamp(value.lastRunAt))||(value.lastStatus!==undefined&&!['reserved','running','completed','failed','unknown','skipped'].includes(String(value.lastStatus)))||(value.lastError!==undefined&&(typeof value.lastError!=='string'||value.lastError.length>2000)))return false;
 try{normalizeRoutineInput({id:value.id,name:value.name,prompt:value.prompt,target:value.target,schedule:value.schedule,enabled:value.enabled});return true;}catch{return false;}
}
const formatters=new Map<string,Intl.DateTimeFormat>();
function formatter(timezone:string){let f=formatters.get(timezone);if(!f){f=new Intl.DateTimeFormat('en-US',{timeZone:timezone,calendar:'gregory',numberingSystem:'latn',hourCycle:'h23',year:'numeric',month:'2-digit',day:'2-digit',hour:'2-digit',minute:'2-digit'});if(formatters.size>=100)formatters.clear();formatters.set(timezone,f);}return f;}
function wall(ms:number,f:Intl.DateTimeFormat){const p:Record<string,number>={};for(const part of f.formatToParts(new Date(ms)))if(part.type!=='literal')p[part.type]=Number(part.value);return {year:p.year!,month:p.month!,day:p.day!,hour:p.hour!%24,minute:p.minute!};}
/** One occurrence per local calendar date: a DST gap skips that date, a fold uses
 * its first occurrence only. Missed occurrences coalesce; never backfill a burst. */
export function nextRoutineRunAt(raw:RoutineSchedule,afterMs:number,anchorMs=afterMs):string {
 const schedule=normalizeRoutineSchedule(raw);
 if(!Number.isFinite(afterMs)||!Number.isFinite(anchorMs)||Math.abs(afterMs)>8e15||Math.abs(anchorMs)>8e15)throw new RoutineError('routine_invalid_clock','일정 기준 시각을 확인하세요.');
 if(schedule.kind==='interval'){
  const period=schedule.minutes*60000,next=anchorMs+(Math.max(0,Math.floor((afterMs-anchorMs)/period))+1)*period;
  return new Date(next).toISOString();
 }
 const f=formatter(schedule.timezone),start=wall(afterMs,f),[hour,minute]=schedule.time.split(':').map(Number);
 for(let day=0;day<16;day++){
  const date=new Date(Date.UTC(start.year,start.month-1,start.day+day));
  if(schedule.weekdays&&!schedule.weekdays.includes(date.getUTCDay()))continue;
  const civil=Date.UTC(date.getUTCFullYear(),date.getUTCMonth(),date.getUTCDate(),hour,minute),offsets=new Set<number>();
  // Sample both sides of offset changes, then round-trip each candidate. Handles
  // half-hour offsets and skipped civil dates without assuming a 24-hour day.
  for(let delta=-36;delta<=36;delta+=6){const t=civil+delta*3600000,p=wall(t,f);offsets.add(Date.UTC(p.year,p.month-1,p.day,p.hour,p.minute)-t);}
  const candidates=[...offsets].map(offset=>civil-offset).filter(t=>{const p=wall(t,f);return p.year===date.getUTCFullYear()&&p.month===date.getUTCMonth()+1&&p.day===date.getUTCDate()&&p.hour===hour&&p.minute===minute;}).sort((a,b)=>a-b);
  if(candidates[0]!==undefined&&candidates[0]>afterMs)return new Date(candidates[0]).toISOString();
 }
 throw new RoutineError('routine_schedule_unavailable','이 시간대에서 다음 실행 시각을 계산하지 못했습니다.');
}
