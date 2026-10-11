import assert from 'node:assert/strict';
import { after, test } from 'node:test';
import { readFile } from 'node:fs/promises';
import { Window } from 'happy-dom';
import { build } from 'esbuild';

// Exact shipped React 18 + VDS DOM, isolated from Electron/profiles/providers.
// happy-dom validates effects, events and computed CSS constraints, not pixel layout.
const browser = new Window({ url: 'http://venditbot.test', width: 1220, height: 850 });
globalThis.window = browser; globalThis.document = browser.document;
for (const name of ['HTMLElement', 'HTMLInputElement', 'Node', 'Element']) globalThis[name] = browser[name];
browser.eval(await readFile(new URL('../frontend/venditbot/react.js', import.meta.url), 'utf8'));
browser.eval(await readFile(new URL('../frontend/venditbot/vds.js', import.meta.url), 'utf8'));
for (const file of ['vds.css', 'style.css']) { const style = document.createElement('style'); style.textContent = await readFile(new URL(`../frontend/venditbot/${file}`, import.meta.url), 'utf8'); document.head.append(style); }
const React = browser.React, { createRoot, flushSync } = browser.ReactDOM;
const h = React.createElement;
let eventHandler;
const snapshot = { version: 'fixture', profiles: [], agents: [], teams: [], sessions: [], queue: { running: [], queued: [] }, activeRun: null, update: { phase: 'idle', currentVersion: 'fixture' } };
browser.venditbot = { invoke: async method => method === 'authStatus' ? { codex: { phase: 'disconnected' }, 'claude-code': { phase: 'disconnected' } } : snapshot, onEvent: handler => { eventHandler = handler; return () => { eventHandler = undefined; }; } };
browser.ReactDOM = { createRoot: () => ({ render() {} }) }; // Omit only the module's automatic bootstrap.
const built = await build({ entryPoints: ['frontend/venditbot/app.tsx', 'frontend/venditbot/update-control.tsx'], bundle: true, platform: 'node', format: 'esm', jsx: 'transform', jsxFactory: 'React.createElement', jsxFragment: 'React.Fragment', write: false, outdir: '/unused' });
const load = async name => import(`data:text/javascript;base64,${Buffer.from(built.outputFiles.find(file => file.path.endsWith(`/${name}.js`)).text).toString('base64')}`);
const { App } = await load('app'), { UpdateControl, updateProgressView } = await load('update-control');
after(() => browser.happyDOM.abort());
const noop = () => {};
const stamp = value => new Date(value).toISOString();
const began = Date.parse('2026-10-11T00:00:00Z');
const progress = (extra = {}) => ({ stage: 'copying-archive', startedAt: stamp(began), updatedAt: stamp(began), ...extra });
const update = (extra = {}) => ({ phase: 'installing', currentVersion: '0.3.3', version: 'fixture-next', ...extra });
const control = state => h(UpdateControl, { update: state, onCheck: noop, onInstall: noop });
function fixture(t, element) {
  browser.localStorage.clear();
  const host = document.createElement('div'); document.body.append(host);
  const root = createRoot(host); let mounted = true;
  const render = element => flushSync(() => root.render(h(browser.VDS.VDSProvider, { preferScheme: 'light' }, element)));
  render(element);
  const unmount = () => { if (mounted) { flushSync(() => root.unmount()); host.remove(); mounted = false; } };
  t.after(unmount);
  return { host, render, unmount };
}
const visible = node => !node.closest('[hidden]');
function button(host, text) { const target = [...host.querySelectorAll('button')].find(node => node.textContent === text && visible(node)); assert.ok(target, `visible button ${text}`); return target; }
function click(target) { flushSync(() => target.click()); }
function clock(t) {
  let now = began, serial = 0; const timers = new Map();
  t.mock.method(Date, 'now', () => now);
  t.mock.method(browser, 'setInterval', (callback, delay) => { assert.equal(delay, 1000); timers.set(++serial, callback); return serial; });
  t.mock.method(browser, 'clearInterval', id => timers.delete(id));
  return { timers, advance(milliseconds) { now += milliseconds; flushSync(() => { for (const callback of timers.values()) callback(); }); }, get now() { return now; } };
}

test('measured percentages and byte totals describe only the current stage, including zero and 100', () => {
  const half = updateProgressView(progress({ completedBytes: 1024 ** 2, totalBytes: 2 * 1024 ** 2 }), began + 4000, began);
  assert.equal(half.label, '업데이트 파일 복사·검증'); assert.equal(half.percent, 50); assert.equal(half.bytesLabel, '1.0 MiB / 2.0 MiB'); assert.equal(half.elapsed, '4초');
  assert.equal(updateProgressView(progress({ percent: 0 }), began, began).percentLabel, '0%');
  assert.equal(updateProgressView(progress({ percent: 100 }), began, began).percentLabel, '100%');
  for (const invalid of [{ percent: NaN }, { percent: Infinity }, { percent: -1 }, { percent: 101 }, { completedBytes: 4, totalBytes: 0 }, { completedBytes: 5, totalBytes: 4 }]) assert.equal(updateProgressView(progress(invalid), began, began).percent, undefined);
  const invalidTime = updateProgressView(progress({ startedAt: 'invalid', updatedAt: 'invalid' }), began + 2000, began);
  assert.equal(invalidTime.elapsed, '2초'); assert.equal(invalidTime.stale, false);
});

