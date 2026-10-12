import assert from 'node:assert/strict';
import test from 'node:test';
import React from 'react';
import {build} from 'esbuild';
import {setImmediate as tick} from 'node:timers/promises';
let slots=[],cursor=0,invoke=async()=>{};
const hooks={...React,useState(initial){const i=cursor++;if(!(i in slots))slots[i]=typeof initial==='function'?initial():initial;return[slots[i],value=>{slots[i]=typeof value==='function'?value(slots[i]):value;}];},useRef(initial){const i=cursor++;if(!(i in slots))slots[i]={current:initial};return slots[i];},useEffect(){}};
const passthrough=({children})=>children;
globalThis.window={React:hooks,ReactDOM:{createRoot:()=>({render(){}})},VDS:{VDSProvider:passthrough,Button:passthrough,Icon:passthrough,Badge:passthrough,TextInput:passthrough,TextArea:passthrough,Checkbox:passthrough,Dialog:{Root:passthrough,Portal:passthrough,Content:passthrough,Header:passthrough,Footer:passthrough}},venditbot:{invoke:(...args)=>invoke(...args),onEvent:()=>()=>{}}};globalThis.document={getElementById:()=>({})};
async function bundle(path){const result=await build({entryPoints:[new URL(path,import.meta.url).pathname],bundle:true,platform:'node',format:'esm',jsx:'transform',jsxFactory:'React.createElement',jsxFragment:'React.Fragment',write:false});return import(`data:text/javascript;base64,${Buffer.from(result.outputFiles[0].text).toString('base64')}`);}
const {App}=await bundle('../frontend/venditbot/app.tsx');
const {MessageHeader,ConnectionAttempts}=await bundle('../frontend/venditbot/message-header.tsx');
const {routineEditDrafts,blankRoutine,routineInput}=await bundle('../frontend/venditbot/routine-drafts.ts');
const {LocalDraftStore}=await bundle('../frontend/venditbot/draft-storage.ts');
const {reduceStateEvent}=await bundle('../frontend/venditbot/ui-state.ts');
const nodes=n=>Array.isArray(n)?n.flatMap(nodes):React.isValidElement(n)?[n,...nodes(n.props.children)]:[];
const text=n=>Array.isArray(n)?n.map(text).join(''):React.isValidElement(n)?text(n.props.children):typeof n==='string'||typeof n==='number'?String(n):'';
const button=(tree,label)=>nodes(tree).find(n=>n.props.onPress&&text(n)===label);
const component=(tree,name)=>nodes(tree).find(n=>n.type?.name===name);
const disk=()=>{const values=new Map();return{getItem:k=>values.get(k)??null,setItem:(k,v)=>values.set(k,v)};};
const agent={id:'agent',name:'검토 에이전트',instructions:'검토',connectionId:'api',model:'model',createdAt:'2026-01-01',updatedAt:'2026-01-01'};
const team={id:'team',name:'검토 팀',instructions:'',memberAgentIds:['agent'],rounds:1,createdAt:'2026-01-01',updatedAt:'2026-01-01'};
const state={version:'fixture',profiles:[],agents:[agent],teams:[team],sessions:[],queue:{running:[],queued:[]},activeRun:null,routines:[]};
const routine={id:'routine',name:'아침 확인',prompt:'상태 확인',target:{kind:'agent',id:'agent'},schedule:{kind:'calendar',time:'09:00',timezone:'Asia/Seoul'},enabled:true,revision:1,createdAt:'2026-10-12T00:00:00.000Z',updatedAt:'2026-10-12T00:00:00.000Z',nextRunAt:'2026-10-13T00:00:00.000Z'};
function fixture(initialState=state,storage=disk(),props={}){slots=[];window.localStorage=storage;invoke=async()=>initialState;return()=>{cursor=0;return App({initialState,initialView:'routines',...props});};}
const view=render=>component(render(),'RoutinesView');
function fill(render){view(render).props.onEdit('new');let p=view(render).props;p.onChange({...p.record,draft:{...p.record.draft,name:'상태 확인',prompt:'서비스 상태를 확인해 줘',targetId:'agent'}});return view(render).props;}

