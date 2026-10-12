export type SecureStorageErrorCode = 'pending' | 'timeout' | 'failed' | 'unavailable';

const messages: Record<SecureStorageErrorCode, string> = {
  pending: '이전 macOS 보안 저장소 요청이 아직 처리 중입니다. 시스템 확인 창을 마친 뒤 다시 시도하세요.',
  timeout: 'macOS 보안 저장소 응답 시간이 초과되었습니다. 저장된 연결 정보는 변경하지 않았습니다. 시스템 키체인 확인 창을 마친 뒤 연결 버튼을 다시 누르세요.',
  failed: 'macOS 보안 저장소 요청에 실패했습니다. 저장된 연결 정보는 보존했습니다. 시스템 키체인 접근을 확인한 뒤 다시 시도하세요.',
  unavailable: 'macOS 보안 저장소를 사용할 수 없어 연결 정보를 읽거나 저장하지 않았습니다.',
};

/** Only locally classified failures may cross the renderer boundary; native details never do. */
export class SecureStorageError extends Error {
  constructor(readonly code: SecureStorageErrorCode) { super(messages[code]); this.name = 'SecureStorageError'; }
}

export function secureStorageErrorMessage(error: SecureStorageError): string {
  return messages[error.code] ?? messages.failed;
}
