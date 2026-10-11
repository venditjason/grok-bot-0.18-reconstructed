# 벤디트봇 개발자 안내

이 문서는 본인 Mac에서 사용하는 독립 VenditBot 제품의 개발 경로를 설명한다. 현재 기본 진입점은 `source/venditbot/main.ts`와 `frontend/venditbot/`다. 초기 Grok Bot 재구성 구조는 [UPSTREAM_RECONSTRUCTION.md](UPSTREAM_RECONSTRUCTION.md)에 그대로 보존했다. `ARCHITECTURE.md`, `PUBLISHING.md`, 복원용 verify/smoke 명령은 기존 연구 경로의 문서이며 현재 제품 합격 근거와 구분한다.

## 빌드 구조

```text
frontend/venditbot/app.tsx
  → source/venditbot/preload.ts (venditbot:request / venditbot:event)
  → source/venditbot/main.ts
      ├─ provider-auth-runtime → 공식 Codex app-server / Claude CLI
      ├─ api-provider-transport → 명시적 API 프로필
      ├─ agent-store / local-store / team-store / settings / safeStorage
      ├─ team-coordinator → 대표 계획·위임·멤버·정책·후속 문맥
      ├─ agent-avatar / codex-avatar-image → SVG 일러스트 / 공식 래스터 이미지
      ├─ task-queue → 실행 1개 + 대기 16개
      └─ workspace-tools → 목록·읽기·검색·승인된 쓰기
```

`npm run build`는 `.build/venditbot-app`에 main/preload/renderer와 공식 native runtime을 준비한다. `scripts/package-venditbot.mjs`는 `node_modules/electron/dist/Electron.app`을 복사해 VenditBot 식별자를 적용한다. 공급자 runtime은 `Contents/Resources/runtimes/`에 두고 app.asar 밖에서 실행한다. 기본 제품은 원본 app.asar, Grok/Cursor 계정, 원격 box, Docker를 요구하지 않는다.

제품 상수는 `source/shared/product-identity.ts`, 경로와 자식 환경은 `source/shared/node/venditbot-paths.ts`가 관리한다. Electron helper의 실행 이름과 plist 식별자를 함께 변경하며 프레임워크 ABI를 임의로 바꾸지 않는다. 패키저는 arm64 검사와 ad-hoc codesign 검증을 수행한다. 기본 bundle ID는 `com.vendit.venditbot`, 개발용은 `com.vendit.venditbot.development`다. 일반 번들은 `venditbot` scheme만 등록하며 개발 번들은 기존 링크 소유권을 바꾸지 않도록 scheme을 등록하지 않는다.

## 설치·개발 명령

macOS arm64, Node.js 26.5.x, Xcode Command Line Tools를 사용한다. 실제 확인 장비는 Apple M6, Mac18,5, 메모리 34,359,738,368바이트(32GiB), macOS 27.0.1(26A434)이다.

```sh
npm ci --ignore-scripts
npm run bootstrap
npm run check
npm run build
npm run package:dev
npm run dev:desktop
```

bootstrap은 공식 Electron·native CLI만 준비한다. `package.json`과 `package-lock.json`에서 확인한 현재 버전은 다음과 같다.

| 구성 | 고정 버전 |
| --- | --- |
| 벤디트봇 | 0.3.6 |
| Electron | 42.11.12 |
| 공식 Codex CLI | 0.162.1 |
| 공식 Claude CLI | 2.1.296 |

Electron 42.11.12 개발 패키지의 native 실행 및 `codesign --verify --deep --strict` 검사를 통과했다. 최종 회사형 팀·이미지·대화 기능을 포함한 일반 패키지·ZIP은 재생성 중이며, 그 산출물의 서명·해시·검사 결과는 최종 QA 보고서로 확정한다. Electron 갱신만으로 전체 의존성의 취약점이 없다고 선언하지 않는다.

```sh
npm run package:dev
npm run package
```

개발 결과는 `dist/벤디트봇 개발.app`, 일반 결과는 `dist/releases/<version>/벤디트봇.app`과 같은 디렉터리의 ZIP·검증 JSON이다. 이미 있는 일반 릴리스는 거절하며 다른 새 경로가 필요하면 패키저의 `--output-dir`을 명시한다. 실행 중인 개발 앱도 덮어쓰지 않는다. 기존 `dist/벤디트봇.app`과 운영 프로세스는 개발·패키징에서 건드리지 않는다. `dev:desktop`은 준비된 개발 패키지를 실행하며 raw Electron 실행과 seatbelt 안의 AppKit 실행을 거절한다. 빌드·패키징 명령은 `/Applications`, `~/Applications`에 앱을 설치하지 않는다. 공급자 로그인·사용자 Keychain 변경·GitHub push도 빌드 단계에서 수행하지 않는다. 패키징 검증 JSON은 dist에 생성하며 외부 배포용 Developer ID 서명·공증과 구분한다.

