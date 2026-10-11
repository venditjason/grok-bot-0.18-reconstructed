import type { RabbitConnection, RabbitConnectionDraft, RabbitRunInput, RabbitRunReceipt, RabbitRunDetail, RabbitEventPage } from '../../source/shared/rabbit-project-api';
export type RabbitRunRecord = { id: string; connectionId: string; connectionSnapshot: RabbitConnection; request: RabbitRunInput; idempotencyKey: string; phase: 'prepared' | 'submitting' | 'accepted' | 'unknown' | 'rejected'; createdAt: string; updatedAt: string; attempts: number; source?: { sessionId: string; agentId?: string; teamRunId?: string }; receipt?: RabbitRunReceipt; detail?: RabbitRunDetail; events?: RabbitEventPage; error?: string };
export type RabbitProfile = RabbitConnection & { hasKey: boolean; verified: boolean };
export type RabbitEditDraft = { draft: RabbitConnectionDraft & { id?: string }; endpoint: string; expectedUpdatedAt: string };
export type RabbitWorkDraft = { objective: string; criteria: string; pending?: { requestId: string; input: RabbitRunInput } };
export const rabbitPreset = 'https://lane.vendit.work/v1/projects/5bedba5c-3539-4e57-b8fd-e0b0351e4f34/runs';
export function blankRabbitEdit(): RabbitEditDraft {
  return { draft: { name: '', baseUrl: '', projectId: '', baseRef: 'main', workflowTemplate: 'feature_pr', maxParallelTasks: 1, timeoutSeconds: 3600, enabledForAgents: false, preferForProjectTasks: false }, endpoint: '', expectedUpdatedAt: '' };
}
export function rabbitEditFor(profile: RabbitProfile): RabbitEditDraft {
  return { draft: { id: profile.id, name: profile.name, baseUrl: profile.baseUrl, projectId: profile.projectId, ...(profile.repositoryId ? { repositoryId: profile.repositoryId } : {}), baseRef: profile.baseRef, workflowTemplate: profile.workflowTemplate, maxParallelTasks: profile.maxParallelTasks, timeoutSeconds: profile.timeoutSeconds, enabledForAgents: profile.enabledForAgents, preferForProjectTasks: profile.preferForProjectTasks === true, ...(profile.allowInsecureLoopback ? { allowInsecureLoopback: true } : {}) }, endpoint: `${profile.baseUrl}/v1/projects/${profile.projectId}/runs`, expectedUpdatedAt: profile.updatedAt };
}
export function rabbitRunLabel(run: RabbitRunRecord): string {
  const remote = run.detail?.state;
  if (remote) return ({ queued: '대기 중', running: '실행 중', completed: '완료', succeeded: '완료', failed: '실패', blocked: '차단됨', cancelled: '취소됨' } as Record<string, string>)[remote] ?? remote;
  return ({ prepared: '전송 준비됨', submitting: '접수 확인 중', accepted: '202 접수됨 · 완료 전', unknown: '접수 여부 확인 필요', rejected: '접수 거절됨' })[run.phase];
}
export function mergeRabbitRun(runs: RabbitRunRecord[] = [], result: RabbitRunRecord): RabbitRunRecord[] {
  const current = runs.find(item => item.id === result.id);
  if (current && current.updatedAt > result.updatedAt) return runs;
  return [result, ...runs.filter(item => item.id !== result.id)];
}
