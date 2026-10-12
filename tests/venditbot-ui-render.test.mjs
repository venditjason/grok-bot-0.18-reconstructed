import assert from 'node:assert/strict';
import test from 'node:test';
import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { build } from 'esbuild';

// Render actual App conditions with lightweight VDS-shaped test components.
// Effects never run on the server, so these checks cannot reach native accounts.
const passthrough = tag => ({ children }) => React.createElement(tag, {}, children);
const input = ({ label, value, readOnly, ...props }) => React.createElement('label', {}, label, React.createElement('input', { 'aria-label': props['aria-label'] ?? label, value, readOnly: readOnly ?? true }));
globalThis.window = { React, ReactDOM: { createRoot: () => ({ render() {} }) }, VDS: {
  VDSProvider: passthrough(React.Fragment), Button: ({ children, disabled }) => React.createElement('button', { disabled }, children), Badge: passthrough('span'), Icon: () => null,
  TextInput: input, TextArea: props => React.createElement('textarea', { 'aria-label': props['aria-label'], defaultValue: props.value }), Checkbox: () => React.createElement('input', { type: 'checkbox' }),
  Dialog: { Root: ({ open, children }) => open ? children : null, Portal: passthrough(React.Fragment), Content: passthrough('div'), Header: () => null, Footer: () => null },
} };
globalThis.document = { getElementById: () => ({}) };
const built = await build({ entryPoints: [new URL('../frontend/venditbot/app.tsx', import.meta.url).pathname], bundle: true, platform: 'node', format: 'esm', jsx: 'transform', jsxFactory: 'React.createElement', jsxFragment: 'React.Fragment', write: false });
const { App, ModelPicker, AgentConnectionsEditor } = await import(`data:text/javascript;base64,${Buffer.from(built.outputFiles[0].text).toString('base64')}`);
const disconnected = { phase: 'disconnected', authenticated: false, inferenceVerified: false, credentialStorage: 'keyring' };
const initialState = { version: 'fixture', profiles: [], agents: [], sessions: [], queue: { running: [], queued: [] }, activeRun: null };
const render = props => renderToStaticMarkup(React.createElement(App, { initialState, ...props }));

test('logged-out connection cards omit every CLI model, effort and response-test control', () => {
  const html = render({ initialView: 'settings', initialAuth: { codex: disconnected, 'claude-code': disconnected } });
  assert.equal((html.match(/로그인으로 연결/g) ?? []).length, 2);
  assert.doesNotMatch(html, /Codex 연결 확인 모델|Claude 연결 확인 모델|연결 확인 추론 강도|응답 확인<\/button>/);
  assert.match(html, /새 API 연결/);
});

test('only an authenticated provider reveals catalog selectors and response verification', () => {
  const html = render({ initialView: 'settings', initialAuth: { codex: { ...disconnected, phase: 'authenticated', authenticated: true }, 'claude-code': disconnected } });
  assert.match(html, /Codex 연결 확인 모델/); assert.match(html, /Codex 연결 확인 추론 강도/);
  assert.doesNotMatch(html, /Claude 연결 확인 모델|Claude 연결 확인 추론 강도/);
  assert.equal((html.match(/응답 확인<\/button>/g) ?? []).length, 1);
  assert.match(html, /공식 모델 목록을 확인하세요/);
});

test('agent overview renders stored role/configuration and only its own task count', () => {
  const agent = { id: 'reviewer', name: '검토 에이전트', instructions: '코드를 읽고 개선점을 설명합니다.', connectionId: 'codex', model: 'fixture-model', effort: 'high', createdAt: '2026-01-01', updatedAt: '2026-01-01' };
  const html = render({ initialView: 'agents', initialState: { ...initialState, agents: [agent], sessions: [{ id: 'one', agentId: 'reviewer', title: '검토 작업', connectionId: 'codex', model: 'fixture-model', messages: [], createdAt: '2026-01-01', updatedAt: '2026-01-01' }, { id: 'two', agentId: 'writer', title: '다른 작업', connectionId: 'codex', model: 'fixture-model', messages: [], createdAt: '2026-01-01', updatedAt: '2026-01-01' }] } });
  assert.match(html, /코드를 읽고 개선점을 설명합니다/); assert.match(html, /fixture-model.*high/);
  assert.match(html, /작업 1개/); assert.match(html, /새 대화<\/button>/);
  assert.match(html, /한 작업씩 실행/);
});

