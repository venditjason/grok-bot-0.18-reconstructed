/** Public app connection contract. OAuth credentials never cross this boundary. */
export type AppId = 'gmail' | 'google_calendar' | 'google_drive' | 'google_docs' | 'google_sheets' | 'notion' | 'slack' | 'github';
export type AppConnectorProvider = 'google' | 'notion' | 'slack' | 'github';
export type AppConnectorStatus = 'setup_required' | 'disconnected' | 'authorizing' | 'connected' | 'verifying' | 'error';
export type AppConnectorPhase = 'reading_registration' | 'discovering' | 'registering' | 'opening_browser' | 'awaiting_consent' | 'exchanging_token' | 'saving_credential' | 'checking_connection';
export type AppConnectorRegistration = 'managed' | 'dynamic' | 'custom' | 'unavailable';
export type AppDeviceAuthorization = {userCode:string; verificationUri:string; expiresAt:string};
export type AppConnectorTest = {ok: boolean; checkedAt: string; message: string; kind: 'api_read' | 'mcp_handshake'; toolCount?: number};
export type AppConnectorDefinition = {id: AppId; label: string; provider: AppConnectorProvider; scopes: string[]; description: string; setupUrl: string};
export type AppConnectorView = AppConnectorDefinition & {
  status: AppConnectorStatus; configured: boolean; hasCredential: boolean;
  setupMessage?: string; error?: string; lastTest?: AppConnectorTest; githubApp?: boolean;
  registration?: AppConnectorRegistration; phase?:AppConnectorPhase; phaseMessage?:string; deviceAuthorization?:AppDeviceAuthorization;
};
export type ConfigureAppConnectorInput = {provider: AppConnectorProvider; clientId: string; clientSecret?: string; appId?: string; githubApp?: boolean};
export type ConnectAppConnectorInput = {id: AppId; consentAccepted: true};
export type AppConnectorInput = {id: AppId};
/** Docs and Sheets need a user-selected document/spreadsheet ID for an actual API read. */
export type TestAppConnectorInput = AppConnectorInput & {resourceId?: string};
export const APP_CONNECTORS_CHANGED = 'app-connectors-changed';
const googleSetup = 'https://console.cloud.google.com/auth/clients';
export const APP_CONNECTORS: readonly AppConnectorDefinition[] = [
  {id:'gmail',label:'Gmail',provider:'google',scopes:['https://www.googleapis.com/auth/gmail.readonly'],description:'메일 조회 권한을 요청합니다. 메일 전송은 포함하지 않습니다.',setupUrl:googleSetup},
  {id:'google_calendar',label:'Google Calendar',provider:'google',scopes:['https://www.googleapis.com/auth/calendar.readonly'],description:'캘린더와 일정 조회 권한을 요청합니다.',setupUrl:googleSetup},
  {id:'google_drive',label:'Google Drive',provider:'google',scopes:['https://www.googleapis.com/auth/drive.readonly'],description:'Drive 파일 조회 권한을 요청합니다.',setupUrl:googleSetup},
  {id:'google_docs',label:'Google Docs',provider:'google',scopes:['https://www.googleapis.com/auth/documents.readonly'],description:'문서 조회 권한을 요청합니다. 실제 검사는 문서 ID가 필요합니다.',setupUrl:googleSetup},
  {id:'google_sheets',label:'Google Sheets',provider:'google',scopes:['https://www.googleapis.com/auth/spreadsheets.readonly'],description:'스프레드시트 조회 권한을 요청합니다. 실제 검사는 스프레드시트 ID가 필요합니다.',setupUrl:googleSetup},
  {id:'notion',label:'Notion',provider:'notion',scopes:['default'],description:'공식 MCP의 기본 권한은 선택한 작업공간의 읽기와 수정을 포함합니다. 이 앱의 연결 검사는 도구 목록만 조회합니다.',setupUrl:'https://developers.notion.com/guides/mcp/build-mcp-client'},
  {id:'slack',label:'Slack',provider:'slack',scopes:['search:read.public','channels:history','channels:read'],description:'공개 채널 검색·조회 권한을 요청합니다. PKCE를 켠 내부 또는 게시된 Slack 앱이 필요합니다.',setupUrl:'https://docs.slack.dev/ai/slack-mcp-server/'},
  {id:'github',label:'GitHub',provider:'github',scopes:['read:user'],description:'공식 MCP와 프로필 접근을 확인합니다. 이 초기 연결은 비공개 저장소·쓰기 권한을 요청하지 않습니다.',setupUrl:'https://github.com/settings/developers'},
];
export function appConnectorId(value: unknown): AppId {
  if(typeof value !== 'string' || !APP_CONNECTORS.some(item=>item.id === value)) throw new Error('앱 연결을 선택하세요.');
  return value as AppId;
}
export function appConnectorProvider(value: unknown): AppConnectorProvider {
  if(!['google','notion','slack','github'].includes(String(value))) throw new Error('앱 공급자를 선택하세요.');
  return value as AppConnectorProvider;
}
export function appConnectorDefinition(id: AppId): AppConnectorDefinition {return structuredClone(APP_CONNECTORS.find(item=>item.id===appConnectorId(id))!);}
