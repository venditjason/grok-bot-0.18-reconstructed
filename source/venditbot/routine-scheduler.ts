import type {RoutineTarget} from '../shared/routines.js';
import {RoutineStore,type RoutineReservation,type RoutineOutcome} from './routine-store.js';
export type RoutineDispatchStatus='running'|'completed'|'failed'|'unknown';
export interface RoutineSchedulerPort {
 allocateDispatchId():string;
 dispatchReserved(reservation:RoutineReservation):Promise<RoutineOutcome>;
 inspectDispatch(dispatchId:string):RoutineDispatchStatus|Promise<RoutineDispatchStatus>;
 isTargetBusy(target:RoutineTarget):boolean;
 validateTarget(target:RoutineTarget):boolean;
}
export interface RoutineSchedulerOptions {now?:()=>number;pollMs?:number;onError?:(error:unknown)=>void}
export class RoutineScheduler {
 private timer:ReturnType<typeof setInterval>|undefined;private stopped=true;private ticking:Promise<void>|undefined;private readonly pending=new Set<string>();
 constructor(private readonly store:RoutineStore,private readonly port:RoutineSchedulerPort,private readonly options:RoutineSchedulerOptions={}){}
 async start():Promise<void>{if(!this.stopped)return;const ms=this.options.pollMs??15000;if(!Number.isInteger(ms)||ms<1000||ms>60000)throw Error('Invalid routine poll interval');this.stopped=false;try{await this.reconcile();if(this.stopped)return;this.timer=setInterval(()=>{void this.tick().catch(e=>this.report(e));},ms);this.timer.unref?.();await this.tick();}catch(e){this.stop();throw e;}}
 stop():void{this.stopped=true;if(this.timer)clearInterval(this.timer);this.timer=undefined;}
 private report(e:unknown){try{this.options.onError?.(e);}catch{/* reporting does not dispatch work */}}
 async reconcile():Promise<void>{for(const r of this.store.reservations()){if(!['reserved','running'].includes(r.status)||this.pending.has(r.dispatchId))continue;let status:RoutineDispatchStatus;try{status=await this.port.inspectDispatch(r.dispatchId);}catch{status='unknown';}if(status==='running')this.store.markRunning(r.dispatchId);else if(status==='completed'||status==='failed')this.store.settle(r.dispatchId,{status});else this.store.markUnknown(r.dispatchId);}}
 tick():Promise<void>{if(this.ticking)return this.ticking;const work=this.runTick();this.ticking=work;void work.finally(()=>{if(this.ticking===work)this.ticking=undefined;}).catch(()=>{});return work;}
 private async runTick(){if(this.stopped)return;await this.reconcile();if(this.stopped)return;const now=this.options.now?.()??Date.now();
  for(const r of this.store.list().sort((a,b)=>(a.nextRunAt??'').localeCompare(b.nextRunAt??''))){if(this.stopped)return;if(!r.enabled||!r.nextRunAt||Date.parse(r.nextRunAt)>now)continue;
   try{if(!this.port.validateTarget(r.target)){this.store.skip(r.id,r.revision,now,'실행 대상이 없거나 사용할 수 없어 이번 일정을 건너뛰었습니다.');continue;}if(this.port.isTargetBusy(r.target)||this.store.reservations().some(v=>['reserved','running','unknown'].includes(v.status)&&(v.routineId===r.id||(v.target.kind===r.target.kind&&v.target.id===r.target.id)))){this.store.skip(r.id,r.revision,now,'이 대상의 작업이 진행 중이므로 이번 일정을 건너뛰었습니다.');continue;}
    const reservation=this.store.reserve(r.id,r.revision,this.port.allocateDispatchId(),now);if(!reservation)continue;this.store.markRunning(reservation.dispatchId);this.pending.add(reservation.dispatchId);
    // No await here: each durable reservation joins the existing host queue. The
    // adapter promise must settle only after its queued work has actually ended.
    void Promise.resolve().then(()=>this.port.dispatchReserved(reservation)).then(outcome=>this.store.settle(reservation.dispatchId,outcome),()=>this.store.markUnknown(reservation.dispatchId)).catch(e=>this.report(e)).finally(()=>this.pending.delete(reservation.dispatchId));
   }catch(e){this.report(e);}
  }
 }
}
