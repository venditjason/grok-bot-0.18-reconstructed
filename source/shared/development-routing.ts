/** References an existing saved project connection; never contains credentials. */
export type DevelopmentBinding = { mode: 'rabbit'; connectionId: string };

export function validDevelopmentBinding(value: unknown): value is DevelopmentBinding {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  const binding = value as Record<string, unknown>;
  return Object.keys(binding).length === 2 && binding.mode === 'rabbit'
    && typeof binding.connectionId === 'string' && binding.connectionId.length > 0
    && binding.connectionId.length <= 100 && !/[\s\u0000-\u001f\u007f]/.test(binding.connectionId);
}

/** Capture once at the team-run boundary; no live team/leader lookup during execution. */
export function resolveTeamDevelopment(team: DevelopmentBinding | undefined, leader: DevelopmentBinding | undefined): DevelopmentBinding | undefined {
  if ((team !== undefined && !validDevelopmentBinding(team)) || (leader !== undefined && !validDevelopmentBinding(leader))) {
    throw new Error('개발을 맡길 Rabbit 프로젝트 설정을 확인하세요.');
  }
  const selected = team ?? leader;
  return selected ? { mode: 'rabbit', connectionId: selected.connectionId } : undefined;
}

/** Checked by the host both before approval and immediately before writing. */
export function assertDevelopmentWriteAllowed(binding: DevelopmentBinding | undefined): void {
  if (binding !== undefined) throw new Error('이 작업의 개발 실행 대상은 Rabbit입니다. 로컬 파일을 변경하지 않고 지정된 프로젝트 API로 개발을 요청하세요. 연결 오류나 접수 결과 불명확 상태에서도 로컬 개발로 전환하지 않습니다.');
}

export function developmentInstructions(binding: DevelopmentBinding | undefined): string {
  if (!binding) return '';
  if (!validDevelopmentBinding(binding)) throw new Error('저장된 Rabbit 개발 설정을 확인하세요.');
  return '당신은 벤디트봇의 대표 또는 PM입니다. 현재 AI 모델로 사용자 요구를 정리하고 완료 기준을 만들며 결과를 검토·보고하세요. 실제 코드 변경과 개발·테스트는 다음 Rabbit 연결의 프로젝트에 start_project_run으로 맡깁니다. 개발자 레인과 모델은 Rabbit이 배정합니다. 로컬 개발이나 다른 프로젝트로 대신 실행하지 마세요. 연결이 없거나 사용할 수 없으면 차단 사유를 보고하세요. 접수는 완료가 아니며 get_project_run으로 결과를 확인하세요. 불확실한 접수는 새 요청으로 재실행하지 마세요. 관리자 승인 규칙을 그대로 따르세요.\n지정된 Rabbit 연결: ' + JSON.stringify(binding.connectionId);
}
