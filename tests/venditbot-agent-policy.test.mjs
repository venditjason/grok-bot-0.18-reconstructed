import assert from 'node:assert/strict';
import test from 'node:test';
import {build} from 'esbuild';

async function load(file, platform = 'node') {
  const built = await build({entryPoints: [file], bundle: true, platform, format: 'esm', write: false, metafile: true});
  assert.equal(Object.keys(built.metafile.inputs).some(file => file.includes('node_modules/')), false);
  assert.equal(built.outputFiles[0].text.includes('node:'), false);
  return import('data:text/javascript;base64,' + Buffer.from(built.outputFiles[0].text).toString('base64'));
}
const schema = await load('source/shared/agent-policy.ts', 'browser');
const {normalizeAgentPolicyDraft, normalizeAgentPolicy, normalizePolicyConnections, classifyPolicyTask, validAgentPolicySelection} = schema;
const {resolveAgentPolicy} = await load('source/venditbot/agent-policy-resolver.ts');
const codex = {connectionId: 'codex', model: 'gpt-6-astra', effort: 'high'};
const claude = {connectionId: 'claude-code', model: 'claude-opus-5', effort: 'high'};
const original = [codex, claude];
const model = (id, efforts = ['low', 'high'], rest = {}) => ({id, label: id, isDefault: false, efforts, ...rest});
const catalogs = [
  {connectionId: 'codex', models: [model('gpt-6-astra'), model('gpt-6-luna', ['low', 'high'], {defaultEffort: 'low'})]},
  {connectionId: 'claude-code', models: [model('opus', ['high'], {resolvedId: 'claude-opus-5'}), model('sonnet', ['low', 'high'], {resolvedId: 'claude-sonnet-5-5', defaultEffort: 'low'})]},
];
function policy() {
  return {id: 'policy-a', name: '업무 정책', description: '', defaultTaskKind: 'standard', createdAt: '2026-10-11T00:00:00.000Z', updatedAt: '2026-10-11T01:00:00.000Z', rules: [
    {taskKind: 'routine', keywords: ['요약', 'REPEAT', '[a-z]+'], connections: [{connectionId: 'codex', model: 'gpt-6-luna', effort: 'low'}]},
    {taskKind: 'standard', keywords: ['검토'], connections: [structuredClone(codex)]},
    {taskKind: 'complex', keywords: ['심층', '설계'], connections: [structuredClone(claude), structuredClone(codex)]},
  ]};
}
function resolve(overrides = {}) {return resolveAgentPolicy({policy: policy(), originalConnections: original, text: '요약', catalogs, ...overrides});}
function frozen(value) {if (value && typeof value === 'object') {Object.values(value).forEach(frozen); Object.freeze(value);} return value;}

test('browser schema returns owned canonical three-rule objects and strips untrusted extra metadata', () => {
  const input = policy(); input.name = '  업무 정책  '; input.description = '  설명\n가능  '; input.rules.reverse(); input.rules[0].ignored = true;
  const draft = normalizeAgentPolicyDraft(input);
  assert.deepEqual(draft.rules.map(rule => rule.taskKind), ['routine', 'standard', 'complex']);
  assert.equal(draft.name, '업무 정책'); assert.equal(draft.description, '설명\n가능');
  assert.equal(draft.id, undefined); assert.equal(draft.rules[2].ignored, undefined);
  draft.rules[2].connections[0].model = 'mutated'; draft.rules[0].keywords.push('new');
  assert.equal(input.rules[0].connections[0].model, claude.model); assert.equal(input.rules[2].keywords.length, 3);
  assert.deepEqual(normalizeAgentPolicy(policy()), policy());
});

test('schema enforces exactly three unique kinds and nonempty bounded route priorities', () => {
  for (const mutate of [p => p.rules.pop(), p => p.rules.push(p.rules[0]), p => p.rules[2].taskKind = 'routine', p => p.rules[0].taskKind = 'other', p => p.defaultTaskKind = 'other', p => p.rules[0].connections = [], p => p.rules[0].connections = Array.from({length: 9}, (_, i) => ({connectionId: 'codex', model: 'model-' + i})), p => p.rules[0].connections.push({...p.rules[0].connections[0]})]) {
    const input = policy(); mutate(input); assert.throws(() => normalizeAgentPolicy(input));
  }
});

