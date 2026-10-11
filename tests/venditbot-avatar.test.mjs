import assert from 'node:assert/strict';
import {mkdtemp, readFile, writeFile, rm, symlink, link, stat, realpath} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import path from 'node:path';
import test from 'node:test';
import {build} from 'esbuild';

const built = await build({entryPoints: [path.resolve('source/venditbot/agent-avatar.ts')], bundle: true, platform: 'node', format: 'esm', write: false});
const {AvatarStore, parseAvatarResponse, renderAvatarScene, validateAvatarScene, validateAvatarPng} = await import(`data:text/javascript;base64,${Buffer.from(built.outputFiles[0].text).toString('base64')}`);
const scene = {background: '#4D24E2', shapes: [{type: 'circle', cx: 256, cy: 256, r: 180, fill: '#FFF'}, {type: 'path', d: 'M 160 180 Q 256 360 352 180', fill: 'none', stroke: '#4D24E2', strokeWidth: 24, linecap: 'round'}]};
async function fixture(t) {const root = await realpath(await mkdtemp(path.join(tmpdir(), 'vendit-avatar-'))); t.after(() => rm(root, {recursive: true, force: true})); return {root, store: new AvatarStore(root)};}

test('avatar structured scene becomes a bounded standalone image without executable content', () => {
  const parsed = parseAvatarResponse('```json\n' + JSON.stringify(scene) + '\n```');
  assert.deepEqual(parsed, scene); const image = renderAvatarScene(parsed);
  assert.match(image, /viewBox="0 0 512 512"/); assert.match(image, /stroke-linecap="round"/);
  assert.doesNotMatch(image, /<script|<foreignObject|<image|href=|style=|onload=/);
  parsed.shapes[0].cx = 0; assert.equal(scene.shapes[0].cx, 256);
});

test('avatar rejects markup injection, external resources and malformed model output', () => {
  const attacks = [
    {...scene, background: '#fff" onload="alert(1)'},
    {...scene, shapes: [{type: 'script', d: 'alert(1)'}]},
    {...scene, shapes: [{...scene.shapes[0], fill: 'url(https://evil.invalid/x)'}]},
    {...scene, shapes: [{...scene.shapes[0], onload: 'alert(1)'}]},
    {...scene, shapes: [{...scene.shapes[0], cx: Infinity}]},
    {...scene, shapes: [{...scene.shapes[0], r: -1}]},
    {...scene, shapes: [{...scene.shapes[1], d: 'M 1e999 2 L 3 4'}]},
    {...scene, shapes: [{...scene.shapes[1], d: 'M 1 2"/><image href="x'}]},
    {...scene, shapes: [{...scene.shapes[1], strokeWidth: 65}]},
    {...scene, shapes: [{...scene.shapes[1], opacity: 2}]},
    {...scene, shapes: [{...scene.shapes[1], linecap: ['round']}]},
    {...scene, shapes: [{type: '__proto__'}]},
    {...scene, shapes: []}, {...scene, shapes: Array(201).fill(scene.shapes[0])},
  ];
  for (const attack of attacks) assert.throws(() => validateAvatarScene(attack));
  for (const text of ['<svg><script/></svg>', 'Here is your image: ' + JSON.stringify(scene), 'x'.repeat(120001), '{}']) assert.throws(() => parseAvatarResponse(text));
});

test('avatar store persists private immutable images with restart and safe data URLs', async t => {
  const {root, store} = await fixture(t), saved = store.save(scene);
  assert.equal(saved.kind, 'illustration'); assert.match(saved.dataUrl, /^data:image\/svg\+xml;base64,/);
  const file = path.join(root, 'avatars', saved.id + '.json');
  assert.equal((await stat(file)).mode & 0o777, 0o600); assert.equal((await stat(path.dirname(file))).mode & 0o777, 0o700);
  assert.deepEqual(new AvatarStore(root).get(saved.id), saved);
  assert.throws(() => store.get('../settings'), /ID/);
  const original = await readFile(file, 'utf8'); await writeFile(file, original.replace('"#4D24E2"', '"url(file:///secret)"'));
  assert.throws(() => store.get(saved.id)); assert.match(await readFile(file, 'utf8'), /file:\/\/\/secret/);
});

test('avatar store rejects directory symlinks and file symlinks/hardlinks', async t => {
  const {root, store} = await fixture(t), asset = store.save(scene), directory = path.join(root, 'avatars'), file = path.join(directory, asset.id + '.json'), outside = path.join(root, 'sentinel.json');
  const original = await readFile(file, 'utf8'); await writeFile(outside, original); await rm(file); await symlink(outside, file);
  assert.throws(() => store.get(asset.id), /안전/); await rm(file); await link(outside, file); assert.throws(() => store.get(asset.id), /안전/);
  await rm(directory, {recursive: true}); await symlink(root, directory); assert.throws(() => new AvatarStore(root), /안전/);
  assert.equal(await readFile(outside, 'utf8'), original);
});

test('avatar cleanup retains referenced historical images and recent previews', async t => {
  const {store} = await fixture(t), assets = Array.from({length: 6}, () => store.save(scene));
  assert.equal(store.prune([assets[0].id, assets[1].id], 2), 2);
  assert.equal(store.get(assets[0].id).id, assets[0].id); assert.equal(store.get(assets[1].id).id, assets[1].id);
  assert.equal(store.prune([assets[0].id, assets[1].id], 0), 2);
  assert.throws(() => store.prune([], -1));
});

test('normalized raster avatar survives restart and rejects oversized, truncated or non-image data', async t => {
  const {root, store} = await fixture(t);
  const png = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aN1cAAAAASUVORK5CYII=', 'base64');
  const saved = store.saveImagePng(png); assert.equal(saved.kind, 'image'); assert.equal(saved.dataUrl, 'data:image/png;base64,' + png.toString('base64'));
  assert.deepEqual(new AvatarStore(root).get(saved.id), saved);
  const hugeDimensions = Buffer.from(png); hugeDimensions.writeUInt32BE(100000, 16);
  for (const invalid of [Buffer.from('<svg onload="alert(1)"/>'), png.subarray(0, 30), Buffer.concat([png, Buffer.from('extra')]), hugeDimensions, Buffer.alloc(2 * 1024 * 1024 + 1)]) assert.throws(() => validateAvatarPng(invalid));
});
