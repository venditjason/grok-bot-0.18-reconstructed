import {validSafeProviderFailure, type SafeProviderFailure, type ProviderFailureCode} from '../provider-turns.js';
const messages: Record<ProviderFailureCode, string> = {
  authentication: '공급자 인증을 확인해야 합니다.', permission: '공급자가 요청 권한을 거절했습니다.',
  'context-limit': '공급자의 대화 길이 제한에 도달했습니다.', 'usage-limit': '공급자의 사용량 제한에 도달했습니다.',
  'rate-limit': '공급자의 요청 빈도 제한에 도달했습니다.', overloaded: '공급자가 현재 과부하 상태입니다.',
  'service-unavailable': '공급자 서비스를 일시적으로 이용할 수 없습니다.', policy: '공급자 정책으로 요청이 중단되었습니다.',
  'bad-request': '요청의 모델·설정을 확인하세요.', connection: '공급자 연결이 종료되었습니다.',
  timeout: '공급자 요청 시간이 초과되었습니다.', cancelled: '요청이 취소되었습니다.',
  protocol: '공급자 응답 형식을 확인할 수 없습니다.', unknown: '공급자 요청이 실패했습니다. 원인 코드를 확인할 수 없습니다.',
};
export class ProviderTurnFailure extends Error {
  readonly safe: Readonly<SafeProviderFailure>;
  constructor(safe: SafeProviderFailure) {
    if (!validSafeProviderFailure(safe)) throw new TypeError('Invalid provider failure metadata.');
    super(messages[safe.code]); this.name = safe.code === 'cancelled' ? 'AbortError' : 'ProviderTurnFailure'; this.safe = Object.freeze({...safe});
  }
}
export function safeProviderFailure(error: unknown): SafeProviderFailure | undefined {
  return error instanceof ProviderTurnFailure ? {...error.safe} : undefined;
}
const codexCodes: Record<string, ProviderFailureCode> = {
  contextWindowExceeded:'context-limit', sessionBudgetExceeded:'usage-limit', usageLimitExceeded:'usage-limit', rateLimitExceeded:'rate-limit',
  serverOverloaded:'overloaded', flexUnavailable:'service-unavailable', internalServerError:'service-unavailable', unauthorized:'authentication', badRequest:'bad-request',
  cyberPolicy:'policy', misalignmentPolicyViolation:'policy', tooManyDenials:'policy', sandboxError:'permission', threadRollbackFailed:'unknown', other:'unknown',
};
const connectionCodes = ['httpConnectionFailed','responseStreamConnectionFailed','responseStreamDisconnected','responseTooManyFailedAttempts'];
/** Pinned Codex 0.162.1 generated ErrorNotification schema. Never inspect message/additionalDetails. */
export function codexTurnFailure(raw: unknown, phase: SafeProviderFailure['phase'] = 'stream'): ProviderTurnFailure {
  const info = raw && typeof raw === 'object' && !Array.isArray(raw) ? (raw as Record<string, unknown>).codexErrorInfo : undefined;
  let code: ProviderFailureCode = 'unknown', httpStatus: number | undefined;
  if (typeof info === 'string' && Object.hasOwn(codexCodes, info)) code = codexCodes[info]!;
  else if (info && typeof info === 'object' && !Array.isArray(info) && Object.keys(info).length === 1) {
    const key = Object.keys(info)[0]!;
    if (connectionCodes.includes(key)) {
      code = 'connection'; const value = (info as Record<string, unknown>)[key];
      const status = value && typeof value === 'object' && !Array.isArray(value) ? (value as Record<string, unknown>).httpStatusCode : undefined;
      if (Number.isInteger(status) && (status as number) >= 400 && (status as number) <= 599) httpStatus = status as number;
      if (httpStatus === 401) code = 'authentication'; else if (httpStatus === 403) code = 'permission';
      else if (httpStatus != null && httpStatus >= 500) code = 'service-unavailable';
    } else if (key === 'activeTurnNotSteerable') code = 'bad-request';
  }
  return new ProviderTurnFailure({provider:'codex',code,phase,outcome:'unknown',autoRetry:false,...(httpStatus == null ? {} : {httpStatus})});
}
/** Unknown thrown objects cannot inject messages, categories, or automatic retry authority. */
export function providerTurnFailure(error: unknown, provider: SafeProviderFailure['provider'], phase: SafeProviderFailure['phase'], sent: boolean): ProviderTurnFailure {
  if (error instanceof ProviderTurnFailure) return error;
  const code = error instanceof Error && error.name === 'AbortError' ? 'cancelled' : 'unknown';
  return new ProviderTurnFailure({provider,code,phase,outcome:sent?'unknown':'not-sent',autoRetry:false});
}
