/** Safe, bounded metadata only. Provider messages, diagnostics and credentials never enter this DTO. */
export const PROVIDER_FAILURE_CODES = ['authentication', 'permission', 'context-limit', 'usage-limit', 'rate-limit', 'overloaded', 'service-unavailable', 'policy', 'bad-request', 'connection', 'timeout', 'cancelled', 'protocol', 'unknown'] as const;
export type ProviderFailureCode = typeof PROVIDER_FAILURE_CODES[number];
export interface SafeProviderFailure {
  provider: 'codex' | 'claude-code';
  code: ProviderFailureCode;
  phase: 'preflight' | 'start' | 'stream' | 'steer';
  outcome: 'not-sent' | 'unknown';
  autoRetry: false;
  httpStatus?: number;
}
export function validSafeProviderFailure(raw: unknown): raw is SafeProviderFailure {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return false;
  const v = raw as Record<string, unknown>;
  return Object.keys(v).every(k => ['provider','code','phase','outcome','autoRetry','httpStatus'].includes(k))
    && ['codex','claude-code'].includes(v.provider as string) && PROVIDER_FAILURE_CODES.includes(v.code as ProviderFailureCode)
    && ['preflight','start','stream','steer'].includes(v.phase as string) && ['not-sent','unknown'].includes(v.outcome as string) && v.autoRetry === false
    && (v.httpStatus === undefined || Number.isInteger(v.httpStatus) && (v.httpStatus as number) >= 400 && (v.httpStatus as number) <= 599);
}
export interface ActiveProviderTurn {
  provider: 'codex'; capability: 'steer'; clientConversationId: string; attemptId: string; threadId: string; turnId: string;
}
export interface ProviderSteerInput { clientConversationId: string; attemptId: string; expectedTurnId: string; clientMessageId: string; text: string }
interface SteerBinding { clientConversationId: string; attemptId: string; clientMessageId: string; turnId: string }
export type ProviderSteerResult = (SteerBinding & {state: 'accepted' | 'not-active-before-wire' | 'unsupported-before-wire' | 'conflict-before-wire'})
  | (SteerBinding & {state: 'unknown'; safeProviderFailure: SafeProviderFailure});
