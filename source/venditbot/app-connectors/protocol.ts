import {createServer} from 'node:http';
import {createHash, randomBytes, timingSafeEqual} from 'node:crypto';
import type {AppConnectorProvider} from '../../shared/app-connectors.js';

export class ConnectorError extends Error {}
export function fail(message: string): never {throw new ConnectorError(message);}
export const publicError = (error: unknown): string => error instanceof ConnectorError ? error.message : '앱 연결 요청을 완료하지 못했습니다. 연결 설정과 네트워크를 확인한 뒤 다시 시도하세요.';
export const abort = (signal: AbortSignal) => {if(signal.aborted) fail('앱 연결 요청을 취소했습니다.');};
export function record(value: unknown): Record<string, unknown> {if(!value || typeof value!=='object' || Array.isArray(value)) return fail('앱 서버의 응답 형식을 확인할 수 없습니다.');return value as Record<string, unknown>;}
export function text(value: unknown, max=4096): string {if(typeof value!=='string'||!value||value.length>max||/[\u0000-\u001f\u007f]/.test(value)) return fail('앱 연결 값의 형식을 확인하세요.');return value;}
export const MCP_ENDPOINTS = {notion:'https://mcp.notion.com/mcp',slack:'https://mcp.slack.com/mcp',github:'https://api.githubcopilot.com/mcp/'};
const origins: Record<AppConnectorProvider, string[]> = {google:['https://accounts.google.com','https://oauth2.googleapis.com','https://gmail.googleapis.com','https://www.googleapis.com','https://docs.googleapis.com','https://sheets.googleapis.com'],notion:['https://mcp.notion.com'],slack:['https://mcp.slack.com','https://slack.com'],github:['https://api.githubcopilot.com','https://github.com','https://api.github.com']};
export function trustedUrl(provider: AppConnectorProvider, raw: unknown): string {
  let url: URL;try{url=new URL(text(raw));}catch{return fail('공식 앱 서버 주소를 확인할 수 없습니다.');}
  if(!origins[provider].includes(url.origin)||url.username||url.password||url.hash) return fail('허용되지 않은 앱 서버 주소입니다.');return url.href;
}
export type FetchPort = typeof fetch;
export async function request(fetcher: FetchPort, provider: AppConnectorProvider, url: string, init: RequestInit, signal: AbortSignal, maxBytes=512*1024): Promise<{response:Response;body:string}> {
  abort(signal);const combined=AbortSignal.any([signal,AbortSignal.timeout(20_000)]);
  const response=await fetcher(trustedUrl(provider,url),{...init,redirect:'manual',signal:combined});
  if(response.status>=300&&response.status<400) return fail('앱 서버가 다른 주소로 이동을 요청하여 연결을 중단했습니다.');
  const reader=response.body?.getReader();let body='';let size=0;const decoder=new TextDecoder('utf-8',{fatal:true});
  if(reader)try{while(true){abort(combined);const next=await reader.read();if(next.done)break;size+=next.value.byteLength;if(size>maxBytes)fail('앱 응답이 조회 한도를 초과했습니다. 범위를 줄여 다시 조회하세요.');body+=decoder.decode(next.value,{stream:true});}body+=decoder.decode();}finally{await reader.cancel().catch(()=>{});}
  abort(combined);return {response,body};
}
export async function jsonRequest(fetcher:FetchPort,provider:AppConnectorProvider,url:string,init:RequestInit,signal:AbortSignal):Promise<Record<string,unknown>> {
  const {response,body}=await request(fetcher,provider,url,init,signal);
  if(!response.ok)fail(response.status===401?'앱 인증이 만료되었거나 취소되었습니다. 다시 연결하세요.':response.status===403?'앱 권한 또는 API 사용 설정을 확인하세요.':response.status===429?'앱 요청 한도에 도달했습니다. 잠시 후 다시 시도하세요.':'앱 서버가 요청을 완료하지 못했습니다.');
  let value:unknown;try{value=JSON.parse(body);}catch{return fail('앱 서버의 JSON 응답을 확인할 수 없습니다.');}const result=record(value);
  if(result.error||result.ok===false)fail('앱 서버가 요청을 거절했습니다. 권한과 연결 설정을 확인하세요.');return result;
}
export type OAuthMetadata={authorizationEndpoint:string;tokenEndpoint:string;issuer:string;registrationEndpoint?:string;resource?:string};
export async function discover(fetcher:FetchPort,provider:AppConnectorProvider,signal:AbortSignal):Promise<OAuthMetadata>{
  if(provider==='google')return {issuer:'https://accounts.google.com',authorizationEndpoint:'https://accounts.google.com/o/oauth2/v2/auth',tokenEndpoint:'https://oauth2.googleapis.com/token'};
  const endpoint=MCP_ENDPOINTS[provider];let metadataUrl=new URL('/.well-known/oauth-protected-resource',endpoint).href;
  if(provider==='github'){
    const {response}=await request(fetcher,provider,endpoint,{method:'POST',headers:{'Content-Type':'application/json',Accept:'application/json, text/event-stream'},body:JSON.stringify({jsonrpc:'2.0',id:1,method:'initialize',params:{protocolVersion:'2025-03-26',capabilities:{},clientInfo:{name:'VenditBot',version:'1'}}})},signal);
    const found=/resource_metadata="([^"]+)"/.exec(response.headers.get('www-authenticate')??'');if(response.status!==401||!found)fail('GitHub의 공식 OAuth 인증 안내를 찾을 수 없습니다.');metadataUrl=trustedUrl(provider,found![1]);
  }
  const resource=await jsonRequest(fetcher,provider,metadataUrl,{},signal),servers=resource.authorization_servers;
  if(!Array.isArray(servers)||!servers.length)fail('앱의 인증 서버 정보를 찾을 수 없습니다.');
  const issuer=text(servers[0]);trustedUrl(provider,issuer);const base=new URL(issuer),path=base.pathname.replace(/\/$/,'');
  const auth=await jsonRequest(fetcher,provider,`${base.origin}/.well-known/oauth-authorization-server${path}`,{},signal);
  if(auth.issuer!==issuer||!Array.isArray(auth.code_challenge_methods_supported)||!auth.code_challenge_methods_supported.includes('S256'))fail('안전한 PKCE 인증을 지원하는 앱 설정이 필요합니다.');
  // OAuth resource and issuer are exact identifiers: URL validation must not add a trailing slash.
  const resourceIdentifier=text(resource.resource??endpoint);trustedUrl(provider,resourceIdentifier);
  const result:OAuthMetadata={issuer,authorizationEndpoint:trustedUrl(provider,auth.authorization_endpoint),tokenEndpoint:trustedUrl(provider,auth.token_endpoint),resource:resourceIdentifier};
  if(provider==='notion'&&auth.registration_endpoint)result.registrationEndpoint=trustedUrl(provider,auth.registration_endpoint);return result;
}

