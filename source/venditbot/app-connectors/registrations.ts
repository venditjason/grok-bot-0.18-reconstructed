import type {AppConnectorProvider} from '../../shared/app-connectors.js';
import {fail,text} from './protocol.js';

/** Dedicated registrations owned by the VenditBot distributor. Public IDs only. */
export type ManagedAppRegistration =
  | {provider:'google';clientId:string;flow:'native_pkce'}
  | {provider:'slack';clientId:string;appId:string;flow:'native_pkce'}
  | {provider:'github';clientId:string;githubApp:boolean;flow:'device'};
/** Verified dedicated public registrations. Google uses private per-install configuration. */
export const MANAGED_APP_REGISTRATIONS:readonly ManagedAppRegistration[] = [
 {provider:'github',clientId:'Iv23lizKDfRa2sIe3DSZ',githubApp:true,flow:'device'},
 {provider:'slack',clientId:'1443515283511.12283089417861',appId:'A0C8B2MC9RB',flow:'native_pkce'},
];

export function managedAppRegistrations(input:readonly ManagedAppRegistration[]=MANAGED_APP_REGISTRATIONS):ReadonlyMap<AppConnectorProvider,ManagedAppRegistration>{
 const result=new Map<AppConnectorProvider,ManagedAppRegistration>();
 if(!Array.isArray(input)||input.length>3)fail('배포된 앱 연결 등록을 확인할 수 없습니다.');
 for(const item of input){
  if(!item||typeof item!=='object'||!['google','slack','github'].includes(item.provider)||result.has(item.provider))fail('배포된 앱 연결 등록이 올바르지 않습니다.');
  const allowed=item.provider==='google'?['provider','clientId','flow']:item.provider==='slack'?['provider','clientId','appId','flow']:['provider','clientId','githubApp','flow'];
  if(Object.keys(item).some(key=>!allowed.includes(key)))fail('배포 앱 등록에는 공개 식별자만 포함할 수 있습니다.');
  const clientId=text(item.clientId,512);if(!/^[A-Za-z0-9._-]+$/.test(clientId))fail('배포 앱 공개 식별자 형식을 확인하세요.');
  if(item.provider==='google'&&(!clientId.endsWith('.apps.googleusercontent.com')||item.flow!=='native_pkce'))fail('Google Desktop 앱 등록을 확인하세요.');
  if(item.provider==='slack'&&(item.flow!=='native_pkce'||!/^A[A-Z0-9]{5,}$/.test(item.appId)))fail('Slack Desktop 앱 등록을 확인하세요.');
  if(item.provider==='github'&&(item.flow!=='device'||typeof item.githubApp!=='boolean'))fail('GitHub 기기 로그인 등록을 확인하세요.');
  result.set(item.provider,Object.freeze({...item}));
 }
 return result;
}
