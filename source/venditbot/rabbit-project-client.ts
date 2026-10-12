import {
  normalizeRabbitConnection, normalizeRabbitRunInput, normalizeRabbitRepositoryPage,
  normalizeRabbitRunReceipt, normalizeRabbitRunDetail, normalizeRabbitEventPage,
  normalizeRabbitCursor, rabbitUuid, validateRabbitProjectApiKey,
  validateRabbitRepositoryCursor, rabbitEventCursorSequence,
  type RabbitConnection, type RabbitConnectionTest, type RabbitRunReceipt,
  type RabbitRunDetail, type RabbitEventPage,
} from '../shared/rabbit-project-api.js';

const RESPONSE_LIMIT = 1024 * 1024;
const ERROR_CODES = new Set(['invalid_api_key', 'invalid_principal', 'project_archived', 'project_not_found', 'project_scope_mismatch', 'run_not_found', 'owner_session_required', 'invalid_limit', 'invalid_cursor', 'event_cursor_expired', 'cursor_conflict', 'idempotency_conflict', 'idempotency_key_required', 'invalid_request', 'invalid_json', 'payload_too_large', 'ambiguous_principal', 'attachment_not_registered', 'repository_not_found', 'rate_limited',
  // Explicit public error codes from the verified server's http.ts/project-api.ts, never its raw message.
  'internal_error', 'database_schema_unavailable', 'execution_admission_paused', 'legacy_run_read_only', 'legacy_runtime_read_only', 'validation_error', 'repository_scope_mismatch', 'request_too_large', 'json_required', 'body_required', 'body_not_allowed', 'cross_origin_denied', 'unsupported_model_selection', 'identity_mismatch', 'runtime_login_changed', 'runtime_session_changed', 'runtime_reverification_required', 'already_exists', 'access_denied', 'not_found']);
