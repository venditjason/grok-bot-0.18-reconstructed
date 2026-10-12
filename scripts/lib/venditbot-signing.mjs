import {createHash} from 'node:crypto';
import {mkdtemp,open,readFile,readdir,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import path from 'node:path';
import {capture,run} from './process.mjs';
import {signAppBundleAdHoc} from './codesign.mjs';

const FINGERPRINT=/^[A-Fa-f0-9]{40}$/;
const IDENTIFIER=/^[A-Za-z0-9][A-Za-z0-9._-]{1,220}$/;
const MACHO=new Set([0xfeedface,0xcefaedfe,0xfeedfacf,0xcffaedfe,0xcafebabe,0xbebafeca,0xcafebabf,0xbfbafeca]);

export function signingConfiguration({development=false,identity,certificateSha256}={},environment=process.env) {
  if(development)return {mode:'development-adhoc',identity:'-'};
  identity??=environment.VENDITBOT_CODESIGN_IDENTITY;certificateSha256??=environment.VENDITBOT_CODESIGN_CERT_SHA256;
  if(typeof identity!=='string'||!FINGERPRINT.test(identity))throw new Error('Production packaging requires VENDITBOT_CODESIGN_IDENTITY as an explicit 40-hex certificate fingerprint. No ad-hoc release fallback is allowed.');
  if(typeof certificateSha256!=='string'||!/^[A-Fa-f0-9]{64}$/.test(certificateSha256))throw new Error('Production packaging requires VENDITBOT_CODESIGN_CERT_SHA256 as the matching public certificate SHA-256 pin.');
  return {mode:'certificate',identity:identity.toUpperCase(),certificateSha256:certificateSha256.toLowerCase()};
}

export function certificateRequirement(identity,identifier) {
  if(!FINGERPRINT.test(identity)||!IDENTIFIER.test(identifier))throw new Error('Invalid pinned signing identity or bundle identifier.');
  return `identifier "${identifier}" and certificate leaf = H"${identity.toLowerCase()}"`;
}

export function certificateSignArguments(target,identity,identifier) {
  if(typeof target!=='string'||!path.isAbsolute(target))throw new Error('Signing requires an absolute copied target path.');
  return ['--force','--timestamp=none','--sign',identity,'--identifier',identifier,'--requirements',`=designated => ${certificateRequirement(identity,identifier)}`,target];
}

/** Reads public identity metadata only. Never provisions, exports or changes a Keychain. */
export async function requireSigningIdentity(config,ports={capture,run}) {
  if(config.mode==='development-adhoc')return;
  const listed=await ports.capture('/usr/bin/security',['find-identity','-v','-p','codesigning']);
  const available=[...listed.matchAll(/^\s*\d+\)\s+([A-Fa-f0-9]{40})\s+"[^\r\n]*"\s*$/gm)].map(match=>match[1].toUpperCase());
  if(!available.includes(config.identity))throw new Error('The configured certificate is not an existing valid code-signing identity. Complete the approved personal identity setup first; packaging will not choose or create another identity.');
}

export async function signingInventory(appPath) {
  const nativeFiles=[],bundles=[];
  async function visit(directory) {
    const entries=(await readdir(directory,{withFileTypes:true})).sort((a,b)=>a.name.localeCompare(b.name));
    for(const entry of entries){
      const target=path.join(directory,entry.name);
      if(entry.isDirectory()){await visit(target);if(/\.(app|framework)$/.test(entry.name))bundles.push(target);}
      else if(entry.isFile()){
        const file=await open(target,'r');try{const bytes=Buffer.alloc(4);const result=await file.read(bytes,0,4,0);if(result.bytesRead===4&&MACHO.has(bytes.readUInt32BE()))nativeFiles.push(target);}finally{await file.close();}
      }
      // Relative framework symlinks are not followed or re-signed as duplicate files.
    }
  }
  await visit(appPath);return {nativeFiles,bundles:[...bundles,appPath]};
}

async function bundleIdentifier(target,ports) {
  const plist=path.join(target,target.endsWith('.framework')?'Resources/Info.plist':'Contents/Info.plist');
  const id=await ports.capture('/usr/bin/plutil',['-extract','CFBundleIdentifier','raw','-o','-',plist]);
  if(!IDENTIFIER.test(id))throw new Error('Copied bundle has an invalid signing identifier.');return id;
}

