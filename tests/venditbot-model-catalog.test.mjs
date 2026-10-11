import assert from 'node:assert/strict';
import test from 'node:test';
import { build } from 'esbuild';
const built = await build({ entryPoints: [new URL('../frontend/venditbot/model-catalog.ts', import.meta.url).pathname], bundle: true, platform: 'node', format: 'esm', write: false });
const { accountKey, catalogModelSelection, reconcileModelSelection, selectionForRequest, CatalogRequestGate, catalogModelLabel, agentConnectionsForRequest } = await import(`data:text/javascript;base64,${Buffer.from(built.outputFiles[0].text).toString('base64')}`);
const catalog = { models: [
  { id: 'fixture-deep', label: 'Deep', isDefault: true, efforts: ['low', 'high'], defaultEffort: 'high' },
  { id: 'fixture-quick', label: 'Quick', isDefault: false, efforts: ['low'] },
  { id: 'fixture-plain', label: 'Plain', isDefault: false, efforts: [] },
], fetchedAt: '2026-01-01T00:00:00Z', source: 'mock official catalog' };
const auth = { authenticated: true, account: { email: 'fixture@example.invalid', plan: 'fixture' } };
const state = { phase: 'ready', accountKey: accountKey(auth), catalog };

test('only the provider-advertised default is auto-selected; no first-model guess', () => {
  assert.deepEqual(reconcileModelSelection(catalog, { model: '' }), { model: 'fixture-deep', effort: 'high' });
  assert.deepEqual(reconcileModelSelection({ ...catalog, models: catalog.models.map(model => ({ ...model, isDefault: false })) }, { model: '' }), { model: '' });
});

test('changing model clears unsupported effort and uses only its advertised default', () => {
  const deep = catalogModelSelection(catalog, 'fixture-deep'); assert.equal(deep.effort, 'high');
  assert.deepEqual(catalogModelSelection(catalog, 'fixture-quick'), { model: 'fixture-quick' });
  assert.deepEqual(catalogModelSelection(catalog, 'fixture-plain'), { model: 'fixture-plain' });
  assert.deepEqual(catalogModelSelection(catalog, 'invented-model'), { model: '' });
  assert.equal(selectionForRequest(state, auth, { model: 'fixture-quick', effort: deep.effort }), undefined);
});

test('refresh preserves a supported selection and removes obsolete models/efforts', () => {
  assert.deepEqual(reconcileModelSelection(catalog, { model: 'fixture-deep', effort: 'low' }), { model: 'fixture-deep', effort: 'low' });
  assert.deepEqual(reconcileModelSelection(catalog, { model: 'fixture-deep', effort: 'ultra' }), { model: 'fixture-deep', effort: 'high' });
  assert.deepEqual(reconcileModelSelection(catalog, { model: 'retired-model', effort: 'ultra' }), { model: 'fixture-deep', effort: 'high' });
  assert.equal(selectionForRequest({ ...state, phase: 'loading' }, auth, { model: 'fixture-deep' }), undefined);
  assert.equal(selectionForRequest({ ...state, phase: 'error' }, auth, { model: 'fixture-deep' }), undefined);
});

test('catalogs from a signed-out or changed account cannot authorize a model selection', () => {
  assert.deepEqual(selectionForRequest(state, auth, { model: 'fixture-quick' }), { model: 'fixture-quick' });
  assert.equal(selectionForRequest(state, { ...auth, authenticated: false }, { model: 'fixture-deep' }), undefined);
  assert.equal(selectionForRequest(state, { ...auth, account: { email: 'other@example.invalid' } }, { model: 'fixture-deep' }), undefined);
});

test('stale fetch success and failure cannot replace a newer catalog or another provider', async () => {
  const gate = new CatalogRequestGate(); let resolveOld; let rejectOld; let visible;
  const oldGeneration = gate.begin('codex');
  const old = new Promise(resolve => { resolveOld = resolve; }).then(value => { if (gate.current('codex', oldGeneration)) visible = value; });
  const newest = gate.begin('codex'); const other = gate.begin('claude-code');
  assert.equal(gate.current('codex', newest), true); assert.equal(gate.current('claude-code', other), true);
  visible = 'new catalog'; resolveOld('old catalog'); await old; assert.equal(visible, 'new catalog');
  const failureGeneration = gate.begin('codex');
  const failure = new Promise((_resolve, reject) => { rejectOld = reject; }).catch(() => { if (gate.current('codex', failureGeneration)) visible = 'stale error'; });
  gate.begin('codex'); rejectOld(new Error('old request')); await failure; assert.equal(visible, 'new catalog');
  gate.begin('claude-code'); assert.equal(gate.current('claude-code', other), false);
});

