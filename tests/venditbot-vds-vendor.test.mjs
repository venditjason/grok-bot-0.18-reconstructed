import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import vm from 'node:vm';
import test from 'node:test';
import { locateLodash, sha256, SOURCE_SHA256, LICENSE_SHA256, ORIGINAL_BUNDLE_SHA256 } from '../scripts/patch-vds-lodash.mjs';
import { renderVendorFixtures } from './helpers/venditbot-vds-render.mjs';

const bundle = await readFile(new URL('../frontend/venditbot/vds.js', import.meta.url), 'utf8');
const provenance = JSON.parse(await readFile(new URL('../resources/licenses/vds-lodash-provenance.json', import.meta.url), 'utf8'));
const baseline = JSON.parse(await readFile(new URL('./fixtures/venditbot-vds-render-baseline.json', import.meta.url), 'utf8'));
const range = locateLodash(bundle);

function lodashContext() {
  const context = vm.createContext({});
  vm.runInContext(`self = globalThis;
    function init_define_import_meta_env() {}
    function __commonJS(cb, mod) { return function() { return mod || (0, Object.values(cb)[0])((mod = { exports: {} }).exports, mod), mod.exports; }; }
    ${bundle.slice(range.declarationStart, range.end)}
    globalThis.lodash = require_lodash();`, context, { timeout: 5000 });
  return context;
}

test('vendor patch contains official Lodash 4.18.0 and preserves every unrelated VDS byte', async () => {
  assert.equal(range.version, '4.18.0');
  assert.equal(provenance.originalBundleSha256, ORIGINAL_BUNDLE_SHA256);
  assert.equal(sha256(bundle), provenance.patchedBundleSha256);
  assert.equal(sha256(bundle.slice(0, range.start)), provenance.unchangedPrefixSha256);
  assert.equal(sha256(bundle.slice(range.end)), provenance.unchangedSuffixSha256);
  assert.equal(sha256(bundle.slice(range.start, range.end)), provenance.patchedModuleSha256);
  const body = bundle.slice(range.body.start + 1, range.body.end - 1);
  const prefix = '\n      init_define_import_meta_env();\n';
  const suffix = '\n    ';
  assert.ok(body.startsWith(prefix) && body.endsWith(suffix));
  assert.equal(sha256(body.slice(prefix.length, -suffix.length)), SOURCE_SHA256, 'Official source must remain byte-for-byte intact');
  assert.equal(sha256(await readFile(new URL('../resources/licenses/lodash-4.18.0-LICENSE', import.meta.url))), LICENSE_SHA256);
  assert.doesNotMatch(bundle, /lodash@4\.17\.21|VERSION = ["']4\.17\.21/);
});

test('actual VDS components, exports and complete semantic color tree match the pre-patch baseline without eval', () => {
  const result = renderVendorFixtures(bundle);
  assert.equal(baseline.originalBundleSha256, ORIGINAL_BUNDLE_SHA256);
  assert.deepEqual(result.hashes, baseline.renderHashes);
  assert.equal(result.colorHash, baseline.semanticColorTreeSha256);
  assert.equal(sha256(JSON.stringify(result.exportedNames)), baseline.exportedNamesSha256);
  assert.equal(result.colors.background.vendit.normal.toUpperCase(), '#4D24E2FF');
  assert.match(result.markup.textInput, /에이전트 이름/);
  assert.match(result.markup.textInput, /value="검토 도우미"/);
  assert.match(result.markup.disabledButton, /aria-disabled="true"/);
});

test('Lodash token transforms keep plain-object detection, own keys and nested color-map semantics', () => {
  const context = lodashContext();
  const result = JSON.parse(vm.runInContext(`JSON.stringify((() => {
    const _ = lodash; class Color {};
    const input = Object.assign(Object.create({ inherited: 9 }), { normal: { alpha: 1 }, subtle: { alpha: 0.25 } });
    return {
      version: _.VERSION,
      plain: [{}, Object.create(null), [], null, new Color()].map(value => _.isPlainObject(value)),
      mapped: _.mapValues(input, color => _.mapValues(color, value => value * 100))
    };
  })())`, context));
  assert.equal(result.version, '4.18.0');
  assert.deepEqual(result.plain, [true, true, false, false, false]);
  assert.deepEqual(result.mapped, { normal: { alpha: 100 }, subtle: { alpha: 25 } });
});

test('patched template rejects import-key code injection and ignores inherited imports', () => {
  const context = lodashContext();
  const result = JSON.parse(vm.runInContext(`JSON.stringify((() => {
    let rejected = false;
    try { lodash.template('ok', { imports: { 'probe = (globalThis.injectionExecuted = true)': undefined } }); }
    catch { rejected = true; }
    const imports = Object.assign(Object.create({ 'probe = (globalThis.inheritedExecuted = true)': undefined }), { name: 'safe' });
    const normal = lodash.template('Hello <%= name %>', { imports })();
    return { rejected, normal, executed: !!globalThis.injectionExecuted, inheritedExecuted: !!globalThis.inheritedExecuted };
  })())`, context));
  assert.deepEqual(result, { rejected: true, normal: 'Hello safe', executed: false, inheritedExecuted: false });
});

test('patched unset and omit reject string and array-wrapped prototype paths', () => {
  const context = lodashContext();
  const result = JSON.parse(vm.runInContext(`JSON.stringify((() => {
    Object.prototype.vendorProbe = 'preserved';
    const paths = [
      '__proto__.vendorProbe', ['__proto__', 'vendorProbe'], [['__proto__'], 'vendorProbe'],
      ['constructor', 'prototype', 'vendorProbe'], [['constructor'], ['prototype'], 'vendorProbe']
    ];
    for (const path of paths) { lodash.unset({}, path); lodash.omit({}, [path]); }
    const preserved = Object.prototype.vendorProbe;
    delete Object.prototype.vendorProbe;
    const ordinary = { nested: { remove: 1, keep: 2 } };
    lodash.unset(ordinary, ['nested', 'remove']);
    return { preserved, ordinary };
  })())`, context));
  assert.deepEqual(result, { preserved: 'preserved', ordinary: { nested: { keep: 2 } } });
});
