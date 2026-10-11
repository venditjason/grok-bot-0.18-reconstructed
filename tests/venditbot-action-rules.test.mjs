import assert from 'node:assert/strict';
import test from 'node:test';
import {chmod, link, mkdir, mkdtemp, readFile, readdir, rename, rm, stat, symlink, writeFile} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {build} from 'esbuild';
const shared = await build({entryPoints: ['source/shared/action-rules.ts'], bundle: true, platform: 'browser', format: 'esm', write: false, metafile: true});
assert.equal(shared.outputFiles[0].text.includes('node:'), false); assert.equal(Object.keys(shared.metafile.inputs).some(path => path.includes('node_modules')), false);
const {ACTION_RULE_CATEGORIES, ACTION_RULE_METADATA, DEFAULT_ACTION_RULES, normalizeActionRules, normalizeActionRulePath, evaluateActionRules} = await import('data:text/javascript;base64,' + Buffer.from(shared.outputFiles[0].text).toString('base64'));
const built = await build({entryPoints: ['source/venditbot/action-rules-store.ts'], bundle: true, platform: 'node', format: 'esm', write: false});
const {ActionRulesStore} = await import('data:text/javascript;base64,' + Buffer.from(built.outputFiles[0].text).toString('base64'));
const defaults = () => structuredClone(DEFAULT_ACTION_RULES);
const evaluate = (rules, request = {}) => evaluateActionRules(rules, {category: 'routine', tool: 'read_file', ...request});
async function fixture(t) {const root = await mkdtemp(join(tmpdir(), 'venditbot-action-rules-')); t.after(() => rm(root, {recursive: true, force: true})); return {root, file: join(root, 'action-rules.json'), store: new ActionRulesStore(root)};}

test('browser-safe defaults contain all twelve risk rules and explicit unsupported-tool descriptions', () => {
  const rules = normalizeActionRules(DEFAULT_ACTION_RULES);
  assert.equal(rules.defaultMode, 'allow'); assert.equal(rules.rules.length, 12); assert.deepEqual(rules.rules.map(rule => rule.category), [...ACTION_RULE_CATEGORIES]);
  assert.deepEqual(rules.rules.filter(rule => rule.mode === 'deny').map(rule => rule.category), ['untrusted_execution', 'policy_change']);
  assert.deepEqual(ACTION_RULE_METADATA.map(item => item.category), [...ACTION_RULE_CATEGORIES]);
  assert.ok(ACTION_RULE_METADATA.every(item => item.label && item.description && item.examples.length && item.support));
  rules.rules[0].mode = 'deny'; assert.equal(DEFAULT_ACTION_RULES.rules[0].mode, 'ask');
});

test('schema requires complete unique risk categories and never accepts automatic allow for risk rules', () => {
  for (const mutate of [r => r.version = 2, r => r.updatedAt = 'bad', r => r.defaultMode = 'unknown', r => r.rules.pop(), r => r.rules[0].category = 'unknown', r => r.rules[0].category = r.rules[1].category, r => r.rules[0].mode = 'allow', r => delete r.rules[0], r => r.protectedPaths = [{id: 'private', pathPrefix: 'private', mode: 'allow'}], r => r.protectedPaths = new Array(1)]) {
    const value = defaults(); mutate(value); assert.throws(() => normalizeActionRules(value));
  }
});

test('relative path normalization handles Unicode, case and slash boundaries without traversal or patterns', () => {
  assert.equal(normalizeActionRulePath('  DÓCS//Internal/  '), 'dócs/internal');
  assert.equal(normalizeActionRulePath('한글/'.normalize('NFD')), '한글');
  assert.equal(normalizeActionRulePath('Straße/Σ'), normalizeActionRulePath('STRASSE/ς'));
  for (const path of ['', '.', '..', 'a/../b', 'a/./b', '/root', '//server/share', 'C:/Windows', 'c:relative', '\\server', 'a\\b', 'bad\0path', 'bad\npath', 'p'.repeat(4097)]) assert.throws(() => normalizeActionRulePath(path));
  // Refuse pattern syntax instead of silently treating a requested wildcard as
  // a literal filename and leaving the intended directory unprotected.
  for (const path of ['docs/*', 'docs/**', 'docs/[a-z]', 'docs/(private|secret)', '^docs$', 'docs/?', 'docs/{a,b}', 'docs/a+']) assert.throws(() => normalizeActionRulePath(path), /와일드카드/);
});

test('protected paths enforce ID, count and normalized-prefix uniqueness limits', () => {
  for (const paths of [[{id: '', pathPrefix: 'a', mode: 'ask'}], [{id: 'a b', pathPrefix: 'a', mode: 'ask'}], [{id: 'a', pathPrefix: 'one', mode: 'ask'}, {id: 'a', pathPrefix: 'two', mode: 'ask'}], [{id: 'one', pathPrefix: '한글', mode: 'ask'}, {id: 'two', pathPrefix: '한글'.normalize('NFD'), mode: 'deny'}], Array.from({length: 101}, (_, i) => ({id: 'p-' + i, pathPrefix: 'path-' + i, mode: 'ask'}))]) {
    assert.throws(() => normalizeActionRules({...defaults(), protectedPaths: paths}));
  }
});

