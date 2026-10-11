/** User-owned host rules, shared with the renderer. Never inferred from model text. */
export const ACTION_RULE_CATEGORIES = ['repository_delete', 'project_delete', 'destructive_change', 'history_rewrite', 'security_change', 'production_change', 'sensitive_disclosure', 'external_publish', 'financial_action', 'privilege_escalation', 'untrusted_execution', 'policy_change'] as const;
export type ActionRuleCategory = typeof ACTION_RULE_CATEGORIES[number];
export type ActionRuleMode = 'allow' | 'ask' | 'deny';
export type ActionRules = {
  version: 1;
  updatedAt: string;
  defaultMode: ActionRuleMode;
  rules: {category: ActionRuleCategory; mode: 'ask' | 'deny'}[];
  protectedPaths: {id: string; pathPrefix: string; mode: 'ask' | 'deny'}[];
};
export type ActionRuleRequest = {category: 'routine' | ActionRuleCategory; categories?: readonly ActionRuleCategory[]; tool: string; path?: string};
export type ActionRuleDecision = {mode: ActionRuleMode; ruleIds: string[]; reason: string};
export const ACTION_RULE_LIMITS = Object.freeze({protectedPaths: 100, path: 4096, id: 100});
export const ACTION_RULE_METADATA: readonly {category: ActionRuleCategory; label: string; description: string; examples: readonly string[]; support: string}[] = [
  {category: 'repository_delete', label: '저장소 삭제', description: '저장소와 복구 가능한 이력을 없애는 작업입니다.', examples: ['GitHub 저장소 삭제', '로컬 저장소 전체 삭제'], support: '현재 저장소 삭제 도구는 제공하지 않습니다.'},
  {category: 'project_delete', label: '프로젝트 삭제', description: '프로젝트 또는 작업 자료를 통째로 제거하는 작업입니다.', examples: ['프로젝트 폴더 삭제', '작업 공간 초기화'], support: '현재 폴더·프로젝트 삭제 도구는 제공하지 않습니다.'},
  {category: 'destructive_change', label: '기존 내용 변경', description: '기존 파일이나 데이터를 덮어쓰거나 잃을 수 있는 작업입니다.', examples: ['기존 파일 덮어쓰기', '데이터 초기화'], support: '현재 파일 쓰기 도구의 기존 파일 덮어쓰기에 적용합니다.'},
  {category: 'history_rewrite', label: '이력 재작성', description: '공유 이력이나 되돌리기에 필요한 기록을 바꾸는 작업입니다.', examples: ['강제 푸시', '공유 커밋 이력 재작성'], support: '현재 Git 실행 도구는 제공하지 않습니다.'},
  {category: 'security_change', label: '보안·실행 설정 변경', description: '접근 권한이나 실행 동작에 영향을 주는 설정 변경입니다.', examples: ['빌드·패키지 실행 설정 수정', '보안 관련 설정 파일 수정'], support: '현재 파일 쓰기 도구에서 알려진 실행·보안 설정 경로를 확인합니다. 모든 위험을 자동 탐지하지는 않습니다.'},
  {category: 'production_change', label: '운영 환경 변경', description: '실제 서비스나 운영 데이터에 영향을 주는 변경입니다.', examples: ['운영 서비스 배포', '운영 데이터 변경'], support: '현재 배포·운영 제어 도구는 제공하지 않습니다. 로컬 운영 자료는 보호 경로로 지정할 수 있습니다.'},
  {category: 'sensitive_disclosure', label: '민감 정보 전달', description: '개인 정보나 비밀 값이 모델 또는 외부로 전달될 수 있는 작업입니다.', examples: ['개인 정보가 포함된 파일 읽기', '민감 내용이 포함된 검색 결과 전달'], support: '현재 읽기·검색 도구는 알려진 민감 내용 패턴을 확인합니다. 탐지는 완전하지 않으며 자격증명 경로는 승인 여부와 관계없이 차단합니다.'},
  {category: 'external_publish', label: '외부 게시·전송', description: '로컬 작업 공간 밖으로 게시하거나 다른 사람에게 전송하는 작업입니다.', examples: ['프로젝트 API 작업 접수', '공개 게시', '외부 이메일·메시지 전송'], support: 'Rabbit 프로젝트 API 작업 접수와 재시도에 적용합니다. 원격 작업 내부의 파일 변경·PR 게시 등은 Rabbit의 권한과 정책을 따릅니다. 팀 내부 메시지는 외부 전송에 포함되지 않습니다.'},
  {category: 'financial_action', label: '결제·금전 작업', description: '비용 지출이나 금전 이동을 직접 실행하는 작업입니다.', examples: ['구매 확정', '송금'], support: '현재 구매·송금 도구는 제공하지 않습니다. 모델 이용료는 이 규칙의 대상에 포함되지 않습니다.'},
  {category: 'privilege_escalation', label: '권한 상승', description: '현재 작업에 허용된 범위보다 높은 권한을 요청하는 작업입니다.', examples: ['관리자 권한 실행', '접근 권한 확대'], support: '현재 관리자·셸 실행 도구는 제공하지 않습니다.'},
  {category: 'untrusted_execution', label: '검증되지 않은 코드 실행', description: '외부에서 가져온 코드나 신뢰를 확인하지 않은 명령 실행입니다.', examples: ['내려받은 스크립트 실행', '외부 명령 실행'], support: '현재 임의 코드·셸 실행 도구는 제공하지 않습니다.'},
  {category: 'policy_change', label: '앱 안전 규칙 변경', description: '앱이 실행을 승인하거나 차단하는 안전 규칙 자체를 변경하는 작업입니다.', examples: ['에이전트가 승인 규칙 완화', '안전 제한 해제'], support: '에이전트에는 안전 규칙 편집 도구를 제공하지 않습니다. 사용자가 설정 화면에서 직접 변경합니다. 팀 운영 지침 편집과는 구분합니다.'},
];

