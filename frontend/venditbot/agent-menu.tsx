/** @jsxRuntime classic */
/** @jsx React.createElement */
/** @jsxFrag React.Fragment */
import type * as ReactTypes from 'react';
import { contextMenuPosition, type ContextMenuAnchor } from './context-menu-position';

const React: typeof ReactTypes = window.React;
type Props = { agent?: { id?: string; name: string }; anchor?: ContextMenuAnchor; kind?: '에이전트' | '팀'; busy?: boolean; canMoveUp?: boolean; canMoveDown?: boolean; onClose(): void; onClone(): void; onOpen?(): void; onEdit?(): void; onDelete?(): void; onMove?(offset: number): void };

export function AgentMenu(props: Props) {
  return props.agent ? <ProfileContextMenu key={props.agent.id ?? props.agent.name} {...props} /> : null;
}

function ProfileContextMenu({ agent, anchor, kind = '에이전트', busy, canMoveUp = false, canMoveDown = false, onClose, onClone, onOpen, onEdit, onDelete, onMove }: Props) {
  const menu = React.useRef<HTMLDivElement>(null);
  const close = React.useRef(onClose); close.current = onClose;
  const trigger = React.useRef<HTMLElement | undefined>(undefined);
  const [position, setPosition] = React.useState({ left: anchor?.x ?? 8, top: anchor?.y ?? 8 });
  React.useLayoutEffect(() => {
    const node = menu.current; if (!node) return;
    trigger.current = anchor?.trigger ?? (document.activeElement instanceof HTMLElement ? document.activeElement : undefined);
    const rect = node.getBoundingClientRect();
    setPosition(contextMenuPosition(anchor ?? { x: 8, y: 8 }, rect, { width: window.innerWidth, height: window.innerHeight }));
    node.querySelector<HTMLButtonElement>('[role="menuitem"]:not(:disabled)')?.focus({ preventScroll: true });
  }, [anchor]);
  React.useEffect(() => {
    const outside = (event: PointerEvent) => { if (!menu.current?.contains(event.target as Node)) close.current(); };
    const dismiss = () => close.current();
    const scroll = (event: Event) => { if (!menu.current?.contains(event.target as Node)) dismiss(); };
    document.addEventListener('pointerdown', outside, true);
    document.addEventListener('scroll', scroll, true);
    window.addEventListener('resize', dismiss); window.addEventListener('blur', dismiss);
    return () => {
      document.removeEventListener('pointerdown', outside, true);
      document.removeEventListener('scroll', scroll, true);
      window.removeEventListener('resize', dismiss); window.removeEventListener('blur', dismiss);
    };
  }, []);
  const restore = () => { if (trigger.current?.isConnected) trigger.current.focus({ preventScroll: true }); };
  const activate = (callback: () => void) => { restore(); onClose(); callback(); };
  const keyDown = (event: ReactTypes.KeyboardEvent<HTMLDivElement>) => {
    if (event.key === 'Escape') { event.preventDefault(); event.stopPropagation(); restore(); onClose(); return; }
    if (event.key === 'Tab') { restore(); onClose(); return; }
    const items = Array.from(menu.current?.querySelectorAll<HTMLButtonElement>('[role="menuitem"]:not(:disabled)') ?? []);
    if (!items.length || !['ArrowDown', 'ArrowUp', 'Home', 'End'].includes(event.key)) return;
    event.preventDefault(); event.stopPropagation();
    const current = items.indexOf(document.activeElement as HTMLButtonElement);
    const next = event.key === 'Home' ? 0 : event.key === 'End' ? items.length - 1 : (current + (event.key === 'ArrowDown' ? 1 : -1) + items.length) % items.length;
    items[next].focus({ preventScroll: true });
  };
  return <div ref={menu} role="menu" aria-label={`${agent?.name ?? kind} 메뉴`} className="profile-context-menu typo-b3/m text-glyph-gray-body" style={position} onKeyDown={keyDown} onContextMenu={event => event.preventDefault()}>
    <div className="profile-context-menu-title typo-l1/m text-glyph-gray-caption" title={agent?.name}>{agent?.name}</div>
    {onOpen && <button type="button" role="menuitem" onClick={() => activate(onOpen)}>대화 열기</button>}
    {onEdit && <button type="button" role="menuitem" onClick={() => activate(onEdit)}>{kind} 수정</button>}
    <button type="button" role="menuitem" disabled={busy} onClick={() => activate(onClone)}>{kind} 복제</button>
    {onMove && <><div role="separator" /><button type="button" role="menuitem" disabled={!canMoveUp} onClick={() => activate(() => onMove(-1))}>목록에서 앞으로</button><button type="button" role="menuitem" disabled={!canMoveDown} onClick={() => activate(() => onMove(1))}>목록에서 뒤로</button></>}
    {onDelete && <><div role="separator" /><button type="button" role="menuitem" className="text-glyph-danger-body" disabled={busy} onClick={() => activate(onDelete)}>{kind} 삭제</button></>}
  </div>;
}