test('message header is compact and both dialogs retain policy, fallback failures, exact routes and live state',()=>{
 slots=[];let message={id:'m',role:'assistant',status:'running',text:'',routeSelection:{policyName:'상태 정책',taskKind:'routine',reason:'짧은 상태 확인',connections:[{connectionId:'codex',model:'pinned',effort:'high'}],efficiency:{maxHistoryTurns:1,maxHistoryCharacters:4000},warning:'정책 경고'},attempts:[{connectionId:'codex',model:'first',status:'failed',error:'원래 오류 보존'},{connectionId:'claude-code',model:'second',status:'running'}]};
 const render=()=>{cursor=0;return MessageHeader({message,connectionName:id=>id==='codex'?'Codex':'Claude'});};let tree=render(),heading=nodes(tree).find(n=>n.props.className?.startsWith('message-heading'));
 assert.match(text(heading),/^벤디트봇작업 정책/);assert.doesNotMatch(text(heading),/Codex|Claude/);assert.match(text(heading),/연결 2회 · 시도 중 · 실패 1/);
 button(heading,'작업 정책').props.onPress();tree=render();assert.match(text(tree),/상태 정책.*짧은 상태 확인.*pinned.*high.*4,000.*정책 경고/);
 const connectionButton=nodes(tree).find(n=>n.props['aria-label']?.startsWith('실제 연결 시도'));connectionButton.props.onPress();tree=render();let details=component(tree,'ConnectionAttempts');assert.match(text(ConnectionAttempts(details.props)),/Codex · first.*실패.*원래 오류 보존.*Claude · second.*시도 중/);
 message={...message,attempts:[message.attempts[0],{...message.attempts[1],status:'completed'}]};details=component(render(),'ConnectionAttempts');assert.match(text(ConnectionAttempts(details.props)),/응답 완료/);assert.equal(message.attempts[0].error,'원래 오류 보존');
});

test('partial routine forms persist without scheduling or losing invalid incomplete input',()=>{
 const storage=disk(),record=blankRoutine({kind:'team',id:'team'});record.draft.minutes='';record.draft.time='';record.draft.weekdays=[];record.draft.prompt='아직 작성 중';
 const first=new LocalDraftStore(storage,'routine-edits',{},routineEditDrafts);first.set({new:record});assert.equal(first.error,undefined);const restored=new LocalDraftStore(storage,'routine-edits',{},routineEditDrafts);assert.deepEqual(restored.value.new,record);assert.throws(()=>routineInput(record.draft));
 assert.equal(routineEditDrafts(JSON.parse('{"__proto__":{}}')),undefined);
});

test('interval/calendar requests honor shared limits, timezone and weekday semantics',()=>{
 const r=blankRoutine();Object.assign(r.draft,{name:'루틴',prompt:'확인',targetId:'agent',scheduleKind:'interval',minutes:'1'});assert.deepEqual(routineInput(r.draft).schedule,{kind:'interval',minutes:1});
 for(const minutes of ['', '0','1.5','525601'])assert.throws(()=>routineInput({...r.draft,minutes}));
 const calendar={...r.draft,scheduleKind:'calendar',time:'09:30',timezone:'Asia/Seoul',weekdays:[1,3,5]};assert.deepEqual(routineInput(calendar).schedule,{kind:'calendar',time:'09:30',timezone:'Asia/Seoul',weekdays:[1,3,5]});assert.throws(()=>routineInput({...calendar,timezone:'not/a-zone'}));assert.throws(()=>routineInput({...calendar,weekdays:[]}));assert.throws(()=>routineInput({...calendar,prompt:'x'.repeat(20001)}));
});

