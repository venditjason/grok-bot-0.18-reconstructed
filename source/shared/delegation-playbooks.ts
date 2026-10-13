/** Browser-safe immutable application manuals. IDs are shared with Rabbit; bodies and hashes are app-owned. */
export const PLAYBOOK_IDS = ['evidence-development', 'bug-improvement-loop', 'repeatable-task-manual'] as const;
export type PlaybookTemplateId = typeof PLAYBOOK_IDS[number];
export type PlaybookSnapshot = {id: PlaybookTemplateId; version: 1; sha256: string};
export function playbookTemplateId(value: unknown): PlaybookTemplateId {
  if (!PLAYBOOK_IDS.includes(value as PlaybookTemplateId)) throw new Error('지원하지 않는 업무 매뉴얼입니다. 정책에서 다시 선택하세요.');
  return value as PlaybookTemplateId;
}
export const PLAYBOOK_TEMPLATES = Object.freeze([
  Object.freeze({"id": "evidence-development", "label": "검증형 개발", "purpose": "계획부터 실제 검사와 검토 근거까지 연결합니다.", "version": 1, "sha256": "14ae68f72deae6fef0dc64115a736d4ce5d5c6aa87f73684e74aa13b17351d14", "body": "개발 입력과 변경할 파일을 확인하고 계획·소유권을 정한다. 구현 뒤 변경과 직접 관련된 검사를 실제로 실행한다. 독립 검토가 가능한 경우 별도 검토자에게 변경과 검사 근거를 제공하며, 없으면 독립 검토 unavailable을 명시한다. 실제 검증 영수증 없이 개발·PR·병합 완료라고 단정하지 않는다.\n\n현재 요청에는 아래의 저장된 업무 매뉴얼 한 가지를 적용한다. 작업 시작 계기, 입력의 위치, 수행 순서, 판단 규칙, 완료 기준, 예외를 현재 요청에서 정리한다. 이미 주어진 내용을 다시 질문하지 말고 필수 정보가 실제로 없을 때만 확인한다.\n허용된 도구와 확인된 참조를 재사용한다. 도구가 없거나 거절되면 해당 항목을 unavailable 또는 fail로 남기며 수행했다고 말하지 않는다. 실제 검사 결과, 원문 링크, 관찰한 화면, 검증된 산출물 식별자를 근거로 pass·fail·skipped·unavailable을 구분한다. 모델의 성공 주장이나 도구 호출 종료만으로 작업 검증이 통과한 것은 아니다.\n실패는 절차 누락, 재사용 자료 결함, 검사 부족 중 원인을 분류하고 최소 수정 후 관련 검사를 다시 수행한다. 반복 결함에는 회귀 방지 규칙을 제안한다. 여러 항목이 실패하면 후속 실행 전에 절차를 재검토한다. 병렬 작업은 파일 소유권을 나누고 통합 담당을 한 명으로 둔다.\n매뉴얼은 현재 승인된 쓰기 범위에서만 수정한다. 읽기 전용 또는 review_only에서는 수정안을 제시하며 파일·PR을 쓰지 않는다. 이 매뉴얼은 승인, VDS, 도구 권한을 추가하지 않는다. 원격 요청의 결과가 불명확하면 기존 요청 ID로 상태를 확인하며 로컬 실행이나 새 POST로 반복하지 않는다.\n재사용 자료에 비밀키, 비공개 대화, 고객 음성·전사, 검토되지 않은 임시 초안을 포함하지 않는다. 결과에는 사용한 매뉴얼 ID·버전, 확인한 근거, 실패·미수행 항목, 남은 한계와 허용된 범위에서 반영한 변경을 구분한다."}),
  Object.freeze({"id": "bug-improvement-loop", "label": "버그·개선 루프", "purpose": "재현, 최소 수정, 회귀 검사와 매뉴얼 보완을 연결합니다.", "version": 1, "sha256": "dbc6cdeb1a961dd420b77f01f894d46332b29a2f53f371c483c18c65a6a0533d", "body": "먼저 기대 동작과 관찰된 실패를 분리하고 재현 근거를 수집한다. 원인을 확인한 최소 수정만 수행한다. 수정 전 실패를 잡는 회귀 검사를 마련하고 같은 입력으로 다시 확인한다. 재현하지 못한 문제는 원인 확정이나 해결로 표시하지 않는다. 절차·재사용 자료·검사 중 바꾼 부분을 기록한다.\n\n현재 요청에는 아래의 저장된 업무 매뉴얼 한 가지를 적용한다. 작업 시작 계기, 입력의 위치, 수행 순서, 판단 규칙, 완료 기준, 예외를 현재 요청에서 정리한다. 이미 주어진 내용을 다시 질문하지 말고 필수 정보가 실제로 없을 때만 확인한다.\n허용된 도구와 확인된 참조를 재사용한다. 도구가 없거나 거절되면 해당 항목을 unavailable 또는 fail로 남기며 수행했다고 말하지 않는다. 실제 검사 결과, 원문 링크, 관찰한 화면, 검증된 산출물 식별자를 근거로 pass·fail·skipped·unavailable을 구분한다. 모델의 성공 주장이나 도구 호출 종료만으로 작업 검증이 통과한 것은 아니다.\n실패는 절차 누락, 재사용 자료 결함, 검사 부족 중 원인을 분류하고 최소 수정 후 관련 검사를 다시 수행한다. 반복 결함에는 회귀 방지 규칙을 제안한다. 여러 항목이 실패하면 후속 실행 전에 절차를 재검토한다. 병렬 작업은 파일 소유권을 나누고 통합 담당을 한 명으로 둔다.\n매뉴얼은 현재 승인된 쓰기 범위에서만 수정한다. 읽기 전용 또는 review_only에서는 수정안을 제시하며 파일·PR을 쓰지 않는다. 이 매뉴얼은 승인, VDS, 도구 권한을 추가하지 않는다. 원격 요청의 결과가 불명확하면 기존 요청 ID로 상태를 확인하며 로컬 실행이나 새 POST로 반복하지 않는다.\n재사용 자료에 비밀키, 비공개 대화, 고객 음성·전사, 검토되지 않은 임시 초안을 포함하지 않는다. 결과에는 사용한 매뉴얼 ID·버전, 확인한 근거, 실패·미수행 항목, 남은 한계와 허용된 범위에서 반영한 변경을 구분한다."}),
  Object.freeze({"id": "repeatable-task-manual", "label": "반복업무 매뉴얼", "purpose": "반복 업무의 순서와 검증 기준을 작성하거나 실행합니다.", "version": 1, "sha256": "e1aea0338cba3655e4c3c808850ef64f67fdd30e595a603f2b87fd0c2823eb58", "body": "업무의 시작 조건, 입력 참조, 순서, 분기 규칙, 완료 조건과 알려진 예외를 한 매뉴얼로 정리한다. 이미 선택된 매뉴얼이 있으면 그 버전을 기준으로 실행한다. 반복 사용할 도구·양식의 위치와 실제 사용 여부를 기록한다. 제안한 매뉴얼 개정과 저장된 개정을 구분하고, 변경은 다음 요청에 적용한다.\n\n현재 요청에는 아래의 저장된 업무 매뉴얼 한 가지를 적용한다. 작업 시작 계기, 입력의 위치, 수행 순서, 판단 규칙, 완료 기준, 예외를 현재 요청에서 정리한다. 이미 주어진 내용을 다시 질문하지 말고 필수 정보가 실제로 없을 때만 확인한다.\n허용된 도구와 확인된 참조를 재사용한다. 도구가 없거나 거절되면 해당 항목을 unavailable 또는 fail로 남기며 수행했다고 말하지 않는다. 실제 검사 결과, 원문 링크, 관찰한 화면, 검증된 산출물 식별자를 근거로 pass·fail·skipped·unavailable을 구분한다. 모델의 성공 주장이나 도구 호출 종료만으로 작업 검증이 통과한 것은 아니다.\n실패는 절차 누락, 재사용 자료 결함, 검사 부족 중 원인을 분류하고 최소 수정 후 관련 검사를 다시 수행한다. 반복 결함에는 회귀 방지 규칙을 제안한다. 여러 항목이 실패하면 후속 실행 전에 절차를 재검토한다. 병렬 작업은 파일 소유권을 나누고 통합 담당을 한 명으로 둔다.\n매뉴얼은 현재 승인된 쓰기 범위에서만 수정한다. 읽기 전용 또는 review_only에서는 수정안을 제시하며 파일·PR을 쓰지 않는다. 이 매뉴얼은 승인, VDS, 도구 권한을 추가하지 않는다. 원격 요청의 결과가 불명확하면 기존 요청 ID로 상태를 확인하며 로컬 실행이나 새 POST로 반복하지 않는다.\n재사용 자료에 비밀키, 비공개 대화, 고객 음성·전사, 검토되지 않은 임시 초안을 포함하지 않는다. 결과에는 사용한 매뉴얼 ID·버전, 확인한 근거, 실패·미수행 항목, 남은 한계와 허용된 범위에서 반영한 변경을 구분한다."}),
 ] as const);
