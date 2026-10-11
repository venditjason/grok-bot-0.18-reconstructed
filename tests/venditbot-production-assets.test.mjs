import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import vm from 'node:vm';
import test from 'node:test';
import { REACT_VERSION, REACT_DOM_RUNTIME_VERSION, PACKAGES, LICENSE_SHA256, createBrowserRuntime, sha256 } from '../scripts/vendor-react-runtime.mjs';
import { minifyVendorAsset } from '../scripts/lib/venditbot-build-options.mjs';
import { renderVendorFixtures } from './helpers/venditbot-vds-render.mjs';

const runtime = await readFile(new URL('../frontend/venditbot/react.js', import.meta.url), 'utf8');
const provenance = JSON.parse(await readFile(new URL('../resources/licenses/react-18.3.1-provenance.json', import.meta.url), 'utf8'));

test('browser runtime retains the two exact official React 18.3.1 production sources and license', async () => {
  assert.equal(sha256(runtime), provenance.outputSha256);
  assert.equal(Buffer.byteLength(runtime), provenance.outputBytes);
  assert.ok(Buffer.byteLength(runtime) < 150000);
  assert.equal(provenance.version, REACT_VERSION);
  assert.equal(sha256(await readFile(new URL('../resources/licenses/react-18.3.1-LICENSE', import.meta.url))), LICENSE_SHA256);
  let offset = runtime.indexOf('/**');
  const sources = PACKAGES.map((entry, index) => {
    const size = provenance.packages[index].sourceBytes;
    const source = Buffer.from(runtime).subarray(offset, offset + size).toString('utf8');
    assert.equal(sha256(source), entry.sourceSha256);
    offset += size + 3; // newline, semicolon, newline between the fixed UMD sources
    return source;
  });
  assert.equal(createBrowserRuntime(sources), runtime);
  assert.doesNotMatch(runtime, /react(?:-dom)?\.development\.js/);
});

test('VDS and repeated browser loading retain one matching React instance', () => {
  const context = vm.createContext({ console, setTimeout, clearTimeout });
  vm.runInContext('window = self = globalThis;', context);
  vm.runInContext(runtime, context);
  const firstReact = context.React, firstDOM = context.ReactDOM;
  assert.equal(firstReact.version, REACT_VERSION);
  assert.equal(firstDOM.version, REACT_DOM_RUNTIME_VERSION);
  vm.runInContext(runtime, context);
  assert.equal(context.React, firstReact);
  assert.equal(context.ReactDOM, firstDOM);
  for (const globals of [{ React: { version: '19.2.1' }, ReactDOM: { version: '19.2.1' } }, { React: firstReact }]) {
    const other = vm.createContext({ window: globals });
    assert.throws(() => vm.runInContext(runtime, other), /requires one React 18\.3\.1 runtime/);
  }
});

test('minifying VDS preserves public exports, actual component markup and semantic colors', async () => {
  const source = await readFile(new URL('../frontend/venditbot/vds.js', import.meta.url), 'utf8');
  const optimized = await minifyVendorAsset(source, 'vds.js');
  assert.ok(Buffer.byteLength(optimized) < Buffer.byteLength(source) * 0.6);
  const before = renderVendorFixtures(source), after = renderVendorFixtures(optimized);
  assert.deepEqual(after, before);
  assert.match(optimized, /lodash.*Copyright/s, 'upstream legal comments must survive distribution minification');
});
