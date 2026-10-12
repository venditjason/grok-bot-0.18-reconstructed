# App Store 공개 없이 설치하기

2026-10-12 Apple 공식 문서 확인. 결론은 **가능**입니다. 다만 무료 직접 설치, 등록 기기 배포, 베타 배포는 운영 방식이 다릅니다.

| 방식 | App Store 공개 등록 | 준비/제약 | 이 프로젝트에서의 용도 |
|---|---|---|---|
| Xcode Personal Team | 불필요 | 무료 Apple 계정·Mac의 Xcode·개인 기기, 프로비저닝 7일 후 재빌드/재설치, 최대 3기기·기기당 3앱 | 먼저 본인 iPhone에서 검증 |
| Ad Hoc | 불필요 | 유료 Apple Developer Program, 기기 UDID 등록·서명 프로필, 제품군별 연간 최대 100기기 | 소수 등록 기기에 설치 배포 |
| TestFlight | 공개 출시 불필요, App Store Connect 앱 레코드와 업로드 필요 | 유료 계정, 빌드당 최대 90일, 첫 외부 테스트 빌드 심사 | 베타 배포·업데이트 편의가 필요할 때 |
| Safari 웹 앱/PWA | 불필요 | HTTPS 웹 서비스와 Safari 홈 화면 추가, 네이티브 `.ipa` 설치가 아님 | 빠른 모바일 웹 접근이 우선일 때 |

무료 Personal Team 제약은 Apple의 [Developer account overview](https://developer.apple.com/help/account/basics/about-your-developer-account)를 기준으로 합니다. 무료 앱은 영구 설치가 아니며, 재프로비저닝이 필요합니다.

Ad Hoc은 [등록 기기에 배포](https://developer.apple.com/documentation/xcode/distributing-your-app-to-registered-devices) 방식으로 베타 심사 없이 사용할 수 있습니다. [등록 기기 수 제한](https://developer.apple.com/help/account/devices/devices-overview/)은 제품군별·회원 연도별 100대입니다. [프로비저닝 프로필](https://developer.apple.com/documentation/technotes/tn3125-inside-code-signing-provisioning-profiles)의 유효기간은 종류에 따라 다르며 보통 1년을 넘지 않습니다. 실제 배포물의 `ExpirationDate`와 인증서 상태를 확인하고 만료 전 갱신해야 하므로 영구 설치로 보장하지 않습니다.

Apple이 안내하는 [Developer Program](https://developer.apple.com/programs/) 기본 멤버십은 연 USD 99입니다. 실제 한국 결제 금액은 계정의 현지 결제 화면을 확인해야 합니다. 현재 결제나 가입은 진행하지 않았습니다.

[TestFlight 공식 안내](https://developer.apple.com/help/app-store-connect/test-a-beta-version/testflight-overview/)에 따라 App Store 공개 출시 없이 베타 설치가 가능합니다. 앱 빌드는 최대 90일 후 만료됩니다. 외부 테스트의 첫 빌드는 App Review에 제출되며, 후속 빌드도 심사가 요구될 수 있습니다. 공개 App Store 등록 자체를 피하려는 목적과 App Store Connect를 전혀 사용하지 않으려는 목적은 구분해야 합니다.

웹 앱은 Apple의 [Safari 홈 화면 앱 안내](https://support.apple.com/guide/iphone/open-as-web-app-iphea86e5236/ios)를 따르면 됩니다. iOS 버전에 따라 메뉴가 다를 수 있습니다. 이 저장소에서 PWA 배포는 하지 않았습니다.

## 우선 적용 경로

본인 iPhone 한 대로 기능을 검증한다면 무료 Xcode 직접 설치로 시작하고, 7일마다 재설치하기 어렵거나 소수 기기로 확대할 때 Ad Hoc을 검토합니다. 팀 배포 업데이트가 중요하면 TestFlight가 대안입니다.

실제 설치에는 정식 Xcode/iOS SDK, 선택한 Apple Team의 서명, 연결된 기기의 신뢰/Developer Mode 설정이 필요합니다. 이 준비 없이 생성한 소스만으로 설치 완료를 주장할 수 없습니다. 현재 기기 모델·iOS 버전·Apple Team은 확인하지 않았으며 계정 로그인·가입·기기 페어링·인증서 생성은 수행하지 않았습니다.
