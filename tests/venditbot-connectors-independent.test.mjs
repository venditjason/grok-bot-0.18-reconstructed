import assert from 'node:assert/strict';
import test from 'node:test';
import {mkdtempSync, readFileSync, writeFileSync, rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {randomUUID} from 'node:crypto';
import {setImmediate as turn} from 'node:timers/promises';
import {build} from 'esbuild';
const built = await build({stdin:{contents:"export * from './source/venditbot/app-connectors/manager.ts'; export * from './source/venditbot/app-connectors/tools.ts'; export * from './source/venditbot/app-connectors/protocol.ts'; export * from './source/venditbot/app-connectors/store.ts'; export * from './source/venditbot/app-connectors/mcp.ts'; export {EncryptedSecretStore} from './source/venditbot/local-store.ts';",resolveDir:process.cwd()},bundle:true,platform:'node',format:'esm',write:false});
const {AppConnectorManager,AppConnectorTools,AppConnectorStore,EncryptedSecretStore,ReadOnlyMcp,request,trustedUrl,publicError} = await import('data:text/javascript;base64,'+Buffer.from(built.outputFiles[0].text+'\n//# sourceURL=connectors-independent-bundle.mjs').toString('base64'));
const response = (value,status=200,headers={}) => new Response(JSON.stringify(value),{status,headers:{'content-type':'application/json',...headers}});
const deferred = () => {let resolve; const promise=new Promise(done=>{resolve=done;});return {promise,resolve};};
const scope='https://www.googleapis.com/auth/gmail.readonly';
const tokenKey='VENDITBOT_APPS_TOKEN_GMAIL',configKey='VENDITBOT_APPS_CONFIG_GOOGLE';
const config={provider:'google',clientId:'synthetic-client',clientSecret:'synthetic-client-secret'};
const metadata={issuer:'https://accounts.google.com',authorizationEndpoint:'https://accounts.google.com/o/oauth2/v2/auth',tokenEndpoint:'https://oauth2.googleapis.com/token'};
const oldToken=()=>({id:'gmail',provider:'google',accessToken:'synthetic-access',refreshToken:'synthetic-refresh',expiresAt:Date.now()+3600000,scopes:[scope],config,metadata});
async function fixture(t,overrides={}) {
 const root=mkdtempSync(join(tmpdir(),'vendit-connectors-independent-'));t.after(()=>rmSync(root,{recursive:true,force:true}));
 // Synthetic reversible encryption exercises the real encrypted-store transaction
 // protocol without invoking Keychain or using a real credential.
 let decrypts=0;
 const encryption={isAsyncEncryptionAvailable:async()=>true,encryptStringAsync:async text=>Buffer.from([...Buffer.from(text)].map(v=>v^165)),decryptStringAsync:async bytes=>{decrypts++;return {result:Buffer.from([...bytes].map(v=>v^165)).toString('utf8'),shouldReEncrypt:false};}};
 const secrets=new EncryptedSecretStore(root,encryption),grantId=randomUUID();
 await secrets.write(configKey,JSON.stringify(config));await secrets.write(tokenKey,JSON.stringify(overrides.token??oldToken()));
 writeFileSync(join(root,'app-connectors.json'),JSON.stringify({version:1,providers:{google:{}},apps:{gmail:{grantId}}}),{mode:0o600});
 let mutable=true; const calls=[];
 const manager=new AppConnectorManager({root,secrets,changed:()=>{},assertMutable:()=>{if(!mutable)throw Error('host stopping');},openExternal:async()=>{throw Error('no OAuth browser in independent tests');},fetch:async(url,init)=>{calls.push({url:String(url),init});return overrides.fetch?overrides.fetch(url,init):response({messages:[]});}});
 t.after(()=>manager.abortAndWait());
 return {root,secrets,encryption,manager,calls,grantId,get decrypts(){return decrypts;},setMutable:v=>{mutable=v;}};
}
test('public connector projection never decrypts or contains token/config plaintext',async t=>{
 const f=await fixture(t),before=f.decrypts,view=f.manager.list();assert.equal(f.decrypts,before);assert.equal(view.find(v=>v.id==='gmail').status,'connected');
 for(const secret of ['synthetic-access','synthetic-refresh','synthetic-client-secret'])assert.ok(!JSON.stringify(view).includes(secret));
});
test('metadata commit failure rolls the real encrypted store back to the old grant',async t=>{
 const f=await fixture(t),file=join(f.root,'credentials.encrypted.json'),before=readFileSync(file);
 await assert.rejects(f.secrets.write(tokenKey,'new-synthetic-token',{afterCommit:()=>{throw Error('metadata disk failure');}}));
 assert.deepEqual(readFileSync(file),before);assert.equal(JSON.parse(await f.secrets.read(tokenKey)).accessToken,'synthetic-access');
});
test('late native encryption completion after cancellation cannot replace old ciphertext',async t=>{
 const f=await fixture(t),before=readFileSync(join(f.root,'credentials.encrypted.json')),gate=deferred(),controller=new AbortController();
 f.encryption.encryptStringAsync=()=>gate.promise;
 const write=f.secrets.write(tokenKey,'late-synthetic-token',{signal:controller.signal});await turn();controller.abort();await assert.rejects(write,{name:'AbortError'});
 gate.resolve(Buffer.from('late-ciphertext'));await turn();assert.deepEqual(readFileSync(join(f.root,'credentials.encrypted.json')),before);
});
test('refresh request is preceded by durable uncertainty and cannot be silently retried after lost response',async t=>{
 let calls=0;const expired={...oldToken(),expiresAt:Date.now()-1};
 const f=await fixture(t,{token:expired,fetch:async()=>{calls++;const state=JSON.parse(readFileSync(join(f.root,'app-connectors.json'),'utf8'));assert.equal(state.apps.gmail.requiresReconnect,true);throw Error('lost token response containing synthetic-refresh');}});
 await assert.rejects(f.manager.read({id:'gmail',operation:'list_messages'}),e=>!e.message.includes('synthetic-refresh'));
 await assert.rejects(f.manager.read({id:'gmail',operation:'list_messages'}));assert.equal(calls,1);assert.equal(JSON.parse(await f.secrets.read(tokenKey)).accessToken,'synthetic-access');
});
test('host shutdown before refresh commit preserves old token and the uncertainty fence',async t=>{
 const f=await fixture(t,{token:{...oldToken(),expiresAt:Date.now()-1},fetch:async()=>{f.setMutable(false);return response({access_token:'replacement',refresh_token:'replacement-refresh',token_type:'bearer',scope,expires_in:3600});}});
 await assert.rejects(f.manager.read({id:'gmail',operation:'list_messages'}));assert.equal(JSON.parse(await f.secrets.read(tokenKey)).accessToken,'synthetic-access');assert.equal(JSON.parse(readFileSync(join(f.root,'app-connectors.json'),'utf8')).apps.gmail.requiresReconnect,true);
});
test('disconnect aborts pending read and cannot return content from the removed grant',async t=>{
 const gate=deferred();const f=await fixture(t,{fetch:async()=>gate.promise});
 const read=f.manager.read({id:'gmail',operation:'list_messages'});await turn();const removal=f.manager.disconnect({id:'gmail'});gate.resolve(response({messages:[{id:'must-not-return'}]}));
 await assert.rejects(read);await removal;assert.equal(f.secrets.has(tokenKey),false);assert.equal(f.manager.grantRevision('gmail'),undefined);
});
test('tool authorization cancellation and replacement grant prevent the underlying read',async()=>{
 let grant='first',reads=0;const gate=deferred(),controller=new AbortController();
 const port={list:()=>[{id:'gmail',status:'connected',hasCredential:true}],grantRevision:()=>grant,authorizeRead:()=>gate.promise,read:async()=>{reads++;return 'private';}};
 const tools=new AppConnectorTools(port,controller.signal),reading=tools.execute('read_connected_app',{id:'gmail',operation:'list_messages'},'call');
 await turn();grant='different-account';gate.resolve(true);await assert.rejects(reading,/연결이 변경/);assert.equal(reads,0);
 const cancelled=new AppConnectorTools({...port,authorizeRead:async()=>{controller.abort();return true;}},controller.signal);
 await assert.rejects(cancelled.execute('read_connected_app',{id:'gmail',operation:'list_messages'},'other'));assert.equal(reads,0);
});
test('official origins reject credentials, redirects, non-HTTPS and lookalike hosts',async()=>{
 for(const url of ['http://gmail.googleapis.com/gmail/v1','https://gmail.googleapis.com.evil.invalid','https://user:secret@gmail.googleapis.com','https://gmail.googleapis.com/#secret'])assert.throws(()=>trustedUrl('google',url));
 let calls=0;await assert.rejects(request(async()=>{calls++;return new Response(null,{status:302,headers:{location:'https://evil.invalid'}});},'google','https://gmail.googleapis.com/gmail/v1',{},new AbortController().signal),/다른 주소/);assert.equal(calls,1);
});
test('bounded API body rejects oversized content without returning any partial data',async()=>{
 const body=new ReadableStream({start(c){c.enqueue(new Uint8Array(65));c.close();}});
 await assert.rejects(request(async()=>new Response(body),'google','https://gmail.googleapis.com/gmail/v1',{},new AbortController().signal,64),/한도/);
});
test('MCP remote read hints cannot enable writes and mismatched response IDs cannot become data',async()=>{
 let calls=0;const client=new ReadOnlyMcp(async(_url,init)=>{calls++;const p=JSON.parse(init.body);if(p.method==='notifications/initialized')return new Response(null,{status:202});return response({id:p.id,result:p.method==='initialize'?{protocolVersion:'2025-03-26'}:{tools:[{name:'notion-create-pages',annotations:{readOnlyHint:true},inputSchema:{type:'object'}}]}});},'notion','synthetic-token',new AbortController().signal);
 assert.deepEqual(await client.list(),[]);await assert.rejects(client.call('notion-create-pages',{}),/읽기 전용/);assert.equal(calls,3);
 const wrong=new ReadOnlyMcp(async()=>response({id:999,result:{protocolVersion:'2025-03-26'}}),'github','synthetic-token',new AbortController().signal);await assert.rejects(wrong.list(),/요청 ID/);
});
test('corrupt public connector metadata is never reset or overwritten by defaults',async t=>{
 const f=await fixture(t),file=join(f.root,'app-connectors.json');writeFileSync(file,'{broken');assert.throws(()=>new AppConnectorStore(f.root));assert.equal(readFileSync(file,'utf8'),'{broken');
});
test('returned JSON redacts synthetic credential values even when JSON escaping changes their spelling',async t=>{
 const secret='synthetic-quote"and\\slash',token={...oldToken(),config:{...config,clientSecret:secret}};
 const f=await fixture(t,{token,fetch:async()=>response({echo:secret})});const result=await f.manager.read({id:'gmail',operation:'list_messages'});
 assert.notEqual(JSON.parse(result.text).echo,secret);
});