test('canonical persisted model matches a returned official alias without guessing effort', () => {
  const resolved = { ...catalog, models: [{ id: 'fixture-alias', resolvedId: 'fixture-canonical', label: 'Alias', isDefault: true, efforts: ['high'] }] };
  assert.deepEqual(reconcileModelSelection(resolved, { model: 'fixture-canonical' }), { model: 'fixture-alias' });
});


test('model labels expose exact official versions and aliases without inventing entries', () => {
  const aliases = [
    { id: 'opus', resolvedId: 'claude-opus-fixture-5-5', label: 'Opus', isDefault: false },
    { id: 'fixture-gpt-6', label: 'GPT fixture', isDefault: true },
    { id: 'fixture-plain', label: 'fixture-plain', isDefault: false },
  ];
  assert.equal(catalogModelLabel(aliases[0]), 'Opus · claude-opus-fixture-5-5 (opus)');
  assert.equal(catalogModelLabel(aliases[1]), 'GPT fixture · fixture-gpt-6 · 기본');
  assert.equal(catalogModelLabel(aliases[2]), 'fixture-plain');
  assert.equal(aliases.map(catalogModelLabel).length, 3);
});

test('fallback validation preserves ordered provider/model/effort choices and fixes API models', () => {
  const routes = [{ connectionId: 'codex', model: 'fixture-deep', effort: 'high' }, { connectionId: 'codex', model: 'fixture-quick' }, { connectionId: 'api', model: 'stale-api-model', effort: 'high' }];
  const profiles = [{ id: 'api', model: 'fixed-api-model' }];
  assert.deepEqual(agentConnectionsForRequest(routes, { codex: state }, { codex: auth }, profiles), [...routes.slice(0, 2), { connectionId: 'api', model: 'fixed-api-model' }]);
  assert.deepEqual(agentConnectionsForRequest([{ ...routes[0], effort: 'low' }, routes[0]], { codex: state }, { codex: auth }, []), [{ ...routes[0], effort: 'low' }, routes[0]]);
  assert.throws(() => agentConnectionsForRequest([routes[0], routes[0]], { codex: state }, { codex: auth }, []), /2순위.*같은 모델/);
  assert.throws(() => agentConnectionsForRequest(Array(9).fill(routes[0]), { codex: state }, { codex: auth }, []), /8개/);
  assert.throws(() => agentConnectionsForRequest([], {}, {}, []), /1개/);
});

test('every fallback route requires the current account catalog and rejects duplicate resolved aliases', () => {
  const route = { connectionId: 'codex', model: 'fixture-deep' };
  for (const invalid of [{ ...auth, authenticated: false }, { ...auth, account: { email: 'new-account@example.invalid' } }]) {
    assert.throws(() => agentConnectionsForRequest([{ connectionId: 'api', model: 'fixed' }, route], { codex: state }, { codex: invalid }, [{ id: 'api', model: 'fixed' }]), /2순위.*로그인/);
  }
  assert.throws(() => agentConnectionsForRequest([route], { codex: { ...state, phase: 'loading' } }, { codex: auth }, []), /공식 목록/);
  const aliases = { ...state, catalog: { ...catalog, models: ['default', 'opus'].map(id => ({ id, resolvedId: 'claude-opus-fixture-5-5', label: id, efforts: [] })) } };
  assert.throws(() => agentConnectionsForRequest(['default', 'opus'].map(model => ({ connectionId: 'claude-code', model })), { 'claude-code': aliases }, { 'claude-code': auth }, []), /2순위.*같은 모델/);
  assert.throws(() => agentConnectionsForRequest([{ connectionId: 'deleted', model: 'old-model' }], {}, {}, []), /1순위.*선택/);
});
