import assert from 'node:assert/strict';
import test from 'node:test';
import {mkdtempSync,rmSync} from 'node:fs';
import {build} from 'esbuild';
import {randomUUID} from 'node:crypto';

// Real tool, host, store, schema and client. Only the HTTP peer and vault are
// synthetic. In particular, preserve the enriched connections() production port.
const requests=[];let respond;
const nativeFetch=globalThis.fetch;
globalThis.fetch=async(url,init)=>{
  const request={url:String(url),...init};requests.push(request);return respond(request);
};
const built=await build({stdin:{contents:"export {RabbitHost} from './source/venditbot/rabbit-host.ts';export {RabbitStore} from './source/venditbot/rabbit-store.ts';export {RabbitTools} from './source/venditbot/rabbit-tools.ts';",resolveDir:process.cwd()},bundle:true,platform:'node',format:'esm',write:false});
const {RabbitHost,RabbitStore,RabbitTools}=await import('data:text/javascript;base64,'+Buffer.from(built.outputFiles[0].text).toString('base64'));
globalThis.fetch=nativeFetch;
const key='rabbit_'+'a'.repeat(43),json=(value,status=200)=>new Response(JSON.stringify(value),{status,headers:{'Content-Type':'application/json'}});
function fixture(t){
  requests.length=0;const root=mkdtempSync('/private/tmp/vendit-toolchain-');t.after(()=>rmSync(root,{recursive:true,force:true}));
  const store=new RabbitStore(root),project=randomUUID(),repository=randomUUID(),remote=randomUUID(),source={sessionId:randomUUID(),agentId:randomUUID()};
  let revision='ciphertext-1',hasKey=true,approve=async()=>true;
  const connection=store.saveConnection({name:'Registered project',baseUrl:'https://rabbit.example',projectId:project,workflowTemplate:'feature_pr',baseRef:'main',maxParallelTasks:3,timeoutSeconds:3600,enabledForAgents:true,preferForProjectTasks:true});
  respond=request=>{
    assert.equal(request.headers['X-Project-API-Key'],key);
    assert.equal(request.redirect,'manual');assert.equal(request.credentials,'omit');
    if(request.method==='GET'){
      assert.equal(request.url,`https://rabbit.example/v1/projects/${project}/repositories?limit=100`);
      return json({items:[{id:repository,provider:'github',url:'https://github.com/example/project',default_branch:'main',status:'ready'}],next_cursor:null,has_more:false});
    }
    assert.equal(request.url,`https://rabbit.example/v1/projects/${project}/runs`);
    return json({run_id:remote,project_id:project,state:'created',created_at:new Date().toISOString(),poll_url:`https://rabbit.example/v1/runs/${remote}`,events_url:`https://rabbit.example/v1/runs/${remote}/events`},202);
  };
  const host=new RabbitHost({store,secrets:{has:()=>hasKey,revision:()=>revision,read:async()=>key},authorize:(...args)=>approve(...args),changed(){},assertMutable(){}});
  const tools=()=>new RabbitTools({connections:()=>host.connections().filter(c=>c.hasKey),repositories:c=>host.test(c,undefined,true),start:(c,input,id,origin)=>host.start(c.id,input,id,origin),getRecord:id=>store.getRun(id),refresh:r=>host.refresh(r.id,undefined,true),authorizeRead:async()=>true},source);
  const input={objective:'Check the current API boundary',acceptance_criteria:['Preserve the API contract'],repository_id:repository,workflow_template:'review_only',constraints:{max_parallel_tasks:1,timeout_seconds:600}};
  return {store,host,tools,connection,input,source,edit(patch){const c=store.getConnection(connection.id);return store.saveConnection({...c,...patch},c.updatedAt);},rotate(){revision='ciphertext-2';},revoke(){hasKey=false;revision=undefined;},approve(fn){approve=fn;}};
}
test('actual enriched list → repositories → start sends one compatible request and durable UUID receipt',async t=>{
  const f=fixture(t),tools=f.tools();const list=await tools.execute('list_project_connections',{},'list');assert.equal(list.connections[0].id,f.connection.id);
  assert.equal(f.host.connections()[0].verified,false);const repos=await tools.execute('list_project_repositories',{connectionId:f.connection.id},'repos');assert.equal(repos.repositories[0].id,f.input.repository_id);assert.equal(f.host.connections()[0].verified,true);
  const args={connectionId:f.connection.id,input:f.input};const receipt=await tools.execute('start_project_run',args,'start');
  assert.equal(receipt.phase,'accepted');assert.match(receipt.id,/^[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/);assert.deepEqual(receipt.source,f.source);
  const post=requests.find(r=>r.method==='POST');assert.equal(post.headers['Idempotency-Key'],receipt.idempotencyKey);
  assert.deepEqual(JSON.parse(post.body),{objective:f.input.objective,acceptance_criteria:f.input.acceptance_criteria,repository_id:f.input.repository_id,base_ref:'main',workflow_template:'review_only',attachments:[],constraints:{environment:'development',max_parallel_tasks:1,timeout_seconds:600,api_cost_limit_usd:0}});
  assert.deepEqual(await tools.execute('start_project_run',args,'start'),receipt);
  assert.deepEqual(await f.tools().execute('start_project_run',args,'start'),receipt);
  await assert.rejects(f.tools().execute('start_project_run',{...args,input:{...f.input,objective:'Different task'}},'start'),/같은 프로젝트 요청 ID/);
  assert.equal(requests.filter(r=>r.method==='POST').length,1);assert.equal(JSON.stringify(receipt).includes(key),false);
});
test('canonical evidence still rejects edited configuration, ciphertext rotation, revocation and TTL expiry',async t=>{
  for(const mutation of ['edit','rotate','revoke','disabled','expired','clock-backward'])await t.test(mutation,async t=>{
    const f=fixture(t),tools=f.tools();await tools.execute('list_project_repositories',{connectionId:f.connection.id},'repos');
    const now=Date.now;t.after(()=>{Date.now=now;});
    if(mutation==='edit')f.edit({baseRef:'next'});if(mutation==='rotate')f.rotate();if(mutation==='revoke')f.revoke();if(mutation==='disabled')f.edit({enabledForAgents:false,preferForProjectTasks:false});if(mutation==='expired'){const future=now()+300001;Date.now=()=>future;}if(mutation==='clock-backward'){const past=now()-300001;Date.now=()=>past;}
    assert.equal(f.host.connections()[0].verified,false);
    await assert.rejects(tools.execute('start_project_run',{connectionId:f.connection.id,input:f.input},'start'),/GET 검사|허용/);
    assert.equal(f.store.listRuns().length,0);assert.equal(requests.filter(r=>r.method==='POST').length,0);
  });
});
test('configuration or key mutation during GET never produces reusable evidence',async t=>{
  for(const mutation of ['edit','rotate','disabled'])await t.test(mutation,async t=>{
    const f=fixture(t),normal=respond;respond=async request=>{const response=normal(request);if(mutation==='edit')f.edit({baseRef:'next'});if(mutation==='rotate')f.rotate();if(mutation==='disabled')f.edit({enabledForAgents:false,preferForProjectTasks:false});return response;};
    await assert.rejects(f.tools().execute('list_project_repositories',{connectionId:f.connection.id},'repos'),/변경|허용/);assert.equal(f.host.connections()[0].verified,false);assert.equal(f.store.listRuns().length,0);
  });
});
test('GET expiring while external approval waits prevents POST and never retries automatically',async t=>{
  const f=fixture(t),tools=f.tools();await tools.execute('list_project_repositories',{connectionId:f.connection.id},'repos');
  const now=Date.now;t.after(()=>{Date.now=now;});f.approve(async request=>{if(request.tool==='start_project_run'){const future=now()+300001;Date.now=()=>future;}return true;});
  const args={connectionId:f.connection.id,input:f.input};const receipt=await tools.execute('start_project_run',args,'start');assert.equal(receipt.phase,'rejected');assert.equal(receipt.attempts,0);assert.match(receipt.error,/GET 검사/);
  await f.tools().execute('list_project_repositories',{connectionId:f.connection.id},'new-repos');assert.equal((await f.tools().execute('start_project_run',args,'start')).id,receipt.id);assert.equal(requests.filter(r=>r.method==='POST').length,0);
});
test('uncertain POST replay retains the same receipt and sends no duplicate POST',async t=>{
  const f=fixture(t),normal=respond;respond=request=>{if(request.method==='POST')throw new TypeError('synthetic lost response');return normal(request);};const tools=f.tools();await tools.execute('list_project_repositories',{connectionId:f.connection.id},'repos');
  const args={connectionId:f.connection.id,input:f.input};const receipt=await tools.execute('start_project_run',args,'start');assert.equal(receipt.phase,'unknown');assert.equal(receipt.attempts,1);
  const replay=await f.tools().execute('start_project_run',args,'start');assert.deepEqual(replay,receipt);assert.equal(requests.filter(r=>r.method==='POST').length,1);
});
