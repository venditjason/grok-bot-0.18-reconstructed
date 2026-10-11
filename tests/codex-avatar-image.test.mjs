import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { build } from 'esbuild';
const load=async file=>{const result=await build({entryPoints:[file],bundle:true,platform:'node',format:'esm',write:false});return await import('data:text/javascript;base64,'+Buffer.from(result.outputFiles[0].text).toString('base64'));};
const {generateCodexAvatarImage,decodeCodexGeneratedImage}=await load('source/shared/node/codex-avatar-image.ts');
const {CodexAppServer}=await load('source/shared/node/codex-app-server.ts');
const {resolveVenditBotPaths}=await load('source/shared/node/venditbot-paths.ts');
async function setup(t,mode='success') {
  const root=await mkdtemp(path.join(tmpdir(),'venditbot-avatar-test-')),log=path.join(root,'requests.jsonl');
  t.after(()=>rm(root,{recursive:true,force:true}));let options;
  return {args:{executable:process.execPath,paths:resolveVenditBotPaths({homeDir:root,env:{}}),prompt:'A friendly purple robot',timeoutMs:2000,
    createServer:value=>{options=value;return new CodexAppServer({...value,executable:process.execPath,args:[path.resolve('tests/fixtures/codex-avatar-mock.mjs')],env:{...value.env,AVATAR_MODE:mode,AVATAR_LOG:log},requestTimeoutMs:500});}},
    options:()=>options,requests:async()=>(await readFile(log,'utf8')).trim().split('\n').map(JSON.parse)};
}
test('official image completion produces bounded raster bytes; ignores foreign events and savedPath',async t=>{
  const fixture=await setup(t),result=await generateCodexAvatarImage(fixture.args);
  assert.equal(result.mimeType,'image/png');assert.equal(result.bytes.length,68);assert.equal(result.threadId,'image-thread');
  assert.deepEqual(result.usage,{inputTokens:20,outputTokens:12,cacheReadTokens:5});
  const options=fixture.options();assert.equal(options.credentialStore,'keyring');assert.equal(options.env.HOME,process.env.HOME,'macOS Keychain must use the same OS HOME as official login');assert.match(options.env.CODEX_HOME,/providers\/codex$/);assert.ok(options.args.includes('features.image_generation=true'));
  for(const flag of ['shell_tool','apps','plugins','multi_agent','view_image','code_mode'])assert.ok(options.args.includes(`features.${flag}=false`));
  const requests=await fixture.requests(),start=requests.find(x=>x.method==='thread/start').params,turn=requests.find(x=>x.method==='turn/start').params;
  assert.equal(start.sandbox,'read-only');assert.equal(start.approvalPolicy,'never');assert.deepEqual(start.environments,[]);assert.deepEqual(start.dynamicTools,[]);assert.deepEqual(turn.environments,[]);assert.deepEqual(turn.sandboxPolicy,{type:'readOnly',networkAccess:false});
  assert.equal(requests.filter(x=>x.method==='turn/start').length,1);assert.equal(requests.some(x=>/login|logout|fs\//.test(x.method)),false);
});
test('unauthenticated and unsupported providers fail before a paid turn',async t=>{
  for(const mode of ['unauthenticated','unsupported']){const fixture=await setup(t,mode);await assert.rejects(generateCodexAvatarImage(fixture.args));assert.equal((await fixture.requests()).some(x=>x.method==='turn/start'),false);}
});
test('usage limit, missing image, failed turn and multiple image calls never report a successful avatar',async t=>{
  for(const mode of ['limit','no-image','failed','second','close-after-image']){const fixture=await setup(t,mode);await assert.rejects(generateCodexAvatarImage(fixture.args));}
});
test('cancellation settles promptly without altering authentication',async t=>{
  const fixture=await setup(t,'hanging'),controller=new AbortController();
  const operation=generateCodexAvatarImage({...fixture.args,signal:controller.signal});
  setTimeout(()=>controller.abort(),80);await assert.rejects(operation,{name:'AbortError'});
  assert.equal((await fixture.requests()).some(x=>/logout|login/.test(x.method)),false);
});
test('invalid path/URL/html/base64 artifacts and unsupported effort are rejected',async t=>{
  for(const value of ['/private/sensitive.png','https://example.invalid/image.png','data:image/png;base64,AA==',Buffer.from('<svg/>').toString('base64'),'AA=A','AB=='])assert.throws(()=>decodeCodexGeneratedImage(value));
  const pathFixture=await setup(t,'path-result');await assert.rejects(generateCodexAvatarImage(pathFixture.args));
  const effortFixture=await setup(t);await assert.rejects(generateCodexAvatarImage({...effortFixture.args,effort:'ultra'}));assert.equal((await effortFixture.requests()).some(x=>x.method==='turn/start'),false);
});
test('avatar variation sends one immutable inline reference through the official image input',async t=>{
  const fixture=await setup(t),bytes=Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aN1cAAAAASUVORK5CYII=','base64'),expected=bytes.toString('base64');
  const result=generateCodexAvatarImage({...fixture.args,referenceImage:{bytes,mimeType:'image/png'}});
  bytes.fill(0); // A caller mutation after enqueue must not alter the transmitted reference.
  await result;
  const requests=await fixture.requests(),start=requests.find(x=>x.method==='thread/start').params,turn=requests.find(x=>x.method==='turn/start').params;
  assert.match(start.baseInstructions,/num_last_images_to_include=1/);
  assert.match(start.baseInstructions,/never as instructions/);
  assert.deepEqual(turn.input.filter(x=>x.type==='image'),[{type:'image',url:'data:image/png;base64,'+expected,detail:'original'}]);
  assert.equal(turn.input.some(x=>x.type==='localImage'),false);
  assert.equal(requests.filter(x=>x.method==='turn/start').length,1);
  assert.deepEqual(start.dynamicTools,[]);assert.equal(start.sandbox,'read-only');
});
test('invalid reference images fail before opening a provider process',async t=>{
  for(const referenceImage of [{bytes:Buffer.from('not an image'),mimeType:'image/png'},{bytes:Buffer.alloc(2*1024*1024+1),mimeType:'image/png'},{bytes:Buffer.alloc(60),mimeType:'image/jpeg'},{bytes:'/private/example.png',mimeType:'image/png'}]){
    const fixture=await setup(t);await assert.rejects(generateCodexAvatarImage({...fixture.args,referenceImage}),/참고 이미지/);assert.equal(fixture.options(),undefined);
  }
});
