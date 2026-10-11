import assert from 'node:assert/strict';
import test from 'node:test';
import React from 'react';
import { build } from 'esbuild';
globalThis.window = { React };
const built = await build({ entryPoints: [new URL('../frontend/venditbot/draft-storage.ts', import.meta.url).pathname], bundle: true, platform: 'node', format: 'esm', write: false });
const { LocalDraftStore, textDrafts, agentEditDrafts, teamEditDrafts, policyEditDrafts, clearMatchingDraft } = await import(`data:text/javascript;base64,${Buffer.from(built.outputFiles[0].text).toString('base64')}`);
const key = 'venditbot.drafts.v1.prompts';
function storage() { const values = new Map(); return { values, getItem: key => values.get(key) ?? null, setItem: (key, value) => values.set(key, value) }; }
const agent = { draft: { name: '설계 도우미', instructions: '변경 중 역할', connectionId: 'codex', model: 'gpt-6.1-sol', connections: [{ connectionId: 'codex', model: 'gpt-6.1-sol', effort: 'low' }], avatarId: 'generated', workspacePath: '/workspace' }, avatarPrompt: '파란 로봇', avatarMode: 'image' };
const team = { draft: { id: 'team', name: '편집 중 팀', instructions: '공동 지침', topic: '검토', policies: '검증 먼저', leaderAgentId: 'agent', memberAgentIds: ['agent'], rounds: 1 }, expectedUpdatedAt: '2026-01-01' };

test('draft input is durably written synchronously and recovered by a new store instance', () => {
  const disk = storage(), store = new LocalDraftStore(disk, 'prompts', {}, textDrafts);
  store.set({ 'session:one': '보낼 메시지', 'agent:two': '새 작업', 'new-chat': '' });
  assert.deepEqual(JSON.parse(disk.getItem(key)), { 'session:one': '보낼 메시지', 'agent:two': '새 작업' });
  assert.deepEqual(new LocalDraftStore(disk, 'prompts', {}, textDrafts).value, { 'session:one': '보낼 메시지', 'agent:two': '새 작업' });
  const edits = new LocalDraftStore(disk, 'agent-edits', {}, agentEditDrafts); edits.set({ new: agent });
  assert.deepEqual(new LocalDraftStore(disk, 'agent-edits', {}, agentEditDrafts).value, { new: agent });
  const teams = new LocalDraftStore(disk, 'team-edits', {}, teamEditDrafts); teams.set({ team });
  assert.deepEqual(new LocalDraftStore(disk, 'team-edits', {}, teamEditDrafts).value, { team });
});

test('twenty-member team drafts, policy edits and scoped avatar recovery metadata persist without secrets', () => {
  const disk = storage(), expanded = { ...team, draft: { ...team.draft, memberAgentIds: Array.from({ length: 20 }, (_, at) => `agent-${at}`) } };
  const teams = new LocalDraftStore(disk, 'team-edits', {}, teamEditDrafts); teams.set({ team: expanded }); assert.equal(teams.error, undefined); assert.equal(new LocalDraftStore(disk, 'team-edits', {}, teamEditDrafts).value.team.draft.memberAgentIds.length, 20);
  const withRequest = { ...agent, avatarOwnerKey: 'draft:identity', avatarRequestId: 'request', avatarAppliedRequestId: 'previous', draft: { ...agent.draft, automation: { policyId: 'policy' } } }, edits = new LocalDraftStore(disk, 'agent-edits', {}, agentEditDrafts);
  edits.set({ new: withRequest }); assert.deepEqual(new LocalDraftStore(disk, 'agent-edits', {}, agentEditDrafts).value.new, withRequest);
  const policy = { draft: { name: '미완성 정책', description: '', defaultTaskKind: 'routine', rules: ['routine', 'standard', 'complex'].map(taskKind => ({ taskKind, keywords: ['아직 입력 중', ''], connections: [{ connectionId: '', model: '', apiKey: 'never-store' }] })) }, expectedUpdatedAt: '', previewAgentId: '', previewText: '작업 예시' }, policies = new LocalDraftStore(disk, 'policy-edits', {}, policyEditDrafts);
  policies.set({ new: policy }); assert.equal(policies.error, undefined); const restored = new LocalDraftStore(disk, 'policy-edits', {}, policyEditDrafts).value.new; assert.equal(restored.previewText, policy.previewText); assert.equal(restored.draft.rules.length, 3); assert.doesNotMatch(disk.getItem('venditbot.drafts.v1.policy-edits'), /never-store|apiKey/);
});

test('draft persistence whitelists editable fields and rejects malformed keys and oversized text', () => {
  const record = { ...agent, apiKey: 'never-store', draft: { ...agent.draft, apiKey: 'never-store', token: 'never-store', connections: [{ ...agent.draft.connections[0], secret: 'never-store' }] } };
  assert.doesNotMatch(JSON.stringify(agentEditDrafts({ new: record })), /never-store|apiKey|secret/);
  assert.doesNotMatch(JSON.stringify(teamEditDrafts({ team: { ...team, token: 'never-store', draft: { ...team.draft, secret: 'never-store' } } })), /never-store|secret/);
  for (const bad of ['__proto__', 'constructor', 'prototype']) assert.equal(agentEditDrafts(JSON.parse(`{"${bad}":${JSON.stringify(agent)}}`)), undefined);
  assert.equal(textDrafts({ apiKey: 'never-store' }), undefined);
  assert.equal(textDrafts({ 'new-chat': 'x'.repeat(100001) }), undefined);
});

