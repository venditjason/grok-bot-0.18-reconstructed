/** Browser-safe policy contracts. Catalog access and persistence belong to the host. */
export const TASK_KINDS = ['routine', 'standard', 'complex'] as const;
export type TaskKind = typeof TASK_KINDS[number];
export type PolicyConnectionRoute = {connectionId: string; model: string; effort?: string};
export type AgentPolicyRule = {taskKind: TaskKind; keywords: string[]; connections: PolicyConnectionRoute[]};
export type AgentPolicyDraft = {name: string; description: string; defaultTaskKind: TaskKind; rules: AgentPolicyRule[]};
export type AgentPolicy = AgentPolicyDraft & {id: string; createdAt: string; updatedAt: string};
export type AgentPolicySelection = {
  connections: PolicyConnectionRoute[];
  taskKind: TaskKind;
  reason: string;
  policyId: string;
  policyName: string;
  policyUpdatedAt: string;
  warning?: string;
};
export const AGENT_POLICY_LIMITS = Object.freeze({name: 80, description: 2000, keywordsPerRule: 32, keyword: 80, routesPerRule: 8});
const labels: Record<TaskKind, string> = {routine: '단순·반복', standard: '일반', complex: '복잡한 작업'};
const controlCharacters = /[\u0000-\u001f\u007f]/;

function object(value: unknown, message: string): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error(message);
  return value as Record<string, unknown>;
}
function bounded(value: unknown, max: number, message: string, empty = false, multiline = false): string {
  if (typeof value !== 'string' || value.length > max || (multiline ? value.includes('\0') : controlCharacters.test(value)) || (!empty && !value.trim())) throw new Error(message);
  return value;
}
function token(value: unknown, max: number, message: string): string {
  const result = bounded(value, max, message);
  if (/\s/.test(result)) throw new Error(message);
  return result;
}
function taskKind(value: unknown): TaskKind {
  if (value !== 'routine' && value !== 'standard' && value !== 'complex') throw new Error('작업 종류는 routine, standard, complex 중 하나여야 합니다.');
  return value;
}
function date(value: unknown): string {
  const result = bounded(value, 40, '정책 저장 날짜가 올바르지 않습니다.');
  if (!Number.isFinite(Date.parse(result))) throw new Error('정책 저장 날짜가 올바르지 않습니다.');
  return result;
}
const matchText = (value: string): string => value.normalize('NFKC').toLowerCase();
const routeKey = (route: PolicyConnectionRoute): string => JSON.stringify([route.connectionId, route.model, route.effort ?? null]);

/** Returns owned objects and refuses duplicate priorities, including malformed IPC input. */
export function normalizePolicyConnections(value: unknown): PolicyConnectionRoute[] {
  if (!Array.isArray(value) || value.length < 1 || value.length > AGENT_POLICY_LIMITS.routesPerRule) throw new Error('정책 연결은 1개부터 8개까지 지정하세요.');
  const routes = Array.from(value, item => {
    const route = object(item, '정책 연결 형식을 확인하세요.');
    const connectionId = bounded(route.connectionId, 200, '정책 연결 ID를 확인하세요.');
    const model = token(route.model, 200, '정책 모델 ID를 확인하세요.');
    return {connectionId, model, ...(route.effort === undefined ? {} : {effort: token(route.effort, 40, '정책 추론 수준을 확인하세요.')})};
  });
  if (new Set(routes.map(routeKey)).size !== routes.length) throw new Error('같은 연결·모델·추론 수준을 정책에 중복 지정할 수 없습니다.');
  return routes;
}