현재 제품 QA 데이터를 작업 디렉터리에 제한하려면 다음처럼 제품 전용 환경변수를 지정한다.

```sh
VENDITBOT_USER_DATA_DIR="$PWD/.build/qa-data" VENDITBOT_PROFILE_ID=qa npm run dev:desktop
```

이 경우 로그·캐시도 지정한 데이터 루트 안에 생성된다. API 키나 실제 인증을 테스트 데이터로 커밋하지 않는다. 원본 복원 연구가 필요한 경우에만 `bootstrap:legacy`, `build:legacy`, `package:legacy`를 사용한다.

## 운영 보존과 로컬 업데이트

운영 사용 중에는 개발 앱·프로필에서만 QA한다. 릴리스 게시 명령은 `node scripts/publish-venditbot-release.mjs --archive ZIP --verification JSON --qa-report JSON [--channel DIR]`이다. 동일 버전·ZIP 해시·완료된 QA 근거를 검증하고 기본 `~/Library/Application Support/VenditBot Updates`에 게시한다. 검증 파일 없이 게시하거나 운영 앱을 직접 덮어쓰는 우회 경로를 사용하지 않는다.

main은 `LocalUpdater`에 `paths.dataRoot` 전체, 현재 `.app` 경로와 `updater-helper.cjs`를 전달한다. `state.update`와 `update` 이벤트는 확인·설치 상태를 전달한다. 시작 시와 60초 간격으로 로컬 릴리스를 확인하지만 설치는 `installUpdate` 사용자 요청에서만 시작한다. 개발 빌드는 설치를 거절한다. 실행/대기 작업·활성 팀·이미지 생성·연결 시험·로그인·진행 중 비동기 IPC·미저장 기록을 검사하고, 설치 lock 뒤 모든 변경 요청을 거절한다. 공급자 프로세스 종료 완료를 기다린 후 비공개 백업과 동일 파일시스템 staging을 준비하고 유휴/미저장 상태를 재검사한다. DOMStorage를 디스크에 flush하도록 요청하고 helper READY를 받은 뒤 정상 종료한다. renderer가 beforeunload로 종료를 취소하면 helper 중단을 확인한 뒤 lock을 풀고 창·작업을 유지한다. helper 종료 확인에 실패하면 부모 앱을 닫지 않고 오류를 표시한다. 준비 실패도 기존 앱을 계속 사용할 수 있게 한다. 업데이트 중에는 저장 없이 종료 선택으로 이 검사를 우회할 수 없다.

백업에는 앱 소유의 영구 파일, `renderer-state`의 입력 중 초안, 공급자 전용 상태가 포함되므로 인증 정보를 출력·첨부·커밋하지 않는다. Keychain의 원문 자격증명을 별도로 추출하지 않는다. 캐시·로그와 정확히 지정된 Electron 임시 잠금 파일은 제외한다. 복사 결과 해시와 전체 원본 파일 목록·해시를 다시 확인하며, 백업 중 변경이 발견되면 교체를 중단한다.

helper는 부모 종료와 번들 자식 프로세스 종료를 확인한 뒤 앱을 교체한다. 다른 프로필에서 같은 번들을 실행 중이면 교체하지 않는다. 새 앱을 직접 자식으로 실행하고 앱 경로·버전·데이터 루트·프로필·부모/자식 PID가 일치하는 비공개 시작 ACK를 기다린다. main은 `loadFile` 성공 뒤 `await updater.acknowledgeStartup()`을 호출하며 완료 전까지 모든 renderer IPC를 대기시켜 로그인 자식 생성이나 새 작업을 막는다. 성공 후 창을 표시한다. 시작 실패는 자신이 실행한 새 자식의 종료와 번들 사용 프로세스 부재를 확인한 뒤 앱만 복구한다. 종료를 확인하지 못하면 실행 중인 번들을 옮기지 않고 기존 앱 백업을 남긴다. 성공 ACK 후 진단 상태 파일 쓰기 실패는 복구 사유가 되지 않는다. 이 흐름의 최종 실제 설치·복구 결과는 별도 QA 보고서에 기록한다. 기존 0.1.0 앱에는 이 UI가 없으므로 사용자에 의한 최초 0.2.1 전환이 한 번 필요하다. 기존 운영 앱에 버튼을 뒤늦게 주입하거나 자동 종료하지 않는다.

