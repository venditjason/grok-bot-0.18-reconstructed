import {validRequiredPolicy, validActionReceipt, type RequiredPolicyPin, type ActionReceipt} from '../shared/required-delegation-policy.js';
import {validChatAttachments,type ChatAttachment} from '../shared/chat-attachments.js';
import {validDevelopmentBinding, type DevelopmentBinding} from '../shared/development-routing.js';
import {SecureStorageError} from './secure-storage-error.js';
import { existsSync, lstatSync, mkdirSync, readFileSync, renameSync, writeFileSync, unlinkSync } from 'node:fs';
import { join } from 'node:path';
import { createHash, randomUUID } from 'node:crypto';
import {normalizeAgentPolicy, validAgentPolicySelection, type AgentPolicy, type AgentPolicySelection} from '../shared/agent-policy.js';

export type ToolRecord = { callId: string; name: string; path?: string; status: 'running' | 'completed' | 'failed'; summary?: string; input?: Record<string, unknown>; output?: unknown };
export type ConnectionRoute = { connectionId: string; model: string; effort?: string };
export type ConnectionAttempt = ConnectionRoute & { status: 'running' | 'failed' | 'completed'; error?: string };
export type AvatarRequestRecord = {requestId: string; ownerKey: string; sessionId?: string; phase: 'validating' | 'queued' | 'running' | 'completed' | 'failed' | 'cancelled'; assetId?: string; error?: string};
export type ChatMessage = { requiredPolicy?: RequiredPolicyPin; actionReceipt?: ActionReceipt; attachments?: ChatAttachment[]; id: string; role: 'user' | 'assistant'; text: string; createdAt: string; status: 'running' | 'completed' | 'failed' | 'cancelled'; error?: string; tools?: ToolRecord[]; attempts?: ConnectionAttempt[]; routeSelection?: AgentPolicySelection };
export type ChatSession = { requiredPolicy?: RequiredPolicyPin; queuedAttachments?:ChatAttachment[]; routineDispatchId?: string; development?: DevelopmentBinding; id: string; title: string; connectionId: string; model: string; effort?: string; connections?: ConnectionRoute[]; agentId?: string; agentName?: string; instructions?: string; teamRunId?: string; teamStepIndex?: number; purpose?: 'avatar'; avatarRequest?: AvatarRequestRecord; automation?: {policyId: string}; policySnapshot?: AgentPolicy; policyAllowedConnections?: ConnectionRoute[]; policyTaskText?: string; routeSelection?: AgentPolicySelection; taskStatus?: 'queued' | 'running' | 'completed' | 'failed' | 'cancelled'; queuedPrompt?: string; createdAt: string; updatedAt: string; workspacePath?: string; providerSessionId?: string; providerSessionBinding?: string; messages: ChatMessage[] };

export function validPolicySnapshot(value: unknown): value is AgentPolicy {try {normalizeAgentPolicy(value); return true;} catch {return false;}}
export function validAvatarRequest(value: unknown): value is AvatarRequestRecord {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  const v = value as AvatarRequestRecord;
  return text(v.requestId, 100) && !!v.requestId && text(v.ownerKey, 120) && /^(agent|draft):[^\s:]+$/.test(v.ownerKey)
    && (v.sessionId === undefined || text(v.sessionId, 100)) && ['validating', 'queued', 'running', 'completed', 'failed', 'cancelled'].includes(v.phase)
    && (v.assetId === undefined || text(v.assetId, 100)) && (v.error === undefined || text(v.error, 2000));
}

