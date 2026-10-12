import {spawn} from 'node:child_process';
import {createHash,randomUUID} from 'node:crypto';
import {mkdir,readFile,realpath,rename,rm,writeFile} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {capture,run} from './lib/process.mjs';
import {assertNativeDesktopEnvironment} from './lib/native-desktop-environment.mjs';
import {signingConfiguration,requireSigningIdentity,signVenditBundle,verifyVenditBundleSigning,assertSigningContinuity} from './lib/venditbot-signing.mjs';

export function canaryNamespace(name) {
  if(typeof name!=='string'||!/^VenditBotSigningQA-[a-f0-9]{32}$/.test(name))throw new Error('Only a fresh UUID safeStorage test namespace is allowed.');
  return {name,account:name+' Key',legacyAccount:name,service:`${name} Safe Storage`,bundleId:`com.vendit.venditbot.signingqa.${name.slice(19)}`};
}

/** A namespace intention or successful encrypt call does not prove which native
 * Keychain item was accessed. In particular, missing expected metadata leaves
 * actual native access unverified; never infer production non-access. */
export function canaryScopeEvidence(journal) {
  return {productionDataAccess:'unknown',
    intendedKeychainScope:'Only the new synthetic service/account; no existing credentials, ACL or search-list changes are authorized.',
    verifiedKeychainEvidence:{exactPairAbsentBefore:journal.absentBefore===true,legacyPairAbsentBefore:journal.legacyAbsentBefore===true,nativeLaunchAttempted:journal.launchAttempted===true,exactPairObservedAfterLaunch:journal.createdAfterLaunch===true},
    nativeItemAccessScope:journal.createdAfterLaunch===true?'Expected pair observed; other native item access was not audited.':'Unverified; expected pair creation has not been confirmed.'};
}

export async function canaryOutputPath(output) {
  const parent=await realpath(path.dirname(path.resolve(output))),roots=await Promise.all([realpath(tmpdir()),realpath('/private/tmp')]);
  if(!roots.some(root=>parent===root||parent.startsWith(root+path.sep)))throw new Error('Native canary output must be a new directory inside a physical temporary root, never an application or user profile directory.');
  return path.join(parent,path.basename(output));
}

function securityMetadata(args) {
  return new Promise((resolve,reject)=>{
    const child=spawn('/usr/bin/security',args,{stdio:['ignore','pipe','pipe'],shell:false});let stdout='';
    const timer=setTimeout(()=>child.kill('SIGKILL'),10000);
    child.stdout.setEncoding('utf8');child.stdout.on('data',chunk=>{stdout+=chunk;if(stdout.length>65536)child.kill();});
    // No password switches are used. Do not print even metadata for the exact synthetic item.
    child.stderr.resume();child.once('error',()=>{clearTimeout(timer);reject(new Error('Synthetic Keychain metadata command could not start.'));});
    child.once('exit',code=>{clearTimeout(timer);resolve({code,stdout});});
  });
}

export async function queryCanaryItem(namespace,execute=securityMetadata) {return queryCanaryAccount(namespace,false,execute);}
export async function queryLegacyCanaryItem(namespace,execute=securityMetadata) {return queryCanaryAccount(namespace,true,execute);}
async function queryCanaryAccount(namespace,legacy,execute) {
  const checked=canaryNamespace(namespace.name);
  if(checked.account!==namespace.account||checked.legacyAccount!==namespace.legacyAccount||checked.service!==namespace.service)throw new Error('Canary namespace mismatch.');
  const account=legacy?checked.legacyAccount:checked.account;
  const result=await execute(['find-generic-password','-s',checked.service,'-a',account]);
  if(result.code===44)return undefined; // errSecItemNotFound, with no password read.
  if(result.code!==0)throw new Error('Cannot establish exact synthetic Keychain item absence or attributes.');
  if(!result.stdout.includes(`"acct"<blob>="${account}"`)||!result.stdout.includes(`"svce"<blob>="${checked.service}"`))throw new Error('Keychain returned an unexpected item; refuse to touch it.');
  return {metadataSha256:createHash('sha256').update(result.stdout).digest('hex')};
}

