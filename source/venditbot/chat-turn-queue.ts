import type {ActiveProviderTurn, ProviderSteerResult as SteerResult} from '../shared/provider-turns.js';
import {existsSync, lstatSync, readFileSync} from 'node:fs';
import {join} from 'node:path';
import {atomicWriteJson, safeError} from './local-store.js';
import {validChatTurn, type ChatTurn} from '../shared/chat-turns.js';

type Port = {
  canRun?(): boolean;
  state(): {running: string[]; queued: string[]};
  start(turn: ChatTurn, hooks: {started(): void; settled(status: string, error?: unknown): void}): void;
  cancel(sessionId: string): boolean;
  changed(turns: ChatTurn[], storageError?: string): void;
  active?(sessionId: string): (ActiveProviderTurn & {answerId: string}) | null;
  steer?(turn: ChatTurn): Promise<SteerResult>;
  accepted?(turn: ChatTurn): void;
  write?(path: string, data: unknown): void;
};

/** Persist before accepting input. The provider scheduler retains its slot until settlement. */
export class ChatTurnQueue {
  private readonly file: string;
  private turns: ChatTurn[] = [];
  private readonly reserved = new Map<string, string>();
  private scheduling = false;
  private storageError: string | undefined;
  constructor(root: string, private readonly port: Port) {
    this.file = join(root, 'chat-turns.json');
    if (!existsSync(this.file)) return;
    const stat = lstatSync(this.file);
    if (!stat.isFile() || stat.isSymbolicLink() || stat.nlink !== 1 || stat.size > 64 * 1024 * 1024) throw new Error('안전하지 않은 메시지 대기열 파일입니다. 원본은 보존했습니다.');
    const data = JSON.parse(readFileSync(this.file, 'utf8'));
    if (data.version !== 1 || !Array.isArray(data.turns) || data.turns.length > 10000 || !data.turns.every(validChatTurn) || new Set(data.turns.map((turn: ChatTurn) => turn.id)).size !== data.turns.length) throw new Error('메시지 대기열을 읽을 수 없습니다. 원본은 보존했습니다.');
    this.turns = data.turns.map((turn: ChatTurn) => turn.delivery?.phase === 'intent' ? {...turn, status: 'paused', delivery: {...turn.delivery, phase: 'unknown'}, error: '추가 입력의 접수 여부를 확인할 수 없습니다. 자동 재전송하지 않습니다.'} : turn);
    if (data.turns.some((turn: ChatTurn) => turn.delivery?.phase === 'intent' || turn.status === 'running' || turn.status === 'queued')) this.commit(this.turns.map(turn => turn.status === 'running' || turn.status === 'queued' ? {...turn, status: turn.status === 'running' ? 'failed' : 'paused', error: '앱 종료로 보류되었습니다. 확인 후 다시 시작하세요.'} : turn));
  }
  snapshot(): ChatTurn[] { return structuredClone(this.turns); }
  error(): string | undefined { return this.storageError; }
  submit(input: Pick<ChatTurn, 'id' | 'sessionId' | 'text' | 'attachments'>): ChatTurn {
    const existing = this.turns.find(turn => turn.id === input.id);
    if (existing) {
      if (existing.sessionId !== input.sessionId || existing.text !== input.text || JSON.stringify(existing.attachments) !== JSON.stringify(input.attachments)) throw new Error('같은 메시지 요청의 내용이 변경되었습니다.');
      this.flush(); this.schedule(); return structuredClone(existing);
    }
    if (this.turns.length >= 10000) throw new Error('메시지 보관 한도입니다. 이전 대화를 내보낸 뒤 삭제하세요.');
    const pending = this.pending();
    if (pending.length >= 100 || pending.filter(turn => turn.sessionId === input.sessionId).length >= 17) throw new Error('이 대화는 최대 16개 메시지를 기다릴 수 있습니다. 대기 메시지를 처리하거나 취소하세요.');
    const paused = pending.some(turn => turn.sessionId === input.sessionId && (turn.delivery?.phase === 'unknown' || turn.status === 'paused' || turn.status === 'failed' && !turn.continueAfter));
    const turn: ChatTurn = {...structuredClone(input), createdAt: new Date().toISOString(), status: paused ? 'paused' : 'queued'};
    if (!validChatTurn(turn)) throw new Error('메시지 형식을 확인하세요.');
    const active = !paused && !input.attachments.length && this.port.canRun?.() !== false && !pending.some(item => item.sessionId === input.sessionId && ['queued','paused'].includes(item.status)) ? this.port.active?.(input.sessionId) : null;
    if (active?.capability === 'steer' && active.clientConversationId === input.sessionId && this.port.steer) {
      turn.delivery = {mode: 'steer', phase: 'intent', attemptId: active.attemptId, threadId: active.threadId, turnId: active.turnId, answerId: active.answerId}; turn.status = 'running';
      if (!validChatTurn(turn)) throw new Error('현재 공급자 응답 식별자를 확인할 수 없습니다. 추가 입력을 전송하지 않았습니다.');
      this.commit([...this.turns, turn]); void this.deliver(turn.id);
    } else {this.commit([...this.turns, turn]); this.schedule();} return this.snapshot().find(item => item.id === turn.id)!;
  }
  retry(id: string): void {
    const turn = this.get(id);
    if (turn.delivery) throw new Error('진행 중 응답에 보낸 입력은 자동 또는 동일 요청으로 다시 실행할 수 없습니다.');
    if (!['failed', 'cancelled'].includes(turn.status)) throw new Error('다시 시도할 수 없는 메시지입니다.');
    if (this.reserved.has(turn.sessionId)) throw new Error('현재 응답이 끝난 뒤 다시 시도하세요.');
    const pending = this.pending().filter(item => item.id !== id);
    if (pending.length >= 100 || pending.filter(item => item.sessionId === turn.sessionId).length >= 17) throw new Error('대기열 한도에 도달했습니다. 기존 메시지를 처리하거나 취소하세요.');
    // Retry in the original position; later failed turns still require their own explicit retry.
    let blocked = false;
    this.commit(this.turns.map(item => {
      if (item.sessionId !== turn.sessionId) return item;
      const next: ChatTurn = item.id === id ? {...item, status: 'queued', error: undefined, continueAfter: false} : item;
      if (next.delivery?.phase === 'unknown' || next.status === 'failed' && !next.continueAfter) blocked = true;
      return next.status === 'paused' && !blocked ? {...next, status: 'queued', error: undefined} : next;
    }));
    this.schedule();
  }
  resume(sessionId: string): void {
    if (this.turns.some(turn => turn.sessionId === sessionId && turn.delivery?.phase === 'unknown')) throw new Error('접수 미확인 입력이 있습니다. 자동으로 다음 요청을 시작하지 않습니다.');
    this.commit(this.turns.map(turn => turn.sessionId !== sessionId ? turn : turn.status === 'paused' ? {...turn, status: 'queued', error: undefined} : turn.status === 'failed' ? {...turn, continueAfter: true} : turn));
    this.schedule();
  }
  cancel(id: string): void {
    const turn = this.get(id);
    if (turn.delivery) {if (turn.delivery.phase === 'unknown') throw new Error('접수 미확인 입력은 취소되었다고 확정할 수 없습니다.'); if (turn.status !== 'running') return; const active = this.port.active?.(turn.sessionId); if (!active || active.attemptId !== turn.delivery.attemptId || active.turnId !== turn.delivery.turnId) throw new Error('원래 응답이 이미 끝났습니다. 다른 응답은 중단하지 않습니다.'); this.port.cancel(turn.sessionId); return;}
    if (turn.status === 'completed' || turn.status === 'cancelled') return;
    if (this.reserved.get(turn.sessionId) === id) {this.port.cancel(turn.sessionId); return;}
    this.commit(this.turns.map(item => item.id === id ? {...item, status: 'cancelled', error: '대기 메시지를 취소했습니다.'} : item));
    this.schedule();
  }
  removeSession(sessionId: string): void {
    if (this.reserved.has(sessionId)) throw new Error('진행 중인 대화의 메시지는 삭제할 수 없습니다.');
    this.commit(this.turns.filter(turn => turn.sessionId !== sessionId));
  }
  schedule(): void {
    if (this.scheduling || this.storageError || this.port.canRun?.() === false) return;
    this.scheduling = true;
    try {
      const seen = new Set<string>();
      for (const turn of this.turns) {
        if (seen.has(turn.sessionId)) continue;
        if (turn.delivery?.phase === 'unknown' || turn.status === 'failed' && !turn.continueAfter) {seen.add(turn.sessionId); continue;}
        if (!['queued', 'paused'].includes(turn.status)) continue;
        seen.add(turn.sessionId);
        const state = this.port.state();
        if (turn.status !== 'queued' || this.reserved.has(turn.sessionId) || state.running.includes(turn.sessionId) || state.queued.includes(turn.sessionId) || state.queued.length >= 16) continue;
        this.reserved.set(turn.sessionId, turn.id);
        try {
          this.port.start(structuredClone(turn), {
            started: () => this.commit(this.turns.map(item => item.id === turn.id ? {...item, status: 'running'} : item)),
            settled: (status, error) => this.settle(turn.id, status, error),
          });
        } catch (error) {this.settle(turn.id, 'failed', error);}
      }
    } finally {this.scheduling = false;}
  }
  hasSteerEffect(sessionId: string, attemptId: string): boolean { return this.turns.some(turn => turn.sessionId === sessionId && turn.delivery?.attemptId === attemptId); }
  settleSteers(sessionId: string, answerId: string, status: string, error?: unknown): void {
    const changed = this.turns.some(turn => turn.sessionId === sessionId && turn.delivery?.answerId === answerId && turn.status === 'running');
    if (!changed) return;
    this.commit(this.turns.map(turn => {
      if (turn.sessionId !== sessionId || turn.delivery?.answerId !== answerId || turn.status !== 'running') return turn;
      if (turn.delivery.phase === 'intent') return {...turn, status: 'paused', delivery: {...turn.delivery, phase: 'unknown'}, error: '응답이 끝나 추가 입력 접수를 확인할 수 없습니다. 자동 재전송하지 않습니다.'};
      return {...turn, status: status === 'completed' ? 'completed' : status === 'cancelled' ? 'cancelled' : 'failed', error: status === 'completed' ? undefined : safeError(error ?? '추가 입력을 받은 응답이 완료되지 않았습니다.')};
    }));
  }
  private async deliver(id: string): Promise<void> {
    const original = structuredClone(this.get(id));
    let result: SteerResult | undefined;
    try { result = await this.port.steer!(original); } catch { /* Once invoked, an unclassified outcome never becomes FIFO. */ }
    const current = this.turns.find(turn => turn.id === id);
    if (!current) return; // Explicit conversation deletion wins over a late provider reply.
    const binding = current.delivery;
    if (!binding || binding.phase !== 'intent') return; // Terminal settlement/restart wins over a late acknowledgement.
    const matched = result && result.clientConversationId === current.sessionId && result.clientMessageId === id && result.attemptId === binding.attemptId && result.turnId === binding.turnId;
    try {
      if (matched && result && (result.state === 'unsupported-before-wire' || result.state === 'not-active-before-wire')) {
        this.commit(this.turns.map(turn => turn.id === id ? {...turn, delivery: undefined, status: 'queued', error: undefined} : turn)); this.schedule(); return;
      }
      if (matched && result && result.state === 'accepted') {
        const accepted: ChatTurn = {...current, delivery: {...binding, phase: 'accepted'}};
        this.commit(this.turns.map(turn => turn.id === id ? accepted : turn));
        this.port.accepted?.(structuredClone(accepted)); return;
      }
      this.commit(this.turns.map(turn => turn.id === id ? {...turn, status: 'paused', delivery: {...binding, phase: 'unknown'}, error: '추가 입력의 접수 여부를 확인할 수 없습니다. 원본을 보관하며 자동 재전송하지 않습니다.'} : turn));
    } catch (error) {this.storageError = safeError(error); this.publish();}
  }
  private settle(id: string, status: string, error?: unknown): void {
    const turn = this.get(id);
    this.reserved.delete(turn.sessionId);
    const outcome = status === 'cancelled' ? 'cancelled' : error ? 'failed' : status === 'completed' ? 'completed' : 'failed';
    const next = this.turns.map(item => item.id === id ? {...item, status: outcome, continueAfter: false, error: outcome === 'completed' ? undefined : safeError(error ?? (outcome === 'cancelled' ? '응답을 중단했습니다.' : '응답에 실패했습니다. 다시 시도하거나 다음 메시지를 계속하세요.'))}
      : item.sessionId === turn.sessionId && item.status === 'queued' && outcome !== 'completed' ? {...item, status: 'paused'} : item) as ChatTurn[];
    // Keep settlement in memory if disk fails; block automatic execution until a durable flush.
    try {this.commit(next);} catch (error) {this.turns = next; this.storageError = safeError(error); this.publish();}
  }
  private pending(): ChatTurn[] {return this.turns.filter(turn => ['queued', 'running', 'paused'].includes(turn.status) || turn.status === 'failed' && !turn.continueAfter);}
  private get(id: string): ChatTurn {const turn = this.turns.find(item => item.id === id); if (!turn) throw new Error('메시지를 찾을 수 없습니다.'); return turn;}
  private flush(): void {this.commit(this.turns);}
  private commit(next: ChatTurn[]): void {(this.port.write ?? atomicWriteJson)(this.file, {version: 1, turns: next}); this.turns = next; this.storageError = undefined; this.publish();}
  private publish(): void {this.port.changed(this.snapshot(), this.storageError);}
}
