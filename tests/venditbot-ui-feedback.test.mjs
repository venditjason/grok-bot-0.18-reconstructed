import assert from 'node:assert/strict';
import {test,after} from 'node:test';
import {readFile} from 'node:fs/promises';
import {setImmediate as tick} from 'node:timers/promises';
import {Window} from 'happy-dom';
import {build} from 'esbuild';

const browser=new Window({url:'http://venditbot.test',width:1100,height:900});
globalThis.window=browser;globalThis.document=browser.document;
for(const key of ['HTMLElement','HTMLInputElement','HTMLTextAreaElement','Node','Element'])globalThis[key]=browser[key];
for(const file of ['react.js','vds.js'])browser.eval(await readFile(new URL('../frontend/venditbot/'+file,import.meta.url),'utf8'));
const React=browser.React,{createRoot,flushSync}=browser.ReactDOM;
const built=await build({entryPoints:[new URL('../frontend/venditbot/feedback-ui.tsx',import.meta.url).pathname],bundle:true,platform:'node',format:'esm',jsx:'transform',jsxFactory:'React.createElement',jsxFragment:'React.Fragment',write:false});
const {FeedbackButton,feedbackDraft,feedbackReceipt}=await import('data:text/javascript;base64,'+Buffer.from(built.outputFiles[0].text).toString('base64'));
after(()=>browser.happyDOM.abort());
const key='venditbot.drafts.v1.feedback';
const requestId='b2d61e04-e25b-4d7e-894d-7fd8bf6c5440';
const input={requestId,kind:'bug',title:'버튼 오류',description:'설정 화면에서 버튼을 누르면 응답이 없습니다.'};
const job=(submitted=input,patch={})=>({id:submitted.requestId,kind:submitted.kind,title:submitted.title,description:submitted.description,status:'queued',createdAt:'2026-10-12T08:30:00.000Z',updatedAt:'2026-10-12T08:30:00.000Z',revision:1,...patch});
const snapshot=(jobs=[],patch={})=>({configured:true,jobs,...patch});
async function settle(){await tick();await new Promise(resolve=>setTimeout(resolve,15));flushSync(()=>{});}
const click=node=>{assert.ok(node);flushSync(()=>node.click());};
const button=label=>[...document.querySelectorAll('button')].find(node=>node.textContent===label);
function change(label,value){const node=document.querySelector(`[aria-label="${label}"]`);assert.ok(node,label);const proto=node.tagName==='TEXTAREA'?browser.HTMLTextAreaElement.prototype:node.tagName==='SELECT'?browser.HTMLSelectElement.prototype:browser.HTMLInputElement.prototype;Object.getOwnPropertyDescriptor(proto,'value').set.call(node,value);flushSync(()=>node.dispatchEvent(new browser.Event(node.tagName==='SELECT'?'change':'input',{bubbles:true})));}
function fixture(t,{saved,handler}={}){
  browser.localStorage.clear();if(saved!==undefined)browser.localStorage.setItem(key,typeof saved==='string'?saved:JSON.stringify(saved));
  const host=document.createElement('div');document.body.append(host);let callback;const calls=[],opened=[],guards=[];
  let invoke=handler??(async(method,args)=>method==='submitFeedback'?job(args):snapshot());
  browser.venditbot={onEvent(fn){callback=fn;return()=>{callback=undefined;};}};
  const root=createRoot(host);
  flushSync(()=>root.render(React.createElement(browser.VDS.VDSProvider,{preferScheme:'light'},React.createElement(FeedbackButton,{invoke:async(method,args)=>{calls.push({method,args});return invoke(method,args);},onOpenReportAgent:(...args)=>opened.push(args),onGuard:guard=>guards.push(guard)}))));
  let stopped=false;const unmount=()=>{if(stopped)return;stopped=true;flushSync(()=>root.unmount());host.remove();};t.after(unmount);
  return {calls,opened,guards,unmount,setHandler:value=>{invoke=value;},event:()=>callback?.({type:'feedback'}),open:async()=>{click(document.querySelector('[aria-label="버그 신고 및 개선 요청"]'));await settle();}};
}
function fill(){change('리포트 제목',input.title);change('리포트 내용',input.description);}

