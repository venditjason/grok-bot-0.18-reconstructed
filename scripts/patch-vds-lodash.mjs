#!/usr/bin/env node
// Reproduce the narrowly scoped vendor update without rebuilding the design system.
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { readFile, writeFile } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parse } from 'acorn';
import { simple } from 'acorn-walk';

export const LODASH_VERSION = '4.18.0';
export const ORIGINAL_BUNDLE_SHA256 = 'fa12c2f2019114129a4d02e389d7e9b4d6f81b70ef9a61de0c9da4827388f7c3';
export const TARBALL_INTEGRITY = 'sha512-l1mfj2atMqndAHI3ls7XqPxEjV2J9ZkcNyHpoZA3r2T1LLwDB69jgkMWh71YKwhBbK0G2f4WSn05ahmQXVxupA==';
export const SOURCE_SHA256 = '5009c4c4d2bdbeb10b1c89bac5657beee324a0fb5e3de36ce2aefbac5bb5666f';
export const LICENSE_SHA256 = 'f71e8ed126b46346494aad5486874cd8f0aafe95092ed67d2e3cb6110f939abc';
export const sha256 = value => createHash('sha256').update(value).digest('hex');

export function locateLodash(bundle) {
  const comments = [];
  const ast = parse(bundle, { ecmaVersion: 'latest', sourceType: 'script', onComment: comments });
  const matches = [];
  simple(ast, { VariableDeclaration(node) {
    if (node.declarations.some(row => row.id.type === 'Identifier' && row.id.name === 'require_lodash')) matches.push(node);
  } });
  assert.equal(matches.length, 1, 'Expected exactly one embedded Lodash module');
  const declaration = matches[0];
  assert.equal(declaration.declarations.length, 1);
  const call = declaration.declarations[0].init;
  assert.equal(call?.type, 'CallExpression');
  assert.equal(call.callee.name, '__commonJS');
  const properties = call.arguments[0]?.properties;
  assert.equal(properties?.length, 1);
  const property = properties[0];
  assert.match(property.key.value, /\/lodash@[^/]+\/node_modules\/lodash\/lodash\.js$/);
  assert.deepEqual(property.value.params.map(row => row.name), ['exports', 'module']);
  const comment = comments.find(row => row.end < declaration.start && /^\s*$/.test(bundle.slice(row.end, declaration.start)) && row.value.trim() === property.key.value);
  assert.ok(comment, 'Expected the matching esbuild module-path comment');
  const versions = [];
  simple(property.value.body, { VariableDeclarator(node) {
    if (node.id.type === 'Identifier' && node.id.name === 'VERSION') versions.push(node.init.value);
  } });
  assert.equal(versions.length, 1);
  return { start: comment.start, end: declaration.end, declarationStart: declaration.start, body: property.value.body, version: versions[0] };
}