test('deny dominates every matching category and protected path instead of only the first category', () => {
  const rules = defaults(); rules.rules.find(rule => rule.category === 'security_change').mode = 'deny';
  rules.protectedPaths = [{id: 'folder', pathPrefix: 'docs', mode: 'ask'}, {id: 'secret', pathPrefix: 'docs/private', mode: 'deny'}];
  const result = evaluate(rules, {category: 'destructive_change', categories: ['sensitive_disclosure', 'security_change', 'destructive_change'], path: 'DOCS/private/file.txt'});
  assert.equal(result.mode, 'deny');
  assert.deepEqual(result.ruleIds, ['default', 'category:destructive_change', 'category:security_change', 'category:sensitive_disclosure', 'path:folder', 'path:secret']);
  assert.match(result.reason, /작업 차단/); assert.match(result.reason, /2개/);
  assert.equal(evaluate(rules, {category: 'security_change'}).mode, 'deny'); assert.equal(evaluate(defaults(), {category: 'sensitive_disclosure'}).mode, 'ask');
});

test('default deny cannot be weakened by an ask rule and ordinary operations follow the selected default', () => {
  for (const mode of ['allow', 'ask', 'deny']) assert.equal(evaluate({...defaults(), defaultMode: mode}).mode, mode);
  assert.equal(evaluate({...defaults(), defaultMode: 'deny'}, {category: 'destructive_change'}).mode, 'deny');
  assert.equal(evaluate(defaults(), {category: 'policy_change'}).mode, 'deny');
});

test('directory prefixes do not match sibling prefixes and workspace root is a valid unmatched action', () => {
  const rules = {...defaults(), protectedPaths: [{id: 'protected', pathPrefix: 'docs/private', mode: 'deny'}]};
  for (const path of ['docs/private', 'docs/private/file.md', 'DOCS/PRIVATE/file.md']) assert.equal(evaluate(rules, {path}).mode, 'deny');
  assert.equal(evaluate(rules, {path: 'docs/private/README (copy)+notes.md'}).mode, 'deny');
  for (const path of ['docs/private-other/file.md', 'docs/privately', 'other/docs/private', '.']) assert.equal(evaluate(rules, {path}).mode, 'allow');
  assert.throws(() => evaluate(rules, {path: '../docs/private'}));
  assert.throws(() => normalizeActionRules({...rules, protectedPaths: [{id: 'root', pathPrefix: '.', mode: 'deny'}]}));
});

test('invalid classification and malformed requests fail closed instead of falling through to allow', () => {
  for (const request of [{category: 'unknown'}, {tool: ''}, {categories: ['unknown']}, {categories: new Array(1)}, {categories: Array(13).fill('security_change')}, {path: '/absolute'}, {path: null}]) assert.throws(() => evaluate(defaults(), request));
});

test('100 protected paths and repeated multi-category classifications remain deterministic and immutable', () => {
  const rules = defaults(); rules.protectedPaths = Array.from({length: 100}, (_, i) => ({id: 'protected-' + i, pathPrefix: '資料/領域-' + i, mode: i % 2 ? 'deny' : 'ask'}));
  const captured = JSON.stringify(rules);
  for (let pass = 0; pass < 10; pass++) for (let i = 0; i < 100; i++) {
    const result = evaluate(rules, {path: `資料/領域-${i}/File.txt`.normalize(pass % 2 ? 'NFD' : 'NFC'), categories: pass % 2 ? ['sensitive_disclosure', 'destructive_change'] : ['destructive_change', 'sensitive_disclosure']});
    assert.equal(result.mode, i % 2 ? 'deny' : 'ask'); assert.equal(result.ruleIds.at(-1), 'path:protected-' + i);
  }
  assert.equal(JSON.stringify(rules), captured);
});

test('store returns stable in-memory defaults without creating a file until the user saves', async t => {
  const f = await fixture(t), first = f.store.get(), second = new ActionRulesStore(f.root).get();
  assert.deepEqual(first, second); assert.deepEqual(await readdir(f.root), []);
  first.rules[0].mode = 'deny'; first.protectedPaths.push({id: 'x', pathPrefix: 'x', mode: 'deny'});
  assert.deepEqual(f.store.get(), defaults());
});

test('store requires CAS, stamps monotonic revisions and persists private data that survives restart', async t => {
  const f = await fixture(t), original = f.store.get();
  assert.throws(() => f.store.save(original), /다시 불러/);
  const saved = f.store.save({...original, defaultMode: 'ask', updatedAt: 'untrusted supplied timestamp'}, original.updatedAt);
  assert.equal(saved.defaultMode, 'ask'); assert.ok(Date.parse(saved.updatedAt) > Date.parse(original.updatedAt));
  assert.equal((await stat(f.file)).mode & 0o777, 0o600); assert.equal((await stat(f.root)).mode & 0o777, 0o700);
  assert.deepEqual(new ActionRulesStore(f.root).get(), saved); assert.throws(() => f.store.save({...saved, defaultMode: 'deny'}, original.updatedAt), /다시 불러/);
  assert.deepEqual(f.store.get(), saved);
});