test('storage failures show a persistent task recovery banner in every main view', () => {
  for (const initialView of ['agents', 'agent', 'agent-edit', 'chat', 'settings']) {
    const html = render({ initialView, initialState: { ...initialState, unsavedSessionIds: ['unsaved'], sessions: [{ id: 'unsaved', title: '보존할 작업', connectionId: 'codex', model: 'fixture', messages: [], createdAt: '2026-01-01', updatedAt: '2026-01-01' }] } });
    assert.match(html, /role="alert" aria-label="저장되지 않은 작업"/);
    assert.match(html, /저장되지 않은 작업이 있습니다\. 앱 종료 전 대화를 내보내세요\./);
    assert.match(html, /<button>작업 열기<\/button>/);
  }
  assert.doesNotMatch(render({ initialState: { ...initialState, unsavedSessionIds: [] } }), /저장되지 않은 작업이 있습니다/);
});


const loggedIn = { ...disconnected, phase: 'authenticated', authenticated: true, account: { email: 'fixture@example.invalid', plan: 'fixture' } };
const exactCatalog = { phase: 'ready', accountKey: JSON.stringify(['fixture@example.invalid', 'fixture']), catalog: { fetchedAt: '2026-01-01T00:00:00Z', source: 'official fixture', models: [
  { id: 'opus', resolvedId: 'claude-opus-fixture-5-5', label: 'Opus', isDefault: true, efforts: ['high'] },
  { id: 'sonnet', resolvedId: 'claude-sonnet-fixture-5-5', label: 'Sonnet', isDefault: false, efforts: [] },
] } };
const noop = () => {};

test('all shared model picker contexts show exact official IDs and hide stale-account options', () => {
  for (const context of ['연결 확인', '대화', '에이전트']) {
    const props = { provider: 'claude-code', auth: loggedIn, state: exactCatalog, selection: { model: 'opus', effort: 'high' }, context, onModel: noop, onEffort: noop, onRefresh: noop };
    const html = renderToStaticMarkup(React.createElement(ModelPicker, props));
    assert.match(html, /<option value="opus" selected="">Opus · claude-opus-fixture-5-5 \(opus\) · 기본<\/option>/);
    assert.match(html, /Sonnet · claude-sonnet-fixture-5-5 \(sonnet\)/);
    assert.equal((html.match(/<option value="(?:opus|sonnet)"/g) ?? []).length, 2);
    assert.match(html, /모델 ID · claude-opus-fixture-5-5 · 선택 ID opus/);
    const stale = renderToStaticMarkup(React.createElement(ModelPicker, { ...props, auth: { ...loggedIn, account: { email: 'new@example.invalid' } } }));
    assert.doesNotMatch(stale, /claude-opus-fixture|claude-sonnet-fixture/);
    const loggedOut = renderToStaticMarkup(React.createElement(ModelPicker, { ...props, auth: disconnected }));
    assert.doesNotMatch(loggedOut, /<select|목록 새로고침/);
  }
});

test('agent editor renders priority controls, current-account models, fixed API model and fallback boundaries', () => {
  const props = { routes: [{ connectionId: 'claude-code', model: 'opus' }, { connectionId: 'codex', model: 'private-old-model' }, { connectionId: 'api', model: 'old-api-model' }], profiles: [{ id: 'api', name: 'API fixture', model: 'fixed-api-model' }], auth: { 'claude-code': loggedIn, codex: disconnected }, catalogs: { 'claude-code': exactCatalog }, onChange: noop, onLoad: noop };
  const html = renderToStaticMarkup(React.createElement(AgentConnectionsEditor, props));
  assert.match(html, /에이전트 1순위 AI 연결/); assert.match(html, /에이전트 3순위 AI 연결/);
  assert.match(html, /Claude 에이전트 1순위 모델/); assert.doesNotMatch(html, /<select aria-label="Codex 에이전트 2순위 모델"/);
  assert.match(html, /readOnly="" value="fixed-api-model"/); assert.doesNotMatch(html, /old-api-model|private-old-model/);
  assert.match(html, /시작 후 실패하면 중복 실행을 막기 위해 중단/);
  assert.match(html, /연결 전환 시 이전 완료 대화를 다음 AI에 문맥으로 전달합니다/);
  assert.match(html, /후순위 연결 추가/);
  const full = renderToStaticMarkup(React.createElement(AgentConnectionsEditor, { ...props, routes: Array(8).fill(props.routes[0]) }));
  assert.match(full, /<button disabled="">후순위 연결 추가<\/button>/);
});

