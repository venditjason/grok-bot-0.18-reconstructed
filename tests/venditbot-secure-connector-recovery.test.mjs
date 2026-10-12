import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync,writeFileSync,readFileSync,rmSync} from 'node:fs';
import {join} from 'node:path';
import {tmpdir} from 'node:os';
import {pathToFileURL} from 'node:url';
import {build} from 'esbuild';
const compiled=mkdtempSync(join(tmpdir(),'vendit-secure-connector-module-'));
const bundle=await build({stdin:{contents:`export {AppConnectorManager} from './source/venditbot/app-connectors/manager.ts'; export {EncryptedSecretStore} from './source/venditbot/local-store.ts'; export * from './source/venditbot/secure-storage-error.ts'; export {publicError} from './source/venditbot/app-connectors/protocol.ts';`,resolveDir:process.cwd(),loader:'ts'},bundle:true,platform:'node',format:'esm',write:false});
writeFileSync(join(compiled,'module.mjs'),bundle.outputFiles[0].text);
const {AppConnectorManager,EncryptedSecretStore,SecureStorageError,publicError}=await import(pathToFileURL(join(compiled,'module.mjs')).href);
process.on('exit',()=>rmSync(compiled,{recursive:true,force:true}));
const until=async fn=>{const end=Date.now()+4000;while(!fn()){assert.ok(Date.now()<end,'synthetic deadline');await new Promise(r=>setTimeout(r,2));}};
const config=JSON.stringify({provider:'google',clientId:'synthetic.apps.googleusercontent.com',clientSecret:'synthetic-sensitive-marker'});
function fixture(t,encryption){
 const root=mkdtempSync(join(tmpdir(),'vendit-secure-connector-'));let opens=0,fetches=0;const file=join(root,'credentials.encrypted.json');
 writeFileSync(file,JSON.stringify({version:1,values:{VENDITBOT_APPS_CONFIG_GOOGLE:Buffer.from('synthetic-ciphertext').toString('base64')}}),{mode:0o600});const original=readFileSync(file);
 const secrets=new EncryptedSecretStore(root,{isAsyncEncryptionAvailable:async()=>true,encryptStringAsync:async()=>assert.fail('must not encrypt'),...encryption},30);
 let manager;const phases=[];manager=new AppConnectorManager({root,secrets,registrations:[],assertMutable(){},changed(){if(manager){const v=manager.list().find(v=>v.id==='gmail');if(v.phase)phases.push(v.phase);}},fetch:async()=>{fetches++;assert.fail('no provider request before consent');},openExternal:async()=>{opens++;}});
 t.after(async()=>{await manager.abortAndWait();assert.deepEqual(readFileSync(file),original);rmSync(root,{recursive:true,force:true});});
 return {manager,secrets,phases,view:()=>manager.list().find(v=>v.id==='gmail'),get opens(){return opens;},get fetches(){return fetches;}};
}
test('secure registration timeout and pending errors stay actionable; late approval cannot replay and explicit retry opens once',async t=>{
 let resolve,reads=0;const pending=new Promise(r=>{resolve=r;});const f=fixture(t,{decryptStringAsync:async()=>++reads===1?pending:{result:config,shouldReEncrypt:false}});
 await f.manager.connect({id:'gmail',consentAccepted:true});await until(()=>!f.manager.isBusy());assert.match(f.view().error,/보안 저장소 응답 시간이 초과/);assert.doesNotMatch(f.view().error,/네트워크/);assert.deepEqual([...new Set(f.phases)],['reading_registration']);assert.equal(f.secrets.isPending(),true);
 await f.manager.connect({id:'gmail',consentAccepted:true});await until(()=>!f.manager.isBusy());assert.match(f.view().error,/이전 macOS 보안 저장소 요청/);assert.equal(reads,1);assert.equal(f.opens,0);assert.equal(f.fetches,0);
 resolve({result:config,shouldReEncrypt:false});await until(()=>!f.secrets.isPending());assert.equal(f.opens,0);assert.equal(f.fetches,0);
 await f.manager.connect({id:'gmail',consentAccepted:true});await until(()=>f.view().phase==='awaiting_consent');assert.equal(f.opens,1);assert.equal(reads,2);await f.manager.cancel({id:'gmail'});assert.ok(!JSON.stringify(f.manager.list()).includes('synthetic-sensitive-marker'));
});
for(const scenario of ['denied','unavailable'])test(`secure registration ${scenario} produces only fixed storage guidance before networking`,async t=>{
 const f=fixture(t,{isAsyncEncryptionAvailable:async()=>scenario!=='unavailable',decryptStringAsync:async()=>{throw Error('native detail synthetic-sensitive-marker');}});
 await f.manager.connect({id:'gmail',consentAccepted:true});await until(()=>!f.manager.isBusy());assert.match(f.view().error,scenario==='denied'?/보안 저장소 요청에 실패/:/보안 저장소를 사용할 수 없어/);assert.doesNotMatch(f.view().error,/네트워크|synthetic-sensitive-marker|native detail/);assert.equal(f.opens,0);assert.equal(f.fetches,0);assert.equal(f.secrets.isPending(),false);
});
test('secure storage public errors ignore mutable native messages and reject arbitrary error lookalikes',()=>{
 const e=new SecureStorageError('timeout');e.message='synthetic-sensitive-marker';assert.match(publicError(e),/보안 저장소 응답 시간이 초과/);assert.doesNotMatch(publicError(e),/synthetic-sensitive-marker/);
 assert.match(publicError(Object.assign(Error('synthetic-sensitive-marker'),{code:'timeout',name:'SecureStorageError'})),/연결 설정과 네트워크/);assert.doesNotMatch(publicError(Error('synthetic-sensitive-marker')),/synthetic-sensitive-marker/);
});
test('cancelling secure registration never opens a browser after a late native result',async t=>{
 let resolve,started=false;const pending=new Promise(r=>{resolve=r;});const f=fixture(t,{decryptStringAsync:async()=>{started=true;return pending;}});
 await f.manager.connect({id:'gmail',consentAccepted:true});await until(()=>started);await f.manager.cancel({id:'gmail'});assert.equal(f.view().status,'disconnected');assert.equal(f.secrets.isPending(),true);resolve({result:config,shouldReEncrypt:false});await until(()=>!f.secrets.isPending());assert.equal(f.opens,0);assert.equal(f.fetches,0);assert.equal(f.view().hasCredential,false);
});
