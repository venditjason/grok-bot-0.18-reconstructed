import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,writeFile,readFile,stat,rm,cp} from 'node:fs/promises';
import path from 'node:path';
import {build} from 'esbuild';
import {requiredRendererAssets,readRendererText,validateRendererAssets,rendererInputPlugin} from '../scripts/lib/venditbot-renderer-assets.mjs';
import {minifyVendorAsset} from '../scripts/lib/venditbot-build-options.mjs';

async function fixture(t){const root=await mkdtemp('/private/tmp/vendit-renderer-guard-');t.after(()=>rm(root,{recursive:true,force:true}));return root;}
async function renderer(root){for(const name of requiredRendererAssets)await writeFile(path.join(root,name),name.endsWith('.css')?'body{color:red}':name.endsWith('.html')?'<!doctype html><title>벤디트봇</title>':'globalThis.fixture="한글";');}
const withRead=read=>({stat,readFile:read});

test('exact UTF-8 bytes including BOM survive checked renderer read',async t=>{
 const root=await fixture(t),file=path.join(root,'react.js'),source='\ufeffglobalThis.title="벤디트봇";';await writeFile(file,source);assert.equal(await readRendererText(file),source);assert.equal(Buffer.byteLength(await readRendererText(file)),(await stat(file)).size);
});
test('File Provider full stat with zero-byte read fails before minification',async t=>{
 const root=await fixture(t),file=path.join(root,'vds.js');await writeFile(file,'globalThis.VDS={button:true};');assert.ok((await stat(file)).size>0);let minified=false;
 await assert.rejects((async()=>{const source=await readRendererText(file,withRead(async()=>Buffer.alloc(0)));minified=true;return minifyVendorAsset(source,'vds.js');})(),/Incomplete/);assert.equal(minified,false);
});
test('partial and oversized reads fail against exact on-disk byte size',async t=>{
 const root=await fixture(t),file=path.join(root,'vds.css');await writeFile(file,'body{font-family:"벤디트봇"}');const bytes=await readFile(file);
 for(const malformed of [bytes.subarray(0,bytes.length-1),Buffer.concat([bytes,Buffer.from('x')])])await assert.rejects(readRendererText(file,withRead(async()=>malformed)),/Incomplete/);
});
test('source replacement or mutation during read is rejected even at the same byte size',async t=>{
 const root=await fixture(t),file=path.join(root,'style.css');await writeFile(file,'body{color:red}');const real=await stat(file);let count=0;
 await assert.rejects(readRendererText(file,{readFile,stat:async()=>++count===1?real:{...real,isFile:()=>true,ino:real.ino+1}}),/changed/);
});
test('empty input and minifier-empty JS/CSS cannot become successful required output',async()=>{
 for(const name of ['vds.js','style.css']){await assert.rejects(minifyVendorAsset('',name),/empty/);await assert.rejects(minifyVendorAsset(' \n\t ',name),/empty/);await assert.rejects(minifyVendorAsset('/* intentionally has no executable content */',name),/empty/);}
 const js=await minifyVendorAsset('/*! KEEP LICENSE */ var VDS=globalThis.createVDS();','vds.js');assert.match(js,/KEEP LICENSE/);assert.match(js,/var VDS=/);assert.doesNotMatch(js,/export|module\.exports/);assert.ok((await minifyVendorAsset('body { color: red; }','style.css')).trim());
});
test('real esbuild renderer reads refuse truncated entry or nested imports before emitting a bundle',async t=>{
 const root=await fixture(t),entry=path.join(root,'app.tsx'),child=path.join(root,'child.ts');await writeFile(entry,'import {answer} from "./child"; console.log(answer);');await writeFile(child,'export const answer=42;');
 for(const bad of [entry,child]){
  const io=withRead(async file=>file===bad?Buffer.alloc(0):readFile(file));
  await assert.rejects(build({entryPoints:[entry],bundle:true,write:false,platform:'browser',logLevel:'silent',plugins:[rendererInputPlugin(root,io)]}),/Incomplete/);
 }
 const valid=await build({entryPoints:[entry],bundle:true,write:false,platform:'browser',logLevel:'silent',plugins:[rendererInputPlugin(root)]});assert.match(valid.outputFiles[0].text,/42/);
});
test('package preflight requires every named asset; empty or missing each one blocks packaging',async t=>{
 const root=await fixture(t);await renderer(root);assert.equal(Object.keys(await validateRendererAssets(root)).length,6);
 for(const name of requiredRendererAssets){const file=path.join(root,name),good=await readFile(file);await writeFile(file,'');await assert.rejects(validateRendererAssets(root),/empty/);await rm(file);await assert.rejects(validateRendererAssets(root),/ENOENT/);await writeFile(file,good);}
});
test('package validation reads content even when metadata advertises complete assets',async t=>{
 const root=await fixture(t);await renderer(root);
 for(const name of requiredRendererAssets)await assert.rejects(validateRendererAssets(root,undefined,withRead(async file=>path.basename(file)===name?Buffer.alloc(0):readFile(file))),/Incomplete/);
});
test('post-copy validation rejects empty, truncated and same-length changed bytes before ASAR',async t=>{
 const staged=await fixture(t),copied=await fixture(t);await renderer(staged);const expected=await validateRendererAssets(staged);await cp(staged,copied,{recursive:true});assert.deepEqual(await validateRendererAssets(copied,expected),expected);
 const target=path.join(copied,'vds.js'),good=await readFile(target);for(const bytes of [Buffer.alloc(0),good.subarray(0,good.length-1),Buffer.from('x'.repeat(good.length))]){await writeFile(target,bytes);await assert.rejects(validateRendererAssets(copied,expected),/empty|changed during packaging/);}await writeFile(target,good);assert.deepEqual(await validateRendererAssets(copied,expected),expected);
});
test('unrelated zero-byte marker files remain permitted and invalid UTF-8 mandatory files fail',async t=>{
 const root=await fixture(t);await renderer(root);await writeFile(path.join(root,'.marker'),'');await validateRendererAssets(root);await writeFile(path.join(root,'react.js'),Buffer.from([0xc3,0x28]));await assert.rejects(validateRendererAssets(root),/encoded data/);
});
