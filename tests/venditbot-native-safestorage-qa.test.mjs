import test from 'node:test';
import assert from 'node:assert/strict';
import {canaryScopeEvidence,canaryNamespace,canaryOutputPath,queryCanaryItem,queryLegacyCanaryItem,preflightCanaryNamespace,deleteProvenCanary,nativeContinuityMain} from '../scripts/qa-native-safestorage-continuity.mjs';
const namespace=canaryNamespace('VenditBotSigningQA-'+'a'.repeat(32));
const present={code:0,stdout:`attributes:\n    "acct"<blob>="${namespace.account}"\n    "svce"<blob>="${namespace.service}"\n`};

test('native canary is held by default and never accepts a production or generic Electron namespace',async()=>{
 await assert.rejects(nativeContinuityMain([]),/Held by default/);
 for(const name of ['VenditBot','벤디트봇','Electron','Chromium','VenditBotSigningQA-old','VenditBotSigningQA-'+'a'.repeat(32)+'extra'])assert.throws(()=>canaryNamespace(name),/fresh UUID/);
 assert.equal(namespace.bundleId,'com.vendit.venditbot.signingqa.'+'a'.repeat(32));assert.equal(namespace.service,namespace.name+' Safe Storage');
});
test('native canary output cannot target an application or non-temporary user directory',{skip:process.platform!=='darwin'},async()=>{
 assert.match(await canaryOutputPath('/private/tmp/vendit-new-canary'),/^\/private\/tmp\//);
 await assert.rejects(canaryOutputPath('/Applications/vendit-new-canary'),/physical temporary root/);
});
test('exact metadata preflight reads no password and distinguishes absent, unexpected attributes and failure',async()=>{
 let calls=[];assert.equal(await queryCanaryItem(namespace,async args=>{calls.push(args);return {code:44,stdout:''};}),undefined);
 assert.deepEqual(calls,[['find-generic-password','-s',namespace.service,'-a',namespace.account]]);
 const found=await queryCanaryItem(namespace,async()=>present);assert.match(found.metadataSha256,/^[a-f0-9]{64}$/);assert.equal(Object.keys(found).length,1);
 await assert.rejects(queryCanaryItem(namespace,async()=>({code:0,stdout:'unrelated attributes'})),/unexpected item/);
 await assert.rejects(queryCanaryItem(namespace,async()=>({code:36,stdout:''})),/Cannot establish/);
});
test('cleanup requires proven absence and own native launch and deletes only the exact new service/account',async()=>{
 const valid={namespace,absentBefore:true,legacyAbsentBefore:true,launchAttempted:true,createdAfterLaunch:true};
 for(const journal of [{...valid,absentBefore:false},{...valid,legacyAbsentBefore:false},{...valid,launchAttempted:false},{...valid,createdAfterLaunch:false},{...valid,namespace:{name:'other'}}])await assert.rejects(deleteProvenCanary(namespace,journal,async()=>assert.fail('must not access Keychain')),/proven-new/);
 const calls=[];await deleteProvenCanary(namespace,valid,async args=>{calls.push(args);return calls.length===1?present:{code:calls.length===2?0:44,stdout:''};});
 assert.deepEqual(calls,[['find-generic-password','-s',namespace.service,'-a',namespace.account],['delete-generic-password','-s',namespace.service,'-a',namespace.account],['find-generic-password','-s',namespace.service,'-a',namespace.account]]);
 assert.ok(calls.every(args=>!args.includes('-w')&&!args.includes('-g')&&!args.includes('set-key-partition-list')&&!args.includes('list-keychains')));
});

test('native encryption without the expected item leaves access scope unknown, and observed metadata never proves no other item access',()=>{
 const missing=canaryScopeEvidence({absentBefore:true,launchAttempted:true,createdAfterLaunch:false});assert.equal(missing.productionDataAccess,'unknown');assert.equal(missing.verifiedKeychainEvidence.exactPairObservedAfterLaunch,false);assert.match(missing.nativeItemAccessScope,/Unverified/);
 const found=canaryScopeEvidence({absentBefore:true,launchAttempted:true,createdAfterLaunch:true});assert.equal(found.productionDataAccess,'unknown');assert.equal(found.verifiedKeychainEvidence.exactPairObservedAfterLaunch,true);assert.match(found.nativeItemAccessScope,/not audited/);
});

test('Electron downstream suffix and both preflight absences are required before a new native fixture can run',async()=>{
 assert.equal(namespace.account,namespace.name+' Key');assert.equal(namespace.legacyAccount,namespace.name);
 const calls=[];assert.deepEqual(await preflightCanaryNamespace(namespace,async args=>{calls.push(args);return {code:44,stdout:''};}),{absentBefore:true,legacyAbsentBefore:true});
 assert.deepEqual(calls.map(a=>a.at(-1)),[namespace.name+' Key',namespace.name]);
 const legacy={code:0,stdout:present.stdout.replace(namespace.name+' Key',namespace.name)};
 await assert.rejects(preflightCanaryNamespace(namespace,async args=>args.at(-1)===namespace.account?{code:44,stdout:''}:legacy),/legacy canary pair/);
 await assert.rejects(preflightCanaryNamespace(namespace,async()=>present),/legacy canary pair/);
 assert.ok(await queryLegacyCanaryItem(namespace,async()=>legacy));
 await assert.rejects(deleteProvenCanary(namespace,{namespace,absentBefore:true,launchAttempted:true,createdAfterLaunch:true},async()=>assert.fail('legacy proof02 can never authorize suffix cleanup')),/proven-new/);
});