function text(value: unknown, max: number): value is string { return typeof value === 'string' && value.length <= max && !value.includes('\0'); }
export function connectionRouteKey(route: ConnectionRoute): string { return JSON.stringify([route.connectionId, route.model, route.effort ?? '']); }
export function validConnectionRoute(value: unknown): value is ConnectionRoute {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  const route = value as ConnectionRoute;
  return text(route.connectionId, 200) && !!route.connectionId.trim() && text(route.model, 200) && !!route.model && !/\s/.test(route.model) && (route.effort === undefined || (text(route.effort, 40) && !!route.effort && !/\s/.test(route.effort)));
}
export function validConnections(value: unknown): value is ConnectionRoute[] {
  return Array.isArray(value) && value.length > 0 && value.length <= 8 && value.every(validConnectionRoute) && new Set(value.map(connectionRouteKey)).size === value.length;
}
export function connectionRoutes(value: ConnectionRoute & {connections?: ConnectionRoute[]}): ConnectionRoute[] {
  return structuredClone(value.connections ?? [{connectionId: value.connectionId, model: value.model, ...(value.effort ? {effort: value.effort} : {})}]);
}
function date(value: unknown): boolean { return text(value, 40) && Number.isFinite(Date.parse(value)); }
function validSession(value: unknown): value is ChatSession {
  if (!value || typeof value !== 'object') return false;
  const s = value as ChatSession;
  return (s.requiredPolicy===undefined||validRequiredPolicy(s.requiredPolicy)) && (s.queuedAttachments===undefined||validChatAttachments(s.queuedAttachments)) && (s.routineDispatchId === undefined || /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(s.routineDispatchId)) && (s.development === undefined || validDevelopmentBinding(s.development)) && text(s.id, 100) && text(s.title, 200) && text(s.connectionId, 200) && text(s.model, 200) && date(s.createdAt) && date(s.updatedAt)
    && (s.effort === undefined || text(s.effort, 40)) && (s.workspacePath === undefined || text(s.workspacePath, 4096)) && (s.providerSessionId === undefined || text(s.providerSessionId, 200))
    && (s.connections === undefined || validConnections(s.connections)) && (s.providerSessionBinding === undefined || text(s.providerSessionBinding, 500))
    && (s.agentId === undefined || text(s.agentId, 100)) && (s.agentName === undefined || text(s.agentName, 80)) && (s.instructions === undefined || text(s.instructions, 16000))
    && (s.teamRunId === undefined ? s.teamStepIndex === undefined : text(s.teamRunId, 100) && !!s.teamRunId && Number.isInteger(s.teamStepIndex) && s.teamStepIndex! >= 0 && s.teamStepIndex! < 104)
    && (s.purpose === undefined || s.purpose === 'avatar')
    && (s.avatarRequest === undefined || (s.purpose === 'avatar' && validAvatarRequest(s.avatarRequest)))
    && (s.automation === undefined || (!!s.automation && typeof s.automation === 'object' && text(s.automation.policyId, 100)))
    && (s.policySnapshot === undefined || validPolicySnapshot(s.policySnapshot)) && (s.policyAllowedConnections === undefined || validConnections(s.policyAllowedConnections)) && (s.policyTaskText === undefined || text(s.policyTaskText, 100_000))
    && (s.routeSelection === undefined || validAgentPolicySelection(s.routeSelection))
    && (s.taskStatus === undefined || ['queued', 'running', 'completed', 'failed', 'cancelled'].includes(s.taskStatus)) && (s.queuedPrompt === undefined || text(s.queuedPrompt, 500_000))
    && Array.isArray(s.messages) && s.messages.length <= 20_000 && new Set(s.messages.map(m => m?.id)).size === s.messages.length
    && s.messages.every(m => m && (m.requiredPolicy===undefined||validRequiredPolicy(m.requiredPolicy)) && (m.actionReceipt===undefined||validActionReceipt(m.actionReceipt)) && (m.attachments===undefined||validChatAttachments(m.attachments)) && text(m.id, 100) && ['user', 'assistant'].includes(m.role) && text(m.text, 2_000_000) && date(m.createdAt)
      && ['running', 'completed', 'failed', 'cancelled'].includes(m.status) && (m.error === undefined || text(m.error, 2000))
      && (m.routeSelection === undefined || validAgentPolicySelection(m.routeSelection))
      && (m.attempts === undefined || (Array.isArray(m.attempts) && m.attempts.length > 0 && m.attempts.length <= 8 && m.attempts.every(a => validConnectionRoute(a) && ['running', 'failed', 'completed'].includes(a.status) && (a.error === undefined || text(a.error, 2000)))))
      && (m.tools === undefined || (Array.isArray(m.tools) && m.tools.length <= 200 && m.tools.every(t => t && text(t.callId, 200) && text(t.name, 100) && ['running', 'completed', 'failed'].includes(t.status) && (t.path === undefined || text(t.path, 4096)) && (t.summary === undefined || text(t.summary, 2000))))));
}

