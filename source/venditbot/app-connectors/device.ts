import {setTimeout as delay} from 'node:timers/promises';
import type {AppDeviceAuthorization} from '../../shared/app-connectors.js';
import {abort,fail,jsonRequest,oauthErrorMessage,record,request,text,type FetchPort} from './protocol.js';

export type DeviceWait=(milliseconds:number,signal:AbortSignal)=>Promise<void>;
const wait:DeviceWait=async(milliseconds,signal)=>{try{await delay(milliseconds,undefined,{signal});}catch{abort(signal);fail('기기 로그인 대기를 완료하지 못했습니다. 다시 연결하세요.');}};
/** GitHub's official public-client device grant. Device code stays host-side and is never persisted. */
export async function githubDeviceAuthorization(options:{fetcher:FetchPort;clientId:string;scopes:string[];signal:AbortSignal;openExternal:(url:string)=>Promise<unknown>;progress:(value:AppDeviceAuthorization)=>void;wait?:DeviceWait}):Promise<Record<string,unknown>>{
 const {fetcher,signal}=options,body=new URLSearchParams({client_id:options.clientId});if(options.scopes.length)body.set('scope',options.scopes.join(' '));
 const headers={'Content-Type':'application/x-www-form-urlencoded',Accept:'application/json'};
 const grant=await jsonRequest(fetcher,'github','https://github.com/login/device/code',{method:'POST',headers,body},signal);
 const deviceCode=text(grant.device_code,256),userCode=text(grant.user_code,16),verificationUri=text(grant.verification_uri,128);
 if(!/^[a-zA-Z0-9_-]{20,256}$/.test(deviceCode)||!/^([A-Z0-9]{4})-([A-Z0-9]{4})$/.test(userCode)||verificationUri!=='https://github.com/login/device')fail('GitHub 기기 로그인 응답을 확인할 수 없습니다.');
 if(!Number.isInteger(grant.expires_in)||Number(grant.expires_in)<1||Number(grant.expires_in)>900||!Number.isInteger(grant.interval)||Number(grant.interval)<1||Number(grant.interval)>60)fail('GitHub 기기 로그인 대기 시간을 확인할 수 없습니다.');
 const expiresAt=Date.now()+Number(grant.expires_in)*1000;let interval=Number(grant.interval)*1000;
 abort(signal);options.progress({userCode,verificationUri,expiresAt:new Date(expiresAt).toISOString()});
 try{await options.openExternal(verificationUri);}catch{fail('공식 로그인 브라우저를 열지 못했습니다. 기본 브라우저 설정을 확인하고 다시 연결하세요.');}
 while(Date.now()<expiresAt){
  abort(signal);const remaining=expiresAt-Date.now();if(interval>=remaining)break;
  await (options.wait??wait)(interval,signal);abort(signal);if(Date.now()>=expiresAt)break;
  const form=new URLSearchParams({client_id:options.clientId,device_code:deviceCode,grant_type:'urn:ietf:params:oauth:grant-type:device_code'});
  const response=await request(fetcher,'github','https://github.com/login/oauth/access_token',{method:'POST',headers,body:form},signal);
  let value:Record<string,unknown>;try{value=record(JSON.parse(response.body));}catch{return fail('GitHub 로그인 응답을 확인할 수 없습니다.');}
  if(value.error==='authorization_pending'&&(response.response.ok||response.response.status===400))continue;
  if(value.error==='slow_down'&&(response.response.ok||response.response.status===400)){
   interval+=5000;if(Number.isInteger(value.interval)&&Number(value.interval)>0&&Number(value.interval)<=900)interval=Math.max(interval,Number(value.interval)*1000);continue;
  }
  if(value.error)fail(oauthErrorMessage(value.error));if(!response.response.ok)fail('GitHub 기기 로그인 요청을 완료하지 못했습니다. 잠시 후 다시 연결하세요.');
  abort(signal);return value;
 }
 return fail(oauthErrorMessage('expired_token'));
}