const initialTimestamp = '2026-10-11T00:00:00.000Z';
/** A stable initial revision makes the absent-file state safe for editor CAS. */
export const DEFAULT_ACTION_RULES: ActionRules = {
  version: 1, updatedAt: initialTimestamp, defaultMode: 'allow',
  rules: ACTION_RULE_CATEGORIES.map(category => ({category, mode: category === 'untrusted_execution' || category === 'policy_change' ? 'deny' : 'ask'})),
  protectedPaths: [],
};
DEFAULT_ACTION_RULES.rules.forEach(Object.freeze);
Object.freeze(DEFAULT_ACTION_RULES.rules); Object.freeze(DEFAULT_ACTION_RULES.protectedPaths); Object.freeze(DEFAULT_ACTION_RULES);
const controls = /[\u0000-\u001f\u007f]/;
function object(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('작업 규칙 형식을 확인하세요.');
  return value as Record<string, unknown>;
}
function bounded(value: unknown, max: number, label: string): string {
  if (typeof value !== 'string' || !value.trim() || value.length > max || controls.test(value)) throw new Error(`${label} 형식 또는 길이를 확인하세요.`);
  return value;
}
function category(value: unknown): ActionRuleCategory {
  if (typeof value !== 'string' || !ACTION_RULE_CATEGORIES.includes(value as ActionRuleCategory)) throw new Error('지원하지 않는 작업 규칙 종류입니다.');
  return value as ActionRuleCategory;
}
function mode(value: unknown, allow: boolean): ActionRuleMode {
  if (value === 'ask' || value === 'deny' || (allow && value === 'allow')) return value;
  throw new Error(allow ? '기본 작업 처리 방식을 확인하세요.' : '위험 작업과 보호 경로에는 승인 요청 또는 차단만 지정할 수 있습니다.');
}

/** Relative directory-segment prefixes only. No glob, regex, URL decoding or
 * filesystem access. The host separately resolves symlinks and scope boundaries. */
function relativePath(value: unknown, prefix: boolean): string {
  const input = bounded(value, ACTION_RULE_LIMITS.path, '보호 경로').trim().normalize('NFC');
  if (input.startsWith('/') || /^[a-z]:/i.test(input) || input.includes('\\')) throw new Error('보호 경로는 작업 폴더 안의 상대 경로로 입력하세요.');
  if (prefix && /[*?\[\]{}()|^$+]/.test(input)) throw new Error('보호 경로에는 와일드카드나 정규식 대신 실제 폴더 경로를 입력하세요.');
  const segments = input.split('/').filter(Boolean);
  if (!segments.length || segments.some(segment => segment === '.' || segment === '..')) throw new Error('보호 경로에 현재·상위 폴더 이동을 사용할 수 없습니다.');
  // Upper/lower folding also covers final sigma and sharp-s variants. Any
  // overmatching is conservative: it can add a restriction, never remove one.
  const normalized = segments.join('/').toUpperCase().toLowerCase().normalize('NFC');
  if (normalized.length > ACTION_RULE_LIMITS.path) throw new Error('보호 경로가 너무 깁니다.');
  return normalized;
}
export const normalizeActionRulePath = (value: unknown): string => relativePath(value, true);

