import {randomUUID,createHash} from 'node:crypto';
import {constants,openSync,closeSync,fstatSync,lstatSync,readFileSync,writeFileSync,renameSync,unlinkSync,mkdirSync,rmdirSync,fsyncSync,type Stats} from 'node:fs';
import {join,resolve} from 'node:path';
import {RoutineError,normalizeRoutineInput,normalizeRoutineTarget,nextRoutineRunAt,routineId,routineTimestamp,routineLimits,validRoutine,type Routine,type RoutineTarget,type SaveRoutineRequest} from '../shared/routines.js';
export type RoutineOutcome={status:'completed'|'failed';error?:string};
export interface RoutineReservation {dispatchId:string;routineId:string;routineRevision:number;routineName:string;target:RoutineTarget;prompt:string;scheduledAt:string;reservedAt:string;status:'reserved'|'running'|'completed'|'failed'|'unknown'|'acknowledged';finishedAt?:string;error?:string}
type Data={version:1;routines:Routine[];reservations:RoutineReservation[];creations:{requestId:string;inputHash:string;routineId:string}[]};
export interface RoutineStoreOptions {now?:()=>number;onChange?:(routines:Routine[])=>void}
const uuid=(v:unknown):v is string=>typeof v==='string'&&/^[a-f0-9]{8}-[a-f0-9]{4}-[1-8][a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/i.test(v);
const active=(r:RoutineReservation)=>['reserved','running','unknown'].includes(r.status);
const targetKey=(t:RoutineTarget)=>t.kind+':'+t.id;
const failure=(code:string,message:string)=>new RoutineError(code,message);
const empty=():Data=>({version:1,routines:[],reservations:[],creations:[]});
function privateEntry(s:Stats,directory=false){if((directory?!s.isDirectory():!s.isFile()||s.nlink!==1)||s.isSymbolicLink()||(s.mode&0o077)!==0||(process.getuid&&s.uid!==process.getuid())||(!directory&&s.size>routineLimits.storeBytes))throw failure('routine_storage_unsafe','루틴 저장 경로가 안전하지 않습니다. 원본을 보존했습니다.');}
function readPrivate(path:string):string|undefined{
 let fd:number;try{fd=openSync(path,constants.O_RDONLY|constants.O_NOFOLLOW|constants.O_NONBLOCK);}catch(e){if((e as NodeJS.ErrnoException).code==='ENOENT')return;throw e;}
 try{const before=fstatSync(fd);privateEntry(before);const bytes=readFileSync(fd);const after=fstatSync(fd),current=lstatSync(path);privateEntry(after);privateEntry(current);if(bytes.length!==before.size||before.size!==after.size||before.mtimeMs!==after.mtimeMs||before.ctimeMs!==after.ctimeMs||after.dev!==current.dev||after.ino!==current.ino)throw failure('routine_storage_changed','루틴 파일이 읽는 동안 변경되었습니다.');return new TextDecoder('utf-8',{fatal:true}).decode(bytes);}finally{closeSync(fd);}
}
function validReservation(v:unknown):v is RoutineReservation{
 if(!v||typeof v!=='object'||Array.isArray(v))return false;const r=v as RoutineReservation;
 try{normalizeRoutineTarget(r.target);}catch{return false;}
 return routineId(r.dispatchId)&&routineId(r.routineId)&&Number.isSafeInteger(r.routineRevision)&&r.routineRevision>0&&typeof r.routineName==='string'&&r.routineName.length<=routineLimits.name&&typeof r.prompt==='string'&&r.prompt.length<=routineLimits.prompt&&routineTimestamp(r.scheduledAt)&&routineTimestamp(r.reservedAt)&&['reserved','running','completed','failed','unknown','acknowledged'].includes(r.status)&&(r.finishedAt===undefined||routineTimestamp(r.finishedAt))&&(r.error===undefined||typeof r.error==='string'&&r.error.length<=2000);
}
/** All transactions reread disk under an exclusive local lock. Corrupt JSON is
 * never replaced by defaults. A reservation is fsynced before any dispatch. */
export class RoutineStore {
 private readonly root:string;private readonly file:string;private readonly rootPin:Stats;private readonly options:RoutineStoreOptions;
 constructor(root:string,options:RoutineStoreOptions={}){this.root=resolve(root);this.options={...options};this.rootPin=lstatSync(this.root);privateEntry(this.rootPin,true);this.file=join(this.root,'routines.json');this.read();}
 private rootCurrent(){const s=lstatSync(this.root);privateEntry(s,true);if(s.dev!==this.rootPin.dev||s.ino!==this.rootPin.ino)throw failure('routine_storage_changed','루틴 저장 폴더가 변경되었습니다.');}
 private now(){return this.options.now?.()??Date.now();}
 private read():Data{
  this.rootCurrent();const raw=readPrivate(this.file);if(raw===undefined)return empty();
  try{const d=JSON.parse(raw)as Data;if(d.version!==1||!Array.isArray(d.routines)||d.routines.length>routineLimits.routines||!d.routines.every(validRoutine)||new Set(d.routines.map(r=>r.id)).size!==d.routines.length||!Array.isArray(d.reservations)||d.reservations.length>1200||!d.reservations.every(validReservation)||new Set(d.reservations.map(r=>r.dispatchId)).size!==d.reservations.length||!Array.isArray(d.creations)||d.creations.length>routineLimits.receipts||d.creations.some(c=>!uuid(c?.requestId)||!routineId(c.routineId)||!/^[a-f0-9]{64}$/.test(c.inputHash))||new Set(d.creations.map(c=>c.requestId)).size!==d.creations.length)throw Error();return d;}catch{throw failure('routine_storage_corrupt','루틴 저장 데이터가 손상되었습니다. 원본은 보존했습니다.');}
 }
 private lock():()=>void{
  const path=this.file+'.lock';this.rootCurrent();
  try{mkdirSync(path,{mode:0o700});}catch(e){if((e as NodeJS.ErrnoException).code!=='EEXIST')throw e;const s=lstatSync(path);privateEntry(s,true);const owner=readPrivate(join(path,'owner.json'));let pid:number;try{pid=JSON.parse(owner??'null')?.pid;if(!Number.isSafeInteger(pid)||pid<=1)throw Error();}catch{throw failure('routine_storage_busy','루틴 저장 잠금을 확인해야 합니다. 원본을 보존했습니다.');}
   try{process.kill(pid,0);throw failure('routine_storage_busy','다른 루틴 저장 작업이 진행 중입니다.');}catch(cause){if((cause as NodeJS.ErrnoException).code!=='ESRCH')throw cause;}
   const current=lstatSync(path);if(current.dev!==s.dev||current.ino!==s.ino)throw failure('routine_storage_busy','루틴 저장 잠금이 변경되었습니다.');unlinkSync(join(path,'owner.json'));rmdirSync(path);mkdirSync(path,{mode:0o700});
  }
  const pin=lstatSync(path);try{writeFileSync(join(path,'owner.json'),JSON.stringify({pid:process.pid}),{flag:'wx',mode:0o600,flush:true});}catch(e){rmdirSync(path);throw e;}
  return()=>{const s=lstatSync(path);if(s.dev!==pin.dev||s.ino!==pin.ino)throw failure('routine_storage_changed','루틴 잠금 폴더가 변경되었습니다.');unlinkSync(join(path,'owner.json'));rmdirSync(path);};
 }
 private transact<T>(change:(data:Data)=>T):T{
  const unlock=this.lock();let result:T;let snapshot:Routine[]|undefined;
  try{const data=this.read();result=change(data);const serialized=JSON.stringify(data,null,2);if(Buffer.byteLength(serialized)>routineLimits.storeBytes)throw failure('routine_storage_limit','루틴 저장 한도에 도달했습니다. 기존 데이터는 보존했습니다.');this.rootCurrent();const temp=this.file+'.'+randomUUID()+'.tmp';
   try{writeFileSync(temp,serialized,{flag:'wx',mode:0o600,flush:true});this.rootCurrent();renameSync(temp,this.file);const fd=openSync(this.root,constants.O_RDONLY);try{fsyncSync(fd);}finally{closeSync(fd);}}finally{try{unlinkSync(temp);}catch(e){if((e as NodeJS.ErrnoException).code!=='ENOENT')throw e;}}
   snapshot=structuredClone(data.routines);
  }finally{unlock();}
  try{this.options.onChange?.(snapshot!);}catch{/* UI observers cannot undo a durable commit. */}return structuredClone(result!);
 }
 list():Routine[]{return structuredClone(this.read().routines);}
 get(id:string):Routine{const r=this.list().find(r=>r.id===id);if(!r)throw failure('routine_not_found','루틴을 찾을 수 없습니다.');return r;}
 reservations():RoutineReservation[]{return structuredClone(this.read().reservations);}
 private current(data:Data,id:string,revision:number):Routine{const r=data.routines.find(r=>r.id===id);if(!r)throw failure('routine_not_found','루틴을 찾을 수 없습니다.');if(!Number.isSafeInteger(revision)||r.revision!==revision)throw new RoutineError('routine_revision_conflict','루틴이 변경되었습니다. 최신 내용을 확인한 뒤 저장하세요.',structuredClone(r));return r;}
 save(request:SaveRoutineRequest):Routine{
  const input=normalizeRoutineInput(request.routine),hash=createHash('sha256').update(JSON.stringify(input)).digest('hex');
  return this.transact(data=>{
   let previous:Routine|undefined;
   if(input.id){previous=this.current(data,input.id,request.expectedRevision!);}else{
    if(request.expectedRevision!==undefined||!uuid(request.requestId))throw failure('routine_request_required','새 루틴에는 고유한 생성 요청 ID가 필요합니다.');
    const receipt=data.creations.find(c=>c.requestId===request.requestId);if(receipt){if(receipt.inputHash!==hash)throw failure('routine_request_conflict','같은 생성 요청 ID의 루틴 내용이 다릅니다.');const existing=data.routines.find(r=>r.id===receipt.routineId);if(!existing)throw failure('routine_deleted','이 요청으로 만든 루틴은 삭제되었습니다. 새 초안으로 생성하세요.');return existing;}
    if(data.routines.length>=routineLimits.routines||data.creations.length>=routineLimits.receipts)throw failure('routine_limit','루틴 또는 생성 이력 한도에 도달했습니다.');
   }
   if(previous&&data.reservations.some(r=>r.routineId===previous!.id&&r.status==='unknown')&&input.enabled)throw failure('routine_unknown_outcome','이전 실행 결과를 확인한 뒤 활성화 버튼으로 향후 실행을 다시 켜세요.');
   const now=this.now(),stamp=new Date(Math.max(now,previous?Date.parse(previous.updatedAt)+1:0)).toISOString();
   const routine:Routine={...previous,...input,id:previous?.id??randomUUID(),revision:(previous?.revision??0)+1,createdAt:previous?.createdAt??stamp,updatedAt:stamp};
   if(routine.enabled)routine.nextRunAt=nextRoutineRunAt(routine.schedule,now);else delete routine.nextRunAt;
   if(!validRoutine(routine))throw failure('routine_invalid_input','루틴 입력을 확인하세요.');
   data.routines=[...data.routines.filter(r=>r.id!==routine.id),routine];if(!previous)data.creations.push({requestId:request.requestId!,inputHash:hash,routineId:routine.id});return routine;
  });
 }
 setEnabled(id:string,enabled:boolean,expectedRevision:number):Routine{
  if(typeof enabled!=='boolean')throw failure('routine_invalid_input','활성 상태를 확인하세요.');
  return this.transact(data=>{const r=this.current(data,id,expectedRevision),now=this.now();r.enabled=enabled;r.revision++;r.updatedAt=new Date(Math.max(now,Date.parse(r.updatedAt)+1)).toISOString();
   if(enabled){r.nextRunAt=nextRoutineRunAt(r.schedule,now);for(const reservation of data.reservations)if(reservation.routineId===id&&reservation.status==='unknown'){reservation.status='acknowledged';reservation.finishedAt=new Date(now).toISOString();}if(r.lastStatus==='unknown'){r.lastStatus='skipped';r.lastError='이전 결과 미확인 실행은 재실행하지 않고 향후 일정만 다시 활성화했습니다.';}}
   else delete r.nextRunAt;return r;});
 }
 remove(id:string,expectedRevision:number):{id:string;deleted:true}{return this.transact(data=>{this.current(data,id,expectedRevision);if(data.reservations.some(r=>r.routineId===id&&r.status==='unknown'))throw failure('routine_unknown_outcome','이전 실행 결과를 확인하고 향후 실행을 명시적으로 활성화한 뒤 삭제하세요.');if(data.reservations.some(r=>r.routineId===id&&['reserved','running'].includes(r.status)))throw failure('routine_active_execution','실행 중인 루틴은 먼저 비활성화하고 실행이 끝난 뒤 삭제하세요.');data.routines=data.routines.filter(r=>r.id!==id);return {id,deleted:true};});}
 reserve(id:string,expectedRevision:number,dispatchId:string,nowMs=this.now()):RoutineReservation|undefined{
  if(!routineId(dispatchId))throw failure('routine_invalid_dispatch','실행 예약 ID를 확인하세요.');
  return this.transact(data=>{const r=this.current(data,id,expectedRevision);if(!r.enabled||!r.nextRunAt||Date.parse(r.nextRunAt)>nowMs)return;
   if(data.reservations.some(v=>v.dispatchId===dispatchId))throw failure('routine_duplicate_dispatch','중복 실행 예약 ID입니다.');
   if(data.reservations.some(v=>active(v)&&(v.routineId===id||targetKey(v.target)===targetKey(r.target))))return;
   const reservation:RoutineReservation={dispatchId,routineId:id,routineRevision:r.revision,routineName:r.name,target:structuredClone(r.target),prompt:r.prompt,scheduledAt:r.nextRunAt,reservedAt:new Date(nowMs).toISOString(),status:'reserved'};
   r.lastRunAt=reservation.reservedAt;r.lastStatus='reserved';delete r.lastError;r.nextRunAt=nextRoutineRunAt(r.schedule,nowMs,Date.parse(reservation.scheduledAt));
   const retained=data.reservations.filter(active),history=data.reservations.filter(v=>!active(v)).slice(-999);data.reservations=[...history,...retained,reservation];return reservation;
  });
 }
 markRunning(dispatchId:string):void{this.changeDispatch(dispatchId,'running');}
 settle(dispatchId:string,outcome:RoutineOutcome):void{if(!['completed','failed'].includes(outcome.status))throw failure('routine_invalid_outcome','실행 결과를 확인하세요.');this.changeDispatch(dispatchId,outcome.status,outcome.error);}
 markUnknown(dispatchId:string,reason='실행 결과를 확인할 수 없습니다. 확인 후 향후 일정만 다시 활성화하세요.'):void{this.changeDispatch(dispatchId,'unknown',reason);}
 private changeDispatch(dispatchId:string,status:RoutineReservation['status'],error?:string){this.transact(data=>{const entry=data.reservations.find(r=>r.dispatchId===dispatchId);if(!entry)throw failure('routine_dispatch_not_found','실행 예약을 찾을 수 없습니다.');if(!active(entry)||(status==='unknown'&&entry.status==='unknown'))return;if(status==='running'&&entry.status==='unknown')return;entry.status=status;if(error!==undefined)entry.error=error.slice(0,2000);if(['completed','failed'].includes(status))entry.finishedAt=new Date(this.now()).toISOString();const r=data.routines.find(r=>r.id===entry.routineId);if(r){r.lastStatus=status as NonNullable<Routine['lastStatus']>;if(error!==undefined)r.lastError=error.slice(0,2000);else delete r.lastError;if(status==='unknown'){r.enabled=false;delete r.nextRunAt;r.revision++;r.updatedAt=new Date(Math.max(this.now(),Date.parse(r.updatedAt)+1)).toISOString();}}});}
 skip(id:string,expectedRevision:number,nowMs:number,reason:string):void{this.transact(data=>{const r=this.current(data,id,expectedRevision);if(!r.enabled||!r.nextRunAt||Date.parse(r.nextRunAt)>nowMs)return;r.nextRunAt=nextRoutineRunAt(r.schedule,nowMs,Date.parse(r.nextRunAt));if(!data.reservations.some(v=>active(v)&&v.routineId===id)){r.lastStatus='skipped';r.lastError=reason.slice(0,2000);}});}
}
