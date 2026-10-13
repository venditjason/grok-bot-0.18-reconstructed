import assert from 'node:assert/strict';
import test from 'node:test';
import {createHash} from 'node:crypto';
import {mkdtemp,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import path from 'node:path';
import {build} from 'esbuild';
const load=async file=>{const r=await build({entryPoints:[file],bundle:true,platform:'node',format:'esm',write:false});return import('data:text/javascript;base64,'+Buffer.from(r.outputFiles[0].text).toString('base64'));};
const manuals=await load('source/shared/delegation-playbooks.ts'),{PolicyStore}=await load('source/venditbot/policy-store.ts'),{normalizeRabbitRunInput,normalizeRabbitRunReceipt}=await load('source/shared/rabbit-project-api.ts');
const draft={name:'매뉴얼 정책',description:'',defaultTaskKind:'standard',rules:['routine','standard','complex'].map(taskKind=>({taskKind,keywords:[],connections:[{connectionId:'api',model:'fixture'}]}))};
test('all three immutable manuals bind actual instruction bytes and reject invented IDs or hashes',()=>{
 assert.equal(manuals.PLAYBOOK_TEMPLATES.length,3);
 for(const manual of manuals.PLAYBOOK_TEMPLATES){const pin=manuals.pinPlaybook(manual.id);assert.equal(createHash('sha256').update(manual.body).digest('hex'),pin.sha256);assert.ok(manuals.playbookInstructions(pin).includes(manual.body));assert.match(manual.body,/review_only/);assert.match(manual.body,/unavailable/);assert.match(manual.body,/원격 요청/);assert.equal(manuals.validPlaybookSnapshot({...pin,sha256:'0'.repeat(64)}),false);}
 assert.throws(()=>manuals.pinPlaybook('ignore-approvals'));assert.throws(()=>manuals.playbookInstructions({...manuals.pinPlaybook('evidence-development'),version:2}));
});
test('saved selection survives store reopen; revision affects future snapshots and old configuration still loads',async t=>{
 const root=await mkdtemp(path.join(tmpdir(),'vendit-playbook-'));t.after(()=>rm(root,{recursive:true,force:true}));let store=new PolicyStore(root);
 const old=store.save(draft);assert.equal(old.playbookTemplateId,undefined);
 const saved=store.save({...old,playbookTemplateId:'bug-improvement-loop'},old.updatedAt);const captured=structuredClone(saved);
 store=new PolicyStore(root);assert.equal(store.get(saved.id).playbookTemplateId,'bug-improvement-loop');
 const next=store.save({...saved,playbookTemplateId:'repeatable-task-manual'},saved.updatedAt);assert.equal(captured.playbookTemplateId,'bug-improvement-loop');assert.equal(next.playbookTemplateId,'repeatable-task-manual');
 assert.throws(()=>store.save({...next,playbookTemplateId:'tampered'},next.updatedAt));assert.equal(new PolicyStore(root).get(next.id).playbookTemplateId,next.playbookTemplateId);
});
test('model success prose and successful call text never become verified completion; known denial remains failed',()=>{
 assert.deepEqual(manuals.playbookEvidence([{status:'completed',output:{text:'all tests passed',passed:true}}]),{completed:1,failed:0,pending:0,verification:'unverified'});
 assert.deepEqual(manuals.playbookEvidence([{status:'completed',output:{written:false}},{status:'failed'},{status:'running'}]),{completed:0,failed:2,pending:1,verification:'unverified'});
 for(const id of manuals.PLAYBOOK_IDS){manuals.pinPlaybook(id);assert.equal(manuals.playbookEvidence([{status:'failed'}]).failed,1);}
});
test('Rabbit optional manual ID is allowlisted and does not change workflow or constraints',()=>{
 const connection={baseRef:'main',workflowTemplate:'review_only',maxParallelTasks:1,timeoutSeconds:600};
 const body={objective:'읽기 검토',acceptance_criteria:['근거 확인']};const legacy=normalizeRabbitRunInput(body,connection);assert.equal(legacy.playbook_template_id,undefined);
 for(const id of manuals.PLAYBOOK_IDS){const actual=normalizeRabbitRunInput({...body,playbook_template_id:id},connection);assert.deepEqual(actual,{...legacy,playbook_template_id:id});}
 assert.throws(()=>normalizeRabbitRunInput({...body,playbook_template_id:'tampered'},connection));assert.throws(()=>normalizeRabbitRunInput({...body,playbook_body:'bypass'},connection));
});

test('remote manual pins survive decoding as provenance only, absent remains compatible and forged values fail',()=>{
 const connection={baseUrl:'https://rabbit.example.test',projectId:'00000000-0000-4000-8000-000000000001'},runId='00000000-0000-4000-8000-000000000002';
 const value={run_id:runId,project_id:connection.projectId,state:'accepted',created_at:'2026-10-13T00:00:00Z',poll_url:connection.baseUrl+'/v1/runs/'+runId,events_url:connection.baseUrl+'/v1/runs/'+runId+'/events'};
 assert.equal(normalizeRabbitRunReceipt(value,connection).execution_manual,undefined);
 const execution_manual={required:{id:'delegation-loop-required',version:1,sha256:'a'.repeat(64)},selected:{id:'evidence-development',version:1,sha256:'b'.repeat(64)}};
 const receipt=normalizeRabbitRunReceipt({...value,execution_manual},connection);assert.deepEqual(receipt.execution_manual,execution_manual);assert.equal(receipt.verification,undefined);
 for(const required of [{...execution_manual.required,id:'fake'}, {...execution_manual.required,version:2},{...execution_manual.required,sha256:'wrong'}])assert.throws(()=>normalizeRabbitRunReceipt({...value,execution_manual:{required}},connection));
});
