import assert from 'node:assert/strict';
import test from 'node:test';
import {build} from 'esbuild';
const built = await build({entryPoints: ['source/venditbot/delegation-policy.ts'], bundle: true, platform: 'node', format: 'esm', write: false});
const {recommendRoutineConnections} = await import('data:text/javascript;base64,' + Buffer.from(built.outputFiles[0].text).toString('base64'));
const model = (id, efforts = ['low'], resolvedId) => ({id, ...(resolvedId ? {resolvedId} : {}), label: id, isDefault: false, efforts});
const routes = [{connectionId: 'codex', model: 'gpt-6-astra', effort: 'high'}, {connectionId: 'claude-code', model: 'claude-opus-5', effort: 'high'}];

test('routine preference resolves official aliases and prefers Sonnet before Luna on configured connections', () => {
  const catalogs = [{connectionId: 'codex', models: [model('gpt-6-luna')]}, {connectionId: 'claude-code', models: [model('sonnet', ['low', 'high'], 'claude-sonnet-5-5')]}];
  const selected = recommendRoutineConnections(routes, catalogs);
  assert.deepEqual(selected.connections, [{connectionId: 'claude-code', model: 'claude-sonnet-5-5', effort: 'low'}, ...routes]);
  assert.equal(selected.warning, undefined);
  assert.deepEqual(recommendRoutineConnections(routes, catalogs.slice(0, 1)).connections[0], {connectionId: 'codex', model: 'gpt-6-luna', effort: 'low'});
});

test('missing exact models, missing low effort and foreign connections preserve original priority with a warning', () => {
  for (const catalogs of [[], [{connectionId: 'other', models: [model('claude-sonnet-5-5')]}], [{connectionId: 'codex', models: [model('gpt-6-luna', ['medium'])]}], [{connectionId: 'claude-code', models: [model('sonnet', ['low'])]}], [{connectionId: 'claude-code', models: [model('claude-sonnet-5-5', ['low'], 'claude-sonnet-5')]}]]) {
    const result = recommendRoutineConnections(routes, catalogs);
    assert.deepEqual(result.connections, routes); assert.match(result.warning, /기존 연결 순서/);
    assert.notEqual(result.connections, routes); assert.notEqual(result.connections[0], routes[0]);
  }
});

test('preferred route is deduplicated exactly, preserves effort variants and caps the per-turn plan at eight', () => {
  const original = [{connectionId: 'codex', model: 'gpt-6-luna', effort: 'high'}, {connectionId: 'codex', model: 'gpt-6-luna', effort: 'low'}, ...Array.from({length: 6}, (_, i) => ({connectionId: 'codex', model: 'original-' + i}))];
  const result = recommendRoutineConnections(original, [{connectionId: 'codex', models: [model('gpt-6-luna')]}]);
  assert.equal(result.connections.length, 8); assert.equal(result.connections.filter(route => route.model === 'gpt-6-luna' && route.effort === 'low').length, 1);
  assert.equal(result.connections[1].effort, 'high');
  const added = recommendRoutineConnections(Array.from({length: 8}, (_, i) => ({connectionId: 'codex', model: 'original-' + i})), [{connectionId: 'codex', models: [model('gpt-6-luna')]}]);
  assert.equal(added.connections.length, 8); assert.equal(added.connections.at(-1).model, 'original-6');
});

test('policy never mutates frozen member configuration or catalog and owns its returned routes', () => {
  const original = Object.freeze(routes.map(route => Object.freeze({...route}))), catalog = Object.freeze([{connectionId: 'codex', models: Object.freeze([Object.freeze(model('gpt-6-luna'))])}]);
  const result = recommendRoutineConnections(original, catalog); result.connections[1].model = 'edited';
  assert.equal(original[0].model, 'gpt-6-astra'); assert.equal(catalog[0].models[0].id, 'gpt-6-luna');
});
