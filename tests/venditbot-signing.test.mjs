import test from 'node:test';
import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';
import {mkdtemp,mkdir,writeFile,rm,symlink} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {spawnSync} from 'node:child_process';
import {existsSync} from 'node:fs';
import path from 'node:path';
import {signingConfiguration,certificateRequirement,certificateSignArguments,requireSigningIdentity,verifyCertificateRequirement,signVenditBundle,assertSigningContinuity,signingContinuityBaseline,signingInventory} from '../scripts/lib/venditbot-signing.mjs';
const cert=Buffer.from('synthetic public certificate DER fixture, never an identity');
const identity=createHash('sha1').update(cert).digest('hex').toUpperCase(),sha256=createHash('sha256').update(cert).digest('hex');
const config=signingConfiguration({identity,certificateSha256:sha256});

test('production signing requires exact public certificate pins; only explicit development permits ad-hoc',()=>{
 for(const value of [undefined,'','-','VenditBot personal','A'.repeat(39),'A'.repeat(41),'A'.repeat(40)+'\n'])assert.throws(()=>signingConfiguration({identity:value,certificateSha256:sha256},{}),/fingerprint/);
 for(const value of [undefined,'','A'.repeat(63),'-'])assert.throws(()=>signingConfiguration({identity,certificateSha256:value},{}),/SHA-256/);
 assert.deepEqual(signingConfiguration({identity:identity.toLowerCase(),certificateSha256:sha256.toUpperCase()}),config);
 assert.deepEqual(signingConfiguration({development:true,identity:undefined}),{mode:'development-adhoc',identity:'-'});
});
test('production package command fails before output creation when certificate configuration is missing',{skip:process.platform!=='darwin'},async t=>{
 const root=await mkdtemp(path.join(tmpdir(),'vendit-signing-preflight-'));t.after(()=>rm(root,{recursive:true,force:true}));const output=path.join(root,'must-not-exist'),env={...process.env};delete env.VENDITBOT_CODESIGN_IDENTITY;delete env.VENDITBOT_CODESIGN_CERT_SHA256;
 const result=spawnSync(process.execPath,['scripts/package-venditbot.mjs','--output-dir',output],{cwd:process.cwd(),env,encoding:'utf8',timeout:10000});assert.equal(result.status,1);assert.match(result.stderr,/explicit 40-hex certificate fingerprint/);assert.equal(existsSync(output),false);
});
test('identity selection refuses unavailable/invalid identity and never chooses another valid certificate',async()=>{
 for(const value of ['0 valid identities found',`  1) ${'B'.repeat(40)} "another identity"\n 1 valid identities found`,` 1) ${identity} "expired" (CSSMERR_TP_CERT_EXPIRED)`])await assert.rejects(requireSigningIdentity(config,{capture:async()=>value}),/not an existing valid/);
 await requireSigningIdentity(config,{capture:async(command,args)=>{assert.equal(command,'/usr/bin/security');assert.deepEqual(args,['find-identity','-v','-p','codesigning']);return ` 1) ${identity} "synthetic identity"\n 1 valid identities found`;}});
});
test('signing requirements are literal certificate-bound expressions with each target own identifier',()=>{
 const main=certificateSignArguments('/tmp/copied.app',identity,'com.vendit.venditbot'),helper=certificateSignArguments('/tmp/copied.app/Helper.app',identity,'com.vendit.venditbot.helper');
 assert.ok(main.includes(`=designated => ${certificateRequirement(identity,'com.vendit.venditbot')}`));assert.ok(helper.includes(`=designated => ${certificateRequirement(identity,'com.vendit.venditbot.helper')}`));assert.ok(!main.includes('--deep'));assert.ok(!main.includes('-'));assert.throws(()=>certificateRequirement(identity,'unsafe" or true'),/Invalid/);
});
test('macOS requirement compiler accepts the exact certificate-bound expression without any Keychain access',{skip:process.platform!=='darwin'},async t=>{
 const root=await mkdtemp(path.join(tmpdir(),'vendit-requirement-syntax-'));t.after(()=>rm(root,{recursive:true,force:true}));const result=spawnSync('/usr/bin/csreq',['-r',`=${certificateRequirement(identity,'com.vendit.venditbot')}`,'-b',path.join(root,'requirement.bin')],{encoding:'utf8'});assert.equal(result.status,0,result.stderr);assert.equal(existsSync(path.join(root,'requirement.bin')),true);
});
test('verification rejects cdhash, identifier-only and broadened requirements even when native verification returns success',async()=>{
 const expected=certificateRequirement(identity,'com.vendit.venditbot');
 for(const text of ['identifier "com.vendit.venditbot"',`cdhash H"${identity.toLowerCase()}"`,`${expected} or true`])await assert.rejects(verifyCertificateRequirement('/tmp/app',identity,'com.vendit.venditbot',{run:async()=>{},capture:async()=>`# designated => ${text}`}),/not exactly bound/);
 assert.equal(await verifyCertificateRequirement('/tmp/app',identity,'com.vendit.venditbot',{run:async(command,args)=>assert.equal(args[3],`=${expected}`),capture:async()=>`# designated => ${expected}`}),expected);
});
async function fixture(t){
 const root=await mkdtemp(path.join(tmpdir(),'vendit-signing-test-')),app=path.join(root,'Synthetic.app'),helper=path.join(app,'Contents/Frameworks/Helper.app');t.after(()=>rm(root,{recursive:true,force:true}));
 const ids=new Map([[app,'com.vendit.venditbot'],[helper,'com.vendit.venditbot.helper']]);
 for(const bundle of ids.keys()){await mkdir(path.join(bundle,'Contents/MacOS'),{recursive:true});await writeFile(path.join(bundle,'Contents/Info.plist'),'synthetic plist');await writeFile(path.join(bundle,'Contents/MacOS/test'),Buffer.from([0xcf,0xfa,0xed,0xfe,1,2,3,4]));}
 await symlink('test',path.join(app,'Contents/MacOS/same-code-link'));
 const calls=[],requirements=new Map();const ports={capture:async(command,args)=>{
  if(command==='/usr/bin/security')return ` 1) ${identity} "synthetic identity"`;
  if(command==='/usr/bin/lipo')return 'arm64';
  if(command==='/usr/bin/plutil')return ids.get(path.resolve(args.at(-1),'../../'));
  if(command==='/usr/bin/codesign'&&args.includes('--requirements'))return `# designated => ${requirements.get(args.at(-1))}`;
  assert.fail(`unexpected capture ${command}`);
 },run:async(command,args)=>{calls.push({command,args});
  if(args.includes('--sign'))requirements.set(args.at(-1),args[args.indexOf('--requirements')+1].replace(/^=designated => /,''));
  const extraction=args.find(arg=>arg.startsWith('--extract-certificates='));
  assert.ok(!args.includes('--extract-certificates'),'macOS requires the optional extraction prefix attached with =');
  if(extraction){assert.equal(args.length,3);assert.equal(args[0],'--display');await writeFile(extraction.slice('--extract-certificates='.length)+'0',cert);}
 }};return {app,helper,calls,ports};
}
test('all copied Mach-O files and nested helpers use the same certificate, inner code first; public cert is verified',async t=>{
 const f=await fixture(t),inventory=await signingInventory(f.app);assert.equal(inventory.nativeFiles.length,2);assert.deepEqual(inventory.bundles,[f.helper,f.app]);
 const verified=await signVenditBundle(f.app,config,f.ports),signs=f.calls.filter(c=>c.args.includes('--sign'));
 assert.equal(signs.length,4);assert.ok(signs.every(c=>c.args[c.args.indexOf('--sign')+1]===identity));assert.equal(signs.at(-2).args.at(-1),f.helper);assert.equal(signs.at(-1).args.at(-1),f.app);assert.equal(verified.certificateSha256,sha256);assert.equal(verified.bundleRequirements.length,2);assert.notEqual(verified.bundleRequirements[0].designatedRequirement,verified.designatedRequirement);
});
test('a mismatched public SHA-256 certificate pin stops signing verification',async t=>{const f=await fixture(t);await assert.rejects(signVenditBundle(f.app,{...config,certificateSha256:'0'.repeat(64)},f.ports),/SHA-256 pin/);});
test('missing identity fails before accessing or modifying the copied app',async()=>{let runs=0;await assert.rejects(signVenditBundle('/path/does-not-exist',config,{capture:async()=>'',run:async()=>{runs++;}}),/not an existing valid/);assert.equal(runs,0);});
test('routine release continuity rejects certificate rotation or cdhash changes and requires explicit initial transition',async()=>{
 const previous={signature:'certificate-personal-validation',certificateSha1:identity,certificateSha256:sha256,designatedRequirement:certificateRequirement(identity,'com.vendit.venditbot')};assert.doesNotThrow(()=>assertSigningContinuity(previous,{...previous}));
 for(const next of [{...previous,certificateSha1:'B'.repeat(40)},{...previous,certificateSha256:'0'.repeat(64)},{...previous,designatedRequirement:'identifier "com.vendit.venditbot"'},{...previous,signature:'development-adhoc'}])assert.throws(()=>assertSigningContinuity(previous,next),/not a routine update/);
 await assert.rejects(signingContinuityBaseline({config,identifier:'com.vendit.venditbot'}),/previous-app/);
 await assert.rejects(signingContinuityBaseline({config,previousApp:'/tmp/old.app',initialCertificateRelease:true}),/not both/);
 assert.equal(await signingContinuityBaseline({config,initialCertificateRelease:true}),undefined);
});