test('agent-scoped entry preselects target and routine drafts are recoverable after remount',()=>{
 const storage=disk();let render=fixture(state,storage,{initialView:'chat',initialAgentId:'agent'}),tree=render();button(tree,'에이전트 루틴').props.onPress();assert.deepEqual(view(render).props.filter,{kind:'agent',id:'agent'});view(render).props.onEdit('new');let p=view(render).props;assert.equal(p.record.draft.targetId,'agent');p.onChange({...p.record,draft:{...p.record.draft,name:'보관한 루틴',prompt:'아직 저장 전'}});
 render=fixture(state,storage);tree=render();assert.match(text(tree),/초안 1개/);button(tree,'초안 보기').props.onPress();const recovery=component(render(),'DraftRecovery'),entry=recovery.props.extras.find(e=>e.label==='루틴 · 보관한 루틴');assert.ok(entry);entry.onContinue();assert.equal(view(render).props.record.draft.prompt,'아직 저장 전');
});

test('create uses persisted request ID, unknown-outcome retry reuses it, and only confirmed success clears submitted draft',async()=>{
 const storage=disk(),render=fixture(state,storage);fill(render);const calls=[];let fails=true;
 invoke=async(method,args)=>{calls.push([method,args]);if(method==='saveRoutine'){if(fails)throw Error('응답 확인 불가');return {...routine,...args.routine,id:'created'};}return state;};
 view(render).props.onSave();await tick();assert.equal(calls[0][0],'saveRoutine');const key=calls[0][1].requestId;assert.match(key,/^[a-f0-9-]{36}$/);assert.equal(calls[0][1].expectedRevision,undefined);assert.ok(view(render).props.record);fails=false;view(render).props.onSave();await tick();const saves=calls.filter(c=>c[0]==='saveRoutine');assert.equal(saves[1][1].requestId,key);assert.deepEqual(JSON.parse(storage.getItem('venditbot.drafts.v1.routine-edits')),{});
});

test('save double click is deduplicated; late acknowledgment keeps newly typed draft',async()=>{
 const storage=disk(),render=fixture(state,storage);fill(render);let finish;const calls=[];invoke=async(method,args)=>{calls.push([method,args]);if(method==='saveRoutine')return new Promise(r=>{finish=()=>r({...routine,...args.routine,id:'created'});});return {...state,routines:[routine]};};
 const p=view(render).props;p.onSave();p.onSave();assert.equal(calls.length,1);let current=view(render).props;current.onChange({...current.record,draft:{...current.record.draft,prompt:'응답을 기다리며 추가 입력'}});finish();await tick();const records=JSON.parse(storage.getItem('venditbot.drafts.v1.routine-edits'));assert.equal(Object.values(records)[0].draft.prompt,'응답을 기다리며 추가 입력');assert.equal(Object.values(records)[0].draft.id,'created');
});

test('edit and toggle use expected revision; delete does not invoke cancellation and preserves local drafts',async()=>{
 const snapshot={...state,routines:[routine],queue:{running:['existing'],queued:[]}},render=fixture(snapshot),calls=[];view(render).props.onEdit(routine.id);let p=view(render).props;assert.equal(p.record.expectedRevision,1);p.onChange({...p.record,draft:{...p.record.draft,prompt:'초안 유지'}});
 invoke=async(method,args)=>{calls.push([method,args]);if(method==='setRoutineEnabled')return {...routine,enabled:false,revision:2};if(method==='deleteRoutine')return{id:routine.id,deleted:true};return {...snapshot,routines:[{...routine,enabled:false,revision:2}]};};
 view(render).props.onToggle(routine);await tick();assert.deepEqual(calls[0],['setRoutineEnabled',{id:routine.id,enabled:false,expectedRevision:1}]);assert.match(view(render).props.conflict,/변경/);
 const current={...routine,enabled:false,revision:2};view(render).props.onDelete(current);view(render).props.onConfirmDelete();await tick();assert.ok(calls.some(c=>c[0]==='deleteRoutine'&&c[1].expectedRevision===2));assert.equal(calls.some(c=>/cancel|start|send/.test(c[0])),false);assert.equal(view(render).props.record.draft.prompt,'초안 유지');
});