export function pinPlaybook(value: unknown): PlaybookSnapshot {
  const id = playbookTemplateId(value), manual = PLAYBOOK_TEMPLATES.find(item => item.id === id)!;
  return {id, version: manual.version, sha256: manual.sha256};
}
export function validPlaybookSnapshot(value: unknown): value is PlaybookSnapshot {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  const input = value as PlaybookSnapshot;
  try { const pinned = pinPlaybook(input.id); return input.version === pinned.version && input.sha256 === pinned.sha256 && Object.keys(input).every(key => ['id','version','sha256'].includes(key)); } catch { return false; }
}
export function playbookInstructions(snapshot: PlaybookSnapshot): string {
  if (!validPlaybookSnapshot(snapshot)) throw new Error('저장된 업무 매뉴얼 버전 또는 내용 해시를 확인할 수 없습니다.');
  const manual = PLAYBOOK_TEMPLATES.find(item => item.id === snapshot.id)!;
  return `적용 업무 매뉴얼: ${manual.label} (${snapshot.id}) / v${snapshot.version} / SHA-256 ${snapshot.sha256}\n${manual.body}`;
}
/** Host tool observations are evidence of calls, never a semantic task-success verdict. */
export function playbookEvidence(tools: readonly {status?: string; output?: unknown}[] = []) {
  let completed = 0, failed = 0, pending = 0;
  for (const tool of tools) {
    const output = tool.output && typeof tool.output === 'object' ? tool.output as Record<string, unknown> : undefined;
    if (tool.status === 'failed' || output?.written === false || output?.error !== undefined) failed++;
    else if (tool.status === 'completed') completed++;
    else pending++;
  }
  return {completed, failed, pending, verification: 'unverified' as const};
}