test('all nine stages have concrete labels and unmeasured stages stay indeterminate', t => {
  const timer = clock(t), f = fixture(t, control(update()));
  const labels = { checking: '업데이트 정보 확인', 'verifying-current': '현재 앱 확인', 'verifying-archive': '업데이트 파일 검증', 'copying-archive': '업데이트 파일 복사·검증', extracting: '업데이트 파일 압축 해제', 'verifying-package': '새 앱 검증', 'backing-up': '데이터 백업·검증', 'preparing-restart': '안전한 재시작 준비', 'awaiting-quit': '앱 종료와 교체 대기' };
  for (const [stage, label] of Object.entries(labels)) {
    f.render(control(update({ progress: progress({ stage }) })));
    assert.match(f.host.textContent, new RegExp(label));
    const bar = f.host.querySelector('progress'); assert.ok(bar); assert.equal(bar.hasAttribute('value'), false); assert.equal(bar.getAttribute('aria-label'), `${label} 단계 진행률`);
  }
  f.render(control(update({ progress: progress({ percent: 100 }) })));
  assert.equal(f.host.querySelector('progress').value, 100); assert.match(f.host.textContent, /현재 단계 100%/); assert.match(f.host.textContent, /파일 준비를 마치면 앱이 다시 시작/); assert.doesNotMatch(f.host.textContent, /설치 완료/);
  f.unmount(); assert.equal(timer.timers.size, 0);
});

test('live stage timer reports stale work, clears after a measured update, resets per stage and cleans up', t => {
  const timer = clock(t), f = fixture(t, control(update({ progress: progress({ percent: 20 }) })));
  assert.equal(timer.timers.size, 1); assert.match(f.host.textContent, /이 단계 0초 경과/);
  timer.advance(31_000); assert.match(f.host.textContent, /30초 이상 새 진행 정보가 없습니다/); assert.match(f.host.textContent, /복사본을 검증/); assert.doesNotMatch(f.host.textContent, /강제 종료/);
  f.render(control(update({ progress: progress({ percent: 55, updatedAt: stamp(timer.now) }) })));
  assert.doesNotMatch(f.host.textContent, /새 진행 정보가 없습니다/); assert.match(f.host.textContent, /이 단계 31초 경과/);
  f.render(control(update({ progress: progress({ stage: 'awaiting-quit', startedAt: stamp(timer.now), updatedAt: stamp(timer.now) }) })));
  assert.match(f.host.textContent, /이 단계 0초 경과/);
  timer.advance(60_000); assert.match(f.host.textContent, /이 단계 1분 0초 경과/); assert.match(f.host.textContent, /다른 벤디트봇 창이나 macOS 확인 창/);
  f.render(control(update({ phase: 'error', error: '서명 검증 실패', progress: progress({ percent: 100 }) })));
  assert.equal(timer.timers.size, 0); assert.equal(f.host.querySelector('progress'), null); assert.equal(f.host.querySelector('[role="alert"]').textContent, '서명 검증 실패');
});

test('older installing state has an indeterminate fallback and never invents progress', t => {
  const timer = clock(t), f = fixture(t, control(update()));
  assert.equal(f.host.querySelector('progress').hasAttribute('value'), false); assert.match(f.host.textContent, /화면 표시 후 0초/);
  timer.advance(32_000); assert.match(f.host.textContent, /세부 진행 정보를 제공하지 않습니다/); assert.doesNotMatch(f.host.textContent, /\d+%/);
  f.unmount(); assert.equal(timer.timers.size, 0);
});