test('routines event updates scheduling status without changing queued work or transcript',()=>{
 const snapshot={...state,sessions:[{id:'session',messages:[{text:'keep'}]}],queue:{running:['session'],queued:['next']}};const next=reduceStateEvent(snapshot,{type:'routines',routines:[{...routine,lastStatus:'unknown',lastError:'실행 결과 확인 필요'}]});assert.equal(next.sessions,snapshot.sessions);assert.equal(next.queue,snapshot.queue);assert.equal(next.routines[0].lastStatus,'unknown');
});

test('scheduler error stays visible without discarding a routine form or active work',()=>{
 const snapshot=reduceStateEvent({...state,routines:[routine]},{type:'routine-error',error:'저장소를 확인해야 합니다'});assert.equal(snapshot.routineError,'저장소를 확인해야 합니다');const render=fixture(snapshot);fill(render);const p=view(render).props;assert.equal(p.routineError,'저장소를 확인해야 합니다');assert.equal(p.record.draft.prompt,'서비스 상태를 확인해 줘');
});

test('app connection control sits beside brand and its pending or secret input blocks application update',async()=>{
 const render=fixture({...state,update:{phase:'available',currentVersion:'0.3.9',version:'next'}});let tree=render(),brand=nodes(tree).find(n=>n.props.className==='brand');assert.ok(button(brand,'앱 연결'));assert.equal(component(tree,'AppConnectionsDialog').props.open,false);button(brand,'앱 연결').props.onPress();tree=render();let dialog=component(tree,'AppConnectionsDialog');assert.equal(dialog.props.open,true);dialog.props.onGuard({dirty:true,pending:false});tree=render();assert.match(component(tree,'UpdateControl').props.blockedReason,/앱 연결 등록 설정/);let calls=0;invoke=async()=>{calls++;};component(tree,'UpdateControl').props.onInstall();await tick();assert.equal(calls,0);component(render(),'AppConnectionsDialog').props.onGuard({dirty:false,pending:true});assert.match(component(render(),'UpdateControl').props.blockedReason,/공식 승인/);
});


test('unknown execution requires explicit future-only acknowledgement with the captured revision',async()=>{
 const unknown={...routine,enabled:false,lastStatus:'unknown',revision:7},render=fixture({...state,routines:[unknown]}),calls=[];
 invoke=async(method,args)=>{calls.push([method,args]);return method==='setRoutineEnabled'?{...unknown,enabled:true,lastStatus:'skipped',revision:8}:{...state,routines:[unknown]};};
 view(render).props.onToggle(unknown);await tick();assert.equal(calls.length,0);assert.equal(view(render).props.acknowledging.revision,7);view(render).props.onCancelAcknowledge();assert.equal(view(render).props.acknowledging,undefined);view(render).props.onToggle(unknown);view(render).props.onConfirmAcknowledge();await tick();assert.deepEqual(calls[0],['setRoutineEnabled',{id:'routine',enabled:true,expectedRevision:7}]);assert.equal(view(render).props.acknowledging,undefined);assert.equal(calls.some(c=>/cancel|start|send/.test(c[0])),false);
});

test('reserved, running and unknown routines cannot be deleted from the card',async()=>{
 const {RoutinesView}=await bundle('../frontend/venditbot/routines-ui.tsx');
 for(const lastStatus of ['reserved','running','unknown','completed']){const r={...routine,lastStatus};const tree=RoutinesView({routines:[r],agents:[agent],teams:[team],editKey:'',busy:false});const card=nodes(tree).find(n=>n.props['aria-label']==='루틴 아침 확인');assert.equal(button(card,'삭제').props.disabled,lastStatus!=='completed');assert.match(text(tree),/실행 중이거나 결과 확인이 필요한 루틴은 삭제할 수 없습니다/);}
});