function normalizedRequirement(value) {
  return value.trim().replace(/^#\s*/, '').replace(/^designated\s*=>\s*/, '').replace(/\s+/g,' ').replace(/H"([A-Fa-f0-9]{40})"/g,(_,hash)=>`H"${hash.toLowerCase()}"`);
}

export async function verifyCertificateRequirement(target,identity,identifier,ports={capture,run}) {
  const expected=certificateRequirement(identity,identifier);
  await ports.run('/usr/bin/codesign',['--verify','--strict','--test-requirement',`=${expected}`,target]);
  const output=await ports.capture('/usr/bin/codesign',['--display','--requirements','-',target]);
  const line=output.split('\n').find(value=>/^#?\s*designated\s*=>/.test(value));
  if(!line||normalizedRequirement(line)!==expected)throw new Error('The designated requirement is not exactly bound to the pinned certificate and identifier; a cdhash or identifier-only requirement is not a stable release identity.');
  return expected;
}

/** Extracts only the public certificate embedded in a copied signed app, never a Keychain key. */
export async function embeddedCertificate(appPath,identity,ports={capture,run}) {
  const temporary=await mkdtemp(path.join(tmpdir(),'venditbot-public-cert-'));
  try{
    const prefix=path.join(temporary,'certificate');
    // codesign's extraction prefix is an optional long-option argument; it must
    // be attached with '=' or macOS treats the separate prefix as another app.
    await ports.run('/usr/bin/codesign',['--display',`--extract-certificates=${prefix}`,appPath]);
    const bytes=await readFile(`${prefix}0`);
    if(!bytes.length)throw new Error('Signed application has no embedded certificate.');
    const sha1=createHash('sha1').update(bytes).digest('hex').toUpperCase();
    if(sha1!==identity)throw new Error('Embedded certificate differs from the configured fingerprint.');
    return {certificateSha1:sha1,certificateSha256:createHash('sha256').update(bytes).digest('hex')};
  }finally{await rm(temporary,{recursive:true,force:true});}
}

export async function signVenditBundle(appPath,config,ports={capture,run}) {
  await requireSigningIdentity(config,ports);
  const inventory=await signingInventory(appPath);
  for(const target of inventory.nativeFiles){
    const architectures=(await ports.capture('/usr/bin/lipo',['-archs',target])).split(/\s+/);
    if(!architectures.includes('arm64'))throw new Error('Copied native code is not arm64-compatible.');
    const identifier=`com.vendit.venditbot.native.${createHash('sha256').update(path.relative(appPath,target)).digest('hex').slice(0,24)}`;
    await ports.run('/usr/bin/codesign',config.mode==='development-adhoc'?['--force','--timestamp=none','--sign','-',target]:certificateSignArguments(target,config.identity,identifier));
  }
  if(config.mode==='development-adhoc'){await signAppBundleAdHoc(appPath,ports.run);return {signature:'development-adhoc'};}
  for(const target of inventory.bundles){
    const identifier=await bundleIdentifier(target,ports);
    await ports.run('/usr/bin/codesign',certificateSignArguments(target,config.identity,identifier));
  }
  return verifyVenditBundleSigning(appPath,config,ports);
}

export async function verifyVenditBundleSigning(appPath,config,ports={capture,run}) {
  await ports.run('/usr/bin/codesign',['--verify','--deep','--strict',appPath]);
  if(config.mode==='development-adhoc')return {signature:'development-adhoc'};
  const inventory=await signingInventory(appPath),bundleRequirements=[];
  for(const target of inventory.nativeFiles)await ports.run('/usr/bin/codesign',['--verify','--strict','--test-requirement',`=certificate leaf = H"${config.identity.toLowerCase()}"`,target]);
  for(const target of inventory.bundles){
    const identifier=await bundleIdentifier(target,ports);
    bundleRequirements.push({path:path.relative(appPath,target)||'.',identifier,designatedRequirement:await verifyCertificateRequirement(target,config.identity,identifier,ports)});
  }
  const certificate=await embeddedCertificate(appPath,config.identity,ports);
  if(certificate.certificateSha256!==config.certificateSha256)throw new Error('Embedded public certificate does not match the configured SHA-256 pin.');
  return {signature:'certificate-personal-validation',...certificate,designatedRequirement:bundleRequirements.at(-1).designatedRequirement,nativeFileCount:inventory.nativeFiles.length,bundleRequirements};
}

export function assertSigningContinuity(previous,next) {
  if(previous.signature!=='certificate-personal-validation'||next.signature!=='certificate-personal-validation'||previous.certificateSha1!==next.certificateSha1||previous.certificateSha256!==next.certificateSha256||previous.designatedRequirement!==next.designatedRequirement)throw new Error('Signing identity or designated requirement changed. This is not a routine update; no automatic certificate rotation is permitted.');
}

export async function signingContinuityBaseline({config,previousApp,initialCertificateRelease=false,identifier},ports={capture,run}) {
  if(config.mode==='development-adhoc')return undefined;
  if(initialCertificateRelease&&previousApp)throw new Error('Choose an existing stable signing baseline or the explicit initial certificate transition, not both.');
  if(initialCertificateRelease)return undefined;
  if(!previousApp)throw new Error('Production packaging requires --previous-app with the existing certificate-signed app, or --initial-certificate-release for the explicit first transition.');
  const previous=await verifyVenditBundleSigning(path.resolve(previousApp),config,ports);
  if(previous.designatedRequirement!==certificateRequirement(config.identity,identifier))throw new Error('Previous app is not the same certificate-bound product identity.');
  return previous;
}
