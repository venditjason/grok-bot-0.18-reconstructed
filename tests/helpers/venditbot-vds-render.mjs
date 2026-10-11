import vm from 'node:vm';
import React from 'react';
import * as ReactDOM from 'react-dom';
import { renderToStaticMarkup } from 'react-dom/server';
import { sha256 } from '../../scripts/patch-vds-lodash.mjs';

/** Execute the real browser vendor bundle with no DOM, network, IPC, or eval. */
export function renderVendorFixtures(source) {
  const window = { React, ReactDOM, matchMedia: () => ({ matches: false }) };
  const context = vm.createContext({ window, console, queueMicrotask, setTimeout, clearTimeout }, { codeGeneration: { strings: false, wasm: false } });
  vm.runInContext('self = globalThis; Math.random = () => 0.25;', context);
  vm.runInContext(source, context, { timeout: 5000 });
  const V = window.VDS;
  const render = child => renderToStaticMarkup(React.createElement(V.VDSProvider, { preferScheme: 'light' }, child));
  const cases = {
    primaryButton: React.createElement(V.Button, { kind: 'vendit', hierarchy: 'primary', size: 'medium' }, '작업 시작'),
    disabledButton: React.createElement(V.Button, { kind: 'common', disabled: true }, '대기 중'),
    textInput: React.createElement(V.TextInput, { id: 'agent-name', label: '에이전트 이름', value: '검토 도우미', readOnly: true, maxLength: 80 }),
    textArea: React.createElement(V.TextArea, { id: 'instructions', 'aria-label': '역할 지시', value: '읽고 설명하세요.', readOnly: true }),
    checkbox: React.createElement(V.Checkbox, { id: 'tool-capability', checked: true, label: '파일 도구', onCheckedChange() {} }),
    badge: React.createElement(V.Badge, { kind: 'vendit' }, '사용 가능'),
  };
  const markup = Object.fromEntries(Object.entries(cases).map(([name, element]) => [name, render(element)]));
  let colors;
  function ColorProbe() { colors = V.useSemanticColor(); return null; }
  render(React.createElement(ColorProbe));
  return {
    markup,
    hashes: Object.fromEntries(Object.entries(markup).map(([name, html]) => [name, sha256(html)])),
    colors: JSON.parse(JSON.stringify(colors)),
    colorHash: sha256(JSON.stringify(colors)),
    exportedNames: Object.keys(V).sort(),
  };
}
