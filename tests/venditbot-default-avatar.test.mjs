import assert from 'node:assert/strict';
import test from 'node:test';
import {build} from 'esbuild';
const compiled = await build({stdin: {contents: "export * from './source/venditbot/default-avatar.ts'; export {validateAvatarScene, renderAvatarScene} from './source/venditbot/agent-avatar.ts';", resolveDir: process.cwd()}, bundle: true, platform: 'node', format: 'esm', write: false});
const {defaultAvatarScene, randomDefaultAvatarScene, validateAvatarScene, renderAvatarScene} = await import('data:text/javascript;base64,' + Buffer.from(compiled.outputFiles[0].text).toString('base64'));

test('default portraits are deterministic and independent across callers', () => {
  const first = defaultAvatarScene('대표'), second = defaultAvatarScene('대표');
  assert.deepEqual(first, second); first.shapes[0].fill = '#000000'; assert.notDeepEqual(first, second);
  assert.deepEqual(second, defaultAvatarScene('대표')); assert.notDeepEqual(second, defaultAvatarScene('검토자'));
  assert.throws(() => defaultAvatarScene(null)); assert.throws(() => defaultAvatarScene('x'.repeat(4097)));
});

test('many default seeds remain bounded safe scenes, with varied portraits and both character styles', () => {
  const scenes = Array.from({length: 256}, (_, i) => defaultAvatarScene(`character-${i}`)), unique = new Set();
  let people = 0, robots = 0;
  for (const scene of scenes) {
    assert.deepEqual(validateAvatarScene(scene), scene); assert.ok(scene.shapes.length >= 25 && scene.shapes.length <= 60, `shape count ${scene.shapes.length}`);
    const svg = renderAvatarScene(scene); assert.doesNotMatch(svg, /<script|<image|foreignObject|href=|style=|onload=|<text/); assert.ok(svg.length < 18000);
    assert.ok(scene.shapes.every(shape => Object.values(shape).every(value => typeof value !== 'number' || Number.isFinite(value))));
    unique.add(JSON.stringify(scene)); scene.shapes.some(shape => shape.type === 'rect' && shape.x === 176 && shape.width === 160 && shape.height === 91) ? robots++ : people++;
  }
  assert.ok(unique.size > 220); assert.ok(robots > 25 && people > 100);
  assert.ok(new Set(scenes.map(scene => scene.background)).size >= 6);
});

test('new local defaults vary without exposing the random seed in SVG', () => {
  const scenes = Array.from({length: 32}, () => randomDefaultAvatarScene());
  assert.equal(new Set(scenes.map(scene => JSON.stringify(scene))).size, scenes.length);
  assert.ok(scenes.every(scene => !renderAvatarScene(scene).includes('seed')));
});