export function normalizeAgentPolicyDraft(value: unknown): AgentPolicyDraft {
  const input = object(value, '정책 형식을 확인하세요.');
  const name = bounded(input.name, AGENT_POLICY_LIMITS.name, '정책 이름은 1~80자로 입력하세요.').trim();
  const description = bounded(input.description, AGENT_POLICY_LIMITS.description, '정책 설명은 2000자 이내로 입력하세요.', true, true).trim();
  const defaultTaskKind = taskKind(input.defaultTaskKind);
  if (!Array.isArray(input.rules) || input.rules.length !== TASK_KINDS.length) throw new Error('단순·반복, 일반, 복잡한 작업 규칙을 하나씩 지정하세요.');
  const parsed = Array.from(input.rules, value => {
    const rule = object(value, '작업 규칙 형식을 확인하세요.');
    const kind = taskKind(rule.taskKind);
    if (!Array.isArray(rule.keywords) || rule.keywords.length > AGENT_POLICY_LIMITS.keywordsPerRule) throw new Error('규칙별 키워드는 32개 이내로 지정하세요.');
    const keywords = Array.from(rule.keywords, keyword => bounded(keyword, AGENT_POLICY_LIMITS.keyword, '각 키워드는 1~80자로 입력하세요.').trim());
    if (new Set(keywords.map(matchText)).size !== keywords.length) throw new Error('같은 규칙 안에 중복 키워드를 지정할 수 없습니다.');
    return {taskKind: kind, keywords, connections: normalizePolicyConnections(rule.connections)};
  });
  if (new Set(parsed.map(rule => rule.taskKind)).size !== TASK_KINDS.length) throw new Error('세 작업 종류의 규칙을 중복 없이 하나씩 지정하세요.');
  return {name, description, defaultTaskKind, rules: TASK_KINDS.map(kind => parsed.find(rule => rule.taskKind === kind)!)};
}

export function normalizeAgentPolicy(value: unknown): AgentPolicy {
  const input = object(value, '저장된 정책 형식을 확인하세요.');
  const draft = normalizeAgentPolicyDraft(input);
  const id = token(input.id, 100, '정책 ID를 확인하세요.'), createdAt = date(input.createdAt), updatedAt = date(input.updatedAt);
  if (Date.parse(updatedAt) < Date.parse(createdAt)) throw new Error('정책 수정 날짜가 생성 날짜보다 빠릅니다.');
  return {...draft, id, createdAt, updatedAt};
}

/** Literal, Unicode-normalized, case-insensitive matching; never executes keywords as regex. */
export function classifyPolicyTask(policy: AgentPolicyDraft, text: string, explicitTaskKind?: TaskKind): {taskKind: TaskKind; reason: string} {
  const normalized = normalizeAgentPolicyDraft(policy);
  if (explicitTaskKind !== undefined) {
    const kind = taskKind(explicitTaskKind);
    return {taskKind: kind, reason: `명시한 작업 종류: ${labels[kind]}`};
  }
  if (typeof text !== 'string') throw new Error('정책을 적용할 작업 내용을 확인하세요.');
  const haystack = matchText(text);
  for (const kind of ['complex', 'routine', 'standard'] as const) {
    const rule = normalized.rules.find(rule => rule.taskKind === kind)!;
    const keyword = rule.keywords.find(keyword => haystack.includes(matchText(keyword)));
    if (keyword !== undefined) return {taskKind: kind, reason: `키워드 “${keyword}”에 따라 ${labels[kind]} 규칙 선택`};
  }
  return {taskKind: normalized.defaultTaskKind, reason: `일치하는 키워드가 없어 기본 작업 종류 선택: ${labels[normalized.defaultTaskKind]}`};
}

export function validAgentPolicySelection(value: unknown): value is AgentPolicySelection {
  try {
    const selection = object(value, '정책 선택 형식을 확인하세요.');
    normalizePolicyConnections(selection.connections); taskKind(selection.taskKind);
    bounded(selection.reason, 1000, '정책 선택 이유를 확인하세요.');
    token(selection.policyId, 100, '정책 ID를 확인하세요.');
    bounded(selection.policyName, AGENT_POLICY_LIMITS.name, '정책 이름을 확인하세요.'); date(selection.policyUpdatedAt);
    if (selection.warning !== undefined) bounded(selection.warning, 1000, '정책 알림을 확인하세요.');
    return true;
  } catch { return false; }
}
