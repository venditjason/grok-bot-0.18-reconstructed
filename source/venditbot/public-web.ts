import {lookup} from 'node:dns/promises';
import type {LookupAddress} from 'node:dns';
import {request} from 'node:https';
import {BlockList, isIP} from 'node:net';
import {createGunzip, createInflate} from 'node:zlib';

export const WEB_USER_AGENT = 'VenditBot/0.4 (https://github.com/venditjason/grok-bot-0.18-reconstructed)';
const blocked = new BlockList();
for (const [address, prefix] of [['0.0.0.0',8],['10.0.0.0',8],['100.64.0.0',10],['127.0.0.0',8],['169.254.0.0',16],['172.16.0.0',12],['192.0.0.0',24],['192.0.2.0',24],['192.88.99.0',24],['192.168.0.0',16],['198.18.0.0',15],['198.51.100.0',24],['203.0.113.0',24],['224.0.0.0',4],['240.0.0.0',4]] as const) blocked.addSubnet(address,prefix,'ipv4');
const global6=new BlockList();global6.addSubnet('2000::',3,'ipv6');
for (const [address,prefix] of [['2001::',23],['2001:db8::',32],['2002::',16]] as const) blocked.addSubnet(address,prefix,'ipv6');
export function publicAddress(address:string):boolean {
  const family=isIP(address);
  return family===4?!blocked.check(address,'ipv4'):family===6&&global6.check(address,'ipv6')&&!blocked.check(address,'ipv6');
}
export function publicUrl(raw:string):URL {
  let url:URL;try{url=new URL(raw);}catch{throw Error('공개 HTTPS 주소를 입력하세요.');}
  const host=url.hostname.toLowerCase();
  if(raw.length>4096||url.protocol!=='https:'||url.username||url.password||url.hash||(url.port&&url.port!=='443')||isIP(host)||host.includes(':')||!host.includes('.')||host.endsWith('.')||/\.(?:localhost|local|internal|invalid|test|onion)$/.test(host)||host==='localhost')throw Error('공개 HTTPS 주소만 읽을 수 있습니다. 내부 주소·인증·사용자 지정 포트는 지원하지 않습니다.');
  return url;
}
export type PublicResponse={url:string;status:number;headers:Record<string,string>;body:string;retrievedAt:string};
export type PublicGet=(url:string,signal:AbortSignal,headers?:{ifModifiedSince?:string})=>Promise<PublicResponse>;
type Network={resolve:typeof lookup;request:typeof request};
/** DNS is checked on every redirect and the validated address is pinned to the TLS socket.
 * This transport never uses caller cookies, credentials, proxy configuration or a second DNS lookup. */
export function publicTransport(network:Network={resolve:lookup,request}):PublicGet {
  return async(raw,callerSignal,conditional={})=>{
    const signal=AbortSignal.any([callerSignal,AbortSignal.timeout(15_000)]);
    const run=async(url:URL,redirects:number):Promise<PublicResponse>=>{
      signal.throwIfAborted();
      const addresses=await new Promise<LookupAddress[]>((resolve,reject)=>{
        const abort=()=>reject(Error('웹 조회가 취소되었거나 시간이 초과되었습니다.'));
        signal.addEventListener('abort',abort,{once:true});
        network.resolve(url.hostname,{all:true,verbatim:true}).then(resolve,reject).finally(()=>signal.removeEventListener('abort',abort));
      });
      signal.throwIfAborted();
      if(!Array.isArray(addresses)||!addresses.length||addresses.some(x=>!publicAddress(x.address)))throw Error('웹 주소가 사설망 또는 지원하지 않는 네트워크를 가리킵니다.');
      const address=addresses[0]!;
      return new Promise<PublicResponse>((resolve,reject)=>{
        let settled=false;
        const fail=()=>{if(!settled){settled=true;reject(Error('웹 조회가 실패했거나 제한을 초과했습니다.'));}};
        const req=network.request(url,{method:'GET',agent:false,signal,servername:url.hostname,
          lookup:(_hostname,options,callback)=>{if(typeof options==='object'&&options.all)callback(null,[address]);else callback(null,address.address,address.family);},
          headers:{'User-Agent':WEB_USER_AGENT,Accept:'text/html, text/plain, application/json;q=0.9','Accept-Encoding':'gzip, deflate',...(conditional.ifModifiedSince?{'If-Modified-Since':conditional.ifModifiedSince}:{})}},res=>{
          const status=res.statusCode??0;
          if([301,302,303,307,308].includes(status)){
            res.destroy();
            if(redirects>=3||!res.headers.location){fail();return;}
            let next:URL;try{next=publicUrl(new URL(res.headers.location,url).href);}catch{fail();return;}
            settled=true;run(next,redirects+1).then(resolve,reject);return;
          }
          const headers:Record<string,string>={};for(const key of ['content-type','expires','last-modified','retry-after','date'])if(typeof res.headers[key]==='string')headers[key]=res.headers[key];
          if(status===304){settled=true;res.destroy();resolve({url:url.href,status,headers,body:'',retrievedAt:new Date().toISOString()});return;}
          if(Number(res.headers['content-length'])>1024*1024){res.destroy();fail();return;}
          const encoding=res.headers['content-encoding'];
          if(encoding&&encoding!=='identity'&&encoding!=='gzip'&&encoding!=='deflate'){res.destroy();fail();return;}
          let compressed=0;res.on('data',(chunk:Buffer)=>{compressed+=chunk.length;if(compressed>1024*1024){res.destroy();fail();}});
          const decoder=encoding==='gzip'?createGunzip():encoding==='deflate'?createInflate():undefined;
          const stream=decoder?res.pipe(decoder):res;let size=0;const chunks:Buffer[]=[];
          res.on('error',fail);stream.on('error',fail);
          stream.on('data',(chunk:Buffer)=>{size+=chunk.length;if(size>1024*1024){res.destroy();decoder?.destroy();fail();}else chunks.push(Buffer.from(chunk));});
          stream.on('end',()=>{if(!settled){settled=true;resolve({url:url.href,status,headers,body:Buffer.concat(chunks).toString('utf8'),retrievedAt:new Date().toISOString()});}});
          res.on('aborted',fail);
        });
        req.on('error',fail);req.end();
      });
    };
    return run(publicUrl(raw),0);
  };
}
export const getPublicWeb=publicTransport();