## 프로필과 자격증명

| 항목 | 일반 macOS 빌드 기본값 |
| --- | --- |
| 데이터 루트 | `~/Library/Application Support/VenditBot` |
| 프로필 | `profiles/<profile-id>`; 기본 ID는 `default` |
| 설정 | 프로필의 `settings.json` |
| 에이전트 | 프로필의 `agents.json` |
| 팀 정의·실행 기록 | 프로필의 `teams.json` |
| 프로필 그림 | 프로필의 `avatars/<uuid>.json`; 검증된 SVG 또는 정규화 PNG |
| 대화·작업 | 프로필의 `conversations.json` |
| 입력 중 초안 | 프로필의 `renderer-state/` Chromium Local Storage; API 키 제외 |
| API 키 | 프로필의 `credentials.encrypted.json`; main에서 safeStorage로 암호화 |
| Codex 상태 | 프로필의 `providers/codex`; 해당 경로를 CODEX_HOME으로 주입 |
| Claude 상태 | 프로필의 `providers/claude`; 해당 경로를 CLAUDE_CONFIG_DIR로 주입 |
| 로그 | `~/Library/Logs/VenditBot` |
| 캐시 | `~/Library/Caches/VenditBot/<profile-id>` |
| 개발 빌드 | 같은 구조의 `VenditBot Development` 루트 |

명시적 덮어쓰기는 `VENDITBOT_USER_DATA_DIR`, `VENDITBOT_PROFILE_ID` 등 제품 namespace만 사용한다. 개발 빌드는 명시적 override도 기본 운영 데이터 루트 및 하위 경로를 가리키면 거절한다. 별도 QA 디렉터리는 허용한다. 알려진 다른 앱 인증 경로와 임의 조상 symlink는 거절한다. Electron 이름·프로필·로그 경로 설정 후 single-instance lock을 획득하고 저장소를 연다. 중복 프로세스는 기존 실행의 대화 복구를 수행하지 않고 종료한다.