export async function preflightCanaryNamespace(namespace,execute=securityMetadata) {
  // Electron's downstream patch may migrate/delete an unsuffixed legacy item.
  // Both exact UUID pairs must be absent before any native safeStorage call.
  if(await queryCanaryItem(namespace,execute)||await queryLegacyCanaryItem(namespace,execute))throw new Error('Fresh suffixed or legacy canary pair already exists. Refuse native launch.');
  return {absentBefore:true,legacyAbsentBefore:true};
}

export async function deleteProvenCanary(namespace,journal,execute=securityMetadata) {
  if(journal.absentBefore!==true||journal.legacyAbsentBefore!==true||journal.launchAttempted!==true||journal.createdAfterLaunch!==true||journal.namespace?.name!==namespace.name)throw new Error('Only the exact proven-new synthetic Keychain pair may be deleted.');
  if(!await queryCanaryItem(namespace,execute))return;
  const result=await execute(['delete-generic-password','-s',namespace.service,'-a',namespace.account]);
  if(result.code!==0)throw new Error('Synthetic Keychain item cleanup was not confirmed. Keep the journal for manual inspection.');
  if(await queryCanaryItem(namespace,execute))throw new Error('Synthetic Keychain item remains after cleanup.');
}

async function changePlist(plist,key,value) {await run('/usr/bin/plutil',['-replace',key,'-string',value,plist]);}

async function createFixture(runtime,target,namespace,version,profile,resultPath,synthetic) {
  await run('/usr/bin/ditto',[runtime,target]);
  const contents=path.join(target,'Contents'),resources=path.join(contents,'Resources'),plist=path.join(contents,'Info.plist');
  const runtimeInfo=JSON.parse(await capture('/usr/bin/plutil',['-convert','json','-o','-',plist]));
  if(runtimeInfo.CFBundleExecutable!=='Electron'||runtimeInfo.CFBundleShortVersionString!=='42.11.12')throw new Error('Native canary requires the inspected Electron 42.11.12 template.');
  await rename(path.join(contents,'MacOS','Electron'),path.join(contents,'MacOS',namespace.name));
  for(const [key,value]of Object.entries({CFBundleName:namespace.name,CFBundleDisplayName:namespace.name,CFBundleExecutable:namespace.name,CFBundleIdentifier:namespace.bundleId,CFBundleVersion:version,CFBundleShortVersionString:version}))await changePlist(plist,key,value);
  if(runtimeInfo.CFBundleURLTypes)await run('/usr/bin/plutil',['-remove','CFBundleURLTypes',plist]);
  if(runtimeInfo.ElectronAsarIntegrity)await run('/usr/bin/plutil',['-remove','ElectronAsarIntegrity',plist]);
  const frameworks=path.join(contents,'Frameworks');
  for(const suffix of ['', ' (GPU)',' (Renderer)',' (Plugin)']){
    const from=path.join(frameworks,`Electron Helper${suffix}.app`),to=path.join(frameworks,`${namespace.name} Helper${suffix}.app`),helperName=`${namespace.name} Helper${suffix}`,helperPlist=path.join(from,'Contents/Info.plist');
    await rename(path.join(from,'Contents/MacOS',`Electron Helper${suffix}`),path.join(from,'Contents/MacOS',helperName));
    for(const [key,value]of Object.entries({CFBundleName:helperName,CFBundleDisplayName:helperName,CFBundleExecutable:helperName,CFBundleIdentifier:`${namespace.bundleId}.helper${suffix?'.'+suffix.slice(2,-1).toLowerCase():''}`}))await changePlist(helperPlist,key,value);
    await rename(from,to);
  }
  await rm(path.join(resources,'default_app.asar'),{force:true});const appRoot=path.join(resources,'app');await mkdir(appRoot);
  await writeFile(path.join(appRoot,'package.json'),JSON.stringify({name:namespace.name,productName:namespace.name,version,main:'main.cjs'}));
  // This fixture imports no product bootstrap or real profile module. The only plaintext is a fresh synthetic canary.
  const main=`const {app,safeStorage}=require('electron');const fs=require('node:fs');const cp=require('node:child_process');const crypto=require('node:crypto');const path=require('node:path');
const name=${JSON.stringify(namespace.name)},profile=${JSON.stringify(profile)},out=${JSON.stringify(resultPath)},expected=${JSON.stringify(synthetic)},bundleId=${JSON.stringify(namespace.bundleId)};
app.setName(name);app.setPath('userData',profile);app.setPath('sessionData',path.join(profile,'chromium'));app.disableHardwareAcceleration();
app.whenReady().then(async()=>{const plist=path.resolve(process.resourcesPath,'../Info.plist');const info=JSON.parse(cp.execFileSync('/usr/bin/plutil',['-convert','json','-o','-',plist],{encoding:'utf8'}));const pkg=require('./package.json');
if(app.getName()!==name||info.CFBundleName!==name||info.CFBundleDisplayName!==name||info.CFBundleExecutable!==name||info.CFBundleIdentifier!==bundleId||pkg.name!==name||pkg.productName!==name||app.getPath('userData')!==profile||process.versions.electron!=='42.11.12')throw Error('namespace preflight failed');
if(!await safeStorage.isAsyncEncryptionAvailable())throw Error('native encryption unavailable');const file=path.join(profile,'synthetic.encrypted');const mode=process.env.VENDITBOT_SAFESTORAGE_QA_STAGE;
if(mode==='encrypt'){if(fs.existsSync(file))throw Error('refusing existing ciphertext');const bytes=await safeStorage.encryptStringAsync(expected);fs.writeFileSync(file,bytes,{flag:'wx',mode:0o600});}
else if(mode==='decrypt'){const before=fs.readFileSync(file);const value=await safeStorage.decryptStringAsync(before);if(value.result!==expected)throw Error('synthetic decrypt mismatch');if(!before.equals(fs.readFileSync(file)))throw Error('ciphertext changed');}
else throw Error('invalid canary stage');fs.writeFileSync(out,JSON.stringify({status:'passed',stage:mode,appName:app.getName(),version:app.getVersion(),ciphertextSha256:crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex')}),{flag:'wx',mode:0o600});app.exit(0);
}).catch(()=>{fs.writeFileSync(out,JSON.stringify({status:'failed',error:'Native synthetic safeStorage verification failed; no raw error or credential data is recorded.'}),{flag:'wx',mode:0o600});app.exit(1);});`;
  await writeFile(path.join(appRoot,'main.cjs'),main);await run('/usr/bin/xattr',['-cr',target]);
}

