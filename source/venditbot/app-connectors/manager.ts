import {readFeedbackGithubProof} from '../feedback-github-proof.js';
import {randomUUID} from 'node:crypto';
import {APP_CONNECTORS,appConnectorDefinition,appConnectorId,appConnectorProvider,type AppId,type AppConnectorProvider,type AppConnectorView,type AppConnectorTest,type ConfigureAppConnectorInput,type ConnectAppConnectorInput,type AppConnectorInput,type TestAppConnectorInput,type AppConnectorPhase,type AppDeviceAuthorization} from '../../shared/app-connectors.js';
import type {EncryptedSecretStore} from '../local-store.js';
import {AppConnectorStore} from './store.js';
import {ConnectorError,abort,discover,fail,jsonRequest,oauthCallback,publicError,record,text,trustedUrl,type FetchPort,type OAuthMetadata} from './protocol.js';
import {ReadOnlyMcp} from './mcp.js';
import {GOOGLE_OPERATIONS,googleRead,googleTest} from './google.js';
import {managedAppRegistrations,type ManagedAppRegistration} from './registrations.js';
import {githubDeviceAuthorization,type DeviceWait} from './device.js';
type ClientConfig={provider:AppConnectorProvider;clientId:string;clientSecret?:string;appId?:string;githubApp?:boolean;flow?:'device'};
type StoredToken={id:AppId;provider:AppConnectorProvider;accessToken:string;refreshToken?:string;expiresAt?:number;scopes:string[];config:ClientConfig;metadata:OAuthMetadata};
type Secrets=Pick<EncryptedSecretStore,'has'|'read'|'write'|'remove'|'revision'>;
export type AppConnectorOptions={root:string;secrets:Secrets;openExternal:(url:string)=>Promise<unknown>;changed:()=>void;assertMutable:(ownSecretMutation?:boolean)=>void;fetch?:FetchPort;registrations?:readonly ManagedAppRegistration[];deviceWait?:DeviceWait};
export type AppReadInput={id:AppId;operation:string;args?:Record<string,unknown>};
const configKey=(provider:AppConnectorProvider)=>`VENDITBOT_APPS_CONFIG_${provider.toUpperCase()}`;
const tokenKey=(id:AppId)=>`VENDITBOT_APPS_TOKEN_${id.toUpperCase()}`;
const phases:Record<AppConnectorPhase,string>={reading_registration:'저장된 앱 등록 정보를 macOS 보안 저장소에서 확인하고 있습니다.',discovering:'공식 로그인 서버를 확인하고 있습니다.',registering:'공식 서버에 앱 연결을 준비하고 있습니다.',opening_browser:'기본 브라우저에서 공식 로그인을 열고 있습니다.',awaiting_consent:'브라우저에서 로그인과 연결 승인을 완료하세요.',exchanging_token:'공식 로그인 응답을 확인하고 있습니다.',saving_credential:'이 기기에 연결을 안전하게 저장하고 있습니다.',checking_connection:'공식 서버 연결을 검사하고 있습니다.'};
const unavailable='벤디트봇 전용 앱 연결을 준비하고 있습니다. 현재 배포에는 공급자 등록이 없어 로그인할 수 없습니다. 앱 업데이트 후 다시 확인하세요.';
const setup:Record<AppConnectorProvider,string>={
  google:'Google Cloud에서 Desktop app OAuth 클라이언트를 등록하고 사용할 API를 켜세요. 테스트 사용자와 동의 화면 설정이 필요할 수 있습니다.',
  notion:'공식 Notion MCP가 이 앱을 동적으로 등록합니다. 브라우저에서 작업공간과 권한을 확인한 뒤 승인하세요.',
  slack:'직접 등록한 내부 또는 게시된 Slack 앱의 Client ID와 App ID가 필요합니다. PKCE와 토큰 회전을 켜고 콜백 http://localhost:43127/oauth/callback/slack 을 등록하세요. 조직 관리자 승인이 필요할 수 있습니다.',
  github:'벤디트봇 전용 GitHub App 또는 OAuth App의 Client ID와 Client secret을 등록하세요. GitHub App은 사용자 OAuth와 선택 저장소 설치, Contents·Issues·Pull requests·Metadata 읽기 권한이 필요합니다. OAuth App 모드는 프로필·공개 저장소만 지원합니다.',
};
function configuration(raw:unknown):ClientConfig{
  const value=record(raw),provider=appConnectorProvider(value.provider),clientId=text(value.clientId,512);
  if(Object.keys(value).some(key=>!['provider','clientId','clientSecret','appId','githubApp'].includes(key)))fail('앱 등록 입력에 허용되지 않은 항목이 있습니다.');
  const result:ClientConfig={provider,clientId};if(value.clientSecret!==undefined&&value.clientSecret!=='')result.clientSecret=text(value.clientSecret,2048);
  if(value.appId!==undefined&&value.appId!=='')result.appId=text(value.appId,100);if(value.githubApp!==undefined){if(typeof value.githubApp!=='boolean'||provider!=='github')fail('GitHub 앱 종류를 확인하세요.');result.githubApp=value.githubApp;}
  if(provider==='github'&&!result.clientSecret)fail('전용 GitHub 앱의 Client secret을 입력하세요.');
  if(provider==='slack'&&(!result.appId||!/^A[A-Z0-9]{5,}$/.test(result.appId)))fail('등록한 Slack App ID를 입력하세요.');
  if(provider==='notion')fail('Notion은 연결할 때 공식 서버에 자동 등록됩니다.');return result;
}
/** Owns a single pending operation to avoid overlapping native secure-storage and token rotation. */
export class AppConnectorManager {
  private readonly store:AppConnectorStore;private readonly fetcher:FetchPort;private readonly registrations:ReadonlyMap<AppConnectorProvider,ManagedAppRegistration>;
  private pending:{id:AppId;status:'authorizing'|'verifying';controller:AbortController;done:Promise<unknown>;phase?:AppConnectorPhase;deviceAuthorization?:AppDeviceAuthorization}|undefined;
  private readonly errors=new Map<AppId,string>();
  constructor(private readonly options:AppConnectorOptions){this.store=new AppConnectorStore(options.root);this.fetcher=options.fetch??fetch;this.registrations=managedAppRegistrations(options.registrations);}
  list():AppConnectorView[]{const metadata=this.store.snapshot();return APP_CONNECTORS.map(definition=>{
    const id=definition.id,custom=this.options.secrets.has(configKey(definition.provider)),managed=this.registrations.get(definition.provider),configured=definition.provider==='notion'||custom||!!managed,hasCredential=this.options.secrets.has(tokenKey(id)),saved=metadata.apps[id],error=this.errors.get(id),githubApp=definition.provider==='github'&&(custom?metadata.providers.github?.githubApp===true:managed?.provider==='github'&&managed.githubApp),pending=this.pending?.id===id?this.pending:undefined;
    const registration=definition.provider==='notion'?'dynamic':custom?'custom':managed?'managed':'unavailable';
    return {...structuredClone(definition),...(githubApp?{githubApp:true,scopes:[],description:'선택한 저장소에 설치된 전용 GitHub App의 읽기 권한을 사용합니다. 앱 연결 검사는 MCP 도구 목록만 확인하며 저장소 조회 성공과는 별개입니다.'}:{}),configured,hasCredential,registration,
      status:pending?pending.status:error||saved?.requiresReconnect?'error':hasCredential?'connected':!configured?'setup_required':'disconnected',
      setupMessage:!configured?unavailable:registration==='managed'?'공식 로그인에서 계정과 요청 권한을 확인한 뒤 승인하세요.':setup[definition.provider],
      ...(pending?.phase?{phase:pending.phase,phaseMessage:phases[pending.phase]}:{}),...(pending?.deviceAuthorization?{deviceAuthorization:{...pending.deviceAuthorization}}:{}),
      ...(error?{error}:saved?.requiresReconnect?{error:'토큰 갱신 결과를 확인할 수 없어 재연결이 필요합니다. 자동 재시도하지 않습니다.'}:{}),...(saved?.lastTest?{lastTest:saved.lastTest}:{})};
  });}
  private phase(id:AppId,phase:AppConnectorPhase,deviceAuthorization?:AppDeviceAuthorization):void{if(this.pending?.id!==id)return;this.pending.phase=phase;if(deviceAuthorization)this.pending.deviceAuthorization={...deviceAuthorization};this.notify();}
  private async client(provider:AppConnectorProvider,signal:AbortSignal):Promise<ClientConfig>{
    if(this.options.secrets.has(configKey(provider))){const raw=await this.options.secrets.read(configKey(provider),signal);if(!raw)fail('앱 등록이 변경되었습니다. 다시 연결하세요.');const value=configuration(JSON.parse(raw!));if(value.provider!==provider)fail('앱 등록 공급자가 일치하지 않습니다.');return value;}
    const managed=this.registrations.get(provider);if(!managed)fail(unavailable);
    return {provider,clientId:managed.clientId,...(managed.provider==='slack'?{appId:managed.appId}:{}),...(managed.provider==='github'?{githubApp:managed.githubApp,flow:'device' as const}:{})};
  }
  isBusy():boolean{return !!this.pending;}
  /** Stable for one OAuth grant, including token refresh; changes when the account is reconnected. Host only. */
  grantRevision(id:AppId):string|undefined{return this.options.secrets.has(tokenKey(appConnectorId(id)))?this.store.snapshot().apps[id]?.grantId:undefined;}
  private idle():void{this.options.assertMutable();if(this.pending)fail('진행 중인 앱 연결 요청이 끝나거나 취소한 뒤 다시 시도하세요.');}
  private notify():void{try{this.options.changed();}catch{/* Observers cannot alter credential commits. */}}
  private operation<T>(id:AppId,status:'authorizing'|'verifying',fn:(signal:AbortSignal)=>Promise<T>,external?:AbortSignal):Promise<T>{
    this.idle();const controller=new AbortController(),forward=()=>controller.abort();external?.addEventListener('abort',forward,{once:true});if(external?.aborted)forward();
    const done=Promise.resolve().then(()=>{abort(controller.signal);return fn(controller.signal);}).catch(error=>{const detail=publicError(error),phase=this.pending?.id===id?this.pending.phase:undefined;const message=phase?`${phases[phase]} ${detail}`:detail;if(!controller.signal.aborted)this.errors.set(id,message);throw new ConnectorError(message);}).finally(()=>{external?.removeEventListener('abort',forward);this.pending=undefined;this.notify();});
    this.pending={id,status,controller,done,...(status==='verifying'?{phase:'checking_connection' as const}:{})};this.notify();return done;
  }
  async configure(input:ConfigureAppConnectorInput):Promise<AppConnectorView[]>{
    this.idle();const config=configuration(input),ids=APP_CONNECTORS.filter(item=>item.provider===config.provider).map(item=>item.id);
    if(ids.some(id=>this.options.secrets.has(tokenKey(id))))fail('기존 인증과 앱 등록이 섞이지 않도록 이 공급자의 앱 연결을 먼저 해제하세요.');
    await this.operation(ids[0]!,'verifying',async signal=>{await this.options.secrets.write(configKey(config.provider),JSON.stringify(config),{signal,beforeCommit:()=>{abort(signal);this.options.assertMutable(true);},afterCommit:()=>this.store.update(draft=>{draft.providers[config.provider]=config.githubApp===undefined?{}:{githubApp:config.githubApp};})});for(const id of ids)this.errors.delete(id);});return this.list();
  }
  async connect(input:ConnectAppConnectorInput):Promise<AppConnectorView[]>{
    const id=appConnectorId(input.id);if(input.consentAccepted!==true)fail('공식 로그인으로 연결하려면 연결 버튼을 눌러 동의하세요.');
    const definition=appConnectorDefinition(id);if(definition.provider!=='notion'&&!this.options.secrets.has(configKey(definition.provider))&&!this.registrations.has(definition.provider))fail(`${unavailable} ${definition.provider==='github'?'전용 등록이 필요합니다.':''}`);
    // Start in background; the renderer can cancel or close its dialog without retaining an OAuth URL/token.
    void this.operation(id,'authorizing',async signal=>{
      this.errors.delete(id);const provider=definition.provider;this.phase(id,provider!=='notion'&&this.options.secrets.has(configKey(provider))?'reading_registration':'discovering');
      const preset=provider==='notion'?undefined:await this.client(provider,signal);
      this.phase(id,'discovering');
      if(provider==='github'&&preset?.flow==='device'){
        const metadata:OAuthMetadata={issuer:'https://github.com',authorizationEndpoint:'https://github.com/login/device',tokenEndpoint:'https://github.com/login/oauth/access_token'},scopes=preset.githubApp?[]:definition.scopes;
        this.phase(id,'opening_browser');
        const response=await githubDeviceAuthorization({fetcher:this.fetcher,clientId:preset.clientId,scopes:preset.githubApp?['offline_access']:scopes,signal,openExternal:this.options.openExternal,progress:value=>this.phase(id,'awaiting_consent',value),...(this.options.deviceWait?{wait:this.options.deviceWait}:{})});
        this.phase(id,'exchanging_token');const token=this.tokenResponse(id,preset,metadata,response,scopes);
        const identity=await jsonRequest(this.fetcher,'github','https://api.github.com/user',{headers:{Authorization:`Bearer ${token.accessToken}`,Accept:'application/vnd.github+json'}},signal);
        if(!Number.isSafeInteger(identity.id)||Number(identity.id)<1)fail('GitHub 계정 확인을 완료하지 못했습니다. 기존 연결은 유지됩니다.');
        this.phase(id,'saving_credential');await this.saveToken(token,signal,true);this.errors.delete(id);return;
      }
      const metadata=await discover(this.fetcher,provider,signal),callback=await oauthCallback(provider,signal);
      try{
        let config:ClientConfig;
        if(provider==='notion'){
          this.phase(id,'registering');if(!metadata.registrationEndpoint)fail('Notion의 앱 등록 주소를 찾을 수 없습니다.');
          const registered=await jsonRequest(this.fetcher,provider,metadata.registrationEndpoint!,{method:'POST',headers:{'Content-Type':'application/json',Accept:'application/json'},body:JSON.stringify({client_name:'VenditBot',redirect_uris:[callback.redirectUri],grant_types:['authorization_code','refresh_token'],response_types:['code'],token_endpoint_auth_method:'none',scope:'default'})},signal);
          config={provider,clientId:text(registered.client_id,512)};if(registered.client_secret!==undefined)config.clientSecret=text(registered.client_secret,2048);
        }else{config=preset!;}
        abort(signal);const scopes=provider==='github'&&config.githubApp?[]:definition.scopes;
        const url=new URL(metadata.authorizationEndpoint);for(const [key,value]of Object.entries({client_id:config.clientId,redirect_uri:callback.redirectUri,response_type:'code',state:callback.state,code_challenge:callback.challenge,code_challenge_method:'S256'}))url.searchParams.set(key,value);
        if(scopes.length)url.searchParams.set('scope',scopes.join(provider==='slack'?',':' '));if(metadata.resource)url.searchParams.set('resource',metadata.resource);
        if(provider==='google'){url.searchParams.set('access_type','offline');url.searchParams.set('prompt','consent');}
        this.phase(id,'opening_browser');try{await this.options.openExternal(url.href);}catch{fail('공식 로그인 브라우저를 열지 못했습니다. 기본 브라우저 설정을 확인한 뒤 다시 연결하세요.');}this.phase(id,'awaiting_consent');const code=await callback.code;abort(signal);this.phase(id,'exchanging_token');
        const body=new URLSearchParams({grant_type:'authorization_code',client_id:config.clientId,redirect_uri:callback.redirectUri,code,code_verifier:callback.verifier});if(config.clientSecret&&provider!=='slack')body.set('client_secret',config.clientSecret);if(metadata.resource)body.set('resource',metadata.resource);
        const response=await jsonRequest(this.fetcher,provider,metadata.tokenEndpoint,{method:'POST',headers:{'Content-Type':'application/x-www-form-urlencoded',Accept:'application/json'},body},signal);
        const token=this.tokenResponse(id,config,metadata,response,scopes);this.phase(id,'saving_credential');await this.saveToken(token,signal,true);this.errors.delete(id);
      }finally{callback.close();}
    }).catch(()=>{});return this.list();
  }
  async cancel(input:AppConnectorInput):Promise<AppConnectorView[]>{const id=appConnectorId(input.id);if(this.pending?.id===id){this.pending.controller.abort();await this.pending.done.catch(()=>{});}return this.list();}
  async disconnect(input:AppConnectorInput):Promise<AppConnectorView[]>{const id=appConnectorId(input.id);await this.cancel({id});this.idle();this.options.secrets.remove(tokenKey(id),()=>this.store.update(draft=>{delete draft.apps[id];}));this.errors.delete(id);this.notify();return this.list();}
  async abortAndWait(timeoutMs=4000):Promise<boolean>{const pending=this.pending;if(!pending)return true;pending.controller.abort();let timer:ReturnType<typeof setTimeout>|undefined;try{return await Promise.race([pending.done.then(()=>true,()=>true),new Promise<false>(resolve=>{timer=setTimeout(()=>resolve(false),timeoutMs);})]);}finally{if(timer)clearTimeout(timer);}}
  private tokenResponse(id:AppId,config:ClientConfig,metadata:OAuthMetadata,response:Record<string,unknown>,requested:string[],previous?:StoredToken):StoredToken{
    const value=response.authed_user?record(response.authed_user):response,accessToken=text(value.access_token??response.access_token,3500),type=value.token_type??response.token_type;
    if(type!==undefined&&!['bearer','user'].includes(String(type).toLowerCase()))fail('앱에서 지원되는 토큰을 받지 못했습니다.');
    const scopeValue=value.scope??response.scope;const scopes=typeof scopeValue==='string'?scopeValue.split(/[ ,]+/).filter(Boolean):requested;
    if(requested.some(scope=>!scopes.includes(scope)))fail('필요한 읽기 권한 일부가 승인되지 않았습니다. 기존 연결은 유지됩니다.');
    const result:StoredToken={id,provider:config.provider,accessToken,config,metadata,scopes};const refresh=value.refresh_token??response.refresh_token??previous?.refreshToken;if(refresh!==undefined)result.refreshToken=text(refresh,3500);
    const expires=value.expires_in??response.expires_in;if(expires!==undefined){if(typeof expires!=='number'||!Number.isFinite(expires)||expires<=0||expires>366*86400)fail('토큰 만료 시간을 확인할 수 없습니다.');result.expiresAt=Date.now()+expires*1000;}return result;
  }
  private async saveToken(token:StoredToken,signal:AbortSignal,newGrant=false):Promise<void>{
    await this.options.secrets.write(tokenKey(token.id),JSON.stringify(token),{signal,beforeCommit:()=>{abort(signal);this.options.assertMutable(true);},afterCommit:()=>this.store.update(draft=>{draft.apps[token.id]={...(newGrant?{}:draft.apps[token.id]),grantId:newGrant?randomUUID():draft.apps[token.id]?.grantId??randomUUID(),requiresReconnect:false};})});
  }
  private async token(id:AppId,signal:AbortSignal):Promise<StoredToken>{
    if(this.store.snapshot().apps[id]?.requiresReconnect)fail('토큰 갱신 결과가 불확실합니다. 앱을 다시 연결하세요.');
    const raw=await this.options.secrets.read(tokenKey(id),signal);if(!raw)fail('먼저 앱을 연결하세요.');
    const value=record(JSON.parse(raw!)),provider=appConnectorDefinition(id).provider;if(value.id!==id||value.provider!==provider)fail('앱 인증의 연결 대상을 확인할 수 없습니다.');
    const config=record(value.config),metadata=record(value.metadata);if(config.provider!==provider||typeof config.clientId!=='string'||!Array.isArray(value.scopes)||!value.scopes.every(scope=>typeof scope==='string'))fail('앱 인증 저장 형식을 확인할 수 없습니다.');
    text(value.accessToken,3500);trustedUrl(provider,metadata.tokenEndpoint);trustedUrl(provider,metadata.authorizationEndpoint);trustedUrl(provider,metadata.issuer);if(metadata.resource)trustedUrl(provider,metadata.resource);
    if(value.expiresAt!==undefined&&(typeof value.expiresAt!=='number'||!Number.isFinite(value.expiresAt)))fail('앱 인증 만료 정보를 확인할 수 없습니다.');
    const token=value as unknown as StoredToken;if(!token.expiresAt||token.expiresAt>Date.now()+60_000)return token;
    if(!token.refreshToken)fail('앱 인증이 만료되었습니다. 다시 연결하세요.');
    // Refresh tokens may rotate even when the response is lost. Persist this fence before sending once.
    this.store.update(draft=>{draft.apps[id]={...draft.apps[id],requiresReconnect:true};});
    const body=new URLSearchParams({grant_type:'refresh_token',client_id:token.config.clientId,refresh_token:token.refreshToken!});if(token.config.clientSecret&&provider!=='slack')body.set('client_secret',token.config.clientSecret);
    if(token.metadata.resource)body.set('resource',token.metadata.resource);
    const response=await jsonRequest(this.fetcher,provider,token.metadata.tokenEndpoint,{method:'POST',headers:{'Content-Type':'application/x-www-form-urlencoded',Accept:'application/json'},body},signal);
    const refreshed=this.tokenResponse(id,token.config,token.metadata,response,token.scopes,token);await this.saveToken(refreshed,signal);return refreshed;
  }
  async test(input:TestAppConnectorInput):Promise<AppConnectorView[]>{
    const id=appConnectorId(input.id),definition=appConnectorDefinition(id);let result:AppConnectorTest|undefined;
    try{await this.operation(id,'verifying',async signal=>{const token=await this.token(id,signal);if(definition.provider==='google'){await googleTest(this.fetcher,id,token.accessToken,signal,input.resourceId);result={ok:true,checkedAt:new Date().toISOString(),message:'실제 Google API의 읽기 응답을 확인했습니다. 쓰기 작업은 하지 않았습니다.',kind:'api_read'};}
      else{const tools=await new ReadOnlyMcp(this.fetcher,definition.provider,token.accessToken,signal).list();result={ok:true,checkedAt:new Date().toISOString(),message:'공식 MCP 연결과 도구 목록을 확인했습니다. 실제 문서·채널·저장소 조회 성공을 의미하지는 않습니다.',kind:'mcp_handshake',toolCount:tools.length};}abort(signal);this.errors.delete(id);this.store.update(draft=>{draft.apps[id]={...draft.apps[id],lastTest:result!};});});}
    catch(error){result={ok:false,checkedAt:new Date().toISOString(),message:publicError(error),kind:definition.provider==='google'?'api_read':'mcp_handshake'};this.store.update(draft=>{draft.apps[id]={...draft.apps[id],lastTest:result!};});this.notify();}return this.list();
  }
  /** Host must authorize the session's read before invoking. No arbitrary URLs, writes or remote tool names outside the allowlist. */
  async read(input:AppReadInput,signal?:AbortSignal):Promise<unknown>{
    const id=appConnectorId(input.id),operation=text(input.operation,100),args=input.args===undefined?{}:record(input.args);if(JSON.stringify(args).length>8000)fail('앱 읽기 입력 한도를 초과했습니다.');
    return this.operation(id,'verifying',async current=>{const token=await this.token(id,current);let value:unknown;
      if(token.provider==='google')value=operation==='list_read_tools'?{operations:GOOGLE_OPERATIONS[id]}:await googleRead(this.fetcher,id,operation,args,token.accessToken,current);
      else if(id==='github'&&operation==='read_feedback_pr_verification'){value=await readFeedbackGithubProof(this.fetcher,token.accessToken,args,current);}
      else{const mcp=new ReadOnlyMcp(this.fetcher,token.provider,token.accessToken,current);value=operation==='list_read_tools'?{tools:await mcp.list()}:await mcp.call(operation,args);}
      abort(current);this.errors.delete(id);let output=JSON.stringify(value);
      // Redact both representations, including quoted/escaped credentials in a
      // JSON value or key. Never rely on provider text to keep bearer values private.
      for(const secret of [token.accessToken,token.refreshToken,token.config.clientSecret])if(secret)for(const representation of new Set([secret,JSON.stringify(secret).slice(1,-1)]))output=output.split(representation).join('[보호된 인증 값]');
      return {app:id,operation,untrustedContent:true,text:output.slice(0,40_000),truncated:output.length>40_000};
    },signal);
  }
}