Codex Keychain은 공식 `Codex Auth` service 및 canonical CODEX_HOME의 해시로 구분되는 account를 사용한다. VenditBot 자체 이름의 별도 service를 만들었다고 설명하지 않는다. 운영 기본은 keyring이며 실패하면 평문 auth.json으로 자동 전환하지 않는다. 테스트의 ephemeral 모드는 일회성 모델 조회 등에 명시적으로 지정한다. [공식 app-server](https://learn.chatgpt.com/docs/app-server), [공식 인증](https://learn.chatgpt.com/docs/auth)

Claude는 `personal-local` 정책으로 전용 CLI·구성 디렉터리를 사용한다. 현재 개인용 사용 검증이 제3자 제품의 공개 배포 승인을 뜻하지 않는다. [Claude CLI](https://code.claude.com/docs/en/cli-reference), [Claude 인증](https://code.claude.com/docs/en/authentication)

자식 환경은 OS 실행에 필요한 허용 목록에서 구성한다. 사용자 HOME 자체를 임의로 재설정하지 않지만 공급자의 상태 경로는 제품 프로필에 고정한다. 부모의 API 키·`NODE_OPTIONS`·`DYLD_*`·전역 CLI 설정·기존 `SAND_*`를 전파하지 않는다. 기존 `~/.codex`, `~/.claude`, grokbot 인증을 가져오거나 로그아웃하지 않는다.

## 모델·effort 계약

`listProviderModels(provider, {refresh?})`는 `models`, `fetchedAt`, `source`, 선택적 `warning`을 반환한다. 모델은 `id`, 선택적 `resolvedId`, `label`, `description`, `isDefault`, `efforts`, 선택적 `defaultEffort`로 정규화한다. 캐시는 최대 5분이며 같은 공급자의 중복 조회는 하나로 합치고 인증 변경 시 무효화한다.

Codex는 공식 `model/list`를 페이지 단위로 조회한다. Claude는 공식 CLI 초기화 응답의 모델 정보와 지원 effort를 사용한다. 모델 이름이나 모든 모델의 effort를 UI에 고정하지 않는다. Claude alias는 확인된 `resolvedId`를 실행·저장에 사용한다. [Claude 모델 설정](https://code.claude.com/docs/en/model-config)

UI는 로그인 전 모델 폼을 숨기고 로그인 후 목록을 조회한다. 모델 변경·새로고침·계정 변경 뒤 선택을 재검증한다. IPC에서도 지원 모델·effort를 검증하며 실행 직전 공급자 adapter가 다시 검증한다. 미로그인 catalog 응답이나 목록에 나타난 사실은 계정의 실제 추론 권한 증명이 아니다. API 프로필은 수동 모델 ID를 사용하며 현재 API effort 설정은 제공하지 않는다.

## 에이전트·작업·대기열

에이전트 수에는 고정 개수 제한이 없다. agents.json의 직렬화 UTF-8 크기 4MiB 보호는 유지하며 초과 저장은 기존 데이터를 보존하고 거절한다. 이름, 지시문, 선택 폴더와 `connections` 배열을 포함하며 연결 우선순위는 1개부터 8개까지다. 각 항목은 `{connectionId, model, effort?}`다. 저장 시 모든 연결을 검증하고 공식 catalog의 해석된 모델 ID와 기본 effort로 정규화한다. 같은 연결·해석된 모델·effort 조합은 중복으로 거절하지만 같은 공급자의 다른 모델 또는 effort는 허용한다. 이전 단일 연결 데이터는 그대로 읽고, 새 에이전트의 기존 `connectionId/model/effort` 필드는 첫 항목과 동기화한다.

`createSession({agentId})`는 저장된 에이전트에서 전체 우선순위·역할·이름·폴더를 원자적으로 복사하고 클라이언트 override를 사용하지 않는다. 원본 에이전트를 수정·삭제해도 기존 작업의 `connections`는 바뀌지 않는다. API 주소·공급자 변경, 삭제, 과거 연결 ID 재사용 검사는 첫 순위뿐 아니라 모든 에이전트·작업·팀 실행 스냅샷의 연결 참조를 검사한다.

각 턴은 저장된 첫 순위부터 시도한다. 공급자 실패가 발생했고 응답 텍스트·도구 호출이 없으며 취소되지 않은 경우에만 다음 연결로 넘어간다. 로컬 저장 또는 도구 연결 준비 실패에는 fallback하지 않는다. API의 기존 429·5xx 재시도는 한 HTTP 단계당 최대 3회로 제한하며, 이 정책을 소진한 뒤 다음 연결을 판단한다. 공급자별 시도는 assistant 메시지의 `attempts` 배열에 연결·모델·effort·`running/failed/completed`·오류 요약으로 저장하고 native session 이벤트로 전달한다. 성공 시 작업의 기존 `connectionId/model/effort`는 실제 성공 연결을 가리키지만 `connections` 우선순위는 유지한다.

Claude의 성공한 session ID는 연결·해석된 모델·effort에 바인딩한다. 같은 연결이 연속해서 이어질 때만 `--resume --fork-session`을 사용하며 실패한 fork 대신 마지막 성공 parent를 재시도 지점으로 보존한다. 다른 공급자가 성공하거나 바인딩이 달라지면 기존 session ID를 사용하지 않는다. 여러 연결이 있는 작업에서 유효한 Claude parent가 없으면 `historyHandoff: true`로 완료 이력의 role·tool call ID·결과 구조와 최신 user 메시지를 JSON 문맥으로 전달한다. UI에 문맥 전달을 알리며 native Claude turn을 위조하거나 이전 도구를 재실행하지 않는다. 이 옵션의 기본값은 거부이며 전체 전달 문자열 500,000자를 넘으면 명시적으로 실패한다. 잘라 보내거나 조용히 최신 질문만 전달하지 않는다.

`TaskQueue`는 공급자 인증 runtime의 단일 활성 턴 계약에 맞춰 한 작업씩 FIFO로 실행한다. 대기 한도는 16개이며 같은 session ID의 중복 제출을 거절한다. `submit`은 실행 예약 후 microtask에서 job을 호출한다. 대기 취소는 실행하지 않고 제거하며 실행 취소는 signal만 전달하고 기존 job이 settle할 때까지 slot을 유지한다. `waitForIdle`은 큐를 닫지 않고 제한 시간 동안 정리를 기다린다. `close`는 새 제출을 막고 전부 취소하며 제한 시간 내 종료 여부를 boolean으로 반환한다.

저장소는 임시 파일 내용을 `flush:true`로 fsync한 뒤 rename으로 기록한다. 설정·에이전트·팀·대화·프로필 그림·암호화 키의 기존 JSON 형식은 유지한다. 디렉터리 메타데이터 fsync 또는 갑작스러운 전원 차단의 모든 경우를 보장하는 것은 아니다. 종료된 앱의 queued/running 작업과 실행 중이던 연결 시도를 다음 실행에서 자동 재개하지 않는다. 실패·취소 메시지는 표시용으로 보존하지만 다음 모델 요청의 완료 이력에 섞지 않는다. 성공한 도구 입력·결과는 역할 관계를 유지해 전달한다. 디스크 저장이 실패한 응답은 메모리에 보존하고 모든 화면에 복구 안내를 표시한다. 종료·창 닫기는 먼저 작업 정리를 기다린 뒤 새로 발생한 저장 오류까지 확인하며, 기본 선택은 앱으로 돌아가기다. 사용자가 명시적으로 저장 없이 종료를 선택하기 전에는 창·내보내기·재시도 경로를 유지한다. 프로세스가 이미 종료된 뒤의 메모리 복원까지 보장하지 않는다.

## 회사형 팀과 후속 대화

`TeamProfile`은 `name`, `topic`(4,000자), `instructions`(16,000자), `policies`(16,000자), `leaderAgentId`, `memberAgentIds`(대표 포함 1명 이상), `autonomous`(누락 시 false)을 보관한다. `rounds`는 이전 저장 호환용이며 새 실행 방식은 대표 계획이다. 저장 팀은 50개, 실행 기록은 200개, 활성 팀은 4개로 제한한다. 팀 수정 IPC는 `expectedUpdatedAt` 또는 저장된 `team.updatedAt`을 비교해 오래된 화면이 대표의 변경을 덮어쓰지 못하게 한다.

`TeamCoordinator`는 대표 계획 턴에서 `delegate_team_task`의 예약 ACK만 반환한다. 자식 완료를 기다리는 동안 공급자 슬롯을 붙잡지 않는다. 현재 대표 턴이 끝난 뒤 예약한 팀원 작업을 하나씩 글로벌 큐의 뒤에 넣고, 결과를 대표의 후속 계획에 전달한다. 한 실행의 위임 한도는 max(8, 누적 구성원 스냅샷 수 − 1)로 늘어나고 대표 계획은 3회, 필요시 최종 종합은 1회다. 자식은 다시 위임할 수 없다. 일반 공급자 실패는 해당 단계 실패와 room 결과로 기록해 대표가 재배분하게 하고, 대표 실패·저장 오류·사용자 취소는 실행 중단으로 처리한다.

팀 공통 도구는 `read_team_messages`, `send_team_message`, `read_team_task`다. 작업 폴더 없이도 동작하며 host가 발신자와 현재 팀을 고정한다. 대표 계획 단계만 `list_available_agents`, `list_team_members`, `list_team_models`, `delegate_team_task`, `add_team_member`, `remove_team_member`, `update_team_policy`를 받으며 실행 시에도 권한을 재검증한다. 수동 팀은 등록한 templateAgentId의 설정을 사용한다. 자율주행 팀은 templateAgentId를 생략해 대표의 동결된 연결·모델·effort·폴더로 새 에이전트를 생성할 수 있다. 영구 삭제 도구는 없고 remove_team_member는 현재 팀 소속만 제거한다. 임의 endpoint·인증·shell 권한을 만드는 도구가 아니다. 대표 제거·자기 위임·비멤버 위임·미완료 작업이 있는 멤버 제외는 거절한다. 추가 횟수·멤버·스냅샷에는 고정 개수 제한을 두지 않는다. teams.json 64MiB 저장 보호 및 도구 입력 1MiB 제한은 유지한다. 전체 명단은 50명 단위로 조회하고 초기 프롬프트 명단은 16KB 안에서 전달한다.

`list_team_models({agentId?})`는 현재 멤버가 이미 설정한 연결의 공식 인증 모델 목록과 지원 effort, API 프로필의 고정 모델을 반환한다. 로그인되지 않은 연결은 빈 목록과 이유를 반환하며 실행 중 catalog 조회는 공급자 턴을 변경하지 않는다. `delegate_team_task`의 `taskKind`는 `routine|standard|complex`, 선택적 `connections`는 1~8개다. 명시적 선택은 멤버의 기존 연결 범위·실제 모델·effort를 host가 검증한다. API는 저장된 프로필 모델만 허용한다.

루틴 업무에 명시적 선택이 없으면 `delegation-policy.ts`가 catalog의 해석된 모델 ID `claude-sonnet-5-5`와 `low`, 그다음 `gpt-6-luna`와 `low`를 확인해 기존 순서 앞에 넣는다. 지원하지 않으면 원래 순서를 유지하고 room에 이유를 남긴다. 가격·추론 권한·상시 실행을 보장하지 않는다. `TeamStep.connections/taskKind`와 자식 session은 검증된 선택을 복사하며 멤버 기본 설정과 과거 작업은 바꾸지 않는다. 비동기 모델 조회 뒤 취소·실행 상태를 재확인하고, 조회 중 새 팀 메시지가 들어와도 덮어쓰지 않는다.

명단과 정책 변경은 `teams.json`의 실행 및 영구 팀 정의를 한 번에 원자적으로 기록한다. 템플릿 복제로 생성한 에이전트는 별도 저장소에 저장하고 팀 변경 실패 시 복제본 제거를 시도한다. 이미 시작하거나 완료한 작업의 연결·모델·역할·폴더는 변경하지 않는다. 팀 정의 저장 이후 알림 실패는 이미 커밋한 복제본을 제거하지 않는다. 커밋 전 실패를 되돌릴 때에도 expectedUpdatedAt 비교로 사용자가 변경한 에이전트를 보존한다. 동시에 진행하는 다른 실행은 기존 스냅샷을 유지한다. 사용자가 설정을 수정했거나 다른 실행이 먼저 운영 설정을 갱신하면 대표의 오래된 변경은 충돌 오류로 거절한다.

팀 room은 max(200, 위임 한도 + 계획 한도 × 2 + 40)개의 메시지·메시지당 8,000자를 지원한다. 향후 결과와 감사 기록을 위해 공간을 예약한다. 자동 결과가 길면 명시적 발췌와 원본 session ID를 공유하고 `read_team_task`가 32,768자 단위로 이어 읽게 한다. 직접 메시지는 수신자·발신자 또는 전체공개 범위에서 읽는다. 도구 미지원 API는 위임 없이 대표가 직접 답변하며 이미 공유된 결과를 문맥으로 사용하고 제한을 room에 표시한다.

`startTeamRun({teamId, goal, contextRunId?})`는 같은 팀의 완료 실행만 이어받는다. `previousRunId`를 공개하고 이전 목표·대표 최종 결과·당시 정책을 최근 3회, 직렬화 기준 32,000자 이하의 스냅샷으로 보관한다. 긴 항목의 `excerpt`를 표시하고 과거 내용은 인용 문맥, 현재 `goal`만 새 사용자 명령으로 전달한다. 전체 과거 대화를 무제한 합치지 않는다. 팀 JSON 내보내기는 room과 각 단계의 전체 대화를 포함한다.

state와 `team-run` 이벤트에는 요약만 전달하며 상세 room은 `getTeamRun`에서 조회한다. `teams` 이벤트는 대표가 바꾼 팀 및 에이전트 목록을 즉시 갱신한다. 팀 소속 session은 일반 `send`를 거절하며 팀 대화에서만 진행한다. 팀 기록이 남아 있으면 참조하는 session 삭제를 막는다. 종료된 팀 기록을 삭제해도 개별 대화는 남고, 그때부터 각각 내보내거나 삭제할 수 있다. 앱 재시작 시 미완료 팀을 취소 상태로 복구하며 자동 재실행하지 않는다. `unsavedTeamRunIds`도 기존 종료 보호에 포함한다.

## 프로필 그림

`default-avatar.ts`의 제한된 도형 생성기는 네트워크 없이 임의 seed의 기본 프로필 그림을 만든다. 신규 에이전트가 avatarId를 생략하면 host가 그림을 먼저 저장해 지정하며, 대표의 템플릿 복제는 기존 그림을 복사하지 않고 매번 새 기본 그림을 부여한다. 그림 저장 실패 시 새 에이전트를 만들지 않는다. 기존 에이전트의 그림은 필드 생략 시 유지하고 명시적 빈 문자열은 제거로 처리한다. 그림 없는 이전 데이터는 읽기 시 자동 변경하지 않으며 UI의 안전한 벡터 기본 표시를 사용한다. 저장할 때는 에이전트·팀 기록이 참조하는 그림과 최근 미리 보기를 보존해 미참조 최근 16개 이미지를 보관한다. 고정 이미지 개수 제한 없이 전체 저장 JSON 1GiB 용량 한도를 검사하며, 에이전트·과거 팀 기록이 참조하는 이미지는 정리하지 않는다. 용량 초과나 안전하지 않은 저장 항목은 기존 파일을 바꾸지 않고 거절한다.

`generateAgentAvatar({mode, prompt, connectionId, model, effort?})`, `cancelAgentAvatar()`, `getAgentAvatar({id})`는 동일한 제한 IPC를 사용한다. 기본 `mode`는 `illustration`이다. 일러스트는 모든 연결의 텍스트 모델이 제한된 도형 JSON을 생성하고 host 검증 후 SVG로 변환한다. 마크업·스크립트·외부 이미지 참조를 허용하지 않으며 200도형·120,000자 이내다. 이 목적의 API 출력 한도만 16,384토큰을 사용한다.

`image` 모드는 Codex에 한정한다. `codex-avatar-image.ts`가 공식 app-server의 계정·이미지 capability·모델·effort를 검증한 뒤 이미지 한 장을 요청한다. 전용 임시 읽기 전용 작업 경로, 기존 앱 전용 CODEX_HOME 및 공식 Keychain을 사용하며 shell·웹·외부 MCP·파일 참조를 끈다. 출력 URL이나 `savedPath`를 읽지 않고 검증된 base64 PNG/JPEG/WebP 바이트만 받는다. 결과는 Electron `nativeImage`로 해석해 가운데 정사각형을 512×512 PNG로 정규화하며 저장 크기는 2MiB 이하다. 기본 timeout은 120초, 공급자 모듈 상한은 180초다.

두 모드는 기존 글로벌 대기열과 취소를 공유한다. 실행 예약 직후 취소해도 IPC Promise가 종료된다. 내부 대화는 `purpose:'avatar'`로 저장하고 일반 최근 목록에서 숨기되 저장 실패 항목은 복구용으로 표시한다. 일반 `send`로 재사용할 수 없다. PNG가 이미 영구 저장된 뒤 대화 기록 저장만 실패하면 미리 보기를 반환하고 저장 실패 배너·종료 보호를 유지한다. PNG 저장 자체가 실패하면 성공을 반환하지 않는다. 에이전트는 검증된 `avatarId`만 참조한다.

## 성능 경계

팀 상태 목록은 메시지·역할 본문을 먼저 복제하지 않고 요약을 직접 투영한다. 진행 판단은 활성 실행에 한정하고 긴 room 문맥은 메시지별 직렬화 길이를 한 번 계산해 앞부분을 제외한다. 제외 수를 모델에 전달하므로 숨은 무제한 이력 누락으로 처리하지 않는다. UI는 스트리밍 갱신을 묶고 긴 대화·목록의 표시량을 제한한다. 빌드와 런타임 복사 최적화의 실제 시간·메모리 개선 수치는 최종 측정 자료로 확인하며 코드 변경만으로 목표 통과를 선언하지 않는다.

## 파일 도구와 IPC 경계

공통 도구는 `list_files`, `read_file`, `search_files`, `write_file`이다. Codex 동적 도구와 API 도구 호출은 같은 executor를 직접 사용하고, Claude는 임시 포트·인증 토큰의 loopback MCP를 통해 같은 executor를 호출한다. 팀 대화의 앱 소유 도구 목록도 같은 bridge를 사용하며, 작업 폴더 없는 팀에서는 파일 도구를 노출하지 않는다. 광고한 목록 밖 도구 호출은 gateway에서도 거절한다. 외부 임의 MCP 서버를 등록하는 기능은 없다.

네이티브 선택 폴더 밖 경로, credential 파일, symlink/hardlink, 특수 파일을 거절한다. UTF-8 파일 읽기·쓰기는 128KiB 이내다. 쓰기 승인에는 전체 내용을 표시하고 승인 이후 파일·부모 디렉터리 identity와 기존 내용을 재검증한다. 취소 또는 승인 대기 중 변경이 있으면 쓰지 않는다. 호출 ID 중복은 같은 결과를 재사용하며 다른 인자로 재사용하면 거절한다. 이 검사를 OS 전체 sandbox라고 설명하지 않는다.

Renderer는 context isolation·sandbox·web security를 켜고 Node integration을 끈다. IPC는 지정된 BrowserWindow와 main frame, 정확한 renderer file URL을 검사한다. navigation·새 창·permission 요청을 거절하며 API 키 원문을 상태 응답으로 돌려주지 않는다.

현재 기본 제품에는 shell 실행, 제3자 MCP, 기존 앱 플러그인, Docker 도구가 없다. 연구용 Docker connector의 소유권 label·설치 ID·동적 loopback 포트·전역 auth mount 제거 회귀 테스트는 유지한다. native arm64 Docker 이미지나 호스트 추론 bridge 검증 없이 기본 앱에 기능을 노출하지 않는다.

## 검사 명령과 증거 수준

```sh
npm run typecheck
npm run source:typecheck
npm test
npm run test:product
node --test tests/venditbot-desktop.test.mjs tests/venditbot-teams.test.mjs tests/venditbot-preload.test.mjs tests/venditbot-avatar.test.mjs tests/codex-avatar-image.test.mjs
```

`typecheck`는 현재 제품 UI와 보존된 frontend를 검사한다. 제품 테스트는 경로 격리, 실제 localhost HTTP/SSE, IPC caller, 암호화 port, 파일 승인, 모델 선택, 에이전트, 회사형 팀과 재배분·후속 문맥, 이미지 생성과 취소·부분 저장 실패, 대기열, 디스크 오류를 검사한다. 실제 preload를 VM에서 실행해 main의 공개 IPC가 누락 없이 연결되는지도 검사한다. localhost listener가 막힌 실행 환경에서는 network 테스트에 해당 권한이 필요하다. Electron의 native UI 경계를 모의 처리한 테스트를 실제 GUI 검사로 기록하지 않는다.

공식 Codex의 미로그인 모델 목록을 일회성으로 확인하려면 다음을 사용한다. 개인 인증이나 추론 요청 없이 임시 HOME/CODEX_HOME과 ephemeral store를 사용하며 `.build/codex-model-list-evidence.json`에 결과를 남긴다.

```sh
node tests/fixtures/probe-codex-models.mjs
```

native Keychain 검사는 명시적 opt-in이다. 실제 사용자의 키 대신 동작하지 않는 합성 키를 임시 프로필에 저장하고 재시작·로그아웃 분리를 확인한 뒤 해당 테스트 항목을 정리한다. 일반 테스트에서는 환경변수가 없으면 건너뛴다.

```sh
VENDITBOT_CODEX_TEST_BINARY="$PWD/dist/벤디트봇 개발.app/Contents/Resources/runtimes/codex/bin/codex" node --test tests/provider-native-smoke.test.mjs
```

현재 Mac의 앱에서 Claude와 Codex 모두 실제 로그인 및 응답을 확인했다. Codex native 합성 키의 저장·재시작 복원·프로필별 로그아웃 분리도 별도로 검사했다. 네이티브 앱에서 에이전트 생성·폴더 선택·쓰기 승인 거절 시 파일 미생성·승인 시 내용 일치와 0600 권한을 확인했다. 전역 grokbot이나 전역 CLI 인증은 변경하지 않았다.

로그인된 공식 Codex 런타임으로 실제 PNG 한 장(약 1.9MB, 32.47초)의 생성 완료를 확인했다. 이는 모의 이미지 응답 검사와 별도 근거이며 최종 패키지의 모든 이미지 UI 조합을 검사했다는 뜻은 아니다.

다중 연결·Claude 문맥 전달·회사형 팀 위임과 실패 회수·후속 대화·장애·취소·저장 오류 조합은 모의 Electron 경계와 실제 localhost/합성 CLI 프로토콜로 회귀 검증했다. 모든 외부 API 실계정·모든 모델 조합·8시간·절전 복귀 검사가 완료되었다는 뜻은 아니다.

**최종 QA 보고서: 최종 일반 패키지와 ZIP 생성 후 통합 담당이 별도로 작성한다.** 보고서에는 전체 검사 수와 명령, 패키지·ZIP 해시, 최종 arm64·서명 검사, 의존성 감사, 실계정·네이티브 GUI 근거와 미실행 항목을 기입한다. 현재 개발 패키지의 통과 결과와 이후 생성할 최종 산출물의 검증을 구분한다.

## 0.2.1 안정성 보완

API transport는 도구 알림 후 실행 직전에 취소를 다시 확인하고, 묶음 전체의 중복 호출 ID·인수를 실행 전에 검증한다. 불완전 스트림, 네트워크 중단, timeout 뒤 이미 수행된 도구를 재실행하지 않는다. 에이전트 저장은 UTF-8 전체 4MiB 읽기·쓰기 한도를 일치시켜 재시작 불가 파일을 만들지 않는다.

늦게 도착한 연결·에이전트·팀 저장 응답은 그사이 작성한 입력이나 선택한 화면을 덮어쓰지 않는다. 일시적인 초안 읽기 오류는 재시도로 복원하며, 손상 원문은 초안 보기의 명시적 보관 동작으로 원본과 신규 초안을 함께 저장할 수 있다. main 상태·내보내기는 진행 중 session의 최신 스트리밍 내용을 반영하고, 종료 시 live 참조를 정리한다.

추가 합성 안정성 runner는 `node --expose-gc scripts/qa-venditbot-stability.mjs`이다. 수백 회의 저장·재시작·실패·취소를 압축 실행한 검사이며 8시간 실제 실행이나 정전 중 파일 기록 내구성 검사와 구분한다.
