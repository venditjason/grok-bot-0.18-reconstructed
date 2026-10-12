# 벤디트봇 iPhone Companion

App Store에 공개하지 않고 개인 기기에서 테스트할 수 있는 SwiftUI 초기 프로토타입입니다. **서명된 iOS 앱이나 설치 완료 결과물이 아닙니다.** 데스크톱 저장소의 `apps/ios`에 포함되며 Rabbit 서버와 연동합니다.

## 구현 범위

- Rabbit `GET /v1/runs/{run UUID}` 상태 조회, 최근 확인 시각, 차단 사유 표시
- HTTPS 서버·프로젝트·작업 ID 검증, 리디렉션 거부, JSON/응답 크기 제한
- 프로젝트 키를 iPhone Keychain `WhenUnlockedThisDeviceOnly`에 저장·삭제. 키는 URL, UserDefaults, 파일, 로그에 저장하지 않음
- 에이전트/팀을 대상으로 목표·완료 기준을 작성하고 iOS 공유 기능으로 내보내는 **미전송 초안**
- 설치 방법 안내

초안은 메모리에만 유지됩니다. 실행 중 탭 전환에서는 유지되지만 앱 종료/프로세스 정리 시 사라집니다. 원격 지시 전송, 계정 로그인, 팀 동기화, 실행·취소·승인, 알림은 아직 구현하지 않았습니다. 운영 서버의 실행 가능 여부를 앱이 보증하지 않습니다.

## 실행 준비

1. Swift 6을 지원하는 정식 Xcode와 iOS SDK를 준비합니다.
2. `VenditBotCompanion.xcodeproj`를 Xcode에서 엽니다. 외부 패키지 다운로드나 프로젝트 생성기가 필요 없습니다.
3. `VenditBotCompanion` target → Signing & Capabilities에서 본인의 Team을 선택합니다. Bundle Identifier를 팀에서 사용 가능한 고유 값으로 지정합니다.
4. 시뮬레이터에서 빌드·화면 확인 후, 설치할 iPhone을 개발 기기로 연결하고 필요한 Developer Mode를 켭니다.
5. Xcode Run으로 설치합니다. 무료 Personal Team은 7일 프로비저닝 만료 후 다시 빌드·설치해야 합니다.

연결 설정에는 Rabbit HTTPS 기본 주소(경로 없이), 프로젝트 UUID, 기존 작업 UUID, `runs:read` 권한의 프로젝트 키를 입력합니다. 최초 주소는 비워 두었습니다. Apple/OpenAI/Claude 계정 비밀번호나 로그인 토큰을 입력하는 화면은 없습니다.

## 검증

Apple Command Line Tools만 있는 이 Mac에서 공통 코어 계약을 검사하려면 다음 명령을 실행합니다.

```sh
./scripts/check-local.sh
```

Xcode가 설치된 환경에서는 표준 XCTest도 실행할 수 있습니다.

```sh
swift test
xcodebuild -project VenditBotCompanion.xcodeproj -scheme VenditBotCompanion \
  -destination 'generic/platform=iOS Simulator' CODE_SIGNING_ALLOWED=NO build
```

`check-local.sh`는 XCTest 테스트 본문과 동일한 검사를 독립 Swift 실행 파일로 수행합니다. 외부 서버·실제 API 키·Keychain을 사용하지 않습니다. `.build`는 로컬 빌드 산출물이며 공유 대상이 아닙니다. Xcode 프로젝트에는 앱 타깃만 있으며 코어 XCTest는 Swift Package의 테스트 타깃에서 실행합니다.

2026-10-12 확인 시 이 Mac은 `/Library/Developer/CommandLineTools`를 사용하고 `iphoneos` SDK와 Xcode가 없습니다. iPhone 빌드·시뮬레이터·기기 서명·실기기 설치는 미검증입니다. 초기 검증 기록은 `docs/prototype-verification.json`에 보관합니다. 현재 실기기 완료 증거는 없습니다.

- [상세 개발지시서](docs/development-instructions.md)
- [설치 선택과 Apple 공식 근거](docs/installation.md)
- [기존 서비스와의 연결 경계](docs/integration.md)