export function normalizeActionRules(value: unknown): ActionRules {
  const input = object(value);
  if (input.version !== 1) throw new Error('지원하지 않는 작업 규칙 버전입니다.');
  const updatedAt = bounded(input.updatedAt, 40, '규칙 저장 날짜');
  if (!Number.isFinite(Date.parse(updatedAt))) throw new Error('규칙 저장 날짜가 올바르지 않습니다.');
  const defaultMode = mode(input.defaultMode, true);
  if (!Array.isArray(input.rules) || input.rules.length !== ACTION_RULE_CATEGORIES.length) throw new Error('12개 위험 작업 규칙을 빠짐없이 지정하세요.');
  const parsed = Array.from(input.rules, value => {const rule = object(value); return {category: category(rule.category), mode: mode(rule.mode, false) as 'ask' | 'deny'};});
  if (new Set(parsed.map(rule => rule.category)).size !== ACTION_RULE_CATEGORIES.length) throw new Error('같은 위험 작업 규칙을 중복 지정할 수 없습니다.');
  if (!Array.isArray(input.protectedPaths) || input.protectedPaths.length > ACTION_RULE_LIMITS.protectedPaths) throw new Error('보호 경로는 최대 100개까지 지정할 수 있습니다.');
  const protectedPaths = Array.from(input.protectedPaths, value => {
    const entry = object(value), id = bounded(entry.id, ACTION_RULE_LIMITS.id, '보호 경로 ID');
    if (/\s/.test(id)) throw new Error('보호 경로 ID에는 공백을 사용할 수 없습니다.');
    return {id, pathPrefix: normalizeActionRulePath(entry.pathPrefix), mode: mode(entry.mode, false) as 'ask' | 'deny'};
  });
  if (new Set(protectedPaths.map(entry => entry.id)).size !== protectedPaths.length || new Set(protectedPaths.map(entry => entry.pathPrefix)).size !== protectedPaths.length) throw new Error('보호 경로와 ID를 중복 지정할 수 없습니다.');
  return {version: 1, updatedAt, defaultMode, rules: ACTION_RULE_CATEGORIES.map(item => parsed.find(rule => rule.category === item)!), protectedPaths};
}

export function evaluateActionRules(value: ActionRules, request: ActionRuleRequest): ActionRuleDecision {
  const settings = normalizeActionRules(value);
  bounded(request.tool, 200, '도구 이름');
  const categories = new Set<ActionRuleCategory>();
  if (request.category !== 'routine') categories.add(category(request.category));
  if (request.categories !== undefined) {
    if (!Array.isArray(request.categories) || request.categories.length > ACTION_RULE_CATEGORIES.length) throw new Error('작업 분류 목록을 확인하세요.');
    for (const value of Array.from(request.categories)) categories.add(category(value));
  }
  const path = request.path === undefined || request.path === '.' ? undefined : relativePath(request.path, false);
  const matches: {id: string; mode: ActionRuleMode; label: string}[] = [{id: 'default', mode: settings.defaultMode, label: '기본 처리'}];
  for (const rule of settings.rules) if (categories.has(rule.category)) matches.push({id: `category:${rule.category}`, mode: rule.mode, label: ACTION_RULE_METADATA.find(item => item.category === rule.category)!.label});
  const protectedMatches = path === undefined ? [] : settings.protectedPaths.filter(rule => path === rule.pathPrefix || path.startsWith(`${rule.pathPrefix}/`));
  for (const rule of protectedMatches) matches.push({id: `path:${rule.id}`, mode: rule.mode, label: '보호 경로'});
  const strength = {allow: 0, ask: 1, deny: 2};
  const finalMode = matches.reduce<ActionRuleMode>((prior, current) => strength[current.mode] > strength[prior] ? current.mode : prior, 'allow');
  const labels = [...new Set(matches.filter(match => match.mode === finalMode).map(match => match.label))];
  const resultLabel = {allow: '자동 허용', ask: '사용자 승인 필요', deny: '작업 차단'}[finalMode];
  return {mode: finalMode, ruleIds: matches.map(match => match.id), reason: `${resultLabel}: ${labels.join(', ')}${protectedMatches.length ? ` · 일치 보호 경로 ${protectedMatches.length}개` : ''}`};
}
