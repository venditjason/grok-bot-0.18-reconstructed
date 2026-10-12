import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync,writeFileSync,rmSync,readFileSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {pathToFileURL} from 'node:url';
import {request as httpRequest} from 'node:http';
import {build} from 'esbuild';
const compiled=mkdtempSync(join(tmpdir(),'vendit-connect-once-module-'));
const bundle=await build({stdin:{contents:`export * from './source/venditbot/app-connectors/manager.ts';export * from './source/venditbot/app-connectors/protocol.ts';export * from './source/venditbot/app-connectors/registrations.ts';export * from './source/venditbot/app-connectors/device.ts';export * from './source/venditbot/app-connectors/mcp.ts';`,resolveDir:process.cwd(),loader:'ts'},bundle:true,platform:'node',format:'esm',write:false});
writeFileSync(join(compiled,'module.mjs'),bundle.outputFiles[0].text);
const {AppConnectorManager,managedAppRegistrations,MANAGED_APP_REGISTRATIONS,oauthCallback,githubDeviceAuthorization,oauthErrorMessage,MCP_READ_ALLOWLIST}=await import(pathToFileURL(join(compiled,'module.mjs')).href);
process.on('exit',()=>rmSync(compiled,{recursive:true,force:true}));
const json=(value,status=200)=>new Response(JSON.stringify(value),{status,headers:{'Content-Type':'application/json'}});
const until=async fn=>{const end=Date.now()+4000;while(!fn()){if(Date.now()>end)throw Error('synthetic deadline');await new Promise(r=>setTimeout(r,2));}};
const google={provider:'google',clientId:'dedicated-test.apps.googleusercontent.com',flow:'native_pkce'};
const github={provider:'github',clientId:'Iv1.dedicatedtest',githubApp:true,flow:'device'};
function fixture(t,{registrations=[],useReleaseDefaults=false,fetcher,open,wait}={}){
 const root=mkdtempSync(join(tmpdir(),'vendit-connect-once-')),values=new Map(),calls=[],urls=[],events=[];let reads=0,manager;
 const secrets={has:key=>values.has(key),revision:key=>values.get(key),read:async(key,signal)=>{reads++;signal?.throwIfAborted();return values.get(key);},write:async(key,value,options={})=>{options.signal?.throwIfAborted();options.beforeCommit?.();const previous=values.get(key);values.set(key,value);try{options.afterCommit?.();}catch(error){previous===undefined?values.delete(key):values.set(key,previous);throw error;}},remove:(key,after)=>{const previous=values.get(key);values.delete(key);try{after?.();}catch(error){if(previous!==undefined)values.set(key,previous);throw error;}}};
 manager=new AppConnectorManager({root,secrets,...(useReleaseDefaults?{}:{registrations}),deviceWait:wait,assertMutable(){},changed(){if(manager)events.push(manager.list());},fetch:async(url,init={})=>{calls.push({url:String(url),init});if(fetcher)return fetcher(String(url),init);return json({access_token:'synthetic-token-only',refresh_token:'synthetic-refresh-only',token_type:'bearer',scope:'https://www.googleapis.com/auth/gmail.readonly',expires_in:3600});},openExternal:async url=>{urls.push(url);if(open)return open(url);const auth=new URL(url),cb=new URL(auth.searchParams.get('redirect_uri'));cb.searchParams.set('state',auth.searchParams.get('state'));cb.searchParams.set('code','synthetic-code-only');const response=await fetch(cb);assert.equal(response.status,200);assert.match(await response.text(),/벤디트봇/);}});
 t.after(async()=>{await manager.abortAndWait();rmSync(root,{recursive:true,force:true});});return {manager,values,calls,urls,events,root,get reads(){return reads;}};
}
const deviceGrant={device_code:'a'.repeat(40),user_code:'ABCD-EFGH',verification_uri:'https://github.com/login/device',expires_in:900,interval:5};
const deviceToken={access_token:'synthetic-device-token',refresh_token:'synthetic-device-refresh',token_type:'bearer',scope:'',expires_in:28800};

