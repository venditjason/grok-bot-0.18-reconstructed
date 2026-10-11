/** @jsxRuntime classic */
/** @jsx React.createElement */
import type * as ReactTypes from 'react';
const React: typeof ReactTypes = window.React;
export const sidebarWidthKey = 'venditbot.layout.sidebar-width.v1';
export const sidebarMinimum = 240, sidebarDefault = 280, sidebarMaximum = 960;
const mainMinimum = 480, separatorWidth = 6;
export function sidebarLimit(viewport: number): number {
  return Math.max(sidebarMinimum, Math.min(sidebarMaximum, Math.floor(viewport) - mainMinimum - separatorWidth));
}
export function clampSidebarWidth(width: number, viewport: number): number {
  return Math.max(sidebarMinimum, Math.min(sidebarLimit(viewport), Math.round(Number.isFinite(width) ? width : sidebarDefault)));
}
export function readSidebarWidth(storage?: Pick<Storage, 'getItem'>): number {
  try { const raw = storage?.getItem(sidebarWidthKey); if (raw && /^\d{3}$/.test(raw)) return clampSidebarWidth(Number(raw), 2000); } catch {}
  return sidebarDefault;
}
export function useSidebarWidth() {
  const [preferred, setPreferred] = React.useState(() => { try { return readSidebarWidth(window.localStorage); } catch { return sidebarDefault; } });
  const [viewport, setViewport] = React.useState(() => window.innerWidth || 1220);
  const [error, setError] = React.useState('');
  React.useEffect(() => { const resize = () => setViewport(window.innerWidth || 1220); window.addEventListener?.('resize', resize); return () => window.removeEventListener?.('resize', resize); }, []);
  const width = clampSidebarWidth(preferred, viewport), maximum = sidebarLimit(viewport);
  const change = (next: number) => {
    const value = clampSidebarWidth(next, window.innerWidth || viewport); setPreferred(value);
    try { window.localStorage.setItem(sidebarWidthKey, String(value)); setError(''); }
    catch { setError('사이드바 폭을 보관하지 못했습니다. 현재 화면에는 적용했습니다.'); }
  };
  return { width, maximum, error, change };
}
export function SidebarResizeHandle({ width, maximum, onChange }: { width: number; maximum: number; onChange(width: number): void }) {
  const latest = React.useRef({ maximum, onChange }); latest.current = { maximum, onChange };
  const drag = React.useRef<{ pointerId: number; x: number; width: number; lastWidth: number; element: HTMLDivElement; cleanup(): void } | undefined>(undefined);
  const finish = () => {
    const start = drag.current; if (!start) return;
    drag.current = undefined; start.cleanup();
    try { if (start.element.hasPointerCapture?.(start.pointerId)) start.element.releasePointerCapture(start.pointerId); } catch {}
  };
  type ResizePointer = Pick<PointerEvent, 'pointerId' | 'clientX' | 'button' | 'buttons' | 'pointerType' | 'preventDefault'>;
  const apply = (event: ResizePointer) => {
    const start = drag.current; if (!start || start.pointerId !== event.pointerId || !Number.isFinite(event.clientX)) return;
    event.preventDefault();
    const next = Math.max(sidebarMinimum, Math.min(latest.current.maximum, start.width + event.clientX - start.x));
    // Native document capture and React's handle listener can see the same event.
    if (next !== start.lastWidth) { start.lastWidth = next; latest.current.onChange(next); }
  };
  const move = (event: ResizePointer) => {
    if (drag.current?.pointerId !== event.pointerId) return;
    // Native automation may report buttons=0 before the matching pointerup.
    // The active pointer ID and explicit end/cancel events own this drag.
    apply(event);
  };
  const end = (event: ResizePointer) => {
    if (drag.current?.pointerId !== event.pointerId || event.button !== 0) return;
    apply(event); finish();
  };
  const cancel = (event: Pick<PointerEvent, 'pointerId'>) => { if (drag.current?.pointerId === event.pointerId) finish(); };
  React.useEffect(() => () => finish(), []);
  return <div className="sidebar-resize text-glyph-gray-caption" role="separator" aria-label="사이드바 폭" aria-orientation="vertical" aria-controls="workspace-sidebar" aria-valuemin={sidebarMinimum} aria-valuemax={maximum} aria-valuenow={width} aria-valuetext={`${width}픽셀`} tabIndex={0} title="드래그하거나 좌우 방향키로 사이드바 폭 조절 · Home 최소 · End 최대" onKeyDown={event => {
    if (event.key === 'Escape' && drag.current) { event.preventDefault(); finish(); return; }
    let next: number | undefined; const step = event.shiftKey ? 40 : 10;
    if (event.key === 'ArrowLeft') next = width - step;
    if (event.key === 'ArrowRight') next = width + step;
    if (event.key === 'Home') next = sidebarMinimum;
    if (event.key === 'End') next = maximum;
    if (next !== undefined) { event.preventDefault(); finish(); onChange(Math.max(sidebarMinimum, Math.min(maximum, next))); }
  }} onPointerDown={event => {
    if (event.button !== 0 || event.isPrimary === false || drag.current) return;
    event.preventDefault(); const element = event.currentTarget; element.focus();
    const document = element.ownerDocument, ownerWindow = document?.defaultView;
    const escape = (keyEvent: KeyboardEvent) => { if (keyEvent.key === 'Escape') { keyEvent.preventDefault(); finish(); } };
    const cleanup = () => {
      document?.removeEventListener('pointermove', move, true); document?.removeEventListener('pointerup', end, true);
      document?.removeEventListener('pointercancel', cancel, true); document?.removeEventListener('keydown', escape, true);
      ownerWindow?.removeEventListener('blur', finish);
    };
    drag.current = { pointerId: event.pointerId, x: event.clientX, width, lastWidth: width, element, cleanup };
    // Electron can deliver the last move/up outside the handle despite capture.
    // Keep these listeners only for this drag and always use the latest props.
    document?.addEventListener('pointermove', move, { capture: true, passive: false }); document?.addEventListener('pointerup', end, { capture: true, passive: false });
    document?.addEventListener('pointercancel', cancel, true); document?.addEventListener('keydown', escape, true);
    ownerWindow?.addEventListener('blur', finish);
    try { element.setPointerCapture?.(event.pointerId); } catch {}
  }} onPointerMove={move} onPointerUp={end} onPointerCancel={cancel} />;
}
