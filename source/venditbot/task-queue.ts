export type TaskQueueState = { running: string[]; queued: string[] };
export type TaskQueueJob = (signal: AbortSignal) => Promise<unknown> | unknown;
export interface TaskQueueOptions {
  /** Waiting jobs, excluding the one active job. Never exceeds the product cap. */
  maxQueued?: number;
  onChange?: (state: TaskQueueState) => void;
  onError?: (id: string, error: unknown) => void;
}
type Entry = { id: string; job: TaskQueueJob; controller: AbortController };

/** Serial provider queue. Cancellation never releases a slot before its job settles. */
export class TaskQueue {
  private readonly maxQueued: number;
  private waiting: Entry[] = [];
  private active: Entry | undefined;
  private closed = false;
  private closePromise: Promise<boolean> | undefined;
  private idleListeners = new Set<() => void>();

  constructor(private readonly options: TaskQueueOptions = {}) {
    this.maxQueued = options.maxQueued ?? 16;
    if (!Number.isInteger(this.maxQueued) || this.maxQueued < 1 || this.maxQueued > 16) throw new Error('Queue capacity must be between 1 and 16.');
  }

  state(): TaskQueueState { return {running: this.active ? [this.active.id] : [], queued: this.waiting.map(entry => entry.id)}; }

  submit(id: string, job: TaskQueueJob): 'running' | 'queued' {
    if (this.closed) throw new Error('작업 대기열이 종료되었습니다.');
    if (typeof id !== 'string' || !id || id.length > 200 || /[\0\r\n]/.test(id) || typeof job !== 'function') throw new Error('올바르지 않은 작업입니다.');
    if (this.active?.id === id || this.waiting.some(entry => entry.id === id)) throw new Error('이 대화의 작업이 이미 실행 중이거나 대기 중입니다.');
    if (this.active && this.waiting.length >= this.maxQueued) throw new Error(`대기 중인 작업은 최대 ${this.maxQueued}개입니다.`);
    const entry = {id, job, controller: new AbortController()};
    this.waiting.push(entry);
    const phase = this.active ? 'queued' : 'running';
    this.advance(); this.publish();
    return phase;
  }

  abort(id: string): boolean {
    if (this.active?.id === id) { this.active.controller.abort(); return true; }
    const index = this.waiting.findIndex(entry => entry.id === id);
    if (index < 0) return false;
    const [entry] = this.waiting.splice(index, 1); entry!.controller.abort();
    this.publish(); this.notifyIdle(); return true;
  }

  /** False means an already-running job ignored abort beyond the bounded wait. */
  close(timeoutMs = 4000): Promise<boolean> {
    if (!Number.isFinite(timeoutMs) || timeoutMs < 0 || timeoutMs > 60_000) throw new Error('Invalid queue close timeout.');
    if (!this.closed) {
      this.closed = true;
      for (const entry of this.waiting.splice(0)) entry.controller.abort();
      this.active?.controller.abort(); this.publish();
    }
    if (!this.active) return Promise.resolve(true);
    if (this.closePromise) return this.closePromise;
    this.closePromise = this.waitForIdle(timeoutMs);
    return this.closePromise;
  }

  /** Observe settlement without closing the queue, so a cancelled quit can resume. */
  waitForIdle(timeoutMs = 4000): Promise<boolean> {
    if (!Number.isFinite(timeoutMs) || timeoutMs < 0 || timeoutMs > 60_000) throw new Error('Invalid queue wait timeout.');
    if (!this.active && !this.waiting.length) return Promise.resolve(true);
    return new Promise(resolve => {
      const done = (drained: boolean) => { clearTimeout(timer); this.idleListeners.delete(idle); resolve(drained); };
      const idle = () => done(true);
      const timer = setTimeout(() => done(false), timeoutMs);
      this.idleListeners.add(idle);
    });
  }

  private advance(): void {
    if (this.active || this.closed) return;
    const entry = this.waiting.shift();
    if (!entry) { this.notifyIdle(); return; }
    this.active = entry;
    // Defer invocation so the caller observes the reservation before job effects.
    // Promise assimilation also captures a synchronous throw or thenable rejection.
    void Promise.resolve().then(() => {
      if (!entry.controller.signal.aborted) return entry.job(entry.controller.signal);
    }).catch(error => {
      this.safeCallback(() => this.options.onError?.(entry.id, error));
    }).finally(() => {
      if (this.active === entry) this.active = undefined;
      this.advance(); this.publish(); this.notifyIdle();
    });
  }

  private publish(): void { this.safeCallback(() => this.options.onChange?.(this.state())); }
  private safeCallback(callback: () => unknown): void {
    try { void Promise.resolve(callback()).catch(() => {}); } catch { /* Observers cannot stall or reject the queue. */ }
  }
  private notifyIdle(): void {
    if (this.active || this.waiting.length) return;
    for (const notify of [...this.idleListeners]) notify();
  }
}
