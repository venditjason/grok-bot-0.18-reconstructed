import type * as ReactTypes from 'react';
const React: typeof ReactTypes = window.React;
type Anchor = {id: string; offset: number};
type Snapshot = {follow: boolean; top: number; height: number; viewport: number; anchors: Anchor[]};
/** Capture before React changes the DOM; resize callbacks also retain the last reading position. */
export class ChatScroll extends React.Component<{sessionKey: string; children: ReactTypes.ReactNode}, Record<string, never>, Snapshot | null> {
  private node: HTMLDivElement | null = null;
  private saved: Snapshot | null = null;
  private observer?: ResizeObserver;
  private read(): Snapshot | null {
    const node = this.node; if (!node) return null;
    const top = node.getBoundingClientRect().top + node.clientTop;
    const anchors: Anchor[] = [];
    for (const item of node.querySelectorAll<HTMLElement>('[data-message-id]')) {
      const bounds = item.getBoundingClientRect();
      if (bounds.bottom > top && bounds.top < top + node.clientHeight && anchors.length < 4) anchors.push({id: item.dataset.messageId!, offset: bounds.top - top});
    }
    return {follow: node.scrollHeight - node.scrollTop - node.clientHeight <= 48, top: node.scrollTop, height: node.scrollHeight, viewport: node.clientHeight, anchors};
  }
  private restore(snapshot: Snapshot | null, reset = false): void {
    const node = this.node; if (!node) return;
    if (reset || snapshot?.follow) node.scrollTop = node.scrollHeight;
    else if (snapshot) {
      const top = node.getBoundingClientRect().top + node.clientTop;
      const items = [...node.querySelectorAll<HTMLElement>('[data-message-id]')];
      const match = snapshot.anchors.map(anchor => ({anchor, item: items.find(item => item.dataset.messageId === anchor.id)})).find(pair => pair.item);
      node.scrollTop = match?.item ? node.scrollTop + match.item.getBoundingClientRect().top - top - match.anchor.offset : snapshot.top;
    }
    this.saved = this.read();
  }
  private scrolled = (): void => {
    const node = this.node; if (!node) return;
    // Browser clamping during a layout change is not a request to abandon the saved anchor.
    if (this.saved && (this.saved.height !== node.scrollHeight || this.saved.viewport !== node.clientHeight)) return;
    this.saved = this.read();
  };
  componentDidMount(): void {
    this.restore(null, true);
    if (typeof ResizeObserver === 'function' && this.node) {
      this.observer = new ResizeObserver(() => this.restore(this.saved));
      this.observer.observe(this.node);
      if (this.node.firstElementChild) this.observer.observe(this.node.firstElementChild);
    }
  }
  getSnapshotBeforeUpdate(previous: Readonly<{sessionKey: string; children: ReactTypes.ReactNode}>): Snapshot | null {
    return previous.sessionKey === this.props.sessionKey ? this.read() : null;
  }
  componentDidUpdate(previous: Readonly<{sessionKey: string; children: ReactTypes.ReactNode}>, _state: Readonly<Record<string, never>>, snapshot: Snapshot | null): void {
    this.restore(snapshot, previous.sessionKey !== this.props.sessionKey);
  }
  componentWillUnmount(): void { this.observer?.disconnect(); }
  render() { return <div className="view-body chat-scroll" ref={node => {this.node = node;}} onScroll={this.scrolled}>{this.props.children}</div>; }
}