test('accessible bug button opens typed dialog and persists partial input without a submission',async t=>{
  const f=fixture(t);assert.equal(document.querySelector('[aria-label="버그 신고 및 개선 요청"]').tagName,'BUTTON');await f.open();fill();change('리포트 요청 종류','request');
  const saved=JSON.parse(browser.localStorage.getItem(key));assert.equal(saved.input.kind,'request');assert.equal(saved.input.description,input.description);assert.match(saved.input.requestId,/^[0-9a-f-]{36}$/);assert.equal(f.calls.filter(c=>c.method==='submitFeedback').length,0);assert.equal(f.guards.at(-1).dirty,true);
  click(button('닫기'));await settle();await f.open();assert.equal(document.querySelector('[aria-label="리포트 제목"]').value,input.title);
});
test('double click submits once, disables editing, and only a persisted queued receipt clears the draft',async t=>{
  let complete;const f=fixture(t,{handler:async(method,args)=>method==='submitFeedback'?new Promise(resolve=>{complete=()=>resolve(job(args));}):snapshot()});await f.open();fill();const submit=button('리포트 보내기');click(submit);click(submit);await settle();assert.equal(f.calls.filter(c=>c.method==='submitFeedback').length,1);assert.equal(document.querySelector('[aria-label="리포트 제목"]').readOnly,true);assert.ok(JSON.parse(browser.localStorage.getItem(key)).pending);complete();await settle();
  const saved=JSON.parse(browser.localStorage.getItem(key));assert.equal(saved.pending,undefined);assert.equal(saved.input.description,'');assert.equal(saved.lastJobId,f.calls.find(c=>c.method==='submitFeedback').args.requestId);assert.match(document.querySelector('[aria-label="접수 상태"]').textContent,/접수됨 · 실행 대기/);assert.doesNotMatch(document.querySelector('[aria-label="접수 상태"]').textContent,/병합 확인됨/);
});
test('unknown outcome survives remount and retry keeps exact request identity and payload',async t=>{
  const f=fixture(t,{handler:async(method)=>{if(method==='submitFeedback')throw Error('lost response');return snapshot();}});await f.open();fill();click(button('리포트 보내기'));await settle();const original=f.calls.find(c=>c.method==='submitFeedback').args,saved=browser.localStorage.getItem(key);assert.match(document.body.textContent,/접수 응답을 확인하지 못했습니다/);assert.equal(document.querySelector('[aria-label="리포트 내용"]').readOnly,true);f.unmount();
  const resumed=fixture(t,{saved});await resumed.open();assert.equal(resumed.calls.filter(c=>c.method==='submitFeedback').length,0);click(button('같은 요청 다시 확인'));await settle();assert.deepEqual(resumed.calls.find(c=>c.method==='submitFeedback').args,original);
});
test('matching persisted job reconciles a lost response on reopen without another submission',async t=>{
  const f=fixture(t,{saved:{input,pending:input},handler:async()=>snapshot([job()])});await f.open();assert.equal(JSON.parse(browser.localStorage.getItem(key)).pending,undefined);assert.match(document.querySelector('[aria-label="접수 상태"]').textContent,/접수됨/);assert.equal(f.calls.filter(c=>c.method==='submitFeedback').length,0);
});
test('wrong-request, changed-body and unproved merged receipts cannot clear a pending report',async t=>{
  for(const patch of [{id:'ffffffff-ffff-4fff-8fff-ffffffffffff'},{description:'different'},{status:'merged'}]){
    const f=fixture(t,{saved:{input,pending:input},handler:async(method,args)=>method==='submitFeedback'?job(args,patch):snapshot()});await f.open();click(button('같은 요청 다시 확인'));await settle();assert.deepEqual(JSON.parse(browser.localStorage.getItem(key)).pending,input);assert.match(document.body.textContent,/접수 응답을 확인하지 못했습니다/);f.unmount();
  }
});
test('unconfigured and blocked statuses are honest; refresh is read-only and preserves prior receipt on failure',async t=>{
  const blocked=job(input,{status:'blocked',message:'연결 설정 확인 필요'}),f=fixture(t,{saved:{input:{...input,title:'',description:''},lastJobId:requestId},handler:async(method)=>{if(method==='refreshFeedback')throw Error('offline');return snapshot([blocked],{configured:false,configurationMessage:'사용할 개발 연결이 없습니다.'});}});await f.open();assert.match(document.body.textContent,/사용할 개발 연결이 없습니다/);click(button('상태 새로고침'));await settle();assert.deepEqual(f.calls.at(-1),{method:'refreshFeedback',args:{id:requestId}});assert.match(document.querySelector('[aria-label="접수 상태"]').textContent,/진행 조건 확인 필요/);assert.match(document.body.textContent,/마지막으로 확인한 접수 내역을 유지/);assert.equal(f.calls.filter(c=>c.method==='submitFeedback').length,0);
});
test('report agent opens only from the verified host result and does not cancel pending work',async t=>{
  const f=fixture(t,{saved:{input:{...input,title:'',description:''},lastJobId:requestId},handler:async(method)=>method==='openFeedbackAgent'?{agentId:'report-agent',sessionId:'report-session'}:snapshot([job()])});await f.open();click(button('리포트 에이전트에서 보기'));await settle();assert.deepEqual(f.opened,[['report-agent','report-session']]);assert.equal(f.calls.some(c=>/cancel|delete|stop/i.test(c.method)),false);
});
test('malformed stored draft is preserved and cannot trigger submission until explicit recovery',async t=>{
  const original='{broken draft';const f=fixture(t,{saved:original});await f.open();fill();assert.equal(browser.localStorage.getItem(key),original);assert.equal(button('리포트 보내기').disabled,true);assert.match(document.body.textContent,/보관한 초안을 읽지 못했습니다/);click(button('원본 보관 후 계속'));await settle();const restored=JSON.parse(browser.localStorage.getItem(key));assert.equal(restored.original,original);assert.equal(restored.drafts.input.title,input.title);assert.equal(f.calls.filter(c=>c.method==='submitFeedback').length,0);
});
test('storage failure prevents dispatch and keeps visible draft',async t=>{
  const f=fixture(t);await f.open();fill();const failed=t.mock.method(browser.localStorage,'setItem',()=>{throw Error('quota');});click(button('리포트 보내기'));await settle();assert.equal(f.calls.filter(c=>c.method==='submitFeedback').length,0);assert.equal(document.querySelector('[aria-label="리포트 내용"]').value,input.description);assert.match(document.body.textContent,/초안을 저장하지 못했습니다/);failed.mock.restore();click(button('초안 저장 다시 시도'));await settle();assert.equal(button('같은 요청 다시 확인').disabled,false);click(button('같은 요청 다시 확인'));await settle();assert.equal(f.calls.filter(c=>c.method==='submitFeedback').length,1);
});
test('feedback events refresh persisted state but never start another task',async t=>{
  let current=job();const f=fixture(t,{saved:{input:{...input,title:'',description:''},lastJobId:requestId},handler:async()=>snapshot([current])});await f.open();current=job(input,{status:'validating',revision:2});f.event();await settle();assert.match(document.querySelector('[aria-label="접수 상태"]').textContent,/검증 중/);assert.equal(f.calls.every(c=>c.method==='listFeedback'),true);
});
test('closed validation rejects ambiguous draft and forged merged proof shapes',()=>{
  assert.equal(feedbackDraft({input,pending:{...input,description:'different'}}),undefined);assert.equal(feedbackReceipt(job(input,{status:'constructor'})),undefined);assert.equal(feedbackReceipt(job(input,{status:'merged',prUrl:'javascript:alert(1)',mergeSha:'a'.repeat(40)})),undefined);assert.ok(feedbackReceipt(job(input,{status:'merged',prUrl:'https://github.com/venditjason/grok-bot-0.18-reconstructed/pull/5',mergeSha:'a'.repeat(40)})));
});
test('explicit pre-dispatch resume keeps the original request and preserves a newer report draft',async t=>{
  const next={...input,requestId:'33333333-3333-4333-8333-333333333333',title:'next report',description:'preserve the next request'},blocked=job(input,{status:'blocked',canResume:true});
  const f=fixture(t,{saved:{input:next,lastJobId:requestId},handler:async(method,args)=>method==='submitFeedback'?job(args,{status:'queued',canResume:false}):snapshot([blocked])});await f.open();
  click(button('실행 준비 다시 확인'));await settle();assert.deepEqual(f.calls.find(c=>c.method==='submitFeedback').args,input);assert.deepEqual(JSON.parse(browser.localStorage.getItem(key)).input,next);assert.equal(button('실행 준비 다시 확인'),undefined);
});
test('unknown prior dispatch exposes no execute-again control',async t=>{
  const f=fixture(t,{saved:{input:{...input,title:'',description:''},lastJobId:requestId},handler:async()=>snapshot([job(input,{status:'unknown',canResume:false})])});await f.open();assert.equal(button('실행 준비 다시 확인'),undefined);assert.ok(button('상태 새로고침'));assert.equal(f.calls.some(c=>c.method==='submitFeedback'),false);
});