test('schema checks text and keyword bounds, literal controls and normalized duplicate keywords', () => {
  for (const mutate of [p => p.name = ' ', p => p.name = 'n'.repeat(81), p => p.description = 'd'.repeat(2001), p => p.name = 'bad\nname', p => p.rules[0].keywords = [''], p => p.rules[0].keywords = ['k'.repeat(81)], p => p.rules[0].keywords = Array.from({length: 33}, (_, i) => 'k' + i), p => p.rules[0].keywords = [' Repeat ', 'ＲＥＰＥＡＴ'], p => p.rules[0].keywords = ['bad\u0000keyword'], p => p.rules[0].keywords = ['bad\nkeyword'], p => p.rules[0].keywords = 'string']) {
    const input = policy(); mutate(input); assert.throws(() => normalizeAgentPolicy(input));
  }
  const input = policy(); input.name = 'n'.repeat(80); input.description = 'd'.repeat(2000); input.rules[0].keywords = Array.from({length: 32}, (_, i) => String(i).padEnd(80, 'k')); input.rules[1].keywords = [];
  assert.equal(normalizeAgentPolicy(input).rules[0].keywords.length, 32);
});

test('schema rejects malformed metadata and route tokens without coercion', () => {
  for (const mutate of [p => p.id = '', p => p.id = 'bad id', p => p.createdAt = 'not a date', p => p.updatedAt = '2026-01-01', p => p.rules[0].connections[0].connectionId = '', p => p.rules[0].connections[0].connectionId = 'c'.repeat(201), p => p.rules[0].connections[0].model = 'model name', p => p.rules[0].connections[0].effort = '', p => p.rules[0].connections[0].effort = 'hi\0gh', p => p.rules[0].connections[0].effort = 2]) {
    const input = policy(); mutate(input); assert.throws(() => normalizeAgentPolicy(input));
  }
  for (const input of [null, undefined, [], '', 1]) assert.throws(() => normalizeAgentPolicyDraft(input));
});

test('structured-clone sparse arrays cannot bypass rule, keyword or route validation', () => {
  for (const mutate of [p => delete p.rules[0], p => delete p.rules[0].keywords[0], p => delete p.rules[0].connections[0]]) {
    const input = policy(); mutate(input); assert.throws(() => normalizeAgentPolicy(structuredClone(input)));
  }
  assert.throws(() => normalizePolicyConnections(new Array(1)));
  const input = policy(); input.rules[0].connections = Array.from({length: 8}, (_, i) => ({connectionId: 'c'.repeat(200), model: 'm'.repeat(199) + i, effort: 'e'.repeat(40)}));
  assert.equal(normalizeAgentPolicy(input).rules[0].connections.length, 8);
});

test('keyword precedence is complex then routine then standard independent of stored rule order', () => {
  const input = policy(); input.rules.reverse();
  assert.equal(classifyPolicyTask(input, '요약과 검토를 위한 심층 설계').taskKind, 'complex');
  assert.equal(classifyPolicyTask(input, '요약 검토').taskKind, 'routine');
  assert.equal(classifyPolicyTask(input, '검토').taskKind, 'standard');
  input.defaultTaskKind = 'complex'; assert.equal(classifyPolicyTask(input, '아무 키워드 없음').taskKind, 'complex');
});

test('keywords match Unicode-normalized case-insensitive literal substrings, never regex syntax', () => {
  assert.equal(classifyPolicyTask(policy(), 'please ｒｅｐｅａｔ').taskKind, 'routine');
  assert.equal(classifyPolicyTask(policy(), 'literal [a-z]+ requested').taskKind, 'routine');
  assert.equal(classifyPolicyTask(policy(), 'plainalphabet').taskKind, 'standard');
  const input = policy(); input.rules[0].keywords = ['한글']; assert.equal(classifyPolicyTask(input, '한글'.normalize('NFD')).taskKind, 'routine');
});

test('explicit task kind outranks every keyword and invalid explicit input is refused', () => {
  for (const kind of ['routine', 'standard', 'complex']) assert.equal(classifyPolicyTask(policy(), '심층 요약 검토', kind).taskKind, kind);
  assert.throws(() => classifyPolicyTask(policy(), 'text', 'unknown'));
  assert.throws(() => classifyPolicyTask(policy(), undefined));
});

test('resolver pins advertised aliases and their supported default effort without guessing', () => {
  const input = policy(); input.rules[0].connections = [{connectionId: 'claude-code', model: 'sonnet'}, {connectionId: 'codex', model: 'gpt-6-luna'}];
  const result = resolve({policy: input});
  assert.deepEqual(result.connections, [{connectionId: 'claude-code', model: 'claude-sonnet-5-5', effort: 'low'}, {connectionId: 'codex', model: 'gpt-6-luna', effort: 'low'}]);
  assert.equal(result.warning, undefined); assert.equal(result.taskKind, 'routine');
  assert.equal(result.policyId, input.id); assert.equal(result.policyName, input.name); assert.equal(result.policyUpdatedAt, input.updatedAt);
  assert.equal(validAgentPolicySelection(result), true);
});

