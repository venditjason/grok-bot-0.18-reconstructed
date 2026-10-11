export type AvatarJob = { requestId: string; ownerKey: string; sessionId?: string; phase: 'validating' | 'queued' | 'running' | 'completed' | 'failed' | 'cancelled'; assetId?: string; error?: string };
export const avatarJobPending = (job?: AvatarJob): boolean => !!job && ['validating', 'queued', 'running'].includes(job.phase);
export function mergeAvatarJob(jobs: AvatarJob[] = [], job: AvatarJob): AvatarJob[] {
  return [job, ...jobs.filter(previous => previous.ownerKey !== job.ownerKey)];
}
