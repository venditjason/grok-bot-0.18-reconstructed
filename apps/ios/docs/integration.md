# Companion 연결 경계

## 기준 소스

- 초기 검토한 데스크톱 소스 revision `a9f633e09d49a85829b8236331b9e21f7e612634`
- 데스크톱 `source/shared/rabbit-project-api.ts`: RunDetail 형태, 프로젝트·작업 UUID와 event cursor 검증
- 데스크톱 `source/venditbot/rabbit-project-client.ts`: `X-Project-API-Key`와 `GET /v1/runs/{id}`, 리디렉션 금지 계약
- Rabbit 저장소의 `docs/project-api.md`, `docs/openapi.yaml`: 프로젝트 키 범위와 소유자 세션 구분. 이 OpenAPI는 저장소 조회/작업 접수의 부분 계약이며 Run 상세 조회는 데스크톱의 구현 계약을 참조함

위 소스를 읽기만 했습니다. 운영 배포·실행 상태는 별도 업무의 실제 관측 결과에 따릅니다.

## 현재 흐름

사용자가 입력한 HTTPS origin → 기기에 보관한 프로젝트 키 → 고정 경로의 작업 조회 → JSON/프로젝트/작업/cursor 검사 → 상태와 마지막 확인 시각 표시.

설정한 origin 외의 URL이나 서버가 반환한 poll URL, Location은 따라가지 않습니다. ephemeral URLSession, 쿠키/캐시/credential storage 비활성화, 20초 요청·30초 리소스 제한, 1 MiB 바디 상한을 적용합니다. API 키가 응답의 표시 문자열에 그대로 반사되면 화면 출력 전 삭제합니다. 오류에는 서버 원문 바디나 인증 헤더를 표시하지 않습니다.

프로젝트 키는 서버 origin과 프로젝트 UUID별로 Keychain에 격리합니다. 연결 주소·프로젝트 ID·작업 ID만 UserDefaults에 저장됩니다. 입력한 키는 설정 화면 종료 시 지웁니다. 동기화·백업으로 키를 옮기지 않는 `WhenUnlockedThisDeviceOnly` 접근성을 사용합니다.

## 후속 단계

1. 정식 Xcode로 iOS 시뮬레이터 빌드, 좁은 화면·Dynamic Type·VoiceOver와 설정 취소/오류 흐름 확인.
2. 전용 `runs:read` 프로젝트 키로 운영 또는 스테이징 작업 조회. 401/403, 연결 끊김, 다른 프로젝트 ID, 서버 변경 응답을 실제 HTTPS 서버에서 검증.
3. 실기기 Keychain 저장·삭제·잠금 상태와 앱 수명주기 검증 후 Personal Team/Ad Hoc 설치 확인.
4. 원격 에이전트·팀 지시는 인증된 Companion gateway 계약을 먼저 결정. 기기별 단기 세션, 서버 측 소유자/대상 권한 검사, 접수 멱등성, 취소/승인 정책과 추적 가능한 접수증을 설계.
5. 서버의 기존 계정 런타임이 실행을 담당하고 아이폰은 명령·상태 UI를 담당. 데스크톱 내부 IPC나 CLI 구독 계정의 로그인 파일을 폰에 복사하지 않음.

현재 지시 화면의 공유는 iOS 공유 시트를 여는 기능이며 원격 작업 생성 API를 호출하지 않습니다. 모델·레인·추론 수준 설정은 프로젝트 키 API가 지원하지 않는 소유자 기능이므로 생성하지 않았습니다. 운영 키, 팀 정보, 로그인/OAuth를 추측해 구현하지 않습니다.