export function buildPatchedVds(original, officialSource) {
  assert.equal(sha256(original), ORIGINAL_BUNDLE_SHA256, 'Unrecognized VDS input: never patch a different vendor bundle implicitly');
  assert.equal(sha256(officialSource), SOURCE_SHA256, 'Lodash source differs from the verified official tarball');
  const oldRange = locateLodash(original);
  assert.equal(oldRange.version, '4.17.21');
  const modulePath = `../../node_modules/.pnpm/lodash@${LODASH_VERSION}/node_modules/lodash/lodash.js`;
  // The official source is inserted byte-for-byte, including its license. Its
  // normal CommonJS exports are resolved by the existing esbuild module loader.
  const replacement = `// ${modulePath}\n  var require_lodash = __commonJS({\n    ${JSON.stringify(modulePath)}(exports, module) {\n      init_define_import_meta_env();\n${officialSource}\n    }\n  });`;
  const prefix = original.slice(0, oldRange.start);
  const suffix = original.slice(oldRange.end);
  const patched = prefix + replacement + suffix;
  const newRange = locateLodash(patched);
  assert.equal(newRange.version, LODASH_VERSION);
  assert.equal(patched.slice(0, newRange.start), prefix);
  assert.equal(patched.slice(newRange.end), suffix);
  return { patched, provenance: {
    package: 'lodash', oldVersion: oldRange.version, version: LODASH_VERSION,
    registry: 'https://registry.npmjs.org', tarball: `https://registry.npmjs.org/lodash/-/lodash-${LODASH_VERSION}.tgz`,
    tarballIntegrity: TARBALL_INTEGRITY, sourceSha256: SOURCE_SHA256,
    license: `lodash-${LODASH_VERSION}-LICENSE`, licenseSha256: LICENSE_SHA256,
    bundle: 'frontend/venditbot/vds.js', originalBundleSha256: ORIGINAL_BUNDLE_SHA256, patchedBundleSha256: sha256(patched),
    originalModuleSha256: sha256(original.slice(oldRange.start, oldRange.end)), patchedModuleSha256: sha256(replacement),
    unchangedPrefixSha256: sha256(prefix), unchangedSuffixSha256: sha256(suffix),
    originalUtf8Bytes: Buffer.byteLength(original), patchedUtf8Bytes: Buffer.byteLength(patched),
    scope: 'Only the AST-delimited require_lodash declaration and its adjacent module-path comment are replaced. The official lodash.js source is unmodified; all other VDS bytes are preserved.',
    advisories: [
      'https://github.com/lodash/lodash/security/advisories/GHSA-r5fr-rjxr-66jc',
      'https://github.com/lodash/lodash/security/advisories/GHSA-f23m-r3pf-42rh',
      'https://github.com/lodash/lodash/security/advisories/GHSA-xxjr-mmjv-4gpg',
    ],
    reproduction: 'See resources/licenses/vds-lodash-README.txt and scripts/patch-vds-lodash.mjs.',
  } };
}

async function main() {
  const args = process.argv.slice(2);
  const value = name => { const i = args.indexOf(name); return i < 0 ? undefined : args[i + 1]; };
  const originalPath = value('--original'); const tarballPath = value('--tarball');
  if (!originalPath || !tarballPath) throw new Error('Usage: node scripts/patch-vds-lodash.mjs --original <original VDS _ds_bundle.js> --tarball <lodash-4.18.0.tgz> [--check]');
  const tarball = await readFile(tarballPath);
  assert.equal(`sha512-${createHash('sha512').update(tarball).digest('base64')}`, TARBALL_INTEGRITY, 'Official npm tarball integrity mismatch');
  const extract = file => execFileSync('tar', ['-xOf', resolve(tarballPath), `package/${file}`], { maxBuffer: 2_000_000 });
  const metadata = JSON.parse(extract('package.json').toString('utf8'));
  assert.equal(metadata.name, 'lodash'); assert.equal(metadata.version, LODASH_VERSION);
  const source = extract('lodash.js').toString('utf8'); const license = extract('LICENSE');
  assert.equal(sha256(license), LICENSE_SHA256);
  const { patched, provenance } = buildPatchedVds(await readFile(originalPath, 'utf8'), source);
  const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
  const files = [
    ['frontend/venditbot/vds.js', patched],
    [`resources/licenses/lodash-${LODASH_VERSION}-LICENSE`, license],
    ['resources/licenses/vds-lodash-provenance.json', `${JSON.stringify(provenance, null, 2)}\n`],
  ];
  for (const [path, content] of files) {
    const target = resolve(root, path);
    if (args.includes('--check')) assert.deepEqual(await readFile(target), Buffer.from(content), `${path} is not reproducible`);
    else await writeFile(target, content);
  }
  console.log(`${args.includes('--check') ? 'Verified' : 'Patched'} VDS Lodash ${LODASH_VERSION}; unchanged prefix and suffix verified; bundle SHA256 ${provenance.patchedBundleSha256}`);
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) await main();