test('release presets contain no borrowed default IDs and reject secret or unsupported fields',()=>{
 assert.deepEqual(MANAGED_APP_REGISTRATIONS,[
 {provider:'github',clientId:'Iv23lizKDfRa2sIe3DSZ',githubApp:true,flow:'device'},
 {provider:'slack',clientId:'1443515283511.12283089417861',appId:'A0C8B2MC9RB',flow:'native_pkce'},
 ]);
 for(const input of [[{...google,clientSecret:'private'}],[{...github,token:'private'}],[{...google,flow:'implicit'}],[google,google],[{provider:'notion',clientId:'private',flow:'native_pkce'}]])assert.throws(()=>managedAppRegistrations(input));
 assert.equal(managedAppRegistrations([google,github,{provider:'slack',clientId:'123.456',appId:'A1234567',flow:'native_pkce'}]).size,3);
});
test('missing registration does not decrypt, open browser or look operational; Notion remains dynamic',async t=>{
 const f=fixture(t);f.values.set('CODEX_AUTH','unrelated');assert.equal(f.manager.list().find(v=>v.id==='gmail').registration,'unavailable');assert.equal(f.manager.list().find(v=>v.id==='notion').registration,'dynamic');await assert.rejects(f.manager.connect({id:'gmail',consentAccepted:true}),/준비/);assert.equal(f.reads,0);assert.equal(f.calls.length,0);assert.equal(f.urls.length,0);
});
test('managed Google needs one connect click and public ID only, preserves explicit official consent and phases',async t=>{
 const f=fixture(t,{registrations:[google]});assert.equal(f.manager.list().find(v=>v.id==='gmail').registration,'managed');await f.manager.connect({id:'gmail',consentAccepted:true});await until(()=>!f.manager.isBusy());const view=f.manager.list().find(v=>v.id==='gmail');assert.equal(view.status,'connected',view.error);assert.equal(f.reads,0);const auth=new URL(f.urls[0]),form=new URLSearchParams(f.calls[0].init.body);assert.equal(auth.searchParams.get('client_id'),google.clientId);assert.equal(auth.searchParams.get('prompt'),'consent');assert.equal(auth.searchParams.get('code_challenge_method'),'S256');assert.equal(form.has('client_secret'),false);assert.ok(form.get('code_verifier'));
 for(const phase of ['discovering','opening_browser','awaiting_consent','exchanging_token','saving_credential'])assert.ok(f.events.some(list=>list.some(v=>v.phase===phase)),phase);
 assert.equal(view.phase,undefined);assert.equal(view.lastTest,undefined);assert.ok(!JSON.stringify(f.events).includes('synthetic-token'));assert.ok(!readFileSync(join(f.root,'app-connectors.json'),'utf8').includes('synthetic-token'));
});
test('custom encrypted registration takes precedence over preset without borrowing unrelated credentials',async t=>{
 const f=fixture(t,{registrations:[google]});await f.manager.configure({provider:'google',clientId:'custom-public-id'});await f.manager.connect({id:'gmail',consentAccepted:true});await until(()=>!f.manager.isBusy());assert.equal(new URL(f.urls[0]).searchParams.get('client_id'),'custom-public-id');assert.equal(f.manager.list().find(v=>v.id==='gmail').registration,'custom');
});
test('callback sends complete no-store response before closing and keeps auth code off page',async t=>{
 const controller=new AbortController(),cb=await oauthCallback('notion',controller.signal,2000);t.after(()=>cb.close());const url=new URL(cb.redirectUri);url.searchParams.set('state',cb.state);url.searchParams.set('code','private-once-code');
 const result=await new Promise((resolve,reject)=>{const req=httpRequest(url,{agent:false},res=>{let body='';res.setEncoding('utf8');res.on('data',chunk=>body+=chunk);res.on('aborted',()=>reject(Error('response truncated')));res.on('end',()=>resolve({status:res.statusCode,headers:res.headers,body,complete:res.complete}));});req.on('error',reject);req.end();});
 assert.equal(result.status,200);assert.equal(result.complete,true);assert.match(result.body,/인증 응답/);assert.equal(result.headers['content-type'],'text/html; charset=utf-8');assert.match(result.body,/<!doctype html><html lang="ko">/);assert.match(result.body,/<meta charset="utf-8">/);assert.match(result.body,/<title>벤디트봇/);assert.ok(!result.body.includes(cb.state));assert.doesNotMatch(result.body,/<(?:script|iframe|form|link|img)\b|https?:|src=|href=/);assert.ok(!result.body.includes('private-once-code'));assert.equal(result.headers['cache-control'],'no-store');assert.equal(result.headers['x-content-type-options'],'nosniff');assert.match(result.headers['content-security-policy'],/default-src 'none'/);assert.equal(await cb.code,'private-once-code');await assert.rejects(fetch(url));
});
test('callback rejects mixed code and error without consuming valid flow, then maps denial safely',async t=>{
 const cb=await oauthCallback('google',new AbortController().signal,2000);t.after(()=>cb.close());const url=new URL(cb.redirectUri);url.searchParams.set('state',cb.state);url.searchParams.set('code','private-code');url.searchParams.set('error','access_denied');assert.equal((await fetch(url)).status,400);url.searchParams.delete('code');url.searchParams.set('error_description','private-error-value');const denied=await fetch(url);assert.equal(denied.status,200);assert.ok(!(await denied.text()).includes('private-error'));await assert.rejects(cb.code,error=>error.message.includes('취소')&&!error.message.includes('private'));
});
test('callback timeout and abort stay distinguishable and close listener',async()=>{
 const timed=await oauthCallback('google',new AbortController().signal,20);await assert.rejects(timed.code,/시간/);await assert.rejects(fetch(timed.redirectUri));const controller=new AbortController(),cancelled=await oauthCallback('google',controller.signal,2000);controller.abort();await assert.rejects(cancelled.code,/취소/);await assert.rejects(fetch(cancelled.redirectUri));
});
test('GitHub device polling honors interval and slow_down; only user code crosses public boundary',async t=>{
 let polls=0;const delays=[];const f=fixture(t,{registrations:[github],wait:async ms=>{delays.push(ms);},open:async url=>assert.equal(url,deviceGrant.verification_uri),fetcher:async(url,init)=>{
  if(url.endsWith('/device/code')){const form=new URLSearchParams(init.body);assert.equal(form.get('scope'),'offline_access');assert.equal(form.has('client_secret'),false);return json(deviceGrant);}
  if(url==='https://api.github.com/user')return json({id:123});
  polls++;const form=new URLSearchParams(init.body);assert.equal(form.has('client_secret'),false);assert.equal(form.get('device_code'),deviceGrant.device_code);return json(polls===1?{error:'authorization_pending'}:polls===2?{error:'slow_down'}:deviceToken);
 }});await f.manager.connect({id:'github',consentAccepted:true});await until(()=>!f.manager.isBusy());assert.equal(f.manager.list().find(v=>v.id==='github').status,'connected');assert.deepEqual(delays,[5000,5000,10000]);assert.equal(f.urls.length,1);const publicState=JSON.stringify(f.events);assert.ok(publicState.includes(deviceGrant.user_code));assert.ok(!publicState.includes(deviceGrant.device_code));assert.ok(!publicState.includes(deviceToken.access_token));const stored=JSON.parse(f.values.get('VENDITBOT_APPS_TOKEN_GITHUB'));assert.equal(stored.config.flow,'device');assert.equal(stored.config.clientSecret,undefined);assert.ok(stored.expiresAt>Date.now());assert.equal(f.manager.list().find(v=>v.id==='github').deviceAuthorization,undefined);
});
test('GitHub device refresh uses no client secret and rotates only once',async t=>{
 let refreshes=0;const f=fixture(t,{registrations:[github],wait:async()=>{},open:async()=>{},fetcher:async(url,init)=>{
  if(url.endsWith('/device/code'))return json(deviceGrant);if(url==='https://api.github.com/user')return json({id:123});
  if(url.endsWith('/access_token')){const form=new URLSearchParams(init.body);assert.equal(form.has('client_secret'),false);if(form.get('grant_type')==='refresh_token'){refreshes++;return json(deviceToken);}return json({...deviceToken,expires_in:1});}
  const payload=JSON.parse(init.body);return payload.method==='notifications/initialized'?new Response(null,{status:202}):json({jsonrpc:'2.0',id:payload.id,result:payload.method==='initialize'?{protocolVersion:'2025-03-26'}:{tools:[]}});
 }});await f.manager.connect({id:'github',consentAccepted:true});await until(()=>!f.manager.isBusy());const revision=f.manager.grantRevision('github');await f.manager.read({id:'github',operation:'list_read_tools'});await f.manager.read({id:'github',operation:'list_read_tools'});assert.equal(refreshes,1);assert.equal(f.manager.grantRevision('github'),revision);
});
test('device cancellation during wait saves nothing and removes displayed code',async t=>{
 let waiting=false;const f=fixture(t,{registrations:[github],open:async()=>{},wait:async(ms,signal)=>{waiting=true;await new Promise((resolve,reject)=>{signal.addEventListener('abort',()=>reject(Error('aborted')),{once:true});});},fetcher:async()=>json(deviceGrant)});await f.manager.connect({id:'github',consentAccepted:true});await until(()=>waiting);await f.manager.cancel({id:'github'});assert.equal(f.values.size,0);assert.equal(f.manager.list().find(v=>v.id==='github').deviceAuthorization,undefined);assert.equal(f.manager.list().find(v=>v.id==='github').status,'disconnected');
});
test('hostile device verification URLs and malformed lifetimes never open a browser',async()=>{
 for(const change of [{verification_uri:'https://github.com.evil.test/login/device'},{verification_uri:'https://github.com/login/device?token=private'},{user_code:'<script>'},{expires_in:0},{interval:0},{expires_in:901}]){
  await assert.rejects(githubDeviceAuthorization({fetcher:async()=>json({...deviceGrant,...change}),clientId:github.clientId,scopes:[],signal:new AbortController().signal,openExternal:()=>assert.fail('must not open'),progress:()=>assert.fail('must not publish')}));
 }
});
test('known and unknown remote OAuth errors never echo secret-bearing descriptions',async t=>{
 for(const code of ['invalid_client','admin_policy_enforced','private-token-error']){
  const f=fixture(t,{registrations:[google],fetcher:async()=>json({error:code,error_description:'secret-bearing-private'},400)});await f.manager.connect({id:'gmail',consentAccepted:true});await until(()=>!f.manager.isBusy());const state=f.manager.list().find(v=>v.id==='gmail');assert.equal(state.status,'error');assert.ok(!JSON.stringify(state).includes('private'));assert.ok(!state.hasCredential);assert.match(state.error,/공식 로그인 응답/);
 }
 assert.match(oauthErrorMessage('device_flow_disabled'),/기기 로그인/);
});
test('failed device identity verification cannot replace previous token or grant',async t=>{
 let second=false;const f=fixture(t,{registrations:[github],open:async()=>{},wait:async()=>{},fetcher:async url=>url.endsWith('/device/code')?json(deviceGrant):url==='https://api.github.com/user'?json(second?{id:'forged'}:{id:123}):json({...deviceToken,access_token:second?'new-private-token':deviceToken.access_token})});await f.manager.connect({id:'github',consentAccepted:true});await until(()=>!f.manager.isBusy());const token=f.values.get('VENDITBOT_APPS_TOKEN_GITHUB'),revision=f.manager.grantRevision('github');second=true;await f.manager.connect({id:'github',consentAccepted:true});await until(()=>!f.manager.isBusy());assert.equal(f.values.get('VENDITBOT_APPS_TOKEN_GITHUB'),token);assert.equal(f.manager.grantRevision('github'),revision);assert.equal(f.manager.list().find(v=>v.id==='github').hasCredential,true);assert.ok(!JSON.stringify(f.manager.list()).includes('private-token'));
});
test('official Notion self metadata read is allowed only through advertised read-tool intersection',()=>{
 assert.ok(MCP_READ_ALLOWLIST.notion.includes('notion-get-self'));assert.ok(!MCP_READ_ALLOWLIST.notion.includes('notion-update-page'));
});

