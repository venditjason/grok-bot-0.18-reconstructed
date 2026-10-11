import {constants, lstatSync, openSync, closeSync, fstatSync, readSync, mkdirSync, type Stats} from 'node:fs';
import {join} from 'node:path';
import {randomUUID} from 'node:crypto';
import {atomicWriteJson} from './local-store.js';
import {normalizeRabbitConnectionDraft, normalizeRabbitConnection, normalizeRabbitRunInput, normalizeRabbitRunReceipt, normalizeRabbitRunDetail, normalizeRabbitEventPage,
  type RabbitConnection, type RabbitRunInput, type RabbitRunReceipt, type RabbitRunDetail, type RabbitEventPage} from '../shared/rabbit-project-api.js';

export type RabbitRunSource = {sessionId: string; agentId?: string; teamRunId?: string};
export type RabbitRunRecord = {
  id: string; connectionId: string; connectionSnapshot: RabbitConnection;
  request: RabbitRunInput; idempotencyKey: string;
  phase: 'prepared' | 'submitting' | 'accepted' | 'unknown' | 'rejected';
  createdAt: string; updatedAt: string; attempts: number; source?: RabbitRunSource;
  /** A previous POST may have committed. A rejected later attempt is not proof
   * that the original work did not start; only its validated receipt clears this. */
  unresolvedSubmission?: true;
  receipt?: RabbitRunReceipt; detail?: RabbitRunDetail; events?: RabbitEventPage; error?: string;
};
const uuid = /^[a-f0-9]{8}-[a-f0-9]{4}-[1-8][a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/i;
const maxBytes = 16 * 1024 * 1024;
const stamp = (previous?: string) => new Date(Math.max(Date.now(), previous ? Date.parse(previous) + 1 : 0)).toISOString();
function object(value: unknown): Record<string, unknown> {if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('프로젝트 API 저장 형식을 확인하세요. 원본을 보존했습니다.'); return value as Record<string, unknown>;}
function bounded(value: unknown, max: number): string {if (typeof value !== 'string' || !value || value.length > max || /[\u0000-\u001f\u007f]/.test(value)) throw new Error('프로젝트 API 저장 값이 올바르지 않습니다.'); return value;}
function identity(value: unknown): string {const id = bounded(value, 100); if (!uuid.test(id)) throw new Error('프로젝트 API 기록 ID가 올바르지 않습니다.'); return id;}
function date(value: unknown): string {const text = bounded(value, 40); if (!Number.isFinite(Date.parse(text))) throw new Error('프로젝트 API 기록 날짜가 올바르지 않습니다.'); return text;}
function source(value: unknown): RabbitRunSource {const input = object(value); return {sessionId: bounded(input.sessionId, 100), ...(input.agentId === undefined ? {} : {agentId: bounded(input.agentId, 100)}), ...(input.teamRunId === undefined ? {} : {teamRunId: bounded(input.teamRunId, 100)})};}
const binding = (connection: RabbitConnection) => JSON.stringify([connection.baseUrl, connection.projectId, connection.allowInsecureLoopback === true]);
function normalizeRecord(value: unknown): RabbitRunRecord {
  const input = object(value), connectionSnapshot = normalizeRabbitConnection(input.connectionSnapshot), id = identity(input.id), connectionId = identity(input.connectionId);
  if (connectionId !== connectionSnapshot.id || !['prepared','submitting','accepted','unknown','rejected'].includes(String(input.phase)) || !Number.isInteger(input.attempts) || Number(input.attempts) < 0 || Number(input.attempts) > 1000) throw new Error('프로젝트 API 실행 기록이 올바르지 않습니다.');
  if (input.unresolvedSubmission !== undefined && input.unresolvedSubmission !== true) throw new Error('프로젝트 API 미확인 접수 기록이 올바르지 않습니다.');
  const result: RabbitRunRecord = {id, connectionId, connectionSnapshot, request: normalizeRabbitRunInput(input.request, connectionSnapshot), idempotencyKey: identity(input.idempotencyKey),
    phase: input.phase as RabbitRunRecord['phase'], createdAt: date(input.createdAt), updatedAt: date(input.updatedAt), attempts: Number(input.attempts), ...(input.source === undefined ? {} : {source: source(input.source)}),
    ...(input.error === undefined ? {} : {error: bounded(input.error, 800)}),
    ...(input.unresolvedSubmission === true || input.phase === 'unknown' ? {unresolvedSubmission: true as const} : {})};
  if (input.receipt !== undefined) result.receipt = normalizeRabbitRunReceipt(input.receipt, connectionSnapshot);
  if (result.receipt && result.unresolvedSubmission) throw new Error('프로젝트 API 접수증과 미확인 상태가 일치하지 않습니다.');
  if (result.phase === 'accepted' && !result.receipt) throw new Error('접수된 프로젝트 API 기록에 접수증이 없습니다.');
  if (input.detail !== undefined || input.events !== undefined) {
    if (!result.receipt) throw new Error('프로젝트 API 조회 결과에 연결된 접수증이 없습니다.');
    const scope = {projectId: connectionSnapshot.projectId, runId: result.receipt.run_id};
    if (input.detail !== undefined) result.detail = normalizeRabbitRunDetail(input.detail, scope);
    if (input.events !== undefined) result.events = normalizeRabbitEventPage(input.events, scope);
  }
  return result;
}
function readPrivate(file: string): string | undefined {
  let before; try {before = lstatSync(file);} catch (error) {if ((error as NodeJS.ErrnoException).code === 'ENOENT') return; throw error;}
  const safe = (entry: Stats) => {if (!entry.isFile() || entry.isSymbolicLink() || entry.nlink !== 1 || entry.size > maxBytes || (entry.mode & 0o077) !== 0 || (process.getuid && entry.uid !== process.getuid())) throw new Error('프로젝트 API 파일이 안전하지 않습니다. 원본을 보존했습니다.');};
  safe(before); const fd = openSync(file, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
  try {
    const start = fstatSync(fd); safe(start); if (start.ino !== before.ino || start.dev !== before.dev) throw new Error('프로젝트 API 파일이 변경되었습니다.');
    const bytes = Buffer.alloc(start.size + 1); let length = 0;
    while (length < bytes.length) {const count = readSync(fd, bytes, length, bytes.length - length, length); if (!count) break; length += count;}
    const after = fstatSync(fd), current = lstatSync(file); safe(after); safe(current);
    if (length !== start.size || after.size !== start.size || after.mtimeMs !== start.mtimeMs || after.ctimeMs !== start.ctimeMs || current.ino !== after.ino || current.dev !== after.dev) throw new Error('읽는 동안 프로젝트 API 파일이 변경되었습니다.');
    return new TextDecoder('utf-8', {fatal: true}).decode(bytes.subarray(0, length));
  } finally {closeSync(fd);}
}

/** Durable outbox for remote work. A lost response never becomes a fresh POST:
 * retries reuse this exact destination, body and idempotency key. No secrets. */
export class RabbitStore {
  private connections: RabbitConnection[] = [];
  private runs: RabbitRunRecord[] = [];
  private readonly connectionsFile: string;
  private readonly runsFile: string;
  private connectionsRaw: string | undefined;
  private runsRaw: string | undefined;
  private readonly unsaved = new Map<string, RabbitRunRecord>();
  constructor(private readonly root: string, private readonly onUnsaved?: (ids: string[]) => void) {
    mkdirSync(root, {recursive: true, mode: 0o700}); this.checkRoot();
    this.connectionsFile = join(root, 'rabbit-connections.json'); this.runsFile = join(root, 'rabbit-runs.json');
    this.connectionsRaw = readPrivate(this.connectionsFile); this.runsRaw = readPrivate(this.runsFile);
    if (this.connectionsRaw !== undefined) {
      const data = object(JSON.parse(this.connectionsRaw));
      if (data.version !== 1 || !Array.isArray(data.connections) || data.connections.length > 25) throw new Error('프로젝트 API 연결 저장 형식이 올바르지 않습니다.');
      this.connections = data.connections.map(normalizeRabbitConnection);
      if (new Set(this.connections.map(item => item.id)).size !== this.connections.length) throw new Error('프로젝트 API 연결 ID가 중복되었습니다.');
    }
    if (this.runsRaw !== undefined) {
      const data = object(JSON.parse(this.runsRaw));
      if (data.version !== 1 || !Array.isArray(data.runs) || data.runs.length > 1000) throw new Error('프로젝트 API 실행 저장 형식이 올바르지 않습니다.');
      this.runs = data.runs.map(normalizeRecord);
      if (new Set(this.runs.map(item => item.id)).size !== this.runs.length || new Set(this.runs.map(item => item.idempotencyKey)).size !== this.runs.length) throw new Error('프로젝트 API 실행 ID가 중복되었습니다.');
      if (this.runs.some(run => ['prepared','submitting'].includes(run.phase))) this.persistRuns(this.runs.map(run => ['prepared','submitting'].includes(run.phase)
        ? {...run, phase: 'unknown', unresolvedSubmission: true, updatedAt: stamp(run.updatedAt), error: '앱 종료로 접수 결과를 확인하지 못했습니다. 같은 요청으로 재확인하세요. 원격 작업은 자동 취소되지 않습니다.'} : run));
    }
  }
  private checkRoot(): void {const stat = lstatSync(this.root); if (!stat.isDirectory() || stat.isSymbolicLink() || (stat.mode & 0o077) !== 0 || (process.getuid && stat.uid !== process.getuid())) throw new Error('프로젝트 API 저장 폴더가 안전하지 않습니다.');}
  listConnections(): RabbitConnection[] {return structuredClone(this.connections);}
  getConnection(id: string): RabbitConnection {const found = this.connections.find(item => item.id === id); if (!found) throw new Error('프로젝트 API 연결을 찾을 수 없습니다.'); return structuredClone(found);}
  saveConnection(input: unknown, expectedUpdatedAt?: string, options?: {create?: boolean}): RabbitConnection {
    const data = object(input), id = data.id === undefined || data.id === '' ? undefined : identity(data.id), previous = id && !options?.create ? this.getConnection(id) : undefined;
    if (options?.create && (expectedUpdatedAt !== undefined || (id && (this.connections.some(item => item.id === id) || this.runs.some(run => run.connectionId === id))))) throw new Error('이미 사용한 프로젝트 연결 ID를 재사용할 수 없습니다.');
    if (previous && previous.updatedAt !== expectedUpdatedAt) throw new Error('프로젝트 API 연결이 변경되었습니다. 다시 불러온 뒤 저장하세요.');
    if (!previous && this.connections.length >= 25) throw new Error('프로젝트 API 연결은 최대 25개입니다.');
    const createdAt = previous?.createdAt ?? stamp(), updatedAt = stamp(previous?.updatedAt);
    const next = normalizeRabbitConnection({...normalizeRabbitConnectionDraft(input), id: previous?.id ?? (options?.create ? id : undefined) ?? randomUUID(), createdAt, updatedAt});
    if (previous && binding(previous) !== binding(next) && this.runs.some(run => run.connectionId === previous.id)) throw new Error('실행 기록이 있는 연결의 서버·프로젝트는 바꿀 수 없습니다. 별도 연결로 추가하세요.');
    this.persistConnections([next, ...this.connections.filter(item => item.id !== next.id)]); return structuredClone(next);
  }
  removeConnection(id: string, expectedUpdatedAt?: string): void {
    const previous = this.getConnection(id);
    if (expectedUpdatedAt !== undefined && expectedUpdatedAt !== previous.updatedAt) throw new Error('프로젝트 API 연결이 변경되었습니다.');
    if (this.runs.some(run => run.connectionId === id)) throw new Error('실행 기록 보존을 위해 이 연결을 삭제할 수 없습니다. 에이전트 사용을 해제할 수 있습니다.');
    this.persistConnections(this.connections.filter(item => item.id !== id));
  }
  listRuns(): RabbitRunRecord[] {return structuredClone(this.runs.map(run => this.unsaved.get(run.id) ?? run));}
  getRun(id: string): RabbitRunRecord {const found = this.unsaved.get(id) ?? this.runs.find(item => item.id === id); if (!found) throw new Error('프로젝트 API 실행 기록을 찾을 수 없습니다.'); return structuredClone(found);}
  unsavedRunIds(): string[] {return [...this.unsaved.keys()];}
  flushRuns(): void {if (this.unsaved.size) this.persistRuns(this.listRuns());}
  prepareRun(connectionId: string, input: unknown, requestId: string = randomUUID(), origin?: RabbitRunSource): RabbitRunRecord {
    identity(requestId); const connectionSnapshot = this.getConnection(connectionId), request = normalizeRabbitRunInput(input, connectionSnapshot), capturedSource = origin ? source(origin) : undefined;
    const existing = this.listRuns().find(run => run.id === requestId);
    if (existing) {
      if (existing.connectionId !== connectionId || binding(existing.connectionSnapshot) !== binding(connectionSnapshot) || JSON.stringify(existing.request) !== JSON.stringify(request) || JSON.stringify(existing.source) !== JSON.stringify(capturedSource)) throw new Error('같은 프로젝트 요청 ID에 다른 내용을 사용할 수 없습니다.');
      return structuredClone(existing);
    }
    if (this.runs.length >= 1000) throw new Error('프로젝트 API 실행 기록 한도에 도달했습니다. 기존 기록은 보존했습니다.');
    const now = stamp(), run = normalizeRecord({id: requestId, connectionId, connectionSnapshot, request, idempotencyKey: randomUUID(), phase: 'prepared', createdAt: now, updatedAt: now, attempts: 0, ...(capturedSource ? {source: capturedSource} : {})});
    this.persistRuns([run, ...this.listRuns()]); return structuredClone(run);
  }
  beginSubmission(id: string): RabbitRunRecord {
    const run = this.getRun(id), current = this.getConnection(run.connectionId);
    if (run.phase === 'submitting') throw new Error('이미 이 프로젝트 작업을 접수 중입니다.');
    if (run.receipt || run.phase === 'accepted') throw new Error('이미 접수된 작업입니다. 새로 접수하지 말고 상태를 조회하세요.');
    if (binding(run.connectionSnapshot) !== binding(current)) throw new Error('서버·프로젝트가 변경되어 기존 요청을 재전송할 수 없습니다.');
    delete run.error;
    return this.replace({...run, phase: 'submitting', attempts: run.attempts + 1}, false);
  }
  completeSubmission(id: string, value: unknown): RabbitRunRecord {
    const run = this.getRun(id); if (run.phase !== 'submitting') throw new Error('이미 종료되거나 변경된 프로젝트 접수 요청입니다.');
    const receipt = normalizeRabbitRunReceipt(value, run.connectionSnapshot);
    delete run.error; delete run.unresolvedSubmission;
    return this.replace({...run, phase: 'accepted', receipt});
  }
  failSubmission(id: string, failure: {uncertain: boolean; error: string}): RabbitRunRecord {
    const run = this.getRun(id); if (run.receipt) return run;
    const unresolved = failure.uncertain || run.unresolvedSubmission === true || run.phase === 'unknown';
    return this.replace({...run, phase: unresolved ? 'unknown' : 'rejected',
      ...(unresolved ? {unresolvedSubmission: true as const} : {}), error: bounded(failure.error, 800)});
  }
  saveObservation(id: string, value: unknown, events?: unknown): RabbitRunRecord {
    const run = this.getRun(id); if (!run.receipt) throw new Error('접수증을 먼저 확인하세요.');
    const scope = {projectId: run.connectionSnapshot.projectId, runId: run.receipt.run_id};
    delete run.error;
    return this.replace({...run, detail: normalizeRabbitRunDetail(value, scope), ...(events === undefined ? {} : {events: normalizeRabbitEventPage(events, scope)})});
  }
  private replace(run: RabbitRunRecord, recoverable = true): RabbitRunRecord {
    const next = normalizeRecord({...run, updatedAt: stamp(run.updatedAt)});
    try {this.persistRuns(this.listRuns().map(item => item.id === next.id ? next : item));}
    catch (error) {if (!recoverable) throw error; this.unsaved.set(next.id, next); this.notifyUnsaved();}
    return structuredClone(next);
  }
  private persistConnections(next: RabbitConnection[]): void {this.connectionsRaw = this.persist(this.connectionsFile, this.connectionsRaw, {version: 1, connections: next}); this.connections = next;}
  private persistRuns(next: RabbitRunRecord[]): void {this.runsRaw = this.persist(this.runsFile, this.runsRaw, {version: 1, runs: next}); this.runs = next; if (this.unsaved.size) {this.unsaved.clear(); this.notifyUnsaved();}}
  private notifyUnsaved(): void {try {this.onUnsaved?.(this.unsavedRunIds());} catch { /* An observer cannot erase a remote receipt. */ }}
  private persist(file: string, previous: string | undefined, value: unknown): string {
    this.checkRoot(); if (readPrivate(file) !== previous) throw new Error('프로젝트 API 저장 파일이 다른 곳에서 변경되었습니다. 원본을 보존했습니다. 앱을 다시 열어 확인하세요.');
    const text = JSON.stringify(value, null, 2); if (Buffer.byteLength(text) > maxBytes) throw new Error('프로젝트 API 기록 저장 한도 16MiB에 도달했습니다. 기존 기록은 보존했습니다.');
    atomicWriteJson(file, value); return text;
  }
}