function privateFile(path: string): void {
  let stat;
  try { stat = lstatSync(path); } catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') return; throw error; }
  if (!stat.isFile() || stat.isSymbolicLink() || stat.nlink !== 1 || stat.size > 64 * 1024 * 1024) throw new Error('안전하지 않거나 너무 큰 저장 파일입니다.');
}

export function atomicWriteJson(path: string, data: unknown): void {
  privateFile(path);
  const temporary = `${path}.${randomUUID()}.tmp`;
  try {
    const serialized = JSON.stringify(data, null, 2);
    if (Buffer.byteLength(serialized) > 64 * 1024 * 1024) throw new Error('저장 한도에 도달했습니다. 이전 대화를 내보낸 뒤 삭제하세요.');
    writeFileSync(temporary, serialized, { mode: 0o600, flag: 'wx', flush: true });
    renameSync(temporary, path);
  } finally { if (existsSync(temporary)) unlinkSync(temporary); }
}

export class LocalSessionStore {
  private readonly file: string;
  private sessions: ChatSession[] = [];
  constructor(root: string) {
    mkdirSync(root, { recursive: true, mode: 0o700 });
    this.file = join(root, 'conversations.json');
    privateFile(this.file);
    if (!existsSync(this.file)) return;
    const raw = JSON.parse(readFileSync(this.file, 'utf8')) as { version?: number; sessions?: unknown };
    if (raw.version !== 1 || !Array.isArray(raw.sessions)) throw new Error('대화 저장 형식을 읽을 수 없습니다. 원본 파일은 보존했습니다.');
    if (raw.sessions.length > 1000 || !raw.sessions.every(validSession) || new Set(raw.sessions.map(s => s.id)).size !== raw.sessions.length) throw new Error('대화 데이터가 손상되었습니다. 원본 파일은 보존했습니다.');
    this.sessions = raw.sessions;
    let changed = false;
    for (const session of this.sessions) {
      if (session.avatarRequest && ['validating', 'queued', 'running'].includes(session.avatarRequest.phase)) {session.avatarRequest.phase = 'cancelled'; session.avatarRequest.error = '앱 종료로 중단된 이미지 요청입니다. 자동 재실행하지 않습니다.'; changed = true;}
      if (session.taskStatus === 'queued' || session.taskStatus === 'running') { session.taskStatus = 'cancelled'; changed = true; }
      for (const message of session.messages) if (message.status === 'running') {
      message.status = 'failed'; message.error = '앱 종료로 중단된 응답입니다.';
      for (const attempt of message.attempts ?? []) if (attempt.status === 'running') { attempt.status = 'failed'; attempt.error = '앱 종료로 중단되었습니다. 자동 재실행하지 않습니다.'; }
      for (const tool of message.tools ?? []) if (tool.status === 'running') { tool.status = 'failed'; tool.summary = '앱 종료로 중단되었습니다. 자동 재실행하지 않습니다.'; }
      changed = true;
      }
    }
    if (changed) this.persist();
  }
  list(): ChatSession[] { return structuredClone(this.sessions); }
  get(id: string): ChatSession { const session = this.sessions.find(s => s.id === id); if (!session) throw new Error('대화를 찾을 수 없습니다.'); return structuredClone(session); }
  create(connectionId: string, model: string, workspacePath?: string, effort?: string, snapshot?: Pick<ChatSession, 'requiredPolicy' | 'routineDispatchId' | 'connections' | 'agentId' | 'agentName' | 'instructions' | 'purpose' | 'avatarRequest' | 'automation' | 'policySnapshot' | 'policyAllowedConnections' | 'development'>): ChatSession {
    if (this.sessions.length >= 1000) throw new Error('대화는 최대 1,000개까지 저장할 수 있습니다. 이전 대화를 내보낸 뒤 삭제하세요.');
    const now = new Date().toISOString();
    const session: ChatSession = { ...structuredClone(snapshot), id: randomUUID(), title: '새 대화', connectionId, model, ...(effort ? {effort} : {}), ...(workspacePath ? {workspacePath} : {}), createdAt: now, updatedAt: now, messages: [] };
    if (!validSession(session)) throw new Error('대화 형식 또는 크기 제한을 확인하세요.');
    this.persist([session, ...this.sessions]); return structuredClone(session);
  }
  save(session: ChatSession): void {
    const index = this.sessions.findIndex(s => s.id === session.id);
    if (index < 0) throw new Error('대화를 찾을 수 없습니다.');
    const next = structuredClone({ ...session, updatedAt: new Date().toISOString() });
    if (!validSession(next)) throw new Error('대화 형식 또는 크기 제한을 확인하세요.');
    this.persist(this.sessions.map((old, i) => i === index ? next : old));
  }
  /** Commit all preallocated team steps before any provider can start. */
  createPrepared(prepared: ChatSession[]): void {
    if (!prepared.length || prepared.length > 25 || this.sessions.length + prepared.length > 1000) throw new Error('팀 작업을 저장할 대화 공간이 부족합니다. 이전 대화를 내보낸 뒤 삭제하세요.');
    const all = [...structuredClone(prepared), ...this.sessions];
    if (!prepared.every(validSession) || new Set(all.map(s => s.id)).size !== all.length) throw new Error('팀 대화 구성이 올바르지 않습니다.');
    this.persist(all);
  }
  remove(id: string): void { this.get(id); this.persist(this.sessions.filter(s => s.id !== id)); }
  private persist(next = this.sessions): void { atomicWriteJson(this.file, { version: 1, sessions: next }); this.sessions = next; }
}