export type OAuthCallback={redirectUri:string;state:string;verifier:string;challenge:string;code:Promise<string>;close:()=>void};
/** One-use, time-bounded loopback listener. Invalid state never consumes the valid callback. */
export async function oauthCallback(provider:AppConnectorProvider,signal:AbortSignal,timeoutMs=300_000):Promise<OAuthCallback>{
  abort(signal);const state=randomBytes(32).toString('base64url'),verifier=randomBytes(48).toString('base64url'),challenge=createHash('sha256').update(verifier).digest('base64url');
  let resolveCode!:(code:string)=>void,rejectCode!:(error:unknown)=>void,finished=false,redirectUri='',timer:ReturnType<typeof setTimeout>|undefined;
  const code=new Promise<string>((resolve,reject)=>{resolveCode=resolve;rejectCode=reject;});void code.catch(()=>{});
  const finish=(value?:string)=>{if(finished)return;finished=true;if(timer)clearTimeout(timer);signal.removeEventListener('abort',cancel);server.close();server.closeAllConnections();value?resolveCode(value):rejectCode(new ConnectorError('앱 로그인을 취소했거나 시간이 초과되었습니다.'));};
  const cancel=()=>finish();
  const server=createServer((req,res)=>{
    res.setHeader('Cache-Control','no-store');res.setHeader('Content-Type','text/plain; charset=utf-8');res.setHeader('Content-Security-Policy',"default-src 'none'");res.setHeader('Referrer-Policy','no-referrer');
    let url:URL;try{url=new URL(req.url??'',redirectUri);}catch{res.writeHead(400).end('잘못된 요청');return;}
    const expected=new URL(redirectUri),supplied=url.searchParams.getAll('state');
    if(req.method!=='GET'||req.headers.host!==expected.host||url.pathname!==expected.pathname||supplied.length!==1||Buffer.byteLength(supplied[0]!)!==Buffer.byteLength(state)||!timingSafeEqual(Buffer.from(supplied[0]!),Buffer.from(state))){res.writeHead(400).end('로그인 확인 값이 올바르지 않습니다.');return;}
    const codes=url.searchParams.getAll('code');if(finished||codes.length>1||url.searchParams.getAll('error').length>1){res.writeHead(400).end('이미 처리했거나 잘못된 요청입니다.');return;}
    if(url.searchParams.has('error')){res.end('앱 연결을 승인하지 않았습니다. 이 창을 닫으세요.');finish();return;}
    if(codes.length!==1||!codes[0]||codes[0].length>4096){res.writeHead(400).end('인증 코드를 확인할 수 없습니다.');return;}
    res.end('인증 응답을 받았습니다. 이 창을 닫고 벤디트봇에서 연결 결과를 확인하세요.');finish(codes[0]);
  });
  // Slack registrations use an exact desktop callback URL. Keep its port stable;
  // Google/GitHub loopback clients and Notion's per-flow DCR use ephemeral ports.
  await new Promise<void>((resolve,reject)=>{server.once('error',reject);server.listen(provider==='slack'?43127:0,'127.0.0.1',()=>{server.removeListener('error',reject);resolve();});});
  const address=server.address();if(!address||typeof address==='string'){server.close();return fail('로그인 응답 포트를 열 수 없습니다.');}
  redirectUri=`http://${provider==='slack'?'localhost':'127.0.0.1'}:${address.port}/oauth/callback/${provider}`;
  timer=setTimeout(cancel,timeoutMs);signal.addEventListener('abort',cancel,{once:true});if(signal.aborted)cancel();
  return {redirectUri,state,verifier,challenge,code,close:cancel};
}
