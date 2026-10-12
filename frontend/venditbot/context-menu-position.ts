export type ContextMenuAnchor = { x: number; y: number; trigger?: HTMLElement };

/** Keyboard invocation anchors to its card; pointer invocation uses viewport coordinates. */
export function contextMenuAnchor(event: { currentTarget: EventTarget; clientX?: number; clientY?: number }): ContextMenuAnchor {
  const trigger = event.currentTarget as HTMLElement;
  if (Number.isFinite(event.clientX) && Number.isFinite(event.clientY) && (event.clientX !== 0 || event.clientY !== 0)) {
    return { x: event.clientX!, y: event.clientY!, trigger };
  }
  const rect = trigger.getBoundingClientRect();
  return { x: rect.left + Math.min(24, rect.width / 2), y: rect.bottom, trigger };
}

export function contextMenuPosition(anchor: Pick<ContextMenuAnchor, 'x' | 'y'>, size: { width: number; height: number }, viewport: { width: number; height: number }) {
  const margin = 8;
  const axis = (point: number, length: number, limit: number) => {
    const origin = Number.isFinite(point) ? point : margin;
    const desired = origin + length + margin > limit ? origin - length : origin;
    return Math.max(margin, Math.min(desired, limit - length - margin));
  };
  return { left: axis(anchor.x, size.width, viewport.width), top: axis(anchor.y, size.height, viewport.height) };
}
