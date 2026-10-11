import assert from 'node:assert/strict';
import test from 'node:test';
import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { build } from 'esbuild';
const passthrough = ({ children }) => children;
globalThis.window = { React, VDS: { Button: ({ children }) => React.createElement('button', null, children), TextInput: ({ label, value }) => React.createElement('label', null, label, React.createElement('input', { value, readOnly: true })), Dialog: { Root: passthrough, Portal: passthrough, Content: passthrough, Header: ({ title, description }) => React.createElement('header', null, title, description), Footer: ({ RightComponent }) => React.createElement(RightComponent) } } };
async function bundle(file) { const result = await build({ entryPoints: [new URL(file, import.meta.url).pathname], bundle: true, platform: 'node', format: 'esm', jsx: 'transform', jsxFactory: 'React.createElement', jsxFragment: 'React.Fragment', write: false }); return import(`data:text/javascript;base64,${Buffer.from(result.outputFiles[0].text).toString('base64')}`); }
const { DEFAULT_ACTION_RULES, ACTION_RULE_METADATA } = await bundle('../source/shared/action-rules.ts');
const { ActionRulesSettings } = await bundle('../frontend/venditbot/action-rules-ui.tsx');
const { ActionApproval } = await bundle('../frontend/venditbot/action-approval.tsx');
const { actionRulesEdits, LocalDraftStore } = await bundle('../frontend/venditbot/draft-storage.ts');
const nodes = node => Array.isArray(node) ? node.flatMap(nodes) : React.isValidElement(node) ? [node, ...nodes(node.props.children)] : [];
const text = node => Array.isArray(node) ? node.map(text).join('') : React.isValidElement(node) ? text(node.props.children) : typeof node === 'string' || typeof node === 'number' ? String(node) : '';
const button = (tree, label) => nodes(tree).find(node => node.props.onPress && text(node) === label);

test('rules editor exposes twelve required ask/deny categories and automatic allowance only for ordinary tools', () => {
  let record = { rules: structuredClone(DEFAULT_ACTION_RULES), expectedUpdatedAt: DEFAULT_ACTION_RULES.updatedAt };
  const render = () => ActionRulesSettings({ record, onChange: next => { record = next; }, onReload() {}, onSave() {} });
  let tree = render(); const selects = nodes(tree).filter(node => node.type === 'select'); assert.equal(selects.length, 13);
  assert.equal(nodes(selects[0]).filter(node => node.type === 'option').length, 3);
  for (const select of selects.slice(1)) assert.deepEqual(nodes(select).filter(node => node.type === 'option').map(node => node.props.value), ['ask', 'deny']);
  selects[1].props.onChange({ target: { value: 'deny' } }); assert.equal(record.rules.rules[0].mode, 'deny');
  button(render(), '보호 경로 추가').props.onPress(); tree = render(); assert.equal(record.rules.protectedPaths.length, 1); assert.equal(record.rules.protectedPaths[0].mode, 'ask');
  nodes(tree).find(node => node.props.label === '1번 보호 경로').props.onChange({ target: { value: 'docs/고객자료' } }); assert.equal(record.rules.protectedPaths[0].pathPrefix, 'docs/고객자료');
  button(render(), '1번 경로 삭제').props.onPress(); assert.equal(record.rules.protectedPaths.length, 0);
  const html = renderToStaticMarkup(render()); for (const meta of ACTION_RULE_METADATA) assert.ok(html.includes(meta.label)); assert.match(html, /상대 경로/); assert.match(html, /완벽하게 판별할 수는 없/); assert.match(html, /현재 저장소 삭제 도구는 제공하지 않습니다/);
});

test('unfinished rules and protected paths persist across remount while risk auto-allow is rejected', () => {
  const values = new Map(), storage = { getItem: key => values.get(key) ?? null, setItem: (key, value) => values.set(key, value) }, record = { rules: { ...structuredClone(DEFAULT_ACTION_RULES), protectedPaths: [{ id: 'path', pathPrefix: '', mode: 'ask' }] }, expectedUpdatedAt: DEFAULT_ACTION_RULES.updatedAt };
  const store = new LocalDraftStore(storage, 'action-rules', {}, actionRulesEdits); store.set({ current: record }); assert.equal(store.error, undefined); assert.deepEqual(new LocalDraftStore(storage, 'action-rules', {}, actionRulesEdits).value.current, record);
  const invalid = structuredClone(record); invalid.rules.rules[0].mode = 'allow'; assert.equal(actionRulesEdits({ current: invalid }), undefined);
  const tree = ActionRulesSettings({ record, conflict: '새 규칙이 저장되었습니다.', onChange() {}, onReload() {}, onSave() {} }); assert.equal(button(tree, '규칙 저장').props.disabled, true); assert.ok(button(tree, '최신 규칙 다시 불러오기'));
});

test('generic approval displays target and reason and omits nonexistent write previews for read/manage requests', () => {
  const responses = [], approval = { approvalId: 'one', sessionId: 'session', path: 'docs/customer.txt', operation: 'read', tool: 'workspace_read_file', category: 'sensitive_disclosure', reason: '민감한 내용이 AI에 전달될 수 있습니다.' };
  const render = request => renderToStaticMarkup(React.createElement(ActionApproval, { approval: request, onRespond: value => responses.push(value) }));
  const html = render(approval); assert.match(html, /파일 읽기 · workspace_read_file/); assert.match(html, /docs\/customer.txt/); assert.match(html, /민감한 내용/); assert.doesNotMatch(html, /<pre|덮어씁니다/);
  assert.match(render({ ...approval, operation: 'write', existing: true, preview: '<script>literal</script>' }), /&lt;script&gt;literal&lt;\/script&gt;/);
  const tree = ActionApproval({ approval, onRespond: value => responses.push(value) }), footer = nodes(tree).find(node => node.props.RightComponent).props.RightComponent(); button(footer, '거절').props.onPress(); button(footer, '이번 작업 허용').props.onPress(); assert.deepEqual(responses, [false, true]); tree.props.onOpenChange(false); assert.deepEqual(responses, [false, true, false]);
});
