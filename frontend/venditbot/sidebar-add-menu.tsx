/** @jsxRuntime classic */
/** @jsx React.createElement */
import type * as ReactTypes from 'react';
const React: typeof ReactTypes = window.React;
const { Button } = window.VDS;
export function SidebarAddMenu({ anchor, onClose, onAgent, onTeam }: { anchor: ReactTypes.RefObject<HTMLDivElement | null>; onClose(): void; onAgent(): void; onTeam(): void }) {
  const menu = React.useRef<HTMLDivElement>(null);
  const close = (restoreFocus = false) => { onClose(); if (restoreFocus) anchor.current?.querySelector<HTMLElement>('[data-add-trigger]')?.focus(); };
  React.useEffect(() => {
    menu.current?.querySelector<HTMLElement>('[role="menuitem"]')?.focus();
    const outside = (event: PointerEvent) => { if (event.target instanceof Node && !anchor.current?.contains(event.target)) close(); };
    document.addEventListener?.('pointerdown', outside); return () => document.removeEventListener?.('pointerdown', outside);
  }, []);
  return <div id="sidebar-add-menu" className="sidebar-add-menu bg-background-base-elevate border border-solid border-line-outline-stroke rounded-xl" role="menu" aria-label="추가할 항목" ref={menu} onKeyDown={event => {
    if (event.key === 'Escape') { event.preventDefault(); event.stopPropagation(); close(true); return; }
    const items = [...(menu.current?.querySelectorAll<HTMLElement>('[role="menuitem"]') ?? [])];
    const current = items.indexOf(document.activeElement as HTMLElement);
    const next = event.key === 'Home' ? 0 : event.key === 'End' ? items.length - 1 : event.key === 'ArrowDown' ? (current + 1) % items.length : event.key === 'ArrowUp' ? (current + items.length - 1) % items.length : undefined;
    if (next !== undefined) { event.preventDefault(); items[next]?.focus(); }
  }}><Button role="menuitem" kind="common" hierarchy="ghost" size="medium" onPress={() => { onClose(); onAgent(); }}>에이전트 추가</Button><Button role="menuitem" kind="common" hierarchy="ghost" size="medium" onPress={() => { onClose(); onTeam(); }}>팀 추가</Button></div>;
}