test('exact VDS settings navigation cannot shrink or impose a fixed text height at narrow sizes', t => {
  const f = fixture(t, h(App, { initialState: snapshot, initialView: 'settings' }));
  for (const width of [1220, 760, 570]) {
    browser.happyDOM.setWindowSize({ width, height: 850 });
    const header = f.host.querySelector('.settings-tab-header'), tabs = [...f.host.querySelectorAll('.settings-sections')];
    assert.equal(browser.getComputedStyle(header).flexShrink, '0');
    for (const nav of tabs) {
      assert.equal(browser.getComputedStyle(nav).flexWrap, 'wrap');
      for (const node of nav.querySelectorAll(':scope > button')) {
        node.style.fontSize = '32px';
        const css = browser.getComputedStyle(node);
        assert.equal(css.whiteSpace, 'normal'); assert.equal(Number.parseFloat(css.minWidth), 0); assert.equal(css.maxWidth, '100%'); assert.equal(css.minHeight, '40px'); assert.equal(css.height, 'auto');
        const content = node.firstElementChild; assert.ok(content, 'the actual VDS content wrapper must be included');
        assert.equal(browser.getComputedStyle(content).whiteSpace, 'normal'); assert.equal(Number.parseFloat(browser.getComputedStyle(content).minWidth), 0);
      }
    }
    assert.equal(browser.getComputedStyle(f.host.querySelector('.connection-sections')).flexShrink, '0');
  }
  assert.match(f.host.textContent, /프로젝트 레인 API\(Rabbit\)/);
});

test('actual App tab navigation starts each settings panel at its heading while live updates keep scroll and drafts', t => {
  const f = fixture(t, h(App, { initialState: snapshot, initialView: 'settings' }));
  const rabbitPanel = f.host.querySelector('[aria-label="프로젝트 레인 API(Rabbit)"]').closest('[data-settings-panel]');
  rabbitPanel.scrollTop = 180;
  click(button(f.host, '프로젝트 레인 API(Rabbit)'));
  assert.equal(rabbitPanel.scrollTop, 0); assert.equal(rabbitPanel.hidden, false); assert.ok(button(rabbitPanel, 'Rabbit 연결 추가'));
  const heading = rabbitPanel.querySelector('.section-heading'), add = button(rabbitPanel, 'Rabbit 연결 추가');
  assert.equal(browser.getComputedStyle(heading).flexWrap, 'wrap'); assert.equal(browser.getComputedStyle(add).flexShrink, '0'); assert.equal(browser.getComputedStyle(add).whiteSpace, 'nowrap');
  click(button(rabbitPanel, '예시 프로젝트 주소'));
  assert.ok([...rabbitPanel.querySelectorAll('input')].some(node => node.value.includes('/v1/projects/')));
  rabbitPanel.scrollTop = 240;
  flushSync(() => eventHandler({ type: 'update', update: { phase: 'available', currentVersion: 'fixture', version: 'new' } }));
  assert.equal(rabbitPanel.scrollTop, 240, 'background events do not scroll an active form');
  click(button(f.host, '업데이트')); assert.equal(rabbitPanel.scrollTop, 0);
  const updatePanel = f.host.querySelector('[aria-label="업데이트 설정"]'); assert.equal(updatePanel.hidden, false);
  click(button(f.host, '연결')); assert.equal(rabbitPanel.hidden, false);
  assert.ok([...rabbitPanel.querySelectorAll('input')].some(node => node.value.includes('/v1/projects/')), 'tab changes preserve the edited connection draft');
  const tab = button(f.host, '규칙'); tab.focus();
  flushSync(() => { tab.dispatchEvent(new browser.KeyboardEvent('keydown', { key: 'Enter', code: 'Enter', bubbles: true })); tab.dispatchEvent(new browser.KeyboardEvent('keyup', { key: 'Enter', code: 'Enter', bubbles: true })); });
  assert.equal(document.activeElement, tab); assert.equal(tab.tagName, 'BUTTON'); assert.ok(tab.tabIndex >= 0);
  // happy-dom does not synthesize the browser's default Enter -> click action.
  click(tab); assert.equal(tab.getAttribute('aria-current'), 'page');
});

test('pending install immediately shows preparation, unrelated busy work does not, and host progress takes over', t => {
  const timer = clock(t), available = { phase: 'available', currentVersion: '0.3.3', version: 'next' };
  const show = props => h(UpdateControl, { update: available, onCheck: noop, onInstall: noop, ...props });
  const f = fixture(t, show({ busy: true }));
  assert.equal(f.host.querySelector('progress'), null); assert.doesNotMatch(f.host.textContent, /설치 준비 중/);
  f.render(show({ busy: true, installRequested: true }));
  assert.match(f.host.textContent, /설치 준비 중/); assert.equal(f.host.querySelector('progress').hasAttribute('value'), false);
  timer.advance(6000); assert.match(f.host.textContent, /준비 시작 후 6초 경과/);
  f.render(show({ installRequested: true, update: update({ progress: progress({ stage: 'verifying-archive', percent: 25 }) }) }));
  assert.match(f.host.textContent, /업데이트 파일 검증/); assert.doesNotMatch(f.host.textContent, /설치 준비 중/); assert.equal(f.host.querySelector('progress').value, 25);
  f.render(show({ update: { phase: 'error', currentVersion: '0.3.3', error: '설치 준비가 거절되었습니다.' } }));
  assert.equal(f.host.querySelector('progress'), null); assert.match(f.host.textContent, /설치 준비가 거절되었습니다/); assert.equal(timer.timers.size, 0);
});
