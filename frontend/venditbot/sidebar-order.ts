import type * as ReactTypes from 'react';
const React: typeof ReactTypes = window.React;
export const sidebarOrderKey = 'venditbot.layout.order.v1';
type Order = { agents: string[]; teams: string[] };
export function reconcileSidebarOrder(saved: string[], ids: string[]): string[] {
  const valid = new Set(ids); return [...new Set([...saved.filter(id => valid.has(id)), ...ids])];
}
export function reorderSidebarItem(ids: string[], id: string, target: string): string[] {
  if (id === target || !ids.includes(id) || !ids.includes(target)) return ids;
  const next = ids.filter(value => value !== id); next.splice(ids.indexOf(target), 0, id); return next;
}
export function useSidebarOrder(agents: string[], teams: string[]) {
  const [saved, setSaved] = React.useState<Order>(() => { try { const value = JSON.parse(window.localStorage.getItem(sidebarOrderKey) ?? '{}'); if (value && ['agents', 'teams'].every(key => Array.isArray(value[key]) && value[key].length <= 300 && value[key].every((id: unknown) => typeof id === 'string' && id.length <= 100))) return value; } catch {} return { agents: [], teams: [] }; });
  const [error, setError] = React.useState('');
  const order: Order = { agents: reconcileSidebarOrder(saved.agents, agents), teams: reconcileSidebarOrder(saved.teams, teams) };
  const ref = React.useRef(order); ref.current = order;
  const persisted = React.useRef(saved); persisted.current = saved;
  // Initial IPC may still be loading or may have failed. Reconcile for display,
  // but only an explicit move may replace that list's stored preference.
  const reorder = (kind: keyof Order, id: string, target: string) => {
    const ids = ref.current[kind];
    if (id === target || !ids.includes(id) || !ids.includes(target)) return;
    const moved = reorderSidebarItem(ids, id, target), next = { ...persisted.current, [kind]: moved };
    persisted.current = next; ref.current = { ...ref.current, [kind]: moved }; setSaved(next);
    try { window.localStorage.setItem(sidebarOrderKey, JSON.stringify(next)); setError(''); }
    catch { setError('목록 순서를 보관하지 못했습니다. 현재 화면에는 적용했습니다.'); }
  };
  return { ...order, error, reorder, move(kind: keyof Order, id: string, offset: number) { const ids = ref.current[kind], index = ids.indexOf(id), target = ids[index + offset]; if (index >= 0 && target) reorder(kind, id, target); } };
}
