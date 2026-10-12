# 앱 연결

앱 관리에서 **연결**을 누르면 기본 브라우저의 공식 로그인으로 이동합니다. 계정 선택, 공급자의 권한 동의, 조직 관리자 승인 또는 GitHub 기기 코드 입력은 사용자가 완료합니다. 연결 버튼은 이 로그인 절차를 시작하는 동의이며, 연결한 자료를 에이전트에 전달하는 승인은 별도로 적용됩니다.

배포자가 준비한 공개 앱 등록이 있으면 일반 사용자는 Client ID나 비밀 값을 입력하지 않습니다. 등록이 없는 공급자는 **연결 준비 중**으로 표시합니다. 빈 등록을 성공한 설정처럼 표시하거나 다른 제품의 인증 정보를 가져오지 않습니다. `source/venditbot/app-connectors/registrations.ts`의 `MANAGED_APP_REGISTRATIONS`가 배포 등록의 원본이며, 검증한 공개 ID만 들어갈 수 있습니다. 현재 배포 등록은 실제 로그인과 공식 MCP 초기화·도구 목록 검사를 통과한 GitHub·Slack 두 개입니다. Notion은 동적 등록을 사용합니다. Google은 공개 배포 등록에 넣지 않으며, 이 기기에 한 번 입력한 전용 클라이언트 설정을 암호화하여 사용합니다. 설정 전에는 다섯 Google 서비스가 연결 준비 중으로 표시됩니다. 기존 직접 등록은 고급 설정에 남고, 해당 공급자에서 배포 등록보다 우선합니다.

## 상태와 검사 결과

- **연결됨**: OAuth 인증을 이 기기에 저장했습니다. 특정 문서나 저장소에 접근할 수 있다는 보장은 아닙니다.
- **연결 검사**: Google은 실제 읽기 API를 확인합니다. Docs·Sheets는 사용자가 지정한 문서 ID가 필요합니다. Notion·Slack·GitHub는 MCP 초기화와 허용된 도구 목록만 검사합니다.
- **실제 자료 읽기**: 연결 검사와 별개입니다. 에이전트가 현재 연결에 허용된 읽기 도구를 요청하고 사용자의 접근 승인 규칙을 통과해야 합니다.
- 취소, 토큰 만료, 조직 정책 또는 권한 거절은 성공으로 표시하지 않습니다. 재연결 실패 시 기존 인증을 덮어쓰지 않습니다.

## 배포자가 한 번 준비할 등록

Rabbit, GrokBot, 다른 제품의 OAuth 앱·키·토큰을 재사용하지 않습니다. 아래 등록은 VenditBot 전용으로 만들고, 실제 계정 로그인과 공식 MCP 초기화·도구 목록 검사를 완료한 GitHub·Slack 공개 ID만 배포합니다. 이 검사는 실제 저장소·메시지 읽기와 별개입니다. 비밀 값, 토큰, 개인 키, OAuth 다운로드 JSON 전체를 소스나 배포 등록에 넣지 않습니다.

| 공급자 | 배포 등록 | 로그인 방식 | 남는 사용자/관리자 절차 |
| --- | --- | --- | --- |
| Google | 기기별 암호화 Desktop OAuth 설정 (배포 등록 제외) | 시스템 브라우저 + PKCE + 임시 loopback 포트 | 계정 선택·동의, 테스트 사용자 또는 조직 정책 |
| Slack | Client ID + 고정 App ID | PKCE + 고정 localhost 콜백 | 워크스페이스 앱 설치·승인·사용자 동의 |
| GitHub | Client ID + `githubApp` 종류 | 기기 코드 로그인 | 코드 확인·동의, GitHub App의 선택 저장소 설치 |
| Notion | 사전 ID 없음 | 공식 MCP 동적 등록 + PKCE | 작업공간 선택·권한 동의 |

### Google

