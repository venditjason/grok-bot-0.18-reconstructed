import assert from 'node:assert/strict';
import {mkdtemp,rm,readFile,writeFile,mkdir} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import path from 'node:path';
import test from 'node:test';
import {setImmediate as tick} from 'node:timers/promises';
import {build} from 'esbuild';
const built=await build({entryPoints:['source/venditbot/workspace-tools.ts'],bundle:true,platform:'node',format:'esm',write:false});
const {WorkspaceExecutor}=await import('data:text/javascript;base64,'+Buffer.from(built.outputFiles[0].text).toString('base64'));
const defer=()=>{let resolve;return{promise:new Promise(r=>resolve=r),resolve:v=>resolve(v)};};
async function fixture(t){const root=await mkdtemp(path.join(tmpdir(),'vendit-rules-'));t.after(()=>rm(root,{recursive:true,force:true}));return root;}
test('host classifies new files, overwrites and security configuration independently of model arguments',async t=>{
  const root=await fixture(t),requests=[];
  const host=new WorkspaceExecutor(root,async()=>{throw Error('legacy callback must not bypass policy');},undefined,async request=>{requests.push(request);return request.category==='routine';});
  assert.equal((await host.execute('write_file',{path:'notes.txt',content:'new notes'},'new')).written,true);
  assert.equal((await host.execute('write_file',{path:'notes.txt',content:'overwrite'},'old')).written,false);
  assert.equal((await host.execute('write_file',{path:'package.json',content:'{}'},'config')).written,false);
  assert.equal(await readFile(path.join(root,'notes.txt'),'utf8'),'new notes');
  assert.deepEqual(requests.map(r=>r.categories),[[],['destructive_change'],['security_change']]);
  await assert.rejects(host.execute('write_file',{path:'b.txt',content:'x',category:'routine'},'extra'),/인자/);
});
test('all applicable risks survive classification and sensitive previews never include their contents',async t=>{
  const root=await fixture(t);await writeFile(path.join(root,'package.json'),'{}');let observed;
  const host=new WorkspaceExecutor(root,async()=>false,undefined,async r=>{observed=r;return false;});
  await host.execute('write_file',{path:'package.json',content:'{"contact":"fictional@example.invalid"}'},'sensitive-write');
  assert.deepEqual(observed.categories,['sensitive_disclosure','security_change','destructive_change']);
  assert.doesNotMatch(observed.preview,/fictional@example/);assert.equal(await readFile(path.join(root,'package.json'),'utf8'),'{}');
});
test('sensitive reads and searches are gated before any returned content, while credential paths stay blocked',async t=>{
  const root=await fixture(t);await writeFile(path.join(root,'contacts.txt'),'contact fictional@example.invalid');await writeFile(path.join(root,'public.txt'),'contact support team');await writeFile(path.join(root,'.env'),'FAKE=value');
  const seen=[],host=new WorkspaceExecutor(root,async()=>true,undefined,async r=>{seen.push(r);return r.category!=='sensitive_disclosure';});
  await assert.rejects(host.execute('read_file',{path:'contacts.txt'},'read'),/허용하지/);
  const result=await host.execute('search_files',{path:'.',query:'contact'},'search');
  assert.deepEqual(result.matches.map(m=>m.path),['public.txt']);assert.equal(result.truncated,true);assert.doesNotMatch(JSON.stringify(seen),/fictional@example/);
  await assert.rejects(host.execute('read_file',{path:'.env'},'credential'),/자격증명/);
  assert.equal(seen.some(r=>r.path==='.env'),false);
});
test('protected paths are presented canonically to every read, search, list and write authorization',async t=>{
  const root=await fixture(t);await mkdir(path.join(root,'protected'));await writeFile(path.join(root,'protected','a.txt'),'protected text');
  const seen=[],host=new WorkspaceExecutor(root,async()=>true,undefined,async r=>{seen.push(r);return !r.path.startsWith('protected');});
  await assert.rejects(host.execute('read_file',{path:'protected/../protected/a.txt'},'read'));
  assert.equal((await host.execute('search_files',{path:'.',query:'protected'},'search')).matches.length,0);
  await assert.rejects(host.execute('list_files',{path:'protected'},'list'));
  assert.equal((await host.execute('write_file',{path:'protected/new.txt',content:'x'},'write')).written,false);
  assert.deepEqual(seen.map(r=>[r.operation,r.path]),[['read','protected/a.txt'],['search','protected/a.txt'],['list','protected'],['write','protected/new.txt']]);
});
test('queued tool arguments cannot be changed after authorization or while waiting for another action',async t=>{
  const root=await fixture(t),gate=defer(),requested=defer();
  const host=new WorkspaceExecutor(root,async()=>false,undefined,async r=>{requested.resolve(r);return gate.promise;});
  const args={path:'approved.txt',content:'approved content'},result=host.execute('write_file',args,'immutable');
  const request=await requested.promise;args.path='other.txt';args.content='unapproved';request.preview='callback modification';gate.resolve(true);await result;
  assert.equal(await readFile(path.join(root,'approved.txt'),'utf8'),'approved content');await assert.rejects(readFile(path.join(root,'other.txt')),{code:'ENOENT'});
});
test('cancelled authorization cannot return sensitive data or perform a late write',async t=>{
  const root=await fixture(t);await writeFile(path.join(root,'contacts.txt'),'fictional@example.invalid');
  for(const name of ['read_file','write_file']){
    const controller=new AbortController(),gate=defer(),requested=defer();
    const host=new WorkspaceExecutor(root,async()=>true,controller.signal,async()=>{requested.resolve();return gate.promise;});
    const result=host.execute(name,name==='read_file'?{path:'contacts.txt'}:{path:'late.txt',content:'never'},name);await requested.promise;controller.abort();
    await assert.rejects(result,{name:'AbortError'});gate.resolve(true);await tick();
    await assert.rejects(readFile(path.join(root,'late.txt')),{code:'ENOENT'});
  }
});
test('stress repeated authorization denial/cancellation and duplicate calls leaves no forbidden writes',async t=>{
  const root=await fixture(t);let approved=0,denied=0,cancelled=0;
  for(let batch=0;batch<20;batch++){
    const host=new WorkspaceExecutor(root,async()=>false,undefined,async r=>!r.path.startsWith('denied'));
    for(let i=0;i<20;i++){
      const args={path:`${i%2?'denied':'allowed'}-${batch}-${i}.txt`,content:'synthetic stress artifact'},id=`call-${i}`;
      const first=host.execute('write_file',args,id);assert.equal(first,host.execute('write_file',args,id));
      const result=await first;if(i%2){assert.equal(result.written,false);denied++;}else{assert.equal(result.written,true);approved++;}
    }
    const controller=new AbortController(),waiting=defer();let started;
    const begun=new Promise(r=>started=r),host2=new WorkspaceExecutor(root,async()=>true,controller.signal,async()=>{started();return waiting.promise;});
    const job=host2.execute('write_file',{path:`cancelled-${batch}.txt`,content:'never'},'cancel');await begun;controller.abort();await assert.rejects(job,{name:'AbortError'});waiting.resolve(true);cancelled++;
  }
  await tick();const {readdir}=await import('node:fs/promises');const files=await readdir(root);
  assert.equal(files.length,200);assert.ok(files.every(file=>file.startsWith('allowed-')));assert.deepEqual({approved,denied,cancelled},{approved:200,denied:200,cancelled:20});
});
