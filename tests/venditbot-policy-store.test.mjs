import assert from 'node:assert/strict';
import test from 'node:test';
import {mkdtemp,rm,readFile,writeFile,stat,rename,mkdir,symlink} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import path from 'node:path';
import {build} from 'esbuild';
const compiled=await build({entryPoints:['source/venditbot/policy-store.ts'],bundle:true,platform:'node',format:'esm',write:false});
const {PolicyStore}=await import(`data:text/javascript;base64,${Buffer.from(compiled.outputFiles[0].text).toString('base64')}`);
const draft={name:'작업별 선택',description:'난이도 정책',defaultTaskKind:'standard',rules:['routine','standard','complex'].map(taskKind=>({taskKind,keywords:[taskKind],connections:[{connectionId:'codex',model:'gpt-6-luna',effort:'low'}]}))};
async function fixture(t){const root=await mkdtemp(path.join(tmpdir(),'venditbot-policy-'));t.after(()=>rm(root,{recursive:true,force:true}));return {root,file:path.join(root,'agent-policies.json'),store:new PolicyStore(root)};}
test('policy CAS, detached snapshots, private persistence and restart preserve task routes',async t=>{
 const {root,file,store}=await fixture(t), first=store.save(draft);assert.equal((await stat(file)).mode&0o777,0o600);
 const next=store.save({...first,name:'수정'},first.updatedAt);assert.ok(next.updatedAt>first.updatedAt);assert.equal(next.createdAt,first.createdAt);
 assert.throws(()=>store.save(first,first.updatedAt),/변경/);assert.throws(()=>store.remove(next.id,first.updatedAt),/변경/);
 next.rules[0].connections[0].model='mutated';assert.equal(new PolicyStore(root).get(next.id).rules[0].connections[0].model,'gpt-6-luna');
 store.remove(next.id,store.get(next.id).updatedAt);assert.deepEqual(new PolicyStore(root).list(),[]);
});
test('policy storage failure and invalid format retain all original data',async t=>{
 const {root,file,store}=await fixture(t), first=store.save(draft), original=await readFile(file);
 await rename(file,file+'.old');await mkdir(file);assert.throws(()=>store.save({...first,name:'not committed'},first.updatedAt));assert.throws(()=>store.remove(first.id,first.updatedAt));assert.equal(store.get(first.id).name,first.name);assert.deepEqual(await readFile(file+'.old'),original);
 await rm(file,{recursive:true});for(const data of ['bad',JSON.stringify({version:1,policies:[first,first]}),JSON.stringify({version:1,policies:[{...first,rules:[]} ]})]){await writeFile(file,data);assert.throws(()=>new PolicyStore(root));assert.equal(await readFile(file,'utf8'),data);}
 await rm(file);await symlink(file+'.old',file);assert.throws(()=>new PolicyStore(root),/안전/);assert.deepEqual(await readFile(file+'.old'),original);
});
test('policy count and multibyte byte cap cannot commit an unreadable policy file',async t=>{
 const {root,file,store}=await fixture(t);for(let i=0;i<50;i++)store.save({...draft,name:`정책${i}`});assert.throws(()=>store.save(draft),/50/);
 const before=await readFile(file),many=Array.from({length:8},(_,i)=>({connectionId:'연'.repeat(195)+i,model:'모'.repeat(195)+i,effort:'강'.repeat(40)}));let denied=false;
 for(const p of store.list()){const previous=store.list(),bytes=await readFile(file);try{store.save({...p,description:'설'.repeat(2000),rules:draft.rules.map(r=>({...r,keywords:Array.from({length:32},(_,i)=>'가'.repeat(78)+i),connections:many}))},p.updatedAt);}catch(e){assert.match(e.message,/4MiB/);assert.deepEqual(store.list(),previous);assert.deepEqual(await readFile(file),bytes);denied=true;break;}}
 assert.ok((await stat(file)).size<=4*1024*1024);assert.ok(before.length);assert.deepEqual(new PolicyStore(root).list(),store.list());await writeFile(file,Buffer.alloc(4*1024*1024+1));assert.throws(()=>new PolicyStore(root),/안전/);
});
