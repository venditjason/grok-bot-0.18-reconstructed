# 앱 연결 설정과 검증

벤디트봇의 **앱 연결**은 AI 모델 로그인과 별개입니다. Gmail, Google Calendar, Drive, Docs, Sheets, Notion, Slack, GitHub를 지원합니다. Rabbit 프로젝트 키나 다른 앱의 로그인 정보를 가져오지 않습니다.

## 연결 순서

1. 상단 **앱 연결**을 열고 해당 공급자의 앱 등록을 설정합니다. Notion은 연결 시 공식 서버가 동적으로 등록합니다.
2. 표시된 접근 범위를 확인하고 동의한 다음 **공식 로그인으로 연결**을 누릅니다. 시스템 브라우저에서 공급자의 동의 화면을 완료합니다.
3. **인증 연결됨**은 OAuth 인증 정보가 저장되었다는 뜻입니다. **실제 연결 검사** 결과는 별도로 표시됩니다.
4. Google 검사는 실제 API 읽기를 수행합니다. Docs와 Sheets는 조회할 수 있는 문서 또는 스프레드시트 ID가 필요합니다. Notion·Slack·GitHub 검사는 공식 MCP 초기화와 읽기 도구 목록을 확인합니다. 문서·채널·저장소 내용을 읽었다는 뜻은 아닙니다.

등록 정보가 없으면 **설정 필요**로 표시됩니다. 예시 토큰이나 다른 제품의 OAuth Client ID를 사용하여 연결됨으로 표시하지 않습니다.

## 공급자별 등록

