import assert from 'node:assert/strict';
import {mkdtemp, rm, readFile, writeFile, realpath} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import path from 'node:path';
import test from 'node:test';
import {build} from 'esbuild';
const load=async file=>{const result=await build({entryPoints:[file],bundle:true,platform:'node',format:'esm',write:false});return import('data:text/javascript;base64,'+Buffer.from(result.outputFiles[0].text).toString('base64'));};
const {varyAvatarScene,referenceAvatarImage}=await load('source/venditbot/avatar-variation.ts');
const {AvatarStore,validateAvatarScene}=await load('source/venditbot/agent-avatar.ts');
const scene={background:'#FFF',shapes:[{type:'circle',cx:256,cy:256,r:180,fill:'#000'},{type:'path',d:'M 160 180 Q 256 360 352 180',fill:'none',stroke:'#4D24E2',strokeWidth:24,linecap:'round'}]};
const png=Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aN1cAAAAASUVORK5CYII=','base64');
const geometry=s=>s.shapes.map(({fill,stroke,...rest})=>rest);
async function fixture(t){const root=await realpath(await mkdtemp(path.join(tmpdir(),'vendit-variation-')));t.after(()=>rm(root,{recursive:true,force:true}));return{root,store:new AvatarStore(root)};}
test('similar illustration retains all geometry, varies boundary colors and does not mutate its source',()=>{
  const before=structuredClone(scene),a=varyAvatarScene(scene,'clone-a'),b=varyAvatarScene(scene,'clone-b');
  assert.deepEqual(scene,before);assert.deepEqual(geometry(a),geometry(scene));assert.deepEqual(validateAvatarScene(a),a);
  assert.notEqual(a.background,'#FFFFFF');assert.notEqual(a.shapes[0].fill,'#000000');assert.equal(a.shapes[1].fill,'none');
  assert.notEqual(a.shapes[1].stroke,scene.shapes[1].stroke);assert.notDeepEqual(a,b);assert.deepEqual(a,varyAvatarScene(scene,'clone-a'));
  assert.throws(()=>varyAvatarScene({...scene,background:'url(file:///private)'},'x'));
});
test('scene retrieval and variant storage keep original and duplicate assets independent across restart',async t=>{
  const {root,store}=await fixture(t),original=store.save(scene),loaded=store.getScene(original.id),variant=store.save(varyAvatarScene(loaded,'duplicate'));
  assert.notEqual(original.id,variant.id);assert.notEqual(original.dataUrl,variant.dataUrl);loaded.shapes[0].cx=0;
  const restarted=new AvatarStore(root);assert.deepEqual(restarted.get(original.id),original);assert.deepEqual(restarted.get(variant.id),variant);assert.equal(restarted.getScene(original.id).shapes[0].cx,256);
  const image=store.saveImagePng(png);assert.equal(store.getScene(image.id),undefined);assert.equal(referenceAvatarImage(original),undefined);
  assert.deepEqual(Buffer.from(referenceAvatarImage(image).bytes),png);
});
test('reference extraction rejects external URLs, noncanonical base64 and corrupt persisted images',async t=>{
  const {root,store}=await fixture(t),image=store.saveImagePng(png);
  for(const dataUrl of ['https://example.invalid/a.png','file:///private/a.png','data:image/png;base64,AA=A','data:image/png;base64,'+Buffer.from('<svg/>').toString('base64')])assert.throws(()=>referenceAvatarImage({...image,dataUrl}));
  const file=path.join(root,'avatars',image.id+'.json'),contents=await readFile(file,'utf8');
  const saved=JSON.parse(contents);saved.png='AA==';await writeFile(file,JSON.stringify(saved));
  assert.throws(()=>store.getScene(image.id));
});