test('resolver retains omitted effort when the catalog advertises no default, including API-only models', () => {
  const input = policy(); input.rules[0].connections = [{connectionId: 'api:own', model: 'configured-model'}];
  const result = resolve({policy: input, originalConnections: [{connectionId: 'api:own', model: 'configured-model'}], catalogs: [{connectionId: 'api:own', models: [model('configured-model', [])]}]});
  assert.deepEqual(result.connections, [{connectionId: 'api:own', model: 'configured-model'}]); assert.equal(result.warning, undefined);
});

test('unknown models, absent catalogs, unsupported effort and unavailable connection reject the whole policy rule', () => {
  const cases = [
    {catalogs: []}, {catalogs: [{connectionId: 'codex', models: []}]},
    {catalogs: [...catalogs, catalogs[0]]},
    {route: {connectionId: 'codex', model: 'not-advertised', effort: 'low'}},
    {route: {connectionId: 'codex', model: 'gpt-6-luna', effort: 'ultra'}},
    {route: {connectionId: 'foreign', model: 'gpt-6-luna', effort: 'low'}, catalogs: [...catalogs, {connectionId: 'foreign', models: [model('gpt-6-luna')]}]},
  ];
  for (const {route, ...overrides} of cases) {
    const input = policy(); if (route) input.rules[0].connections = [structuredClone(claude), route];
    const result = resolve({policy: input, ...overrides});
    assert.deepEqual(result.connections, original); assert.match(result.warning, /기존 연결 순서/);
    assert.notEqual(result.connections, original); assert.notEqual(result.connections[0], original[0]);
  }
});

test('explicit routes have highest precedence but cannot escape the original connection whitelist or catalog', () => {
  const result = resolve({taskKind: 'complex', explicitConnections: [{connectionId: 'codex', model: 'gpt-6-luna', effort: 'high'}]});
  assert.deepEqual(result.connections, [{connectionId: 'codex', model: 'gpt-6-luna', effort: 'high'}]);
  assert.equal(result.taskKind, 'complex'); assert.match(result.reason, /명시한 연결 순서 우선/);
  for (const explicitConnections of [[{connectionId: 'foreign', model: 'gpt-6-luna'}], [{connectionId: 'codex', model: 'missing'}], [{connectionId: 'codex', model: 'gpt-6-luna', effort: 'max'}], []]) assert.throws(() => resolve({explicitConnections}));
  assert.throws(() => resolve({catalogs: [], explicitConnections: original}));
});

test('aliases and omitted defaults that collapse onto one effective route cannot create duplicate execution', () => {
  const routes = [{connectionId: 'claude-code', model: 'sonnet'}, {connectionId: 'claude-code', model: 'claude-sonnet-5-5', effort: 'low'}];
  const input = policy(); input.rules[0].connections = routes;
  assert.match(resolve({policy: input}).warning, /기존 연결 순서/);
  assert.throws(() => resolve({explicitConnections: routes}), /중복/);
  assert.deepEqual(normalizePolicyConnections([{...codex, effort: 'low'}, codex]), [{...codex, effort: 'low'}, codex]);
});

test('policy and catalog edits cannot change an already selected task, including fallback snapshots', () => {
  const input = policy(), ownCatalogs = structuredClone(catalogs), ownOriginal = structuredClone(original);
  const options = frozen({policy: input, catalogs: ownCatalogs, originalConnections: ownOriginal, text: '요약'});
  const result = resolveAgentPolicy(options); result.connections[0].model = 'edited-result';
  assert.equal(input.rules[0].connections[0].model, 'gpt-6-luna'); assert.equal(ownCatalogs[0].models[1].id, 'gpt-6-luna');
  const changed = structuredClone(input), selected = resolve({policy: changed});
  changed.rules[0].connections[0].model = 'another-model'; changed.name = 'new'; changed.updatedAt = '2026-10-12T01:00:00.000Z';
  assert.equal(selected.connections[0].model, 'gpt-6-luna'); assert.equal(selected.policyName, '업무 정책'); assert.equal(selected.policyUpdatedAt, '2026-10-11T01:00:00.000Z');
  const fallback = resolve({catalogs: [], originalConnections: ownOriginal}); fallback.connections[0].model = 'changed-fallback'; assert.equal(ownOriginal[0].model, codex.model);
});

test('selection validator refuses incomplete or corrupted persisted decision metadata', () => {
  const selected = resolve(); assert.equal(validAgentPolicySelection(selected), true);
  for (const mutate of [s => delete s.policyId, s => s.policyUpdatedAt = 'bad-date', s => s.taskKind = 'other', s => s.connections = [], s => s.reason = '', s => s.warning = 'w'.repeat(1001), s => s.policyName = 'n'.repeat(81)]) {
    const input = structuredClone(selected); mutate(input); assert.equal(validAgentPolicySelection(input), false);
  }
});