VenditBot 전용 Cloud 프로젝트에서 동의 화면과 사용자 유형을 설정하고 **Desktop app** OAuth 클라이언트를 만듭니다. Gmail, Calendar, Drive, Docs, Sheets API를 사용 범위에 맞게 켭니다. 앱은 `http://127.0.0.1:<임시 포트>/oauth/callback/google`로 돌아옵니다. Web application 클라이언트로 대체하지 않습니다. Google의 설치형 앱 문서는 최초 교환과 갱신의 `client_secret`을 선택 값으로 설명하지만, 이번 전용 클라이언트의 실제 교환은 해당 값이 없으면 거절되었습니다. 따라서 Google은 공개 배포 등록에서 제외하고, 고급 설정을 통해 Client ID와 Client secret을 이 기기의 암호화 저장소에 한 번 저장합니다. 소스·로그·배포 파일에 비밀 값을 넣지 않습니다. 이 설정은 다섯 서비스를 준비할 뿐이며 각 서비스의 공식 계정 선택과 권한 동의는 별도로 필요합니다. 실제 교환·갱신 성공은 별도 검증 결과로 확인합니다. [Google 설치형 OAuth](https://developers.google.com/identity/protocols/oauth2/native-app), [Desktop loopback 지원](https://developers.google.com/identity/protocols/oauth2/resources/loopback-migration)

각 연결이 요청하는 범위는 아래와 같습니다. 다섯 연결은 토큰도 각각 보관합니다.

| 앱 | OAuth 범위 |
| --- | --- |
| Gmail | `https://www.googleapis.com/auth/gmail.readonly` |
| Calendar | `https://www.googleapis.com/auth/calendar.readonly` |
| Drive | `https://www.googleapis.com/auth/drive.readonly` |
| Docs | `https://www.googleapis.com/auth/documents.readonly` |
| Sheets | `https://www.googleapis.com/auth/spreadsheets.readonly` |

외부 사용자 배포에는 민감·제한 범위 검토와 검증이 필요할 수 있습니다. 테스트 모드는 테스트 사용자 및 토큰 수명 제한이 있으므로 일반 배포 완료로 간주하지 않습니다. 검증과 개인정보 처리 조건은 실제 요청 범위와 데이터 처리 방식에 따라 확인합니다. [Google OAuth 배포 준비](https://developers.google.com/identity/protocols/oauth2/production-readiness/overview)

### Slack

전용 **내부 앱** 또는 **Slack Marketplace에 게시된 앱**을 등록합니다. 현재 Slack MCP는 미게시 외부 배포 앱을 허용하지 않으며 DCR을 제공하지 않습니다. Client ID와 고정 App ID를 배포 등록에 넣습니다. 이 읽기 기능에는 사용자 범위 `search:read.public`, `channels:history`, `channels:read`만 요청합니다. 비공개 채널·DM·메시지 쓰기 범위는 추가하지 않습니다. [Slack MCP 앱 자격·범위](https://docs.slack.dev/ai/slack-mcp-server/)

OAuth 설정에서 PKCE를 켜고, 토큰 회전도 켭니다. 콜백은 정확히 `http://localhost:43127/oauth/callback/slack`로 등록합니다. PKCE 활성화는 앱을 공개 클라이언트로 바꾸며 되돌리려면 Slack 지원이 필요합니다. Desktop PKCE는 사용자 토큰만 사용하고 초기 교환과 갱신에 Client secret을 보내지 않습니다. 내부 앱은 그 워크스페이스용이며, 여러 고객에게 배포하려면 Marketplace 요건을 별도로 완료해야 합니다. [Slack PKCE](https://docs.slack.dev/authentication/using-pkce/)

### GitHub

전용 GitHub App을 만들고 **Device flow**를 활성화합니다. App ID가 아닌 **Client ID**를 `githubApp: true`, `flow: 'device'`로 배포합니다. 사용자 토큰 만료를 켜둡니다. 앱도 `offline_access`를 요청하여 만료·갱신 토큰을 받습니다. 저장소 권한은 Contents·Issues·Pull requests **Read-only**, Metadata **Read-only**로 제한하고 필요한 저장소에만 설치합니다. Device flow는 런타임 loopback 콜백, Client secret, 설치 토큰용 개인 키를 사용하지 않습니다. GitHub 등록의 Callback URL은 선택 사항이며 device flow에서는 무시됩니다. 이 방식에서는 설치 시 사용자 OAuth를 자동 시작하는 옵션을 끄고, 사용하지 않는 웹훅도 비활성화합니다. 외부 사용자 배포에는 설치 대상을 Any account로 선택합니다. [GitHub App 등록](https://docs.github.com/en/apps/creating-github-apps/registering-a-github-app/registering-a-github-app) 앱 설치와 사용자 OAuth 동의는 각각 필요합니다. [GitHub App 기기 로그인](https://docs.github.com/en/apps/creating-github-apps/authenticating-with-a-github-app/generating-a-user-access-token-for-a-github-app)

기기 로그인에서 발급한 GitHub App 토큰의 갱신도 Client secret 없이 가능합니다. 만료된 갱신 토큰은 다시 로그인해야 합니다. 앱의 권한은 OAuth scope 문자열로 확대되지 않습니다. [GitHub 토큰 갱신](https://docs.github.com/en/apps/creating-github-apps/authenticating-with-a-github-app/refreshing-user-access-tokens)

OAuth App 등록을 선택하면 기본 `read:user` 범위의 프로필·공개 저장소 모드입니다. 비공개 저장소를 위해 넓은 `repo` 범위를 자동으로 추가하지 않습니다. 기존 직접 등록 방식의 Client secret은 암호화 저장을 유지하며 배포용 공개 등록에 복사하지 않습니다. 원격 MCP는 별도 인증 서비스를 제공하지 않고 유효한 GitHub 토큰을 받습니다. 조직의 설치·접근 승인은 여전히 적용됩니다. [GitHub MCP 호스트 통합](https://github.com/github/github-mcp-server/blob/main/docs/host-integration.md)

### Notion

공식 MCP 서버의 인증 메타데이터를 확인하고 연결할 때 DCR로 등록합니다. 배포자가 Client ID를 준비할 필요는 없습니다. PKCE, 임시 loopback 콜백, 사용자 동의를 거칩니다. OAuth 기본 권한에는 쓰기 능력이 포함될 수 있지만 VenditBot은 검토한 읽기 도구와 서버가 실제 광고한 도구의 교집합만 호출합니다. [Notion MCP 클라이언트 등록](https://developers.notion.com/guides/mcp/build-mcp-client)

현재 계정만 읽는 검증은 먼저 실제 `tools/list`의 스키마를 확인합니다. 광고되고 로컬 허용 목록에도 있는 `notion-get-self`에 `{}`를 보내는 방식이 가장 명확합니다. 대안은 스키마가 현재 사용자 선택을 제공하는 `notion-get-users`에 그 정확한 인자와 `self`를 전달하는 것입니다. 이름만 추정하여 전체 사용자 목록을 조회하지 않습니다. 현재 공식 문서는 이전 `notion-fetch`의 `id: 'self'`도 지원한다고 설명하지만 새 구현에는 `notion-get-self`를 권장합니다. 이 문서상의 지원은 특정 연결의 실제 호출 성공 증거와 다릅니다. [Notion 읽기 도구](https://developers.notion.com/guides/mcp/mcp-supported-tools)

## 저장·취소·보안 경계

공개 상태 파일 `app-connectors.json`에는 등록 상태, grant 식별자, 검사 결과만 저장합니다. 인증은 기존 암호화 저장소의 `VENDITBOT_APPS_CONFIG_*`, `VENDITBOT_APPS_TOKEN_*` 전용 항목에 저장합니다. 계정 목록 표시만으로 비밀 값을 복호화하지 않습니다. 다른 공급자·Rabbit·모델 로그인 인증을 읽어 대신 사용하지 않습니다.

한 번에 한 연결 작업만 실행합니다. 취소나 종료 뒤 늦게 도착한 토큰을 저장하지 않습니다. 토큰 회전 결과가 불확실하면 먼저 기록한 재연결 필요 상태를 유지하고 자동으로 재시도하지 않습니다. 에이전트는 시작할 때의 grant 식별자를 고정하며, 재연결로 계정이 바뀌면 기존 요청을 거절합니다. 연결 해제는 이 기기의 저장값을 제거하며 공급자 측 권한 취소와는 별개입니다.

콜백은 loopback에만 바인딩하고 일회용 state, Host, origin, 경로를 검증합니다. 성공 페이지에는 code/state/token을 출력하지 않습니다. 응답을 보낸 뒤 소켓을 정리하며 캐시·외부 콘텐츠를 허용하지 않습니다. 브라우저의 `ERR_BLOCKED_BY_CLIENT`만으로 서버 원인을 단정할 수 없습니다. Chromium은 이를 클라이언트가 요청을 차단한 코드로 정의합니다. 실제 응답과 앱 상태를 따로 확인하며 브라우저 보안을 끄는 해결책을 사용하지 않습니다. [Chromium 오류 정의](https://chromium.googlesource.com/chromium/src/+/main/net/base/net_error_list.h), [Node HTTP 종료 동작](https://nodejs.org/api/http.html#servercloseallconnections)
