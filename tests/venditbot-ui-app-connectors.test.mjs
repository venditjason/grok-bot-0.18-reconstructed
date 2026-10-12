import assert from 'node:assert/strict';
import test from 'node:test';
import React from 'react';
import {build} from 'esbuild';
import {setImmediate as tick} from 'node:timers/promises';
let slots=[],cursor=0,effects=[];
const hooks={...React,useState(initial){const i=cursor++;if(!(i in slots))slots[i]=typeof initial==='function'?initial():initial;return[slots[i],v=>{slots[i]=typeof v==='function'?v(slots[i]):v;}];},useRef(initial){const i=cursor++;if(!(i in slots))slots[i]={current:initial};return slots[i];},useEffect(effect,deps){const i=cursor++;if(!(i in slots)||deps?.some((d,j)=>d!==slots[i]?.[j])){slots[i]=deps;effects.push(effect);}}};
const passthrough=({children})=>children;
globalThis.window={React:hooks,VDS:{Button:passthrough,Badge:passthrough,TextInput:passthrough,Checkbox:passthrough,Dialog:{Root:passthrough,Portal:passthrough,Content:passthrough,Header:passthrough,Footer:passthrough}},venditbot:{onEvent:()=>()=>{}}};
const result=await build({entryPoints:[new URL('../frontend/venditbot/app-connections-ui.tsx',import.meta.url).pathname],bundle:true,platform:'node',format:'esm',jsx:'transform',jsxFactory:'React.createElement',jsxFragment:'React.Fragment',write:false});const {AppConnectionsDialog}=await import(`data:text/javascript;base64,${Buffer.from(result.outputFiles[0].text).toString('base64')}`);
const shared=await build({entryPoints:[new URL('../source/shared/app-connectors.ts',import.meta.url).pathname],bundle:true,platform:'node',format:'esm',write:false});const {APP_CONNECTORS}=await import(`data:text/javascript;base64,${Buffer.from(shared.outputFiles[0].text).toString('base64')}`);
const nodes=n=>Array.isArray(n)?n.flatMap(nodes):React.isValidElement(n)?[n,...nodes(n.props.children)]:[];
const text=n=>Array.isArray(n)?n.map(text).join(''):React.isValidElement(n)?text(n.props.children):typeof n==='string'||typeof n==='number'?String(n):'';
const button=(tree,label)=>nodes(tree).find(n=>n.props.onPress&&text(n)===label);
const input=(tree,label)=>nodes(tree).find(n=>n.props['aria-label']===label);
const section=(tree,id)=>nodes(tree).find(n=>n.props['aria-label']===APP_CONNECTORS.find(c=>c.id===id).label+' 연결');
function fixture(overrides={}){
 slots=[];effects=[];const calls=[],guards=[],closed=[];
 let values=APP_CONNECTORS.map(c=>({...c,status:'setup_required',configured:false,hasCredential:false,...overrides[c.id]})),handler=async()=>values;
 const render=()=>{cursor=0;return AppConnectionsDialog({open:true,onOpenChange:v=>closed.push(v),invoke:async(method,args)=>{calls.push([method,args]);return handler(method,args);},onGuard:g=>guards.push(g)});};
 async function load(){button(render(),'상태 새로고침').props.onPress();await tick();return render();}
 return{render,load,calls,guards,closed,setHandler:fn=>{handler=fn;},setValues:next=>{values=next;},get values(){return values;},flushGuard(){for(const e of effects.splice(0)){/* Only guard effect, never start polling/native work in this hook test. */const source=String(e);if(source.includes('onGuard'))e();}}};
}

test('connections require host state and never fabricate connected or tested state',async()=>{
 const f=fixture();assert.doesNotMatch(text(f.render()),/인증 연결됨|검사 · 통과/);assert.equal(f.calls.length,0);const tree=await f.load();assert.equal(f.calls[0][0],'appConnectorsList');
 for(const c of APP_CONNECTORS){const card=section(tree,c.id);assert.ok(card);assert.match(text(card),/설정 필요/);assert.equal(button(card,'공식 로그인으로 연결').props.disabled,true);assert.match(text(card),/검사 기록 없음/);}
});

test('connect is explicit scope consent and invokes only host OAuth without client token arguments',async()=>{
 const f=fixture({gmail:{configured:true,status:'disconnected'}});let tree=await f.load(),card=section(tree,'gmail');assert.equal(button(card,'공식 로그인으로 연결').props.disabled,true);input(card,'Gmail 접근 범위 동의').props.onCheckedChange(true);tree=f.render();card=section(tree,'gmail');assert.equal(button(card,'공식 로그인으로 연결').props.disabled,false);button(card,'공식 로그인으로 연결').props.onPress();await tick();assert.deepEqual(f.calls.at(-1),['appConnectorsConnect',{id:'gmail',consentAccepted:true}]);assert.equal(f.calls.some(c=>/login|send|resume/i.test(c[0])&&!c[0].startsWith('appConnectors')),false);
});