test('default release lists only two managed registrations plus dynamic Notion without decrypt or network',t=>{
 const f=fixture(t,{useReleaseDefaults:true});const views=f.manager.list();assert.equal(views.length,8);assert.deepEqual(views.filter(v=>v.registration==='managed').map(v=>v.id).sort(),['github','slack']);assert.equal(views.filter(v=>v.configured).length,3);assert.equal(views.filter(v=>v.status==='setup_required').length,5);assert.equal(views.filter(v=>v.status==='disconnected').length,3);assert.ok(views.every(v=>!v.hasCredential));assert.equal(f.reads,0);assert.equal(f.calls.length,0);assert.equal(f.urls.length,0);assert.equal(f.values.size,0);
});
test('private Google configuration prepares all five services without connecting or exposing client secret',async t=>{
 const f=fixture(t,{useReleaseDefaults:true}),secret='synthetic-private-config-secret';await f.manager.configure({provider:'google',clientId:'private-test.apps.googleusercontent.com',clientSecret:secret});const views=f.manager.list(),googleViews=views.filter(v=>v.provider==='google');assert.equal(googleViews.length,5);assert.ok(googleViews.every(v=>v.configured&&v.registration==='custom'&&v.status==='disconnected'&&!v.hasCredential));assert.equal(f.values.size,1);assert.ok(f.values.has('VENDITBOT_APPS_CONFIG_GOOGLE'));assert.equal(f.calls.length,0);assert.equal(f.urls.length,0);assert.ok(!JSON.stringify(views).includes(secret));assert.ok(!JSON.stringify(f.events).includes(secret));assert.ok(!readFileSync(join(f.root,'app-connectors.json'),'utf8').includes(secret));
});
test('private Google secret is used for exact token exchange and one same-grant refresh only',async t=>{
 const secret='synthetic-private-refresh-secret',clientId='private-test.apps.googleusercontent.com';let exchanges=0,refreshes=0;const f=fixture(t,{fetcher:async(url,init)=>{assert.equal(url,'https://oauth2.googleapis.com/token');const form=new URLSearchParams(init.body);assert.equal(form.get('client_id'),clientId);assert.equal(form.get('client_secret'),secret);if(form.get('grant_type')==='refresh_token'){refreshes++;assert.equal(form.get('refresh_token'),'synthetic-refresh-only');}else{exchanges++;assert.equal(form.get('grant_type'),'authorization_code');assert.ok(form.get('code_verifier'));}return json({access_token:'synthetic-private-access',refresh_token:'synthetic-refresh-only',token_type:'bearer',scope:'https://www.googleapis.com/auth/gmail.readonly',expires_in:refreshes?3600:1});}});
 await f.manager.configure({provider:'google',clientId,clientSecret:secret});await f.manager.connect({id:'gmail',consentAccepted:true});await until(()=>!f.manager.isBusy());const revision=f.manager.grantRevision('gmail');assert.ok(revision);await f.manager.read({id:'gmail',operation:'list_read_tools'});await f.manager.read({id:'gmail',operation:'list_read_tools'});assert.equal(exchanges,1);assert.equal(refreshes,1);assert.equal(f.manager.grantRevision('gmail'),revision);assert.ok(!f.urls.some(url=>url.includes(secret)));assert.ok(!JSON.stringify(f.events).includes(secret));assert.ok(!readFileSync(join(f.root,'app-connectors.json'),'utf8').includes(secret));
});