| 공급자 | 필요한 설정 | 요청 권한 / 콜백 |
| --- | --- | --- |
| Google | [Google Cloud OAuth 클라이언트](https://console.cloud.google.com/auth/clients)의 **Desktop app**, 동의 화면·테스트 사용자, 사용할 Gmail/Calendar/Drive/Docs/Sheets API 활성화 | 각 앱을 별도로 연결하고 해당 API의 읽기 전용 범위만 요청합니다. Desktop PKCE와 임시 `127.0.0.1` 포트를 사용합니다. |
| Notion | 별도 수동 Client ID 등록 없음 | 공식 `https://mcp.notion.com/mcp`에서 PKCE와 동적 등록을 사용합니다. `default` 권한은 공급자에서 읽기와 수정을 포함할 수 있습니다. 벤디트봇의 도구는 읽기로 제한합니다. |
| Slack | 직접 등록한 내부 앱 또는 게시된 앱의 Client ID·App ID, PKCE 및 토큰 회전, 필요 시 관리자 승인 | `search:read.public`, `channels:history`, `channels:read`. 등록 콜백은 `http://localhost:43127/oauth/callback/slack`입니다. 공개 채널 검색·조회만 요청하며 메시지 전송·비공개 채널·DM 범위를 요청하지 않습니다. |
| GitHub App — 권장 | 벤디트봇 전용 GitHub App의 Client ID·Client secret, 사용자 OAuth, 선택 저장소 설치 | 필요한 저장소에 Contents·Issues·Pull requests·Metadata **읽기** 권한을 설정합니다. OAuth scope 대신 앱·설치 권한이 적용됩니다. 콜백 경로는 `http://127.0.0.1/oauth/callback/github`이며 실행 중 임시 포트를 사용합니다. |
| GitHub OAuth App | 전용 OAuth App의 Client ID·Client secret | `read:user`만 요청합니다. 프로필·공개 저장소용이며 비공개 저장소 연결로 표시하지 않습니다. 콜백 경로는 GitHub App과 같습니다. |

Google은 등록한 클라이언트를 요구하며 Desktop loopback과 PKCE를 지원합니다. [Google 공식 인증 문서](https://developers.google.com/identity/protocols/oauth2/native-app)

Notion은 공식 MCP의 OAuth 발견·동적 등록·PKCE·갱신 규격을 제공합니다. [Notion 클라이언트 문서](https://developers.notion.com/guides/mcp/build-mcp-client)

Slack은 동적 등록을 지원하지 않으므로 앱 등록이 필요합니다. Desktop PKCE는 Client secret 없이 사용자 토큰을 교환하며, 등록된 localhost 콜백을 사용합니다. [Slack MCP](https://docs.slack.dev/ai/slack-mcp-server/), [Slack PKCE](https://docs.slack.dev/authentication/using-pkce/), [사용자 토큰 응답](https://docs.slack.dev/reference/methods/oauth.v2.user.access/)

GitHub의 공식 원격 MCP는 자체 앱 등록과 OAuth를 요구합니다. 저장소 접근은 인증한 사용자와 앱 설치 양쪽의 권한 범위에 따릅니다. [GitHub MCP 호스트 통합](https://github.com/github/github-mcp-server/blob/main/docs/host-integration.md), [GitHub OAuth 콜백](https://docs.github.com/en/apps/oauth-apps/building-oauth-apps/authorizing-oauth-apps)

## 에이전트가 읽는 범위

에이전트는 `list_connected_apps`와 `read_connected_app`만 받습니다. `list_read_tools`로 현재 허용된 작업과 입력 형식을 먼저 확인합니다. 실제 조회 자료를 AI 연결로 전달하기 전 기존 민감정보 공개 승인 정책을 적용합니다. 한 응답이 시작된 뒤 다른 계정으로 재연결하면 그 응답의 접근 허용은 확장되지 않습니다.

- Gmail: 메일 목록 검색, 개별 메일의 기본 헤더·텍스트 본문. 첨부파일과 HTML 본문은 자동으로 열지 않습니다.
- Calendar: 캘린더 목록과 기간별 일정 목록.
- Drive: 파일 이름 검색과 파일 메타데이터. 임의 다운로드 URL은 열지 않습니다.
- Docs: ID로 문서 읽기.
- Sheets: 시트 구조와 명시적인 A1 범위 읽기. 요청당 최대 1,000개 셀입니다.
- Notion·Slack·GitHub: 코드에 정한 읽기 도구 이름과 실제 서버 목록의 교집합만 허용합니다. 서버가 다른 도구를 읽기 전용이라고 표시해도 허용 목록 밖의 도구는 실행하지 않습니다. GitHub 요청에는 서버의 읽기 전용 헤더도 사용합니다.

Google 목록은 한 번에 최대 20개입니다. 일반 HTTP 응답은 512 KiB, MCP 응답은 2 MiB에서 중단하며 모델로 전달하는 결과는 40,000자까지입니다. 잘린 결과는 `truncated`로 표시합니다. 이는 이 도구가 제공하는 내용의 한도이며 공급자의 총 토큰·비용 보장은 아닙니다. 원격 자료는 지시가 아닌 출처 자료로 취급합니다.

메일 보내기, Slack 게시, 문서 수정, 저장소 쓰기 도구는 제공하지 않습니다. 재시도는 새 모델 호출 ID로 명시적으로 요청해야 합니다. 같은 호출 ID의 결과는 재사용하고 다른 입력은 거절합니다.

## 저장·취소·해제

인증 정보는 기존 macOS 보안 저장소 암호화를 통해 `VENDITBOT_APPS_CONFIG_*`, `VENDITBOT_APPS_TOKEN_*` 키로 저장합니다. 앱 상태 조회는 암호문 존재 여부만 확인하며 키체인 복호화를 요청하지 않습니다. 공개 `app-connectors.json`에는 인증 세대 식별자와 고정된 검사 결과만 기록합니다. 토큰, Client secret, 문서 내용은 포함하지 않습니다.

OAuth 대기는 5분 후 만료합니다. 취소한 뒤 늦게 온 응답은 저장하지 않습니다. 토큰 갱신은 한 번만 수행하며 응답 유실로 회전 결과가 불확실하면 재연결이 필요하다고 표시합니다. 기존 인증 값을 자동 삭제하거나 불확실한 갱신을 반복하지 않습니다.

**연결 해제**는 이 Mac의 해당 앱 인증 값만 제거합니다. 공급자의 파일·메일·일정은 삭제하지 않습니다. 공급자 계정의 권한 철회는 해당 계정 설정에서 별도로 수행합니다. 특히 Google의 프로그램 방식 권한 철회는 같은 프로젝트의 다른 앱 범위까지 영향을 줄 수 있으므로 여기서 자동 호출하지 않습니다. [Google 권한 철회 규격](https://developers.google.com/identity/protocols/oauth2/native-app#tokenrevoke)

## 검증 범위

자동 검증은 임시 프로필·합성 토큰으로 PKCE/상태값, 취소와 늦은 응답, 부분 권한 거절, 갱신 결과 유실, JSON/SSE, 쓰기 차단, 계정 변경 경합을 검사합니다. 공식 공개 인증 메타데이터의 실제 네트워크 조회도 별도로 검사합니다. 이러한 검사는 사용자 계정의 연결·문서 조회를 완료했다는 의미가 아닙니다. 실제 계정 검증에는 공급자 등록, 사용자의 OAuth 동의, 필요 시 대상 문서·저장소 접근 권한이 필요합니다.
