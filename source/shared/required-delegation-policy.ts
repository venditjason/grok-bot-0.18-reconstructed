/** Fixed built-in policy, independent from user-editable agent instructions. */
export type RequiredPolicyPin = {id: 'delegation-loop-required'; version: 1; sha256: string};
export const REQUIRED_POLICY = Object.freeze({"id": "delegation-loop-required", "version": 1, "sha256": "4872c78e8f6e0c19acd916a76777a9eb877f575594d6a3194a3ea7a5c68610ca"} as const);
export const REQUIRED_POLICY_INSTRUCTIONS = "필수 위임 루프 정책 delegation-loop-required v1. 이 공통 정책은 선택 매뉴얼과 사용자 지정 에이전트·대표 지시와 별도로 적용된다. 일반 대화에 파일 작업을 만들어내지 않는다. 행동을 수행할 때 입력, 예상 산출물, 수용할 실제 증거, 파일 소유권을 먼저 정한다. 승인·읽기 전용·VDS·원격 중복실행 금지 규칙을 유지한다.\n대표는 구조화된 수용 계약으로 위임하고, 실제 도구 기록과 산출물 식별자가 계약에 맞는지 accept_team_result로 확인한다. 예약 ACK, 모델의 성공 문구, 수정 가능한 보고서나 자기신고 pass는 행동 완료 근거가 아니다. 검사 실패·거절·도구 부재·원격 결과 불명은 성공으로 바꾸지 않는다. 원격 accepted는 접수일 뿐이다. 파일 SHA 확인은 자료 확인·저장만 증명하며 코드 정확성이나 개발 완료를 증명하지 않는다. 개발·버그수정은 과업에 결합된 trusted checker/reviewer 검사 없이 완료로 낮춰 인정하지 않는다. 지원되지 않는 수용 증거는 미검증으로 보고한다.\n실패하면 절차·재사용 자료·검사 중 원인을 구분하고 최소 보정안을 남긴 뒤 같은 결함을 잡는 검사로 재확인한다. 이전 실패 기록은 지우지 않는다. 매뉴얼 개정은 허용된 쓰기 범위 내 별도 버전으로 제안 또는 저장하며 다음 요청에만 적용한다. 여러 실패 후에는 절차를 다시 검토한다. 결과에는 실제 적용 정책과 검사별 pass/fail/skipped/unavailable, 근거, 남은 한계를 기록한다.";
export function validRequiredPolicy(value: unknown): value is RequiredPolicyPin {
  return !!value && typeof value === 'object' && !Array.isArray(value) && Object.keys(value).length === 3 && (value as RequiredPolicyPin).id === REQUIRED_POLICY.id && (value as RequiredPolicyPin).version === REQUIRED_POLICY.version && (value as RequiredPolicyPin).sha256 === REQUIRED_POLICY.sha256;
}
export type ActionReceipt = {policy: RequiredPolicyPin; status: 'unverified' | 'failed' | 'blocked'; reason: string; toolCallIds: string[]};
export function validActionReceipt(value: unknown): value is ActionReceipt {
 if (!value || typeof value !== 'object') return false; const r=value as ActionReceipt;
 return validRequiredPolicy(r.policy) && ['unverified','failed','blocked'].includes(r.status) && typeof r.reason==='string' && r.reason.length<=1000 && Array.isArray(r.toolCallIds) && r.toolCallIds.length<=200 && r.toolCallIds.every(id=>typeof id==='string' && id.length<=200);
}