test('100 paths survive 100 rapid CAS edits while every stale revision remains rejected', async t => {
  const f = await fixture(t); let current = f.store.get();
  current.protectedPaths = Array.from({length: 100}, (_, i) => ({id: 'path-' + i, pathPrefix: 'data/folder-' + i, mode: i % 2 ? 'deny' : 'ask'}));
  for (let i = 0; i < 100; i++) {
    const prior = current.updatedAt; current = f.store.save({...current, defaultMode: i % 2 ? 'deny' : 'ask'}, prior);
    assert.ok(Date.parse(current.updatedAt) > Date.parse(prior)); assert.throws(() => f.store.save(current, prior), /다시 불러/);
  }
  assert.deepEqual(new ActionRulesStore(f.root).get(), current); assert.equal(current.protectedPaths.length, 100);
});

test('two store instances detect disk revision conflicts and never overwrite the other editor', async t => {
  const f = await fixture(t), other = new ActionRulesStore(f.root), original = f.store.get();
  const saved = other.save({...original, defaultMode: 'deny'}, original.updatedAt);
  await assert.rejects(async () => f.store.save({...original, defaultMode: 'allow'}, original.updatedAt), /다른 곳/);
  assert.deepEqual(f.store.get(), saved); assert.deepEqual(JSON.parse(await readFile(f.file, 'utf8')), saved);
});

test('corrupt, oversized, permissive and linked files are rejected without altering the source', async t => {
  const f = await fixture(t);
  for (const bytes of ['{bad json', JSON.stringify({...defaults(), rules: []}), 'x'.repeat(4 * 1024 * 1024 + 1)]) {
    await writeFile(f.file, bytes, {mode: 0o600}); assert.throws(() => new ActionRulesStore(f.root)); assert.equal(await readFile(f.file, 'utf8'), bytes);
  }
  await writeFile(f.file, JSON.stringify(defaults()), {mode: 0o600}); await chmod(f.file, 0o644); assert.throws(() => new ActionRulesStore(f.root), /안전하지/); await chmod(f.file, 0o600);
  const target = f.file + '.original'; await rename(f.file, target);
  await symlink(target, f.file); assert.throws(() => new ActionRulesStore(f.root), /안전하지/); await rm(f.file);
  await link(target, f.file); assert.throws(() => new ActionRulesStore(f.root), /안전하지/); assert.deepEqual(JSON.parse(await readFile(target, 'utf8')), defaults());
});

test('symlink directory ancestors and public directories fail closed before any settings write', async t => {
  const f = await fixture(t), target = join(f.root, 'private'); await mkdir(target, {mode: 0o700}); await mkdir(join(target, 'child'), {mode: 0o700});
  const alias = join(f.root, 'alias'); await symlink(target, alias);
  assert.throws(() => new ActionRulesStore(alias), /안전하지/); assert.throws(() => new ActionRulesStore(join(alias, 'child')), /안전하지/);
  assert.deepEqual(await readdir(join(target, 'child')), []);
  await chmod(target, 0o755); assert.throws(() => new ActionRulesStore(target), /안전하지/);
});

test('a failed write target preserves the prior in-memory settings and file bytes', async t => {
  const f = await fixture(t); const saved = f.store.save(f.store.get(), f.store.get().updatedAt), original = await readFile(f.file, 'utf8');
  await rename(f.file, f.file + '.backup'); await mkdir(f.file, {mode: 0o700});
  assert.throws(() => f.store.save({...saved, defaultMode: 'deny'}, saved.updatedAt), /안전하지/); assert.deepEqual(f.store.get(), saved); assert.equal(await readFile(f.file + '.backup', 'utf8'), original);
  await rm(f.file, {recursive: true}); await rename(f.file + '.backup', f.file);
  assert.equal(f.store.save({...saved, defaultMode: 'deny'}, saved.updatedAt).defaultMode, 'deny');
});

test('malformed edits and removed files cannot silently reset a previously stored rule set', async t => {
  const f = await fixture(t); const saved = f.store.save({...f.store.get(), defaultMode: 'deny'}, f.store.get().updatedAt), original = await readFile(f.file, 'utf8');
  assert.throws(() => f.store.save({...saved, rules: []}, saved.updatedAt)); assert.equal(await readFile(f.file, 'utf8'), original); assert.deepEqual(f.store.get(), saved);
  await rm(f.file); assert.throws(() => f.store.save({...saved, defaultMode: 'allow'}, saved.updatedAt), /다른 곳/); assert.deepEqual(f.store.get(), saved);
});