test('Docs/Sheets actual checks require a selected resource and success comes only from host test metadata',async()=>{
 const f=fixture({google_docs:{configured:true,status:'connected',hasCredential:true},google_sheets:{configured:true,status:'connected',hasCredential:true}});let tree=await f.load();for(const id of ['google_docs','google_sheets'])assert.equal(button(section(tree,id),'실제 연결 검사').props.disabled,true);
 input(section(tree,'google_docs'),'Google Docs 검사 대상 ID').props.onChange({target:{value:'chosen-document'}});f.setHandler(async(method)=>method==='appConnectorsTest'?f.values.map(c=>c.id==='google_docs'?{...c,lastTest:{ok:true,checkedAt:'2026-10-12T00:00:00.000Z',message:'문서 GET 확인',kind:'api_read'}}:c):f.values);
 button(section(f.render(),'google_docs'),'실제 연결 검사').props.onPress();await tick();assert.deepEqual(f.calls.at(-1),['appConnectorsTest',{id:'google_docs',resourceId:'chosen-document'}]);assert.match(text(section(f.render(),'google_docs')),/실제 검사 · 통과/);assert.doesNotMatch(text(section(f.render(),'google_sheets')),/실제 검사 · 통과/);
});

test('configuration secret stays in the explicit form, clears only after confirmed save, and blocks update through guard',async()=>{
 const f=fixture();button(section(await f.load(),'gmail'),'앱 등록 설정').props.onPress();let tree=f.render();input(tree,'앱 클라이언트 ID').props.onChange({target:{value:'client'}});input(tree,'앱 클라이언트 시크릿').props.onChange({target:{value:'secret-fixture'}});tree=f.render();assert.equal(input(tree,'앱 클라이언트 시크릿').props.type,'password');f.flushGuard();assert.equal(f.guards.at(-1).dirty,true);
 f.setHandler(async()=>{throw Error('안전 저장소 잠김');});button(tree,'앱 등록 저장').props.onPress();await tick();assert.equal(input(f.render(),'앱 클라이언트 시크릿').props.value,'secret-fixture');assert.doesNotMatch(text(f.render()),/secret-fixture/);
 f.setHandler(async()=>f.values);button(f.render(),'앱 등록 저장').props.onPress();await tick();assert.equal(input(f.render(),'앱 클라이언트 시크릿'),undefined);assert.deepEqual(f.calls.at(-1),['appConnectorsConfigure',{provider:'google',clientId:'client',clientSecret:'secret-fixture'}]);
});

test('disconnect is explicit and local; failed or malformed host responses cannot claim completion',async()=>{
 const f=fixture({github:{configured:true,status:'connected',hasCredential:true}});let tree=await f.load();button(section(tree,'github'),'연결 해제').props.onPress();tree=f.render();const footer=nodes(tree).find(n=>n.props.RightComponent&&text(n.props.RightComponent()).includes('이 Mac에서 연결 해제')).props.RightComponent();f.setHandler(async()=>[]);button(footer,'이 Mac에서 연결 해제').props.onPress();await tick();assert.deepEqual(f.calls.at(-1),['appConnectorsDisconnect',{id:'github'}]);assert.match(text(f.render()),/상태를 확인하지 못했습니다/);assert.ok(section(f.render(),'github'));assert.match(text(section(f.render(),'github')),/인증 연결됨/);
});

test('unknown provider or duplicate host rows are refused without losing prior view',async()=>{
 const f=fixture();await f.load();f.setHandler(async()=>[...f.values.slice(1),{...f.values[0],id:'untrusted'}]);button(f.render(),'상태 새로고침').props.onPress();await tick();assert.match(text(f.render()),/상태를 확인하지 못했습니다/);assert.ok(section(f.render(),'gmail'));
});

test('GitHub App selected repositories and OAuth public-only modes reach configure without broad repo scope',async()=>{
 const f=fixture();button(section(await f.load(),'github'),'앱 등록 설정').props.onPress();let tree=f.render();assert.equal(input(tree,'GitHub 앱 방식').props.value,'app');assert.match(text(tree),/비공개 저장소 접근은 앱 권한과 설치한 저장소/);
 input(tree,'앱 클라이언트 ID').props.onChange({target:{value:'dedicated-client'}});input(tree,'앱 클라이언트 시크릿').props.onChange({target:{value:'dedicated-secret'}});button(f.render(),'앱 등록 저장').props.onPress();await tick();assert.deepEqual(f.calls.at(-1),['appConnectorsConfigure',{provider:'github',clientId:'dedicated-client',clientSecret:'dedicated-secret',githubApp:true}]);
 button(section(f.render(),'github'),'앱 등록 설정').props.onPress();tree=f.render();input(tree,'GitHub 앱 방식').props.onChange({target:{value:'oauth'}});assert.match(text(f.render()),/비공개 저장소 접근이나 저장소 쓰기 권한은 포함하지 않습니다/);
});