function recoveryMessage(code: string): string {
  switch (code) {
    case 'database_schema_unavailable': return ' Rabbit 서버의 데이터베이스 복구가 필요합니다. 기존 접수 기록을 보관하세요.';
    case 'execution_admission_paused': return ' Rabbit 실행 준비 확인 중으로 새 작업 접수가 일시 중지됐습니다. 기존 접수 기록을 보관하고 준비 완료 후 같은 요청으로 재시도하세요.';
    case 'legacy_run_read_only':
    case 'legacy_runtime_read_only': return ' 이전 실행 기록은 보존 상태입니다. Rabbit 소유자 화면에서 기존 작업의 결과와 종료 여부를 확인하세요. 이 오류는 기존 작업의 완료나 취소를 뜻하지 않습니다.';
    default: return '';
  }
}
export class RabbitProjectApiError extends Error {
  readonly code: string; readonly status?: number; readonly uncertain: boolean; readonly requestId?: string;
  constructor(code: string, uncertain = false, status?: number, requestId?: unknown) {
    const safeRequestId = typeof requestId === 'string' && /^[a-f0-9]{8}-[a-f0-9]{4}-[1-8][a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/i.test(requestId) ? requestId.toLowerCase() : undefined;
    super(`Rabbit 요청을 완료하지 못했습니다 (${code}${status === undefined ? '' : `, HTTP ${status}`}).${recoveryMessage(code)}${uncertain ? ' 원격 접수 여부는 확인되지 않았습니다. 로컬 대기 취소는 원격 작업 취소가 아닙니다.' : ''}${safeRequestId ? ` 진단 요청 ID: ${safeRequestId}` : ''}`);
    this.name = 'RabbitProjectApiError'; this.code = code; this.uncertain = uncertain;
    if (status !== undefined) this.status = status;
    if (safeRequestId) this.requestId = safeRequestId;
  }
}
type Options = {fetch?: typeof fetch; timeoutMs?: number};
type Context = {connection: RabbitConnection; key: string; signal: AbortSignal; post: boolean; dispatched: boolean; status?: number; timedOut: () => boolean};
/** An injectable transport for local fault tests. Production wrappers below use native fetch and 30 seconds. */
export class RabbitProjectClient {
  private readonly fetcher: typeof fetch;
  private readonly timeoutMs: number;
  constructor(options: Options = {}) {
    this.fetcher = options.fetch ?? globalThis.fetch;
    this.timeoutMs = options.timeoutMs ?? 30000;
    if (!Number.isSafeInteger(this.timeoutMs) || this.timeoutMs < 1 || this.timeoutMs > 30000) throw new Error('Rabbit 요청 제한 시간을 확인하세요.');
  }
  private async operation<T>(connection: RabbitConnection, key: string, signal: AbortSignal | undefined, post: boolean, work: (context: Context) => Promise<T>): Promise<T> {
    let normalized: RabbitConnection, checkedKey: string;
    try {normalized = normalizeRabbitConnection(connection); checkedKey = validateRabbitProjectApiKey(key);} catch {throw new RabbitProjectApiError('invalid_configuration');}
    if (signal?.aborted) throw new RabbitProjectApiError('aborted');
    const controller = new AbortController(); let timeout = false;
    const abort = () => controller.abort(); signal?.addEventListener('abort', abort, {once: true});
    const timer = setTimeout(() => {timeout = true; controller.abort();}, this.timeoutMs);
    const context: Context = {connection: normalized, key: checkedKey, signal: controller.signal, post, dispatched: false, timedOut: () => timeout};
    try {return await work(context);} catch (error) {
      if (error instanceof RabbitProjectApiError) throw error;
      const uncertain = post && context.dispatched && !(context.status !== undefined && context.status >= 400 && context.status < 500);
      throw new RabbitProjectApiError(controller.signal.aborted ? timeout ? 'timeout' : 'aborted' : 'invalid_response', uncertain, context.status);
    } finally {clearTimeout(timer); signal?.removeEventListener('abort', abort); controller.abort();}
  }
  private async readJson(response: Response, context: Context): Promise<unknown> {
    const declared = response.headers.get('content-length');
    if (declared !== null && (!/^\d+$/.test(declared) || Number(declared) > RESPONSE_LIMIT)) {
      void response.body?.cancel().catch(() => {}); throw new Error('response_size');
    }
    if (!/^application\/(?:[a-z0-9.+-]+\+)?json(?:\s*;|$)/i.test(response.headers.get('content-type') ?? '') || !response.body) {
      void response.body?.cancel().catch(() => {}); throw new Error('response_type');
    }
    const reader = response.body.getReader(), chunks: Uint8Array[] = []; let total = 0, complete = false;
    try {
      while (true) {
        const part = await this.wait(reader.read(), context);
        if (part.done) {complete = true; break;}
        total += part.value.byteLength; if (total > RESPONSE_LIMIT) throw new Error('response_size');
        chunks.push(part.value);
      }
      const bytes = new Uint8Array(total); let offset = 0; for (const chunk of chunks) {bytes.set(chunk, offset); offset += chunk.length;}
      return JSON.parse(new TextDecoder('utf-8', {fatal: true}).decode(bytes)) as unknown;
    } finally {if (!complete) void reader.cancel().catch(() => {}); reader.releaseLock();}
  }
  private wait<T>(promise: Promise<T>, context: Context): Promise<T> {
    if (context.signal.aborted) {void promise.catch(() => {}); return Promise.reject(new Error('aborted'));}
    return new Promise((resolve, reject) => {
      const abort = () => {context.signal.removeEventListener('abort', abort); reject(new Error('aborted'));};
      context.signal.addEventListener('abort', abort, {once: true});
      promise.then(value => {context.signal.removeEventListener('abort', abort); resolve(value);}, error => {context.signal.removeEventListener('abort', abort); reject(error);});
    });
  }
  private async request(context: Context, path: string, body?: string, idempotencyKey?: string): Promise<unknown> {
    if (context.signal.aborted) throw new Error('aborted');
    const url = new URL(path, context.connection.baseUrl);
    if (url.origin !== context.connection.baseUrl || !url.pathname.startsWith('/v1/')) throw new RabbitProjectApiError('invalid_request');
    const headers: Record<string, string> = {'X-Project-API-Key': context.key, Accept: 'application/json'};
    if (body !== undefined) {headers['Content-Type'] = 'application/json'; headers['Idempotency-Key'] = idempotencyKey!;}
    context.dispatched = true;
    let response: Response;
    try {
      response = await this.wait(this.fetcher(url, {method: body === undefined ? 'GET' : 'POST', headers, ...(body === undefined ? {} : {body}), signal: context.signal, redirect: 'manual', credentials: 'omit', cache: 'no-store'}), context);
    } catch {
      throw new RabbitProjectApiError(context.signal.aborted ? context.timedOut() ? 'timeout' : 'aborted' : 'network_error', context.post);
    }
    context.status = response.status;
    // Never follow server-provided poll URLs or Location headers, even on the same origin.
    if (response.status >= 300 && response.status < 400 || response.url && new URL(response.url).origin !== url.origin) {
      void response.body?.cancel().catch(() => {}); throw new RabbitProjectApiError('redirect_blocked', context.post, response.status);
    }
    let data: unknown;
    try {data = await this.readJson(response, context);} catch {
      const uncertain = context.post && !(response.status >= 400 && response.status < 500);
      throw new RabbitProjectApiError(context.signal.aborted ? context.timedOut() ? 'timeout' : 'aborted' : 'invalid_response', uncertain, response.status);
    }
    if (response.status !== (context.post ? 202 : 200)) {
      const failure = data && typeof data === 'object' && 'error' in data && data.error && typeof data.error === 'object' ? data.error : undefined;
      const rawCode = failure && 'code' in failure ? failure.code : undefined;
      const code = typeof rawCode === 'string' && ERROR_CODES.has(rawCode) ? rawCode : 'http_error';
      throw new RabbitProjectApiError(code, context.post && !(response.status >= 400 && response.status < 500), response.status, failure && 'request_id' in failure ? failure.request_id : undefined);
    }
    return data;
  }
  async testRabbitConnection(connection: RabbitConnection, key: string, signal?: AbortSignal): Promise<RabbitConnectionTest> {
    return this.operation(connection, key, signal, false, async context => {
      const repositories: RabbitConnectionTest['repositories'] = [], seen = new Set<string>(); let cursor: string | undefined;
      for (let pages = 1; pages <= 100; pages++) {
        const query = new URLSearchParams({limit: '100', ...(cursor ? {cursor} : {})});
        const page = normalizeRabbitRepositoryPage(await this.request(context, `/v1/projects/${context.connection.projectId}/repositories?${query}`));
        for (const item of page.items) {
          if (seen.has(item.id) || repositories.length && item.id <= repositories[repositories.length - 1]!.id) throw new Error('page_order');
          seen.add(item.id); repositories.push(item);
        }
        if (!page.has_more) return redact({projectId: context.connection.projectId, repositories, pages, checkedAt: new Date().toISOString()}, context.key);
        cursor = validateRabbitRepositoryCursor(page.next_cursor, context.connection.projectId, page.items[page.items.length - 1]!.id);
      }
      throw new RabbitProjectApiError('pagination_limit');
    });
  }
  async submitRabbitRun(connection: RabbitConnection, key: string, input: unknown, idempotencyKey: string, signal?: AbortSignal): Promise<RabbitRunReceipt> {
    let body: string;
    try {
      if (typeof idempotencyKey !== 'string' || !/^[\x21-\x7e]{8,128}$/.test(idempotencyKey)) throw new Error('idempotency_key');
      body = JSON.stringify(normalizeRabbitRunInput(input, normalizeRabbitConnection(connection)));
    } catch {throw new RabbitProjectApiError('invalid_request');}
    return this.operation(connection, key, signal, true, async context => redact(normalizeRabbitRunReceipt(await this.request(context, `/v1/projects/${context.connection.projectId}/runs`, body, idempotencyKey), context.connection), context.key));
  }
  async getRabbitRun(connection: RabbitConnection, key: string, runId: string, signal?: AbortSignal): Promise<RabbitRunDetail> {
    let id: string; try {id = rabbitUuid(runId);} catch {throw new RabbitProjectApiError('invalid_request');}
    return this.operation(connection, key, signal, false, async context => redact(normalizeRabbitRunDetail(await this.request(context, `/v1/runs/${id}`), {projectId: context.connection.projectId, runId: id}), context.key));
  }
  async getRabbitEvents(connection: RabbitConnection, key: string, runId: string, cursor?: string, signal?: AbortSignal): Promise<RabbitEventPage> {
    let id: string, after: number;
    try {id = rabbitUuid(runId); after = cursor === undefined ? 0 : rabbitEventCursorSequence(normalizeRabbitCursor(cursor), id);} catch {throw new RabbitProjectApiError('invalid_request');}
    return this.operation(connection, key, signal, false, async context => {
      const query = new URLSearchParams({limit: '100', ...(cursor === undefined ? {} : {cursor})});
      const page = normalizeRabbitEventPage(await this.request(context, `/v1/runs/${id}/events?${query}`), {projectId: context.connection.projectId, runId: id});
      if (page.items.some(item => item.sequence <= after) || !page.items.length && rabbitEventCursorSequence(page.next_cursor, id) !== after) throw new Error('event_cursor');
      return redact(page, context.key);
    });
  }
}
// The key is never persisted or returned; also remove malicious exact-key echoes from projected text.
function redact<T>(value: T, key: string): T {return JSON.parse(JSON.stringify(value).replaceAll(key, '[보안값 삭제]')) as T;}
const client = new RabbitProjectClient();
export const testRabbitConnection = (connection: RabbitConnection, key: string, signal?: AbortSignal) => client.testRabbitConnection(connection, key, signal);
export const submitRabbitRun = (connection: RabbitConnection, key: string, body: unknown, idempotencyKey: string, signal?: AbortSignal) => client.submitRabbitRun(connection, key, body, idempotencyKey, signal);
export const getRabbitRun = (connection: RabbitConnection, key: string, runId: string, signal?: AbortSignal) => client.getRabbitRun(connection, key, runId, signal);
export const getRabbitEvents = (connection: RabbitConnection, key: string, runId: string, cursor?: string, signal?: AbortSignal) => client.getRabbitEvents(connection, key, runId, cursor, signal);