function treeElements(node) {
  if (Array.isArray(node)) return node.flatMap(treeElements);
  if (!React.isValidElement(node)) return [];
  return [node, ...treeElements(node.props.children)];
}

test('actual agent priority controls add, reorder, delete and reset provider-specific selections', () => {
  let routes = [{ connectionId: 'claude-code', model: 'opus', effort: 'high' }];
  const loads = [];
  const tree = () => treeElements(AgentConnectionsEditor({ routes, profiles: [{ id: 'api', model: 'fixed-api-model' }], auth: { 'claude-code': loggedIn }, catalogs: { 'claude-code': exactCatalog }, onChange: next => { routes = next; }, onLoad: id => loads.push(id) }));
  const button = name => tree().find(item => item.props.onPress && React.Children.toArray(item.props.children).join('') === name);
  assert.equal(button('1순위 삭제').props.disabled, true);
  button('후순위 연결 추가').props.onPress(); assert.equal(routes.length, 2);
  tree().find(item => item.props['aria-label'] === '에이전트 2순위 AI 연결').props.onChange({ target: { value: 'api' } });
  assert.deepEqual(routes[1], { connectionId: 'api', model: 'fixed-api-model' });
  button('2순위 위로').props.onPress(); assert.equal(routes[0].connectionId, 'api');
  button('1순위 아래로').props.onPress(); assert.equal(routes[0].model, 'opus');
  button('1순위 삭제').props.onPress(); assert.deepEqual(routes, [{ connectionId: 'api', model: 'fixed-api-model' }]);
  tree().find(item => item.props['aria-label'] === '에이전트 1순위 AI 연결').props.onChange({ target: { value: 'claude-code' } });
  assert.deepEqual(routes, [{ connectionId: 'claude-code', model: '' }]); assert.deepEqual(loads, ['claude-code']);
  tree().find(item => item.type === ModelPicker).props.onModel('opus');
  assert.deepEqual(routes, [{ connectionId: 'claude-code', model: 'opus' }]);
  tree().find(item => item.type === ModelPicker).props.onEffort('high');
  assert.equal(routes[0].effort, 'high');
  tree().find(item => item.type === ModelPicker).props.onModel('sonnet'); assert.equal(routes[0].effort, undefined);
});

test('agent overview, detail and task snapshots display each connection in priority order', () => {
  const connections = [{ connectionId: 'codex', model: 'first-model' }, { connectionId: 'claude-code', model: 'second-model', effort: 'high' }];
  const agent = { id: 'multi', name: '연결 순위 도우미', instructions: '검토', ...connections[0], connections, createdAt: '2026-01-01', updatedAt: '2026-01-01' };
  for (const initialView of ['agents', 'agent', 'chat']) {
    const html = render({ initialView, initialAgentId: 'multi', initialState: { ...initialState, agents: [agent] } });
    assert.match(html, /1순위.*Codex · first-model.*2순위.*Claude · second-model · high/);
  }
  const task = { id: 'task', title: 'Fallback task', ...connections[0], connections, createdAt: '2026-01-01', updatedAt: '2026-01-01', messages: [{ id: 'answer', role: 'assistant', status: 'completed', text: '완료한 답변', attempts: [{ ...connections[0], status: 'failed', error: 'quota fixture error' }, { ...connections[1], status: 'completed' }] }] };
  const html = render({ initialView: 'chat', initialSessionId: 'task', initialState: { ...initialState, sessions: [task] } });
  assert.match(html, /aria-label="작업의 연결 우선순위"/);
  assert.match(html, /연결 2회 · 응답 완료 · 실패 1/);
  assert.match(html, /작업 정책/);
  assert.doesNotMatch(html, /quota fixture error/); // Detail is retained in the explicit connection dialog.
  assert.match(html, /완료한 답변/);
});
