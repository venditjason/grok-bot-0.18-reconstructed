export type SidebarItemKind = 'agent' | 'team';
export type SidebarDragOptions = {kind: SidebarItemKind; id: string; itemIds: readonly string[]; onReorder?(id: string, target: string): void; onMenu(id: string): void};
type Pointer = Pick<PointerEvent, 'pointerId' | 'clientX' | 'clientY' | 'button' | 'isPrimary' | 'preventDefault'>;
type Click = Pick<MouseEvent, 'detail' | 'preventDefault' | 'stopPropagation'> & {button?: number};
const cardSelector = '[data-sidebar-id][data-sidebar-kind]', listSelector = 'nav[data-sidebar-list]';
const activeLists = new WeakMap<Element, SidebarPointerDrag>();
export const sidebarDragThreshold = 6;
type Gesture = {pointerId: number; x: number; y: number; kind: SidebarItemKind; id: string; handle: HTMLElement; source: Element; list: Element; dragging: boolean; target?: Element};

/** Capture is best effort: a document listener also receives releases on other
 * elements. Hit testing always uses coordinates, never event.target. */
export class SidebarPointerDrag {
  private gesture?: Gesture;
  private suppressClick = false;
  constructor(private readonly options: () => SidebarDragOptions) {}
  private readonly blur = () => this.cancel();
  private readonly escape = (event: KeyboardEvent) => {if (event.key === 'Escape' && this.gesture) {event.preventDefault(); this.cancel();}};
  private readonly documentMove = (event: PointerEvent) => this.pointerMove(event);
  private readonly documentUp = (event: PointerEvent) => this.pointerUp(event);
  private readonly documentCancel = (event: PointerEvent) => this.pointerCancel(event);
  pointerDown(event: Pointer, handle: HTMLElement): void {
    if (this.gesture || event.button !== 0 || event.isPrimary === false) return;
    this.suppressClick = false;
    const options = this.options(), source = handle.closest(cardSelector), list = handle.closest(listSelector);
    if (!options.onReorder || !options.itemIds.includes(options.id) || !source || !list || activeLists.has(list) || !handle.isConnected || list.getAttribute('data-sidebar-list') !== options.kind || source.getAttribute('data-sidebar-kind') !== options.kind || source.getAttribute('data-sidebar-id') !== options.id || !Number.isFinite(event.clientX) || !Number.isFinite(event.clientY)) return;
    try {handle.setPointerCapture(event.pointerId);} catch { /* Document listeners cover unavailable capture. */ }
    handle.focus({preventScroll: true});
    this.gesture = {pointerId: event.pointerId, x: event.clientX, y: event.clientY, kind: options.kind, id: options.id, handle, source, list, dragging: false};
    activeLists.set(list, this);
    // Native macOS delivery can leave capture unset without a lostcapture event.
    // Capture-phase listeners run before target handlers, which may stop bubbling.
    handle.ownerDocument.addEventListener('pointermove', this.documentMove, true);
    handle.ownerDocument.addEventListener('pointerup', this.documentUp, true);
    handle.ownerDocument.addEventListener('pointercancel', this.documentCancel, true);
    handle.ownerDocument.addEventListener('keydown', this.escape);
    handle.ownerDocument.defaultView?.addEventListener('blur', this.blur);
  }
  private sourceValid(gesture: Gesture): boolean {
    const options = this.options();
    return !!options.onReorder && options.kind === gesture.kind && options.id === gesture.id && options.itemIds.includes(gesture.id) && gesture.handle.isConnected && gesture.source.isConnected && gesture.list.isConnected && gesture.handle.closest(cardSelector) === gesture.source && gesture.source.closest(listSelector) === gesture.list && gesture.source.getAttribute('data-sidebar-id') === gesture.id && gesture.source.getAttribute('data-sidebar-kind') === gesture.kind && gesture.list.getAttribute('data-sidebar-list') === gesture.kind;
  }
  private hit(gesture: Gesture, x: number, y: number): Element | undefined {
    if (!this.sourceValid(gesture) || !Number.isFinite(x) || !Number.isFinite(y)) return;
    const target = gesture.handle.ownerDocument.elementFromPoint(x, y)?.closest(cardSelector), id = target?.getAttribute('data-sidebar-id');
    if (!target?.isConnected || target.closest(listSelector) !== gesture.list || target.getAttribute('data-sidebar-kind') !== gesture.kind || !id || id === gesture.id || !this.options().itemIds.includes(id)) return;
    return target;
  }
  private update(event: Pointer): void {
    const gesture = this.gesture!;
    if (!gesture.dragging && Math.hypot(event.clientX - gesture.x, event.clientY - gesture.y) >= sidebarDragThreshold) {
      gesture.dragging = true; this.suppressClick = true;
      gesture.source.setAttribute('data-sidebar-dragging', 'true'); gesture.list.setAttribute('data-sidebar-dragging', 'true');
    }
    if (!gesture.dragging) return;
    event.preventDefault();
    const target = this.hit(gesture, event.clientX, event.clientY);
    if (target !== gesture.target) {gesture.target?.removeAttribute('data-sidebar-drop-target'); target?.setAttribute('data-sidebar-drop-target', 'true'); gesture.target = target;}
  }
  pointerMove(event: Pointer): void {if (this.gesture?.pointerId === event.pointerId) this.update(event);}
  pointerUp(event: Pointer): void {
    const gesture = this.gesture; if (!gesture || gesture.pointerId !== event.pointerId) return;
    this.update(event);
    // Re-read on pointerup: the last move may be missing or its target may have
    // been deleted, reparented, or covered since it was highlighted.
    const target = gesture.dragging ? this.hit(gesture, event.clientX, event.clientY) : undefined;
    const targetId = target?.getAttribute('data-sidebar-id');
    this.finish();
    if (targetId) this.options().onReorder?.(gesture.id, targetId);
  }
  pointerCancel(event: Pick<PointerEvent, 'pointerId'>): void {if (this.gesture?.pointerId === event.pointerId) this.cancel();}
  lostPointerCapture(event: Pick<PointerEvent, 'pointerId'>): void {this.pointerCancel(event);}
  click(event: Click, activate?: () => void): void {
    if (event.button !== undefined && event.button !== 0) {event.preventDefault(); event.stopPropagation(); return;}
    const suppressed = this.suppressClick && event.detail !== 0; this.suppressClick = false;
    if (suppressed) {event.preventDefault(); event.stopPropagation(); return;}
    const options = this.options(); if (activate) activate(); else options.onMenu(options.id);
  }
  private finish(): void {
    const gesture = this.gesture; this.gesture = undefined; if (!gesture) return;
    if (activeLists.get(gesture.list) === this) activeLists.delete(gesture.list);
    gesture.source.removeAttribute('data-sidebar-dragging'); gesture.list.removeAttribute('data-sidebar-dragging'); gesture.target?.removeAttribute('data-sidebar-drop-target');
    gesture.handle.ownerDocument.removeEventListener('pointermove', this.documentMove, true);
    gesture.handle.ownerDocument.removeEventListener('pointerup', this.documentUp, true);
    gesture.handle.ownerDocument.removeEventListener('pointercancel', this.documentCancel, true);
    gesture.handle.ownerDocument.removeEventListener('keydown', this.escape); gesture.handle.ownerDocument.defaultView?.removeEventListener('blur', this.blur);
    try {if (gesture.handle.hasPointerCapture(gesture.pointerId)) gesture.handle.releasePointerCapture(gesture.pointerId);} catch { /* A detached handle may already have lost capture. */ }
  }
  cancel(): void {if (this.gesture?.dragging) this.suppressClick = true; this.finish();}
  destroy(): void {this.finish(); this.suppressClick = false;}
}
