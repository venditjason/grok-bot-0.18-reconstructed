import assert from 'node:assert/strict';
import {test, after} from 'node:test';
import {readFile} from 'node:fs/promises';
import {setImmediate as tick} from 'node:timers/promises';
import {Window} from 'happy-dom';
import {build} from 'esbuild';

const browser = new Window({url:'http://venditbot.test',width:1100,height:800});
globalThis.window=browser; globalThis.document=browser.document;
for(const name of ['HTMLElement','HTMLInputElement','HTMLTextAreaElement','Node','Element'])globalThis[name]=browser[name];
for(const file of ['react.js','vds.js'])browser.eval(await readFile(new URL('../frontend/venditbot/'+file,import.meta.url),'utf8'));
const React=browser.React,{createRoot,flushSync}=browser.ReactDOM;
const bundle=await build({entryPoints:['chat-composer','chat-attachments','message-header'].map(name=>new URL('../frontend/venditbot/'+name+'.tsx',import.meta.url).pathname),bundle:true,platform:'node',format:'esm',jsx:'transform',jsxFactory:'React.createElement',jsxFragment:'React.Fragment',write:false,outdir:'/unused'});
async function load(name){return import('data:text/javascript;base64,'+Buffer.from(bundle.outputFiles.find(file=>file.path.endsWith('/'+name+'.js')).text).toString('base64'));}
const {ChatComposer}=await load('chat-composer'),{MessageHeader}=await load('message-header'),{useChatAttachments,attachmentDrafts}=await load('chat-attachments');
after(()=>browser.happyDOM.abort());
async function settle(){await tick();await new Promise(resolve=>setTimeout(resolve,30));flushSync(()=>{});}
function mount(t,component){const host=document.createElement('div');document.body.append(host);const root=createRoot(host);let stopped=false;const render=node=>flushSync(()=>root.render(React.createElement(browser.VDS.VDSProvider,{preferScheme:'light'},node)));render(component);const unmount=()=>{if(!stopped){stopped=true;flushSync(()=>root.unmount());host.remove();}};t.after(unmount);return {host,render,unmount};}
const click=node=>flushSync(()=>node.click());
const file=(id='11111111-1111-4111-8111-111111111111')=>({id,name:'요구사항.txt',kind:'text',mimeType:'text/plain',bytes:12,sha256:'a'.repeat(64)});
function hook(t,invoke){browser.localStorage.clear();let current;function Harness({target}){current=useChatAttachments(target,invoke);return null;}const view=mount(t,React.createElement(Harness,{target:'agent:a'}));return {get value(){return current;},switch:target=>view.render(React.createElement(Harness,{target})),...view};}

