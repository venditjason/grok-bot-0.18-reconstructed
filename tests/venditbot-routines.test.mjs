import assert from 'node:assert/strict';
import test from 'node:test';
import {mkdtempSync,readFileSync,writeFileSync,rmSync,mkdirSync,symlinkSync,statSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {randomUUID} from 'node:crypto';
import {setImmediate as turn} from 'node:timers/promises';
import {build} from 'esbuild';
const built=await build({stdin:{contents:"export * from './source/shared/routines.ts';export * from './source/venditbot/routine-store.ts';export * from './source/venditbot/routine-scheduler.ts';export * from './source/venditbot/routine-tools.ts';",resolveDir:process.cwd()},bundle:true,platform:'node',format:'esm',write:false});
const {RoutineStore,RoutineScheduler,RoutineTools,normalizeRoutineInput,normalizeRoutineSchedule,nextRoutineRunAt}=await import('data:text/javascript;base64,'+Buffer.from(built.outputFiles[0].text+'\n//# sourceURL=venditbot-routines-test-bundle.mjs').toString('base64'));
const draft=(target='agent-one')=>({name:'Daily work',prompt:'Review current work and report findings.',target:{kind:'agent',id:target},schedule:{kind:'interval',minutes:1},enabled:true});
const pending=()=>{let resolve,reject;const promise=new Promise((a,b)=>{resolve=a;reject=b;});return {promise,resolve,reject};};
function fixture(t){const root=mkdtempSync(join(tmpdir(),'vendit-routines-test-'));t.after(()=>rmSync(root,{recursive:true,force:true}));let now=Date.parse('2026-10-12T00:00:00.000Z');const changes=[];const store=new RoutineStore(root,{now:()=>now,onChange:r=>changes.push(r)});return {root,store,changes,now:()=>now,advance:ms=>{now+=ms;},create:(input=draft(),requestId=randomUUID())=>store.save({routine:input,requestId})};}
test('closed routine inputs validate bounds, targets, timezones and weekdays',()=>{
 assert.deepEqual(normalizeRoutineInput({...draft(),name:'  trimmed  '}).name,'trimmed');
 for(const minutes of [0,1.5,525601,NaN])assert.throws(()=>normalizeRoutineSchedule({kind:'interval',minutes}));
 for(const change of [{timezone:'Not/A_Zone'},{time:'24:00'},{weekdays:[]},{weekdays:[1,1]},{weekdays:[7]}])assert.throws(()=>normalizeRoutineSchedule({kind:'calendar',time:'09:30',timezone:'Asia/Seoul',...change}));
 for(const change of [{id:''},{prompt:''},{name:'x\n'},{enabled:1},{target:{kind:'all',id:'anything'}},{nextRunAt:'forged'}])assert.throws(()=>normalizeRoutineInput({...draft(),...change}));
 assert.deepEqual(normalizeRoutineSchedule({kind:'calendar',time:'09:30',timezone:'Asia/Seoul',weekdays:[5,1]}).weekdays,[1,5]);
 assert.throws(()=>normalizeRoutineInput({...draft(),target:{kind:'team',id:'team'},prompt:'x'.repeat(8001)}),e=>e.code==='routine_team_prompt_limit');
});
test('calendar is explicit-zone, supports fractional offsets and selects weekdays',()=>{
 assert.equal(nextRoutineRunAt({kind:'calendar',time:'09:00',timezone:'Asia/Seoul'},Date.parse('2026-10-11T23:59:00Z')),'2026-10-12T00:00:00.000Z');
 assert.equal(nextRoutineRunAt({kind:'calendar',time:'09:00',timezone:'Asia/Kathmandu'},Date.parse('2026-10-12T00:00:00Z')),'2026-10-12T03:15:00.000Z');
 assert.equal(nextRoutineRunAt({kind:'calendar',time:'09:00',timezone:'UTC',weekdays:[1]},Date.parse('2026-10-12T09:00:00Z')),'2026-10-19T09:00:00.000Z');
});
test('DST gap skips a nonexistent clock time and fall fold fires only its first occurrence',()=>{
 assert.equal(nextRoutineRunAt({kind:'calendar',time:'02:30',timezone:'America/New_York'},Date.parse('2026-03-08T05:00:00Z')),'2026-03-09T06:30:00.000Z');
 assert.equal(nextRoutineRunAt({kind:'calendar',time:'01:30',timezone:'America/New_York'},Date.parse('2026-11-01T04:00:00Z')),'2026-11-01T05:30:00.000Z');
 assert.equal(nextRoutineRunAt({kind:'calendar',time:'01:30',timezone:'America/New_York'},Date.parse('2026-11-01T05:30:00Z')),'2026-11-02T06:30:00.000Z');
 assert.equal(nextRoutineRunAt({kind:'calendar',time:'02:30',timezone:'Australia/Lord_Howe'},Date.parse('2026-10-03T12:00:00Z')),'2026-10-03T15:30:00.000Z');
});
test('interval skips missed slots while retaining cadence and never returns the present instant',()=>{
 const anchor=Date.parse('2026-10-12T00:00:00Z');assert.equal(nextRoutineRunAt({kind:'interval',minutes:5},anchor+31*60000,anchor),'2026-10-12T00:35:00.000Z');
});
test('durable create receipt retries once, rejects changed input, and never recreates a deleted routine',t=>{
 const f=fixture(t),requestId=randomUUID(),one=f.create(draft(),requestId);assert.equal(f.create(draft(),requestId).id,one.id);assert.equal(new RoutineStore(f.root).list().length,1);assert.equal(statSync(join(f.root,'routines.json')).mode&0o777,0o600);
 assert.throws(()=>f.create({...draft(),name:'changed'},requestId),e=>e.code==='routine_request_conflict');f.store.remove(one.id,one.revision);assert.throws(()=>f.create(draft(),requestId),e=>e.code==='routine_deleted');assert.equal(f.store.list().length,0);
});
test('CAS checks disk across store instances and does not overwrite a changed configuration',t=>{
 const f=fixture(t),a=f.create(),other=new RoutineStore(f.root);const changed=other.setEnabled(a.id,false,a.revision);assert.throws(()=>f.store.save({routine:{...draft(),id:a.id},expectedRevision:a.revision}),e=>e.code==='routine_revision_conflict'&&e.latest.revision===changed.revision);assert.equal(f.store.get(a.id).enabled,false);
});
test('corrupt JSON and unsafe storage entries remain byte-for-byte untouched',t=>{
 const f=fixture(t);f.create();const file=join(f.root,'routines.json');writeFileSync(file,'{broken');assert.throws(()=>new RoutineStore(f.root),e=>e.code==='routine_storage_corrupt');assert.throws(()=>f.create(),e=>e.code==='routine_storage_corrupt');assert.equal(readFileSync(file,'utf8'),'{broken');
 rmSync(file);const external=join(f.root,'external');writeFileSync(external,'keep',{mode:0o600});symlinkSync(external,file);assert.throws(()=>new RoutineStore(f.root));assert.equal(readFileSync(external,'utf8'),'keep');
});
test('live storage lock refuses competing writes rather than removing a lock',t=>{
 const f=fixture(t);const lock=join(f.root,'routines.json.lock');mkdirSync(lock,{mode:0o700});writeFileSync(join(lock,'owner.json'),JSON.stringify({pid:process.pid}),{mode:0o600});assert.throws(()=>f.create(),e=>e.code==='routine_storage_busy');assert.equal(JSON.parse(readFileSync(join(lock,'owner.json'))).pid,process.pid);
});
test('reservation is durable, snapshots config and fences both routine and target across edits/deletion',t=>{
 const f=fixture(t),one=f.create(),two=f.create();f.advance(60000);const reservation=f.store.reserve(one.id,one.revision,'dispatch-1',f.now());assert.equal(reservation.prompt,one.prompt);assert.equal(new RoutineStore(f.root).reservations()[0].dispatchId,'dispatch-1');assert.equal(f.store.reserve(two.id,two.revision,'dispatch-2',f.now()),undefined);
 const edited=f.store.save({routine:{...draft('new-target'),id:one.id,prompt:'new prompt'},expectedRevision:one.revision});assert.equal(f.store.reservations()[0].prompt,one.prompt);assert.throws(()=>f.store.remove(one.id,edited.revision),e=>e.code==='routine_active_execution');const paused=f.store.setEnabled(one.id,false,edited.revision);assert.equal(f.store.reservations()[0].status,'reserved');f.store.settle('dispatch-1',{status:'completed'});f.store.remove(one.id,paused.revision);assert.ok(f.store.reserve(two.id,two.revision,'dispatch-2',f.now()));
});
test('unknown outcomes disable without replay; explicit enable acknowledges only future occurrences',t=>{
 const f=fixture(t),one=f.create();f.advance(60000);f.store.reserve(one.id,one.revision,'dispatch');f.store.markUnknown('dispatch');const unknown=f.store.get(one.id);assert.equal(unknown.enabled,false);assert.equal(unknown.lastStatus,'unknown');assert.equal(unknown.nextRunAt,undefined);assert.throws(()=>f.store.remove(one.id,unknown.revision),e=>e.code==='routine_unknown_outcome');
 const enabled=f.store.setEnabled(one.id,true,unknown.revision);assert.equal(enabled.nextRunAt,new Date(f.now()+60000).toISOString());assert.equal(f.store.reservations()[0].status,'acknowledged');assert.equal(f.store.reserve(one.id,enabled.revision,'different',f.now()),undefined);
});
function scheduler(f,overrides={}){const calls=[],jobs=new Map();const port={allocateDispatchId:()=>randomUUID(),validateTarget:()=>true,isTargetBusy:()=>false,inspectDispatch:()=> 'unknown',dispatchReserved:r=>{assert.ok(new RoutineStore(f.root).reservations().some(v=>v.dispatchId===r.dispatchId));calls.push(r);const job=pending();jobs.set(r.dispatchId,job);return job.promise;},...overrides};const clock=new RoutineScheduler(f.store,port,{now:f.now,pollMs:60000});return {clock,port,calls,jobs};}
test('scheduler reserves before dispatch and launches distinct targets without waiting for full job settlement',async t=>{
 const f=fixture(t);f.create(draft('one'));f.create(draft('two'));f.advance(60000);const s=scheduler(f);t.after(()=>s.clock.stop());await s.clock.start();await turn();assert.equal(s.calls.length,2);const a=s.clock.tick(),b=s.clock.tick();assert.equal(a,b);await a;assert.equal(s.calls.length,2);s.clock.stop();for(const job of s.jobs.values())job.resolve({status:'completed'});await turn();assert.ok(f.store.list().every(r=>r.lastStatus==='completed'));
});
test('same-target and manual busy work coalesce missed schedules without a replay storm',async t=>{
 const f=fixture(t);f.create();f.create();f.create(draft('manual'));f.advance(24*60*60000);const s=scheduler(f,{isTargetBusy:target=>target.id==='manual'});t.after(()=>s.clock.stop());await s.clock.start();await turn();assert.equal(s.calls.length,1);assert.ok(f.store.list().every(r=>Date.parse(r.nextRunAt)>f.now()));s.clock.stop();for(const job of s.jobs.values())job.resolve({status:'completed'});await turn();
});
test('startup reconciles every durable reservation but never resubmits missing dispatch IDs',async t=>{
 const f=fixture(t),a=f.create();f.advance(60000);f.store.reserve(a.id,a.revision,'crash-before-queue');const s=scheduler(f);t.after(()=>s.clock.stop());await s.clock.start();assert.equal(s.calls.length,0);assert.equal(f.store.get(a.id).lastStatus,'unknown');assert.equal(f.store.get(a.id).enabled,false);
});
test('ambiguous adapter throw remains unknown; confirmed failed settlement releases reservation',async t=>{
 for(const ambiguous of [true,false]){const f=fixture(t),a=f.create();f.advance(60000);const s=scheduler(f,{dispatchReserved:async()=>{if(ambiguous)throw Error('unknown');return {status:'failed',error:'known failure'};}});t.after(()=>s.clock.stop());await s.clock.start();await turn();assert.equal(f.store.get(a.id).lastStatus,ambiguous?'unknown':'failed');assert.equal(f.store.get(a.id).enabled,!ambiguous);}
});
test('reservation persistence failure cannot start work and startup inspection never retries it',async t=>{
 const f=fixture(t),a=f.create();f.advance(60000);const s=scheduler(f);t.after(()=>s.clock.stop());
 const markRunning=f.store.markRunning.bind(f.store);f.store.markRunning=()=>{throw Error('simulated disk failure after reservation');};
 await s.clock.start();await turn();assert.equal(s.calls.length,0);assert.equal(f.store.reservations()[0].status,'reserved');
 f.store.markRunning=markRunning;await s.clock.tick();assert.equal(s.calls.length,0);assert.equal(f.store.get(a.id).lastStatus,'unknown');assert.equal(f.store.get(a.id).enabled,false);
});
test('stopping while asynchronous reconciliation waits prevents new dispatch',async t=>{
 const f=fixture(t),a=f.create();f.advance(60000);f.store.reserve(a.id,a.revision,'known-running');f.create(draft('different'));f.advance(60000);
 const gate=pending(),s=scheduler(f,{inspectDispatch:()=>gate.promise});const start=s.clock.start();await turn();s.clock.stop();gate.resolve('completed');await start;assert.equal(s.calls.length,0);assert.equal(f.store.get(a.id).lastStatus,'completed');
});
function toolFixture(t){const f=fixture(t);let leader=true,authorized=true;const source={sessionId:'session',agentId:'self',teamId:'team'},controller=new AbortController();const port={list:()=>f.store.list(),save:r=>f.store.save(r),setEnabled:(...a)=>f.store.setEnabled(...a),remove:(...a)=>f.store.remove(...a),isCurrentTeamLeader:()=>leader,authorizeMutation:()=>authorized};const tools=new RoutineTools(port,source,controller.signal);return {...f,tools,port,source,controller,setLeader:v=>leader=v,setAuthorized:v=>authorized=v};}
const toolDraft=()=>({...draft(),target:'self',userRequest:'Please create a recurring routine.'});
test('agent tools enforce self/current leader scope, explicit trusted authorization and no provider overrides',async t=>{
 const f=toolFixture(t);const created=await f.tools.execute('create_routine',toolDraft(),'call');assert.equal(created.routine.target.id,'self');f.source.agentId='foreign';assert.equal((await f.tools.execute('list_routines',{},'list')).routines.length,1);
 for(const raw of [{...toolDraft(),target:{kind:'agent',id:'other'}},{...toolDraft(),model:'override'},{...toolDraft(),userRequest:''}])await assert.rejects(f.tools.execute('create_routine',raw,randomUUID()));
 f.setAuthorized(false);await assert.rejects(f.tools.execute('create_routine',toolDraft(),'denied'),e=>e.code==='routine_not_authorized');f.setAuthorized(true);f.setLeader(false);await assert.rejects(f.tools.execute('create_routine',{...toolDraft(),target:'team'},'not-leader'),e=>e.code==='routine_tool_scope');assert.equal(f.store.list().length,1);
});
test('tool call retries are identical and create idempotency survives a reconstructed turn capability',async t=>{
 const f=toolFixture(t),raw=toolDraft(),one=f.tools.execute('create_routine',raw,'same');assert.equal(f.tools.execute('create_routine',raw,'same'),one);await one;await assert.rejects(f.tools.execute('create_routine',{...raw,name:'different'},'same'),e=>e.code==='routine_call_conflict');
 const again=new RoutineTools(f.port,{sessionId:'session',agentId:'self',teamId:'team'});await again.execute('create_routine',raw,'same');assert.equal(f.store.list().length,1);
});
test('team leadership is rechecked after asynchronous authorization; cancellation prevents mutation',async t=>{
 const f=toolFixture(t),gate=pending();f.port.authorizeMutation=()=>gate.promise;const attempt=f.tools.execute('create_routine',{...toolDraft(),target:'team'},'leader-change');await turn();f.setLeader(false);gate.resolve(true);await assert.rejects(attempt,e=>e.code==='routine_tool_scope');assert.equal(f.store.list().length,0);
 const g=toolFixture(t);const cancelled=g.tools.execute('create_routine',toolDraft(),'cancel');g.controller.abort();await assert.rejects(cancelled,{name:'AbortError'});assert.equal(g.store.list().length,0);
});
