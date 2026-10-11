/** Vendit Rabbit project-key contract, verified against server revision
 * 58a8f505bed0f3fa398c735e4750521221bfc04e. No owner-only operations. */
export const RABBIT_WORKFLOW_TEMPLATES = ['feature_pr', 'bugfix_pr', 'review_only'] as const;
export type RabbitWorkflowTemplate = typeof RABBIT_WORKFLOW_TEMPLATES[number];
export type RabbitConnectionDraft = {name: string; baseUrl: string; projectId: string; repositoryId?: string; baseRef: string; workflowTemplate: RabbitWorkflowTemplate; maxParallelTasks: number; timeoutSeconds: number; enabledForAgents: boolean; preferForProjectTasks?: boolean; allowInsecureLoopback?: boolean};
export type RabbitConnection = RabbitConnectionDraft & {id: string; createdAt: string; updatedAt: string};
export type RabbitRunInput = {objective: string; repository_id?: string; base_ref: string; workflow_template: RabbitWorkflowTemplate; acceptance_criteria: string[]; attachments: []; constraints: {environment: 'development'; max_parallel_tasks: number; timeout_seconds: number; api_cost_limit_usd: 0}};
export type RabbitRepository = {id: string; provider: 'github'; url: string; default_branch: string; status: 'unverified' | 'ready' | 'revoked'};
export type RabbitRepositoryPage = {items: RabbitRepository[]; next_cursor: string | null; has_more: boolean};
export type RabbitConnectionTest = {projectId: string; repositories: RabbitRepository[]; pages: number; checkedAt: string};
export type RabbitRunReceipt = {run_id: string; project_id: string; state: string; created_at: string; poll_url: string; events_url: string};
export type RabbitRunDetail = {run_id: string; project_id: string; state: string; objective: string; block_reason: string | null; manifest_ready: boolean; created_at: string; run_revision: number; event_cursor: string; last_event_id: string | null; max_parallel_tasks: number; timeout_seconds: number; environment: string};
export type RabbitExecutionResult = {status: 'pr_opened' | 'no_changes' | 'failed' | 'plan_ready' | 'artifact_saved'; base_sha: string; summary: {exit_code: number; output_bytes: number; output_sha256: string; tests: 'unverified'; report?: {text: string; truncated: boolean}}; branch?: string; pr_url?: string; pr_number?: number; head_sha?: string};
export type RabbitEventData = {message?: string; status?: string; reason?: string; task_id?: string | null; attempt_id?: string | null; result?: RabbitExecutionResult | null};
export type RabbitRunEvent = {id: string; sequence: number; project_id: string; run_id: string; type: string; data: RabbitEventData; created_at: string};
export type RabbitEventPage = {items: RabbitRunEvent[]; next_cursor: string; has_more: boolean; run_revision: number};

