import assert from 'node:assert/strict';
import test from 'node:test';
import React from 'react';
import { build } from 'esbuild';
import { readFile } from 'node:fs/promises';
const effects = [], listeners = new Map();
globalThis.Node = class Node {};
globalThis.window = { React: { ...React, useRef: value => ({ current: value }), useEffect: effect => effects.push(effect) }, VDS: { Button: ({ children }) => children } };
globalThis.document = { activeElement: undefined, addEventListener: (name, callback) => listeners.set(name, callback), removeEventListener: name => listeners.delete(name) };
const result = await build({ entryPoints: [new URL('../frontend/venditbot/sidebar-add-menu.tsx', import.meta.url).pathname], bundle: true, format: 'esm', platform: 'node', jsx: 'transform', jsxFactory: 'React.createElement', write: false });
const { SidebarAddMenu } = await import(`data:text/javascript;base64,${Buffer.from(result.outputFiles[0].text).toString('base64')}`);

test('upward add menu focuses its first item, wraps keyboard focus, restores Escape focus and dismisses outside clicks', () => {
  let closed = 0, agents = 0, teams = 0; const trigger = { focus() { document.activeElement = trigger; } }, inside = new Node();
  const items = [0, 1].map(() => ({ focus() { document.activeElement = this; } }));
  const anchor = { current: { contains: target => target === inside, querySelector: () => trigger } };
  const tree = SidebarAddMenu({ anchor, onClose: () => closed++, onAgent: () => agents++, onTeam: () => teams++ });
  tree.props.ref.current = { querySelector: () => items[0], querySelectorAll: () => items }; const cleanup = effects.pop()();
  assert.equal(tree.props.role, 'menu'); assert.equal(document.activeElement, items[0]);
  const key = key => tree.props.onKeyDown({ key, preventDefault() {}, stopPropagation() {} });
  key('ArrowUp'); assert.equal(document.activeElement, items[1]); key('ArrowDown'); assert.equal(document.activeElement, items[0]); key('End'); assert.equal(document.activeElement, items[1]); key('Home'); assert.equal(document.activeElement, items[0]);
  listeners.get('pointerdown')({ target: inside }); assert.equal(closed, 0); listeners.get('pointerdown')({ target: new Node() }); assert.equal(closed, 1);
  key('Escape'); assert.equal(closed, 2); assert.equal(document.activeElement, trigger);
  const buttons = React.Children.toArray(tree.props.children); assert.ok(buttons.every(button => button.props.role === 'menuitem')); buttons[0].props.onPress(); buttons[1].props.onPress(); assert.equal(agents, 1); assert.equal(teams, 1); cleanup(); assert.equal(listeners.size, 0);
});

test('footer actions use equal columns and the menu opens upward independently of list scrolling', async () => {
  const css = await readFile(new URL('../frontend/venditbot/style.css', import.meta.url), 'utf8');
  assert.match(css, /\.sidebar-footer-actions\s*\{[^}]*grid-template-columns:\s*repeat\(2,\s*minmax\(0,\s*1fr\)\)/);
  assert.match(css, /\.sidebar-add-menu\s*\{[^}]*bottom:\s*calc\(100% \+ 10px\)/);
  assert.match(css, /\.sidebar-footer\s*\{\s*flex-shrink:\s*0/);
});
