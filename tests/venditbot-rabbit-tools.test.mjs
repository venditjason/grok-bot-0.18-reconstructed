import assert from 'node:assert/strict';
import test from 'node:test';
import {randomUUID} from 'node:crypto';
import {build} from 'esbuild';
const built=await build({entryPoints:['source/venditbot/rabbit-tools.ts'],bundle:true,platform:'node',format:'esm',write:false});
const {RabbitTools}=await import(`data:text/javascript;base64,${Buffer.from(built.outputFiles[0].text).toString('base64')}`);
const stamp='2026-10-11T00:00:00.000Z';
function fixture(source={sessionId:randomUUID(),agentId:randomUUID()}){
 const enabled={id:randomUUID(),name:'허용 프로젝트',baseUrl:'https://rabbit.example',projectId:randomUUID(),baseRef:'main',workflowTemplate:'review_only',maxParallelTasks:2,timeoutSeconds:600,enabledForAgents:true,createdAt:stamp,updatedAt:stamp},disabled={...enabled,id:randomUUID(),name:'비공개 연결',enabledForAgents:false},records=new Map(),calls=[];
 const port={connections:()=>[structuredClone(enabled),structuredClone(disabled)],authorizeRead:async tool=>{calls.push(['authorize',tool]);return true;},repositories:async connection=>{calls.push(['repositories',connection.id]);return {repositories:[]};},start:async(connection,input,id,actor)=>{calls.push(['start',id]);const record={id,connectionId:connection.id,connectionSnapshot:connection,request:input,idempotencyKey:randomUUID(),phase:'accepted',attempts:1,createdAt:stamp,updatedAt:stamp,source:structuredClone(actor)};records.set(id,record);return structuredClone(record);},getRecord:id=>structuredClone(records.get(id)),refresh:async record=>{calls.push(['refresh',record.id]);return record;}};
 const controller=new AbortController(),tools=new RabbitTools(port,source,controller.signal);return {enabled,disabled,records,calls,source,port,controller,tools};
}
const input={objective:'테스트 실패를 검토한다',acceptance_criteria:['근거를 설명한다']};
test('only enabled connections and supported project operations are exposed without keys or invented lanes',async()=>{
 const f=fixture(),list=await f.tools.execute('list_project_connections',{},'list');assert.deepEqual(list.connections.map(c=>c.id),[f.enabled.id]);assert.ok(f.tools.definitions.every(d=>!d.name.includes('lane')&&!d.name.includes('cancel')));assert.doesNotMatch(JSON.stringify(list),/rabbit_[A-Za-z0-9_-]{43}/);
 await assert.rejects(f.tools.execute('list_project_repositories',{connectionId:f.disabled.id},'disabled'),/허용/);assert.equal(f.calls.some(c=>c[0]==='repositories'),false);f.enabled.enabledForAgents=false;await assert.rejects(f.tools.execute('list_project_repositories',{connectionId:f.enabled.id},'disabled-later'),/허용/);
 assert.deepEqual(new RabbitTools(f.port,f.source).definitions,[]);
});
test('start captures immutable approved fields and stable per-call idempotency identity without duplicate dispatch',async()=>{
 const f=fixture(),args={connectionId:f.enabled.id,input:structuredClone(input)},pending=f.tools.execute('start_project_run',args,'once');args.input.objective='late mutation';args.connectionId=f.disabled.id;const record=await pending;assert.equal(record.request.objective,input.objective);assert.equal(record.request.base_ref,'main');assert.equal(record.source.agentId,f.source.agentId);
 assert.deepEqual(await f.tools.execute('start_project_run',{connectionId:f.enabled.id,input},'once'),record);assert.equal(f.calls.filter(c=>c[0]==='start').length,1);await assert.rejects(f.tools.execute('start_project_run',args,'once'),/다릅니다/);
 const again=new RabbitTools(f.port,f.source);assert.equal((await again.execute('start_project_run',{connectionId:f.enabled.id,input},'once')).id,record.id);
 for(const extra of [{lane_id:randomUUID()},{model:'outside-model'},{attachments:[{}]}])await assert.rejects(f.tools.execute('start_project_run',{connectionId:f.enabled.id,input:{...input,...extra}},randomUUID()));
});
test('run lookup is bound to the initiating conversation or same agent and same team run',async()=>{
 const f=fixture({sessionId:randomUUID(),agentId:randomUUID(),teamRunId:randomUUID()}),record=await f.tools.execute('start_project_run',{connectionId:f.enabled.id,input},'start');assert.equal((await f.tools.execute('get_project_run',{id:record.id},'own')).id,record.id);
 const sameLeader=new RabbitTools(f.port,{...f.source,sessionId:randomUUID()});assert.equal((await sameLeader.execute('get_project_run',{id:record.id},'next-plan')).id,record.id);
 for(const actor of [{sessionId:randomUUID(),agentId:f.source.agentId},{sessionId:randomUUID(),agentId:randomUUID(),teamRunId:f.source.teamRunId},{sessionId:randomUUID(),agentId:f.source.agentId,teamRunId:randomUUID()}])await assert.rejects(new RabbitTools(f.port,actor).execute('get_project_run',{id:record.id},'foreign'),/본인이/);
 const ui={...record,id:randomUUID(),source:undefined};f.records.set(ui.id,ui);await assert.rejects(f.tools.execute('get_project_run',{id:ui.id},'ui-record'),/본인이/);
});
test('abort while read approval is pending never calls network and cannot weaken the source binding',async()=>{
 const f=fixture();let release;f.port.authorizeRead=()=>new Promise(resolve=>{release=resolve;});const pending=f.tools.execute('list_project_connections',{},'pending');await new Promise(resolve=>setImmediate(resolve));f.controller.abort();release(true);await assert.rejects(pending,/중단/);assert.equal(f.calls.some(c=>c[0]==='repositories'),false);
});

test('selected manual is forwarded once and cannot be replaced by model input or changed on replay',async()=>{
 const f=fixture();f.port.playbookTemplateId=()=> 'bug-improvement-loop';
 const args={connectionId:f.enabled.id,input};const r=await f.tools.execute('start_project_run',args,'manual');assert.equal(r.request.playbook_template_id,'bug-improvement-loop');assert.equal(r.request.workflow_template,'review_only');
 f.port.playbookTemplateId=()=> 'repeatable-task-manual';assert.deepEqual(await f.tools.execute('start_project_run',args,'manual'),r);assert.equal(f.calls.filter(x=>x[0]==='start').length,1);
 await assert.rejects(f.tools.execute('start_project_run',{connectionId:f.enabled.id,input:{...input,playbook_template_id:'evidence-development'}},'override'),/바꿀 수 없습니다/);assert.equal(f.calls.filter(x=>x[0]==='start').length,1);
});