// The server's zod 3 UUID schema accepts the canonical hexadecimal form.
const controls = /[\u0000-\u001f\u007f]/, uuidPattern = /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/i;
function record(value: unknown): Record<string, unknown> {if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('Rabbit 데이터 형식을 확인하세요.'); return value as Record<string, unknown>;}
function text(value: unknown, max: number, empty = false): string {if (typeof value !== 'string' || value.length > max || value.includes('\0') || (!empty && !value.trim())) throw new Error('Rabbit 문자열 형식 또는 길이를 확인하세요.'); return value;}
export function rabbitUuid(value: unknown): string {const id = text(value, 36); if (!uuidPattern.test(id)) throw new Error('Rabbit 프로젝트·저장소·작업 ID는 UUID여야 합니다.'); return id.toLowerCase();}
function date(value: unknown): string {const result = text(value, 40); if (!Number.isFinite(Date.parse(result))) throw new Error('Rabbit 저장 날짜가 올바르지 않습니다.'); return result;}
function integer(value: unknown, min: number, max: number): number {if (!Number.isSafeInteger(value) || Number(value) < min || Number(value) > max) throw new Error('Rabbit 숫자 범위를 확인하세요.'); return Number(value);}
function boolean(value: unknown): boolean {if (typeof value !== 'boolean') throw new Error('Rabbit 설정 값을 확인하세요.'); return value;}
function state(value: unknown): string {const result = text(value, 80); if (!/^[a-zA-Z0-9_.-]+$/.test(result)) throw new Error('Rabbit 상태 형식이 올바르지 않습니다.'); return result;}
function ref(value: unknown): string {const result = text(value, 240); if (!/^[A-Za-z0-9_./-]+$/.test(result) || result.startsWith('-') || result.includes('..')) throw new Error('Rabbit 기준 브랜치 형식을 확인하세요.'); return result;}
function template(value: unknown): RabbitWorkflowTemplate {if (!RABBIT_WORKFLOW_TEMPLATES.includes(value as RabbitWorkflowTemplate)) throw new Error('Rabbit 작업 템플릿을 확인하세요.'); return value as RabbitWorkflowTemplate;}
function onlyKeys(value: Record<string, unknown>, keys: readonly string[]): void {if (Object.keys(value).some(key => !keys.includes(key))) throw new Error('프로젝트 API에서 지원하지 않는 요청 필드입니다. 모델·레인·추론 수준은 소유자 화면에서 선택하세요.');}
export const isRabbitProjectApiKey = (value: unknown): value is string => typeof value === 'string' && /^rabbit_[A-Za-z0-9_-]{43}$/.test(value);
export function validateRabbitProjectApiKey(value: unknown): string {if (!isRabbitProjectApiKey(value)) throw new Error('Rabbit 프로젝트 API 키 형식을 확인하세요.'); return value;}
const loopback = (hostname: string): boolean => hostname === 'localhost' || hostname === '[::1]' || /^127(?:\.(?:[0-9]{1,3})){3}$/.test(hostname) && hostname.split('.').every(part => Number(part) <= 255);
function endpointUrl(value: unknown, allowInsecureLoopback = false): URL {
  const raw = text(value, 4096).trim(); if (controls.test(raw) || raw.includes('\\')) throw new Error('Rabbit 주소에 제어 문자나 역슬래시를 사용할 수 없습니다.');
  let url: URL; try {url = new URL(raw);} catch {throw new Error('Rabbit API 주소를 확인하세요.');}
  if (url.username || url.password || url.search || url.hash || !(url.protocol === 'https:' || url.protocol === 'http:' && allowInsecureLoopback && loopback(url.hostname))) throw new Error('Rabbit 주소는 HTTPS여야 하며 인증 정보·쿼리·조각을 포함할 수 없습니다. HTTP는 명시한 로컬 연결만 허용합니다.');
  return url;
}
export function importRabbitEndpoint(value: unknown, options: {allowInsecureLoopback?: boolean} = {}): {baseUrl: string; projectId?: string} {
  const url = endpointUrl(value, options.allowInsecureLoopback);
  const path = url.pathname.replace(/\/$/, '');
  if (path === '' || path === '/v1') return {baseUrl: url.origin};
  const match = /^\/v1\/projects\/([^/]+)\/runs$/.exec(path);
  if (!match) throw new Error('Rabbit 기본 주소 또는 /v1/projects/{프로젝트 UUID}/runs 주소를 입력하세요.');
  return {baseUrl: url.origin, projectId: rabbitUuid(match[1])};
}
export function normalizeRabbitConnectionDraft(value: unknown): RabbitConnectionDraft {
  const input = record(value), allowInsecureLoopback = input.allowInsecureLoopback === undefined ? false : boolean(input.allowInsecureLoopback);
  const imported = importRabbitEndpoint(input.baseUrl, {allowInsecureLoopback});
  const projectId = rabbitUuid(input.projectId === undefined ? imported.projectId : input.projectId);
  if (imported.projectId && imported.projectId !== projectId) throw new Error('주소와 입력한 Rabbit 프로젝트 ID가 일치하지 않습니다.');
  const name = text(input.name, 80).trim(); if (controls.test(name)) throw new Error('Rabbit 연결 이름에 제어 문자를 사용할 수 없습니다.');
  const enabledForAgents = boolean(input.enabledForAgents === undefined ? false : input.enabledForAgents), preferForProjectTasks = boolean(input.preferForProjectTasks === undefined ? false : input.preferForProjectTasks);
  if (preferForProjectTasks && !enabledForAgents) throw new Error('프로젝트 작업에 우선 사용할 연결은 먼저 에이전트 사용을 허용해야 합니다.');
  if (input.repositoryId !== undefined && input.repositoryId !== '') rabbitUuid(input.repositoryId);
  return {name, baseUrl: imported.baseUrl, projectId, ...(input.repositoryId === undefined || input.repositoryId === '' ? {} : {repositoryId: text(input.repositoryId, 36)}),
    baseRef: ref(input.baseRef === undefined ? 'main' : input.baseRef), workflowTemplate: template(input.workflowTemplate === undefined ? 'feature_pr' : input.workflowTemplate), maxParallelTasks: integer(input.maxParallelTasks === undefined ? 2 : input.maxParallelTasks, 1, 4), timeoutSeconds: integer(input.timeoutSeconds === undefined ? 600 : input.timeoutSeconds, 60, 14400), enabledForAgents, ...(preferForProjectTasks ? {preferForProjectTasks: true} : {}), ...(allowInsecureLoopback ? {allowInsecureLoopback: true} : {})};
}
export function normalizeRabbitConnection(value: unknown): RabbitConnection {
  const input = record(value), draft = normalizeRabbitConnectionDraft(input);
  if (draft.repositoryId) rabbitUuid(draft.repositoryId);
  const createdAt = date(input.createdAt), updatedAt = date(input.updatedAt); if (Date.parse(updatedAt) < Date.parse(createdAt)) throw new Error('Rabbit 수정 날짜를 확인하세요.');
  return {...draft, id: rabbitUuid(input.id), createdAt, updatedAt};
}
export function normalizeRabbitRunInput(value: unknown, connection?: RabbitConnectionDraft): RabbitRunInput {
  const input = record(value); onlyKeys(input, ['objective', 'repository_id', 'base_ref', 'workflow_template', 'acceptance_criteria', 'attachments', 'constraints']);
  const objective = text(input.objective, 20000).trim();
  if (!Array.isArray(input.acceptance_criteria) || !input.acceptance_criteria.length || input.acceptance_criteria.length > 30) throw new Error('Rabbit 완료 기준은 1~30개가 필요합니다.');
  const acceptance_criteria = Array.from(input.acceptance_criteria, criterion => text(criterion, 2000).trim());
  if (input.attachments !== undefined && (!Array.isArray(input.attachments) || input.attachments.length)) throw new Error('현재 프로젝트 API는 등록되지 않은 첨부를 지원하지 않습니다. 첨부 목록은 비워 두세요.');
  const constraints = input.constraints === undefined && connection ? {} : record(input.constraints);
  onlyKeys(constraints, ['environment', 'max_parallel_tasks', 'timeout_seconds', 'api_cost_limit_usd']);
  if (constraints.environment !== undefined && constraints.environment !== 'development') throw new Error('Rabbit 프로젝트 API는 development 환경만 허용합니다.');
  if (constraints.api_cost_limit_usd !== undefined && constraints.api_cost_limit_usd !== 0) throw new Error('Rabbit 프로젝트 API 비용 제약은 0만 지원합니다.');
  const repository = input.repository_id ?? connection?.repositoryId;
  if (input.repository_id === null) throw new Error('Rabbit 저장소 ID는 null일 수 없습니다.');
  if (repository !== undefined) rabbitUuid(repository);
  const result: RabbitRunInput = {objective, ...(repository !== undefined ? {repository_id: text(repository, 36)} : {}), base_ref: ref(input.base_ref === undefined ? connection?.baseRef ?? 'main' : input.base_ref), workflow_template: template(input.workflow_template === undefined ? connection?.workflowTemplate : input.workflow_template), acceptance_criteria, attachments: [],
    constraints: {environment: 'development', max_parallel_tasks: integer(constraints.max_parallel_tasks === undefined ? connection?.maxParallelTasks : constraints.max_parallel_tasks, 1, 4), timeout_seconds: integer(constraints.timeout_seconds === undefined ? connection?.timeoutSeconds : constraints.timeout_seconds, 60, 14400), api_cost_limit_usd: 0}};
  if (new TextEncoder().encode(JSON.stringify(result)).byteLength > 65536) throw new Error('Rabbit 요청 전체가 서버의 64KiB 한도를 초과했습니다. 목표나 완료 기준을 줄이세요.');
  return result;
}
export function normalizeRabbitCursor(value: unknown): string {const cursor = text(value, 256); if (!/^[A-Za-z0-9_-]+$/.test(cursor)) throw new Error('Rabbit 페이지 커서를 확인하세요.'); return cursor;}
function decodeCursor(value: unknown): string {
  const cursor = normalizeRabbitCursor(value);
  let decoded: string; try {decoded = atob(cursor.replaceAll('-', '+').replaceAll('_', '/'));} catch {throw new Error('Rabbit 페이지 커서를 확인하세요.');}
  if (btoa(decoded).replaceAll('+', '-').replaceAll('/', '_').replace(/=+$/, '') !== cursor) throw new Error('Rabbit 페이지 커서를 확인하세요.');
  return decoded;
}
export function rabbitEventCursorSequence(value: unknown, runId: string): number {
  const parts = decodeCursor(value).split(':');
  if (parts.length !== 2 || parts[0] !== rabbitUuid(runId) || !/^(0|[1-9][0-9]*)$/.test(parts[1]!)) throw new Error('Rabbit 이벤트 커서의 작업 범위가 일치하지 않습니다.');
  return integer(Number(parts[1]), 0, Number.MAX_SAFE_INTEGER);
}
export function validateRabbitRepositoryCursor(value: unknown, projectId: string, repositoryId: string): string {
  const cursor = normalizeRabbitCursor(value); if (decodeCursor(cursor) !== `${rabbitUuid(projectId)}:${rabbitUuid(repositoryId)}`) throw new Error('Rabbit 저장소 커서의 프로젝트 또는 페이지 범위가 다릅니다.'); return cursor;
}
function scopedId(value: unknown, expected: string): string {const id = rabbitUuid(value); if (id !== rabbitUuid(expected)) throw new Error('Rabbit 응답의 프로젝트 또는 작업 범위가 일치하지 않습니다.'); return id;}
function publicUrl(value: unknown): string {const url = endpointUrl(value); return url.href;}
export function normalizeRabbitRepositoryPage(value: unknown): RabbitRepositoryPage {
  const input = record(value); if (!Array.isArray(input.items) || input.items.length > 100) throw new Error('Rabbit 저장소 페이지 형식을 확인하세요.');
  const items = Array.from(input.items, raw => {const item = record(raw); if (item.provider !== 'github' || !['unverified', 'ready', 'revoked'].includes(String(item.status))) throw new Error('Rabbit 저장소 정보를 확인하세요.'); return {id: rabbitUuid(item.id), provider: 'github' as const, url: publicUrl(item.url), default_branch: text(item.default_branch, 240), status: item.status as RabbitRepository['status']};});
  if (new Set(items.map(item => item.id)).size !== items.length) throw new Error('Rabbit 저장소 ID가 중복되었습니다.');
  const has_more = boolean(input.has_more), next_cursor = input.next_cursor === null ? null : normalizeRabbitCursor(input.next_cursor);
  if (has_more ? !next_cursor || !items.length : next_cursor !== null) throw new Error('Rabbit 저장소 페이지 경계가 올바르지 않습니다.');
  return {items, has_more, next_cursor};
}
export function normalizeRabbitRunReceipt(value: unknown, connection: Pick<RabbitConnectionDraft, 'baseUrl' | 'projectId' | 'allowInsecureLoopback'>): RabbitRunReceipt {
  const input = record(value), run_id = rabbitUuid(input.run_id), project_id = scopedId(input.project_id, connection.projectId);
  const origin = importRabbitEndpoint(connection.baseUrl, connection).baseUrl;
  const checked = (value: unknown, suffix: string): string => {const url = endpointUrl(value, connection.allowInsecureLoopback); if (url.origin !== origin || url.pathname.toLowerCase() !== `/v1/runs/${run_id}${suffix}`) throw new Error('Rabbit 응답 주소가 설정한 서버 또는 작업과 다릅니다.'); return `${origin}/v1/runs/${run_id}${suffix}`;};
  return {run_id, project_id, state: state(input.state), created_at: date(input.created_at), poll_url: checked(input.poll_url, ''), events_url: checked(input.events_url, '/events')};
}
export function normalizeRabbitRunDetail(value: unknown, expected: {projectId: string; runId: string}): RabbitRunDetail {
  const input = record(value), run_id = scopedId(input.run_id, expected.runId), project_id = scopedId(input.project_id, expected.projectId);
  if (input.id !== undefined) scopedId(input.id, run_id);
  rabbitEventCursorSequence(input.event_cursor, run_id);
  return {run_id, project_id, state: state(input.state), objective: text(input.objective, 20000), block_reason: input.block_reason === null ? null : text(input.block_reason, 2000), manifest_ready: boolean(input.manifest_ready), created_at: date(input.created_at), run_revision: integer(input.run_revision, 1, Number.MAX_SAFE_INTEGER), event_cursor: normalizeRabbitCursor(input.event_cursor), last_event_id: input.last_event_id === null ? null : rabbitUuid(input.last_event_id), max_parallel_tasks: integer(input.max_parallel_tasks, 1, 4), timeout_seconds: integer(input.timeout_seconds, 60, 14400), environment: state(input.environment)};
}
function executionResult(value: unknown): RabbitExecutionResult | null {
  if (value === null) return null;
  const input = record(value), summary = record(input.summary);
  if (!['pr_opened', 'no_changes', 'failed', 'plan_ready', 'artifact_saved'].includes(String(input.status)) || !/^[a-f0-9]{40}$/.test(String(input.base_sha)) || !/^[a-f0-9]{64}$/.test(String(summary.output_sha256)) || summary.tests !== 'unverified') throw new Error('Rabbit 작업 결과 형식을 확인하세요.');
  const result: RabbitExecutionResult = {status: input.status as RabbitExecutionResult['status'], base_sha: String(input.base_sha), summary: {exit_code: integer(summary.exit_code, 0, 255), output_bytes: integer(summary.output_bytes, 0, Number.MAX_SAFE_INTEGER), output_sha256: String(summary.output_sha256), tests: 'unverified'}};
  if (summary.report !== undefined) {
    const report = record(summary.report), value = text(report.text, 32768);
    if (new TextEncoder().encode(value).byteLength > 32768) throw new Error('Rabbit 최종 보고서가 너무 큽니다.');
    result.summary.report = {text: value, truncated: boolean(report.truncated)};
  }
  if (result.status === 'pr_opened') {
    const pr_number = integer(input.pr_number, 1, Number.MAX_SAFE_INTEGER), pr_url = text(input.pr_url, 4096), branch = text(input.branch, 187), head_sha = text(input.head_sha, 40);
    if (!/^https:\/\/github\.com\/[A-Za-z0-9_-]+\/[A-Za-z0-9_.-]+\/pull\/[1-9][0-9]*$/.test(pr_url) || !pr_url.endsWith(`/pull/${pr_number}`) || !/^rabbit\/[A-Za-z0-9/_-]{1,180}$/.test(branch) || !/^[a-f0-9]{40}$/.test(head_sha)) throw new Error('Rabbit PR 결과 형식을 확인하세요.');
    Object.assign(result, {pr_number, pr_url, branch, head_sha});
  }
  return result;
}
export function normalizeRabbitEventPage(value: unknown, expected: {projectId: string; runId: string}): RabbitEventPage {
  const input = record(value); if (!Array.isArray(input.items) || input.items.length > 100) throw new Error('Rabbit 이벤트 페이지를 확인하세요.');
  const items = Array.from(input.items, value => {
    const event = record(value), raw = event.data && typeof event.data === 'object' && !Array.isArray(event.data) ? record(event.data) : {}, data: RabbitEventData = {};
    for (const field of ['message', 'status', 'reason'] as const) if (typeof raw[field] === 'string') data[field] = text(raw[field], 8000, true);
    for (const field of ['task_id', 'attempt_id'] as const) if (raw[field] === null || typeof raw[field] === 'string' && uuidPattern.test(raw[field])) data[field] = raw[field] === null ? null : rabbitUuid(raw[field]);
    if (typeof event.type === 'string' && event.type.startsWith('task.execution.') && raw.result !== undefined) data.result = executionResult(raw.result);
    return {id: rabbitUuid(event.id), sequence: integer(event.sequence, 1, Number.MAX_SAFE_INTEGER), project_id: scopedId(event.project_id, expected.projectId), run_id: scopedId(event.run_id, expected.runId), type: state(event.type), data, created_at: date(event.created_at)};
  });
  if (new Set(items.map(item => item.id)).size !== items.length || items.some((item, index) => index > 0 && item.sequence <= items[index - 1]!.sequence)) throw new Error('Rabbit 이벤트 순서 또는 ID가 올바르지 않습니다.');
  const has_more = boolean(input.has_more); if (has_more && !items.length) throw new Error('Rabbit 이벤트 페이지가 진행되지 않습니다.');
  const cursorSequence = rabbitEventCursorSequence(input.next_cursor, expected.runId);
  if (items.length && cursorSequence !== items[items.length - 1]!.sequence) throw new Error('Rabbit 이벤트 커서가 마지막 이벤트와 다릅니다.');
  return {items, next_cursor: normalizeRabbitCursor(input.next_cursor), has_more, run_revision: integer(input.run_revision, 1, Number.MAX_SAFE_INTEGER)};
}