export type EncryptionPort = {
  isAsyncEncryptionAvailable(): Promise<boolean>;
  encryptStringAsync(value: string): Promise<Buffer>;
  decryptStringAsync(value: Buffer): Promise<{result: string; shouldReEncrypt: boolean}>;
};
export class EncryptedSecretStore {
  private readonly file: string;
  private nativePending = false;
  private revisions = new Map<string, number>();
  constructor(root: string, private readonly encryption: EncryptionPort, private readonly timeoutMs = 15_000) {
    mkdirSync(root, { recursive: true, mode: 0o700 }); this.file = join(root, 'credentials.encrypted.json');
  }
  private load(): Record<string, string> {
    privateFile(this.file);
    if (!existsSync(this.file)) return {};
    const data = JSON.parse(readFileSync(this.file, 'utf8')) as { version?: number; values?: unknown };
    if (data.version !== 1 || !data.values || typeof data.values !== 'object' || Array.isArray(data.values)) throw new Error('암호화된 연결 정보를 읽을 수 없습니다.');
    const values = data.values as Record<string, unknown>;
    if (Object.keys(values).length > 100 || !Object.entries(values).every(([key, value]) => /^[A-Z0-9_]+$/.test(key) && typeof value === 'string' && value.length <= 32_768 && /^[A-Za-z0-9+/]+={0,2}$/.test(value))) throw new Error('암호화된 연결 정보가 손상되었습니다.');
    return values as Record<string, string>;
  }
  has(key: string): boolean { return Object.hasOwn(this.load(), key); }
  /** Opaque host-only ciphertext identity; no native Keychain read or plaintext. */
  revision(key: string): string | undefined { const value = this.load()[key]; return value ? createHash('sha256').update(value).digest('hex') : undefined; }
  isPending(): boolean { return this.nativePending; }
  /** Native Keychain work cannot be cancelled, but its late result never commits. */
  private native<T>(operation: (assertActive: () => void) => Promise<T>, signal?: AbortSignal): Promise<T> {
    if (signal?.aborted) return Promise.reject(new DOMException('보안 저장소 요청을 취소했습니다.', 'AbortError'));
    if (this.nativePending) return Promise.reject(new SecureStorageError('pending'));
    this.nativePending = true; let active = true;
    const assertActive = () => { if (!active || signal?.aborted) throw new DOMException('보안 저장소 요청을 취소했습니다.', 'AbortError'); };
    const pending = Promise.resolve().then(() => { assertActive(); return operation(assertActive); });
    // Retain this guard after timeout: do not accumulate native Keychain prompts.
    void pending.then(() => { this.nativePending = false; }, () => { this.nativePending = false; });
    return new Promise<T>((resolve, reject) => {
      const finish = (error?: unknown, value?: T) => { active = false; clearTimeout(timer); signal?.removeEventListener('abort', abort); error ? reject(error) : resolve(value as T); };
      const abort = () => finish(new DOMException('보안 저장소 요청을 취소했습니다.', 'AbortError'));
      const timer = setTimeout(() => finish(new SecureStorageError('timeout')), this.timeoutMs);
      signal?.addEventListener('abort', abort, {once: true});
      pending.then(value => finish(undefined, value), error => finish(error instanceof SecureStorageError ? error : new SecureStorageError('failed')));
    });
  }
  private async available(): Promise<void> {
    if (!await this.encryption.isAsyncEncryptionAvailable()) throw new SecureStorageError('unavailable');
  }
  async read(key: string, signal?: AbortSignal): Promise<string | undefined> {
    const value = this.load()[key]; if (!value) return undefined;
    const revision = this.revisions.get(key) ?? 0;
    const decrypted = await this.native(async assertActive => { await this.available(); assertActive(); return this.encryption.decryptStringAsync(Buffer.from(value, 'base64')); }, signal);
    if (signal?.aborted) throw new DOMException('보안 저장소 요청을 취소했습니다.', 'AbortError');
    if (this.load()[key] !== value || (this.revisions.get(key) ?? 0) !== revision) throw new Error('조회 중 API 키가 변경되었습니다. 다시 시도하세요.');
    if (!decrypted || typeof decrypted.result !== 'string' || !decrypted.result || decrypted.result.length > 8192) throw new Error('macOS 보안 저장소가 올바르지 않은 키를 반환했습니다.');
    // Reading never silently rewrites ciphertext, including key rotation hints.
    return decrypted.result;
  }
  async write(key: string, value: string, options: {signal?: AbortSignal; beforeCommit?: () => void; afterCommit?: () => void; removeKeys?: string[]} = {}): Promise<void> {
    if (!/^[A-Z0-9_]+$/.test(key) || !value || value.length > 8192) throw new Error('올바르지 않은 API 키입니다.');
    const initial = this.load(), revision = this.revisions.get(key) ?? 0;
    const encrypted = await this.native(async assertActive => { await this.available(); assertActive(); return this.encryption.encryptStringAsync(value); }, options.signal);
    if (options.signal?.aborted) throw new DOMException('보안 저장소 요청을 취소했습니다.', 'AbortError');
    if (!Buffer.isBuffer(encrypted) || encrypted.length === 0 || encrypted.toString('base64').length > 32_768) throw new Error('macOS 보안 저장소가 올바르지 않은 암호문을 반환했습니다.');
    options.beforeCommit?.();
    const previous = this.load();
    if (previous[key] !== initial[key] || (this.revisions.get(key) ?? 0) !== revision) throw new Error('저장 중 API 키가 변경되었습니다. 최신 설정에서 다시 시도하세요.');
    const next = {...previous, [key]: encrypted.toString('base64')};
    for (const removed of options.removeKeys ?? []) { if (previous[removed] !== initial[removed]) throw new Error('저장 중 연결 키가 변경되었습니다. 다시 시도하세요.'); delete next[removed]; }
    this.commit(previous, next, options.afterCommit);
  }
  remove(key: string, afterCommit?: () => void): void { const previous = this.load(), next = {...previous}; delete next[key]; this.commit(previous, next, afterCommit); this.revisions.set(key, (this.revisions.get(key) ?? 0) + 1); }
  private commit(previous: Record<string, string>, next: Record<string, string>, afterCommit?: () => void): void {
    const existed = existsSync(this.file);
    atomicWriteJson(this.file, {version: 1, values: next});
    try { afterCommit?.(); }
    catch (error) {
      if (existed) atomicWriteJson(this.file, {version: 1, values: previous});
      else { privateFile(this.file); unlinkSync(this.file); }
      throw error;
    }
    for (const key of new Set([...Object.keys(previous), ...Object.keys(next)])) if (previous[key] !== next[key]) this.revisions.set(key, (this.revisions.get(key) ?? 0) + 1);
  }
}

