import assert from 'node:assert/strict';
import test from 'node:test';
import {randomUUID} from 'node:crypto';
import {mkdtemp,rm,readFile,writeFile,stat,rename,mkdir,symlink,link,chmod} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import path from 'node:path';
import {build} from 'esbuild';
const compiled=await build({entryPoints:['source/venditbot/rabbit-store.ts'],bundle:true,platform:'node',format:'esm',write:false});
const {RabbitStore}=await import(`data:text/javascript;base64,${Buffer.from(compiled.outputFiles[0].text).toString('base64')}`);
const projectId='5bedba5c-3539-4e57-b8fd-e0b0351e4f34';
const draft={name:'프로젝트 연결',baseUrl:'https://lane.vendit.work',projectId,baseRef:'main',workflowTemplate:'review_only',maxParallelTasks:1,timeoutSeconds:60,enabledForAgents:false};
const input=()=>({objective:'read-only smoke',acceptance_criteria:['No changes']});
function receipt(runId=randomUUID()){return {run_id:runId,project_id:projectId,state:'accepted',created_at:new Date().toISOString(),poll_url:`https://lane.vendit.work/v1/runs/${runId}`,events_url:`https://lane.vendit.work/v1/runs/${runId}/events`};}
async function fixture(t){const root=await mkdtemp(path.join(tmpdir(),'venditbot-rabbit-'));await chmod(root,0o700);t.after(()=>rm(root,{recursive:true,force:true}));const notifications=[];return {root,file:path.join(root,'rabbit-runs.json'),notifications,store:new RabbitStore(root,ids=>notifications.push(ids))};}
test('Rabbit connection CAS, host-assigned identity, detached views and private persistence',async t=>{
 const {root,store}=await fixture(t),id=randomUUID(),first=store.saveConnection({...draft,id},undefined,{create:true});assert.equal(first.id,id);
 assert.throws(()=>store.saveConnection({...draft,id},undefined,{create:true}),/재사용/);
 const next=store.saveConnection({...first,name:'updated'},first.updatedAt);assert.ok(next.updatedAt>first.updatedAt);assert.equal(next.createdAt,first.createdAt);
 assert.throws(()=>store.saveConnection(first,first.updatedAt),/변경/);next.name='mutated';assert.equal(store.getConnection(id).name,'updated');
 assert.equal((await stat(path.join(root,'rabbit-connections.json'))).mode&0o777,0o600);
 assert.deepEqual(new RabbitStore(root).listConnections(),store.listConnections());
 store.removeConnection(id,store.getConnection(id).updatedAt);assert.deepEqual(new RabbitStore(root).listConnections(),[]);
});
test('Rabbit durable outbox freezes destination/body/idempotency/source before submission',async t=>{
 const {root,file,store}=await fixture(t),connection=store.saveConnection(draft),body=input(),origin={sessionId:'conversation-1',agentId:'a',teamRunId:'t'},id=randomUUID();
 const run=store.prepareRun(connection.id,body,id,origin);body.objective='changed';origin.agentId='changed';run.request.objective='changed';
 const stored=store.getRun(id);assert.equal(stored.request.objective,'read-only smoke');assert.equal(stored.source.agentId,'a');
 assert.equal(store.prepareRun(connection.id,input(),id,{sessionId:'conversation-1',agentId:'a',teamRunId:'t'}).idempotencyKey,stored.idempotencyKey);
 assert.throws(()=>store.prepareRun(connection.id,{...input(),objective:'different'},id,{sessionId:'conversation-1',agentId:'a',teamRunId:'t'}),/다른/);
 assert.equal((await stat(file)).mode&0o777,0o600);
 const active=store.beginSubmission(id);assert.equal(active.attempts,1);assert.throws(()=>store.beginSubmission(id),/접수 중/);
 const restarted=new RabbitStore(root),unknown=restarted.getRun(id);assert.equal(unknown.phase,'unknown');assert.equal(unknown.idempotencyKey,stored.idempotencyKey);assert.deepEqual(unknown.request,stored.request);
 const retried=restarted.beginSubmission(id);assert.equal(retried.attempts,2);const accepted=restarted.completeSubmission(id,receipt());assert.equal(accepted.phase,'accepted');assert.throws(()=>restarted.beginSubmission(id),/이미 접수/);
 assert.deepEqual(new RabbitStore(root).getRun(id),accepted);
});
test('Rabbit changed defaults never rewrite existing request and bound destination cannot change',async t=>{
 const {store}=await fixture(t),c=store.saveConnection(draft),run=store.prepareRun(c.id,input());
 const edited=store.saveConnection({...c,baseRef:'develop',timeoutSeconds:600},c.updatedAt);assert.equal(store.getRun(run.id).request.base_ref,'main');
 assert.throws(()=>store.saveConnection({...edited,baseUrl:'https://different.example'},edited.updatedAt),/바꿀 수/);assert.throws(()=>store.removeConnection(c.id),/기록 보존/);
 assert.equal(store.prepareRun(c.id,input()).request.base_ref,'develop');
});
test('Rabbit failed preparation and begin do not commit a sendable transition',async t=>{
 const {root,file,store}=await fixture(t),c=store.saveConnection(draft),first=store.prepareRun(c.id,input()),before=await readFile(file);
 await rename(file,file+'.old');await mkdir(file);
 assert.throws(()=>store.prepareRun(c.id,input()));assert.equal(store.listRuns().length,1);assert.throws(()=>store.beginSubmission(first.id));assert.equal(store.getRun(first.id).phase,'prepared');assert.deepEqual(store.unsavedRunIds(),[]);
 assert.deepEqual(await readFile(file+'.old'),before);await rm(file,{recursive:true});await rename(file+'.old',file);store.beginSubmission(first.id);assert.equal(new RabbitStore(root).getRun(first.id).phase,'unknown');
});
test('Rabbit receipt survives post-response disk failure, blocks resubmit, and can flush',async t=>{
 const {root,file,store,notifications}=await fixture(t),c=store.saveConnection(draft),r=store.prepareRun(c.id,input());store.beginSubmission(r.id);await rename(file,file+'.old');await mkdir(file);
 const accepted=store.completeSubmission(r.id,receipt());assert.equal(accepted.phase,'accepted');assert.equal(store.getRun(r.id).receipt.run_id,accepted.receipt.run_id);assert.deepEqual(store.unsavedRunIds(),[r.id]);assert.throws(()=>store.beginSubmission(r.id),/이미 접수/);assert.throws(()=>store.flushRuns());
 await rm(file,{recursive:true});await rename(file+'.old',file);store.flushRuns();assert.deepEqual(store.unsavedRunIds(),[]);assert.deepEqual(notifications.at(-1),[]);assert.equal(new RabbitStore(root).getRun(r.id).receipt.run_id,accepted.receipt.run_id);
});
test('Rabbit corruption, unsafe links and concurrent writers preserve original bytes',async t=>{
 const {root,file,store}=await fixture(t),c=store.saveConnection(draft);store.prepareRun(c.id,input());const original=await readFile(file);
 for(const invalid of ['broken',JSON.stringify({version:1,runs:[{}]})]){await writeFile(file,invalid);assert.throws(()=>new RabbitStore(root));assert.equal(await readFile(file,'utf8'),invalid);}
 await writeFile(file,original);await rename(file,file+'.old');await symlink(file+'.old',file);assert.throws(()=>new RabbitStore(root),/안전/);await rm(file);await link(file+'.old',file);assert.throws(()=>new RabbitStore(root),/안전/);await rm(file);await rename(file+'.old',file);
 const second=new RabbitStore(root);second.prepareRun(c.id,input());const secondBytes=await readFile(file);assert.throws(()=>store.prepareRun(c.id,input()),/변경/);assert.deepEqual(await readFile(file),secondBytes);
});
test('Rabbit outbox stress: 200 simultaneous-result records, restart recovery and exact retries',async t=>{
 const {root,store}=await fixture(t),c=store.saveConnection(draft);const expected=new Map();
 for(let i=0;i<200;i++){const run=store.prepareRun(c.id,{...input(),objective:'stress '+i});expected.set(run.id,{key:run.idempotencyKey,body:run.request});store.beginSubmission(run.id);if(i%2)store.failSubmission(run.id,{uncertain:true,error:'response lost'});}
 const recovered=new RabbitStore(root);assert.equal(recovered.listRuns().length,200);assert.ok(recovered.listRuns().every(r=>r.phase==='unknown'));
 for(const run of recovered.listRuns()){assert.equal(run.idempotencyKey,expected.get(run.id).key);assert.deepEqual(run.request,expected.get(run.id).body);recovered.beginSubmission(run.id);recovered.completeSubmission(run.id,receipt());}
 const final=new RabbitStore(root);assert.equal(final.listRuns().filter(r=>r.phase==='accepted').length,200);assert.equal(new Set(final.listRuns().map(r=>r.receipt.run_id)).size,200);
});
