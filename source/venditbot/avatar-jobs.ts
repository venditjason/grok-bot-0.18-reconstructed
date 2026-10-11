import {randomUUID} from 'node:crypto';
import type {AvatarRequestRecord, ChatSession} from './local-store.js';

const active = (job: AvatarRequestRecord) => ['validating', 'queued', 'running'].includes(job.phase);
const uuid = /^[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/;
/** Owner-scoped status; provider execution is still owned by the serial TaskQueue. */
export class AvatarJobs {
  private jobs = new Map<string, AvatarRequestRecord>();
  private controllers = new Map<string, AbortController>();
  constructor(sessions: ChatSession[], private readonly changed: (job: AvatarRequestRecord) => void) {
    for (const session of [...sessions].reverse()) if (session.avatarRequest) {const job = structuredClone(session.avatarRequest); if (active(job)) {job.phase = 'cancelled'; job.error = '앱 종료로 중단된 이미지 요청입니다. 자동 재실행하지 않습니다.';} this.jobs.set(job.requestId, job);}
  }
  list(): AvatarRequestRecord[] {const latest = new Map<string, AvatarRequestRecord>(); for (const job of this.jobs.values()) latest.set(job.ownerKey, job); return structuredClone([...latest.values()]);}
  active(): AvatarRequestRecord[] {return structuredClone([...this.jobs.values()].filter(active));}
  get(id: string): AvatarRequestRecord {const job = this.jobs.get(id); if (!job) throw new Error('이미지 요청을 찾을 수 없습니다.'); return structuredClone(job);}
  /** A saved clone survives even when its optional image request cannot enter the queue. */
  recordFailure(requestId: string, ownerKey: string, error: string): AvatarRequestRecord {
    if (!uuid.test(requestId) || !/^(agent|draft):/.test(ownerKey) || !uuid.test(ownerKey.slice(ownerKey.indexOf(':') + 1))) throw new Error('이미지 요청과 대상 ID를 확인하세요.');
    const existing = this.jobs.get(requestId);
    if (existing) {if (existing.ownerKey !== ownerKey) throw new Error('이미지 요청과 대상 ID가 일치하지 않습니다.'); return structuredClone(existing);}
    if (this.active().some(job => job.ownerKey === ownerKey)) throw new Error('이 에이전트의 이미지 요청이 이미 진행 중입니다.');
    for (const [oldId, job] of this.jobs) if (!active(job) && job.ownerKey === ownerKey) this.jobs.delete(oldId);
    if (this.jobs.size >= 1000) {const oldest = [...this.jobs.entries()].find(([, job]) => !active(job)); if (oldest) this.jobs.delete(oldest[0]);}
    const job: AvatarRequestRecord = {requestId, ownerKey, phase: 'failed', error};
    this.jobs.set(requestId, job); this.changed(structuredClone(job)); return structuredClone(job);
  }
  begin(requestId?: unknown, ownerKey?: unknown): {job: AvatarRequestRecord; signal: AbortSignal} {
    if (this.active().length >= 17) throw new Error('이미지 요청은 실행 1개와 대기 16개까지입니다. 기존 요청을 마치거나 취소하세요.');
    const id = requestId ?? randomUUID(), owner = ownerKey ?? `draft:${id}`;
    if (typeof id !== 'string' || !uuid.test(id) || typeof owner !== 'string' || !/^(agent|draft):/.test(owner) || !uuid.test(owner.slice(owner.indexOf(':') + 1))) throw new Error('이미지 요청과 대상 ID를 확인하세요.');
    if (this.jobs.has(id)) throw new Error('이미 사용한 이미지 요청 ID입니다. 새 요청을 시작하세요.');
    if (this.active().some(job => job.ownerKey === owner)) throw new Error('이 에이전트의 이미지 요청이 이미 진행 중입니다. 먼저 해당 요청을 취소하세요.');
    for (const [oldId, job] of this.jobs) if (!active(job) && job.ownerKey === owner) this.jobs.delete(oldId);
    if (this.jobs.size >= 1000) {const oldest = [...this.jobs.entries()].find(([, job]) => !active(job)); if (oldest) this.jobs.delete(oldest[0]);}
    const controller = new AbortController(), job: AvatarRequestRecord = {requestId: id, ownerKey: owner, phase: 'validating'};
    this.jobs.set(id, job); this.controllers.set(id, controller); this.changed(structuredClone(job)); return {job: structuredClone(job), signal: controller.signal};
  }
  update(id: string, value: Partial<Omit<AvatarRequestRecord, 'requestId' | 'ownerKey'>>): AvatarRequestRecord {
    const job = this.jobs.get(id); if (!job) throw new Error('이미지 요청을 찾을 수 없습니다.');
    if (!active(job) && value.phase !== undefined && value.phase !== job.phase) return structuredClone(job);
    Object.assign(job, value); if (!active(job)) this.controllers.delete(id);
    const result = structuredClone(job); this.changed(result); return result;
  }
  cancel(id?: string): AvatarRequestRecord | undefined {
    if (id === undefined) {const pending = this.active(); if (pending.length > 1) throw new Error('취소할 이미지 요청을 선택하세요.'); id = pending[0]?.requestId;}
    if (!id) return; const job = this.jobs.get(id); if (!job || !active(job)) return;
    this.controllers.get(id)?.abort(); return this.update(id, {phase: 'cancelled', error: '이미지 생성을 중단했습니다.'});
  }
}