test('composer autofocus works on initial selection and same-target reselect; input and submit share one row',async t=>{
 const props={value:'짧은 지시',onChange(){},onSend(){},onChooseAttachments(){},focusRequest:1};const v=mount(t,React.createElement(ChatComposer,props));await settle();
 const textarea=v.host.querySelector('textarea');assert.equal(document.activeElement,textarea);assert.equal(textarea.getAttribute('rows'),'1');
 const row=v.host.querySelector('.composer-input-row');assert.equal(row.querySelector('.composer-submit').textContent,'입력');assert.ok(row.querySelector('[aria-label="이미지 또는 파일 첨부"]'));
 row.querySelector('button').focus();v.render(React.createElement(ChatComposer,{...props,focusRequest:2}));await settle();assert.equal(document.activeElement,textarea);
});
test('Enter sends once while Korean composition, Shift+Enter and pending/cancel states never submit',async t=>{
 let sent=0;const props={value:'업무',onChange(){},onSend(){sent++;}};const v=mount(t,React.createElement(ChatComposer,props));const key=options=>flushSync(()=>v.host.querySelector('textarea').dispatchEvent(new browser.KeyboardEvent('keydown',{key:'Enter',bubbles:true,cancelable:true,...options})));
 key({isComposing:true});key({shiftKey:true});key({keyCode:229});assert.equal(sent,0);key({});assert.equal(sent,1);
 v.render(React.createElement(ChatComposer,{...props,sending:true}));key({});assert.equal(sent,1);
 v.render(React.createElement(ChatComposer,{...props,onCancel(){}}));key({});assert.equal(sent,1);
});
test('assistant header uses the agent identity and user messages have no redundant heading',t=>{
 const v=mount(t,React.createElement(MessageHeader,{message:{id:'m',role:'assistant'},assistantName:'개발 대표',connectionName:()=>''}));assert.equal(v.host.querySelector('.message-heading>span').textContent,'개발 대표');
 v.render(React.createElement(MessageHeader,{message:{id:'u',role:'user'},assistantName:'개발 대표',connectionName:()=>''}));assert.equal(v.host.querySelector('.message-heading'),null);assert.equal(v.host.textContent,'');
});
test('late picker completion attaches only to the initiating agent and survives remount',async t=>{
 let finish;const h=hook(t,()=>new Promise(resolve=>{finish=resolve;}));flushSync(()=>h.value.choose());h.switch('agent:b');await settle();finish([file()]);await settle();assert.deepEqual(h.value.files,[]);
 h.switch('agent:a');assert.deepEqual(h.value.files,[file()]);assert.deepEqual(JSON.parse(browser.localStorage.getItem('venditbot.drafts.v1.chat-attachments'))['agent:a'],[file()]);
});
test('a failed picker is displayed on its original target, preserving all staged references',async t=>{
 let reject;const h=hook(t,()=>new Promise((_,no)=>{reject=no;}));flushSync(()=>h.value.choose());h.switch('agent:b');reject(new Error('unsupported document'));await settle();assert.equal(h.value.error,'');h.switch('agent:a');assert.match(h.value.error,/unsupported document/);assert.deepEqual(h.value.files,[]);
});
test('drop reads only selected files, forwards exact bytes and rejects excessive input before reading',async t=>{
 const calls=[];const h=hook(t,async(method,args)=>{calls.push({method,args});return [file()];});h.value.drop([new browser.File(['hello'],'note.txt',{type:'text/plain'})]);await settle();assert.equal(calls[0].method,'stageChatAttachments');assert.equal(new TextDecoder().decode(calls[0].args.files[0].bytes),'hello');assert.equal(h.value.files.length,1);
 let read=false;h.value.drop(Array.from({length:6},()=>({size:1,arrayBuffer(){read=true;return new ArrayBuffer(1);}})));await settle();assert.equal(read,false);assert.equal(calls.length,1);assert.equal(h.value.files.length,1);assert.match(h.value.error,/최대 5개/);
});
test('clearing sent references preserves new attachments and another agent draft',async t=>{
 let supplied=[file()];const h=hook(t,async()=>supplied);h.value.choose();await settle();const second=file('22222222-2222-4222-8222-222222222222');supplied=[second];h.value.choose();await settle();h.switch('agent:b');h.value.choose();await settle();
 flushSync(()=>h.value.clear(['agent:a'],[file().id]));assert.deepEqual(h.value.files,[second]);h.switch('agent:a');assert.deepEqual(h.value.files,[second]);
});
test('restored metadata rejects duplicates, invalid names and aggregate excess',()=>{
 assert.equal(attachmentDrafts({'agent:a':[file(),file()]}),undefined);assert.equal(attachmentDrafts({'agent:a':[{...file(),name:'../secret'}]}),undefined);
 const images=Array.from({length:4},(_,i)=>({...file(`${i}`.repeat(8)+'-1111-4111-8111-111111111111'),kind:'image',mimeType:'image/png',bytes:4*1024*1024}));assert.equal(attachmentDrafts({'agent:a':images}),undefined);
});

test('queue-enabled composer keeps typing, attachment, submit and cancel controls together during response',async t=>{
 let sent=0,cancelled=0;const v=mount(t,React.createElement(ChatComposer,{value:'다음 질문',onChange(){},onSend(){sent++;},onCancel(){cancelled++;},onChooseAttachments(){},queueWhileRunning:true}));
 const field=v.host.querySelector('textarea');assert.equal(field.disabled,false);assert.ok([...v.host.querySelectorAll('button')].some(node=>node.textContent==='대기열에 추가'));assert.ok([...v.host.querySelectorAll('button')].some(node=>node.textContent==='응답 중단'));
 flushSync(()=>field.dispatchEvent(new browser.KeyboardEvent('keydown',{key:'Enter',bubbles:true,cancelable:true})));assert.equal(sent,1);assert.equal(cancelled,0);click([...v.host.querySelectorAll('button')].find(node=>node.textContent==='응답 중단'));assert.equal(cancelled,1);assert.equal(sent,1);
});