/** Failed/cancelled turns remain visible but are never silently re-submitted. */
export function completedHistory(session: ChatSession, currentUserId: string, content: (message:ChatMessage)=>string|unknown[] = message=>message.text): {role: 'user' | 'assistant' | 'tool'; content: string | unknown[]}[] {
  const result: {role: 'user' | 'assistant' | 'tool'; content: string | unknown[]}[] = [];
  for (let i = 0; i < session.messages.length; i++) {
    const message = session.messages[i]!;
    if (message.id === currentUserId) { result.push({role: 'user', content: content(message)}); break; }
    const next = session.messages[i + 1];
    if (message.role === 'user' && next?.role === 'assistant' && next.status === 'completed') {
      result.push({role: 'user', content: content(message)});
      for (const tool of next.tools ?? []) if (tool.input !== undefined && tool.output !== undefined) result.push(
        {role: 'assistant', content: [{type: 'tool-call', toolCallId: tool.callId, toolName: tool.name, args: tool.input}]},
        {role: 'tool', content: [{type: 'tool-result', toolCallId: tool.callId, toolName: tool.name, result: tool.output}]},
      );
      result.push({role: 'assistant', content: next.text}); i++;
    }
  }
  return result;
}

export function sessionMarkdown(session: ChatSession): string {
  return `# ${session.title}\n\n연결: ${session.connectionId}\n모델: ${session.model || '공급자 기본값'}\nEffort: ${session.effort || '공급자 기본값'}\n` + session.messages.map(m => `\n## ${m.role === 'user' ? '사용자' : '벤디트봇'} · ${m.createdAt}\n\n${m.text}${m.attachments?.length ? '\n\n첨부: '+m.attachments.map(a=>a.name+' ('+a.bytes+' bytes; SHA256 '+a.sha256+')').join(', ') : ''}\n${m.status !== 'completed' ? `\n[${m.status}] ${m.error ?? ''}\n` : ''}`).join('');
}

export function safeError(error: unknown): string {
  return (error instanceof Error ? error.message : '요청을 처리할 수 없습니다.')
    .replace(/(?:sk-|sess-)[A-Za-z0-9_\-]{8,}/g, '[보호된 키]')
    .replace(/Bearer\s+\S+/gi, 'Bearer [보호됨]')
    .replace(/eyJ[A-Za-z0-9_\-]+\.[A-Za-z0-9_\-]+\.[A-Za-z0-9_\-]+/g, '[보호된 토큰]')
    .slice(0, 800);
}