async function runFixture(appPath,namespace,stage) {
  const env={...process.env,VENDITBOT_SAFESTORAGE_QA_STAGE:stage};delete env.ELECTRON_RUN_AS_NODE;
  await new Promise((resolve,reject)=>{
    const child=spawn(path.join(appPath,'Contents/MacOS',namespace.name),[],{env,stdio:'ignore',shell:false});
    const timer=setTimeout(()=>child.kill('SIGKILL'),90000);
    child.once('error',()=>{clearTimeout(timer);reject(new Error('Synthetic native application could not start.'));});
    child.once('exit',(code,signal)=>{clearTimeout(timer);code===0?resolve():reject(new Error(`Synthetic native ${stage} did not complete (${signal??code}); native Keychain access scope remains unverified.`));});
  });
}

export async function nativeContinuityMain(args) {
  if(!args.includes('--run-approved-native-safestorage'))throw new Error('Held by default. This driver creates and removes one new namespaced synthetic Keychain item only after explicit native-test approval.');
  assertNativeDesktopEnvironment(process.env);if(process.platform!=='darwin'||process.arch!=='arm64')throw new Error('Native macOS arm64 required.');
  const value=name=>{const index=args.indexOf(name);if(index===-1||!args[index+1]||args[index+1].startsWith('--'))throw new Error(`${name} requires a path`);return path.resolve(args[index+1]);};
  const output=await canaryOutputPath(value('--output-dir')),runtime=value('--runtime'),config=signingConfiguration();await requireSigningIdentity(config);
  await mkdir(output,{mode:0o700}); // New output only; no reuse of prior canaries.
  const namespace=canaryNamespace(`VenditBotSigningQA-${randomUUID().replaceAll('-','')}`),profile=path.join(output,'profile'),journalPath=path.join(output,'keychain-canary-journal.json');
  const absence=await preflightCanaryNamespace(namespace);
  const journal={schema:1,namespace,...absence,launchAttempted:false,createdAfterLaunch:false,cleanup:'not-created'};
  const saveJournal=()=>writeFile(journalPath,JSON.stringify(journal,null,2)+'\n',{mode:0o600});await saveJournal();
  const report={schema:1,status:'failed',...canaryScopeEvidence(journal),namespace,startedAt:new Date().toISOString()};
  let failure;
  try{
    await mkdir(profile,{mode:0o700});const first=path.join(output,'first',`${namespace.name}.app`),second=path.join(output,'second',`${namespace.name}.app`),installed=path.join(output,'current',`${namespace.name}.app`),previous=path.join(output,'previous',`${namespace.name}.app`);
    for(const folder of ['first','second','current','previous'])await mkdir(path.join(output,folder),{mode:0o700});
    const encryptedResult=path.join(output,'encrypt-result.json'),decryptedResult=path.join(output,'decrypt-result.json'),synthetic=`nonworking-safe-storage-canary-${randomUUID()}`;
    await createFixture(runtime,first,namespace,'1.0.0',profile,encryptedResult,synthetic);await createFixture(runtime,second,namespace,'1.0.1',profile,decryptedResult,synthetic);
    const firstSigning=await signVenditBundle(first,config),secondSigning=await signVenditBundle(second,config);assertSigningContinuity(firstSigning,secondSigning);
    const mainFile=app=>path.join(app,'Contents/Resources/app/main.cjs');if((await readFile(mainFile(first))).equals(await readFile(mainFile(second))))throw new Error('Continuity needs two genuinely different builds.');
    await rename(first,installed);journal.launchAttempted=true;await saveJournal();await runFixture(installed,namespace,'encrypt');
    const item=await queryCanaryItem(namespace);if(!item)throw new Error('Native encryption did not create the exact expected Keychain service/account.');journal.createdAfterLaunch=true;journal.createdMetadata=item;journal.cleanup='pending';await saveJournal();
    const before=await readFile(path.join(profile,'synthetic.encrypted'));
    await rename(installed,previous);await rename(second,installed);const installedSigning=await verifyVenditBundleSigning(installed,config);assertSigningContinuity(firstSigning,installedSigning);
    await runFixture(installed,namespace,'decrypt');if(!before.equals(await readFile(path.join(profile,'synthetic.encrypted'))))throw new Error('Update changed the synthetic encrypted record.');
    const encrypted=JSON.parse(await readFile(encryptedResult,'utf8')),decrypted=JSON.parse(await readFile(decryptedResult,'utf8'));
    if(encrypted.status!=='passed'||decrypted.status!=='passed'||encrypted.ciphertextSha256!==decrypted.ciphertextSha256)throw new Error('Native result receipts do not match.');
    Object.assign(report,{status:'passed',firstSigning,secondSigning,encrypted,decrypted,continuity:'Actual Electron safeStorage encrypted on first signed build, bundle replaced at same path, decrypted unchanged ciphertext on second signed build.'});
  }catch(error){failure=error;report.error='Native continuity did not complete. See the observed namespace evidence; native Keychain access scope is not proven.';}
  finally{
    // A failed encrypt can still have created its unique Keychain entry. Attribute only this preflight-absent pair.
    try{
      if(await queryCanaryItem(namespace)){if(!journal.launchAttempted)throw new Error('Unexpected canary appearance before native launch; refuse deletion.');journal.createdAfterLaunch=true;journal.cleanup='pending';await saveJournal();await deleteProvenCanary(namespace,journal);journal.cleanup='confirmed-deleted';}
      else if(journal.createdAfterLaunch)journal.cleanup='confirmed-absent';
    }catch(error){failure??=error;report.status='failed';journal.cleanup='manual-exact-pair-inspection-required';}
    await saveJournal();Object.assign(report,canaryScopeEvidence(journal));report.cleanup=journal.cleanup;report.finishedAt=new Date().toISOString();await writeFile(path.join(output,'native-safestorage-report.json'),JSON.stringify(report,null,2)+'\n',{flag:'wx',mode:0o600});
  }
  if(failure)throw failure;return report;
}

if(process.argv[1]&&path.resolve(process.argv[1])===fileURLToPath(import.meta.url)){
  nativeContinuityMain(process.argv.slice(2)).then(()=>console.log('Synthetic native safeStorage continuity passed; see the private report.')).catch(error=>{console.error(error.message);process.exitCode=1;});
}