test('write failure preserves the previous disk copy and latest in-memory draft, then retry recovers', () => {
  const disk = storage(), store = new LocalDraftStore(disk, 'prompts', {}, textDrafts);
  store.set({ 'new-chat': '기존 저장 초안' }); const write = disk.setItem;
  disk.setItem = () => { throw new Error('quota'); }; store.set({ 'new-chat': '새 입력을 잃으면 안 됨' });
  assert.match(store.error, /저장하지 못했습니다/); assert.equal(store.value['new-chat'], '새 입력을 잃으면 안 됨'); assert.equal(JSON.parse(disk.getItem(key))['new-chat'], '기존 저장 초안'); assert.equal(store.flush(), false);
  disk.setItem = write; assert.equal(store.flush(), true); assert.equal(store.error, undefined); assert.equal(new LocalDraftStore(disk, 'prompts', {}, textDrafts).value['new-chat'], '새 입력을 잃으면 안 됨');
});

test('unreadable stored drafts are never silently overwritten and delayed saves preserve subsequent edits', () => {
  const disk = storage(); disk.setItem(key, '{broken original');
  const store = new LocalDraftStore(disk, 'prompts', {}, textDrafts); store.set({ 'new-chat': '새 내용' });
  assert.equal(store.flush(), false); assert.equal(disk.getItem(key), '{broken original'); assert.match(store.error, /원본은 유지/);
  const later = { ...team, draft: { ...team.draft, policies: '저장 응답 대기 중 추가 작성' } };
  assert.deepEqual(clearMatchingDraft({ team: later }, 'team', team), { team: later });
  assert.deepEqual(clearMatchingDraft({ team }, 'team', team), {});
});

test('a temporary startup read failure can retry without losing the prior disk copy or newly typed text', () => {
  const disk = storage(); disk.setItem(key, JSON.stringify({ 'session:old': '기존 대화 초안' })); const read = disk.getItem; disk.getItem = () => { throw new Error('temporary read failure'); };
  const store = new LocalDraftStore(disk, 'prompts', {}, textDrafts); store.set({ 'new-chat': '읽기 실패 중 작성' }); disk.getItem = read;
  assert.equal(store.flush(), true); assert.deepEqual(new LocalDraftStore(disk, 'prompts', {}, textDrafts).value, { 'session:old': '기존 대화 초안', 'new-chat': '읽기 실패 중 작성' });
});

test('bounded draft stress: 1000 writes with 10 injected failures and 50 remounts retain every task', t => {
  const disk = storage(), write = disk.setItem; let store = new LocalDraftStore(disk, 'prompts', {}, textDrafts), failures = 0, remounts = 0;
  for (let index = 0; index < 1000; index++) {
    const name = `session:${index % 200}`, next = { ...store.value, [name]: `${index}:` + '보관할 입력 '.repeat(30) };
    if (index % 100 === 99) { disk.setItem = () => { throw new Error('injected write failure'); }; const before = disk.getItem(key); store.set(next); assert.ok(store.error); assert.equal(disk.getItem(key), before); assert.equal(store.value[name], next[name]); disk.setItem = write; assert.equal(store.flush(), true); failures++; }
    else store.set(next);
    if (index % 20 === 19) { const expected = structuredClone(store.value); store = new LocalDraftStore(disk, 'prompts', {}, textDrafts); assert.deepEqual(store.value, expected); remounts++; }
  }
  assert.equal(Object.keys(store.value).length, 200); assert.equal(failures, 10); assert.equal(remounts, 50);
  for (let index = 800; index < 1000; index++) assert.ok(store.value[`session:${index % 200}`].startsWith(`${index}:`));
  t.diagnostic(`bounded in-memory Storage fixture: 1000 writes, ${failures} injected write failures, ${remounts} store remounts, 200 separate drafts`);
});

test('explicit damaged-draft recovery retains exact original bytes with new drafts through later writes and remounts', () => {
  const disk = storage(), original = '{broken: "원본\n<script>not executable</script>"'; disk.setItem(key, original);
  const store = new LocalDraftStore(disk, 'prompts', {}, textDrafts); store.set({ 'new-chat': '읽기 실패 중에도 적은 내용' });
  assert.deepEqual(store.original, { text: original, preserved: false }); assert.equal(disk.getItem(key), original); assert.equal(store.preserveOriginal(), true); assert.equal(store.error, undefined);
  let restored = new LocalDraftStore(disk, 'prompts', {}, textDrafts); assert.deepEqual(restored.original, { text: original, preserved: true }); assert.equal(restored.value['new-chat'], '읽기 실패 중에도 적은 내용');
  restored.set({ ...restored.value, 'session:later': '복구 뒤 입력' }); restored = new LocalDraftStore(disk, 'prompts', {}, textDrafts); assert.deepEqual(restored.original, { text: original, preserved: true }); assert.equal(restored.value['session:later'], '복구 뒤 입력');
});

test('failed or stale explicit recovery cannot replace the damaged original', () => {
  const disk = storage(), original = 'broken original'; disk.setItem(key, original); const store = new LocalDraftStore(disk, 'prompts', {}, textDrafts), write = disk.setItem;
  disk.setItem = () => { throw new Error('quota'); }; assert.equal(store.preserveOriginal(), false); assert.equal(disk.getItem(key), original); assert.deepEqual(store.original, { text: original, preserved: false });
  disk.setItem = write; disk.setItem(key, 'another original'); assert.equal(store.preserveOriginal(), false); assert.equal(disk.getItem(key), 'another original');
});
