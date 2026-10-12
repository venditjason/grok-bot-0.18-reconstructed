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
    this.turns = data.turns;
    if (this.turns.some(turn => turn.status === 'running' || turn.status === 'queued')) this.commit(this.turns.map(turn => turn.status === 'running' || turn.status === 'queued' ? {...turn, status: turn.status === 'running' ? 'failed' : 'paused', error: '앱 종료로 보류되었습니다. 확인 후 다시 시작하세요.'} : turn));
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
    const paused = pending.some(turn => turn.sessionId === input.sessionId && (turn.status === 'paused' || turn.status === 'failed' && !turn.continueAfter));
    const turn: ChatTurn = {...structuredClone(input), createdAt: new Date().toISOString(), status: paused ? 'paused' : 'queued'};
    if (!validChatTurn(turn)) throw new Error('메시지 형식을 확인하세요.');
    this.commit([...this.turns, turn]); this.schedule(); return this.snapshot().find(item => item.id === turn.id)!;
  }
  retry(id: string): void {
    const turn = this.get(id);
    if (!['failed', 'cancelled'].includes(turn.status)) throw new Error('다시 시도할 수 없는 메시지입니다.');
    if (this.reserved.has(turn.sessionId)) throw new Error('현재 응답이 끝난 뒤 다시 시도하세요.');
    const pending = this.pending().filter(item => item.id !== id);
    if (pending.length >= 100 || pending.filter(item => item.sessionId === turn.sessionId).length >= 17) throw new Error('대기열 한도에 도달했습니다. 기존 메시지를 처리하거나 취소하세요.');
    // Retry in the original position; later failed turns still require their own explicit retry.
    let blocked = false;
    this.commit(this.turns.map(item => {
      if (item.sessionId !== turn.sessionId) return item;
      const next: ChatTurn = item.id === id ? {...item, status: 'queued', error: undefined, continueAfter: false} : item;
      if (next.status === 'failed' && !next.continueAfter) blocked = true;
      return next.status === 'paused' && !blocked ? {...next, status: 'queued', error: undefined} : next;
    }));
    this.schedule();
  }
  resume(sessionId: string): void {
    this.commit(this.turns.map(turn => turn.sessionId !== sessionId ? turn : turn.status === 'paused' ? {...turn, status: 'queued', error: undefined} : turn.status === 'failed' ? {...turn, continueAfter: true} : turn));
    this.schedule();
  }
  cancel(id: string): void {
    const turn = this.get(id);
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
        if (turn.status === 'failed' && !turn.continueAfter) {seen.add(turn.sessionId); continue;}
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
