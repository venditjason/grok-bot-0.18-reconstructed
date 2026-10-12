import {constants,existsSync,lstatSync,openSync,readFileSync,closeSync,fstatSync} from 'node:fs';
import {join} from 'node:path';
import {atomicWriteJson} from '../local-store.js';
import {appConnectorId,appConnectorProvider,type AppId,type AppConnectorProvider,type AppConnectorTest} from '../../shared/app-connectors.js';
import {fail,record} from './protocol.js';
export type ConnectorMetadata={providers:Partial<Record<AppConnectorProvider,{githubApp?:boolean}>>;apps:Partial<Record<AppId,{lastTest?:AppConnectorTest;requiresReconnect?:boolean;grantId?:string}>>};
/** Only public configuration flags and fixed diagnostic text, never credentials or API content. */
export class AppConnectorStore {
  private value:ConnectorMetadata={providers:{},apps:{}};private readonly file:string;private raw:string|undefined;
  constructor(root:string){this.file=join(root,'app-connectors.json');this.raw=this.read();if(this.raw!==undefined){const data=record(JSON.parse(this.raw));if(data.version!==1)fail('앱 연결 저장 형식을 확인하세요. 원본은 보존했습니다.');
    const providers=record(data.providers),apps=record(data.apps);
    for(const [key,value]of Object.entries(providers)){const provider=appConnectorProvider(key),config=record(value);if(config.githubApp!==undefined&&typeof config.githubApp!=='boolean')fail('앱 연결 저장 형식을 확인하세요.');this.value.providers[provider]=config.githubApp===undefined?{}:{githubApp:config.githubApp};}
    for(const [key,value]of Object.entries(apps)){const id=appConnectorId(key),item=record(value),entry:NonNullable<ConnectorMetadata['apps'][AppId]>={};
      if(item.grantId!==undefined){if(typeof item.grantId!=='string'||!/^[a-f0-9-]{36}$/.test(item.grantId))fail('앱 인증 식별자 형식을 확인하세요.');entry.grantId=item.grantId;}
      if(item.requiresReconnect!==undefined){if(typeof item.requiresReconnect!=='boolean')fail('앱 연결 저장 형식을 확인하세요.');entry.requiresReconnect=item.requiresReconnect;}
      if(item.lastTest!==undefined){const test=record(item.lastTest);if(typeof test.ok!=='boolean'||typeof test.checkedAt!=='string'||!Number.isFinite(Date.parse(test.checkedAt))||typeof test.message!=='string'||test.message.length>600||!['api_read','mcp_handshake'].includes(String(test.kind)))fail('앱 검사 기록 형식을 확인하세요.');entry.lastTest={ok:test.ok,checkedAt:test.checkedAt,message:test.message,kind:test.kind as AppConnectorTest['kind']};if(test.toolCount!==undefined){if(!Number.isInteger(test.toolCount)||Number(test.toolCount)<0||Number(test.toolCount)>500)fail('앱 검사 기록 형식을 확인하세요.');entry.lastTest.toolCount=Number(test.toolCount);}}
      this.value.apps[id]=entry;
    }
  }}
  snapshot():ConnectorMetadata{return structuredClone(this.value);}
  update(change:(draft:ConnectorMetadata)=>void):void{const next=this.snapshot();change(next);if(this.read()!==this.raw)fail('앱 연결 설정이 다른 곳에서 변경되었습니다. 다시 열어 확인하세요.');const output={version:1,...next};atomicWriteJson(this.file,output);this.raw=JSON.stringify(output,null,2);this.value=next;}
  private read():string|undefined{if(!existsSync(this.file))return;const before=lstatSync(this.file);if(!before.isFile()||before.isSymbolicLink()||before.nlink!==1||before.size>64*1024||(before.mode&0o077)!==0||(process.getuid&&before.uid!==process.getuid()))fail('앱 연결 저장 파일이 안전하지 않습니다.');const fd=openSync(this.file,constants.O_RDONLY|constants.O_NOFOLLOW);try{const stat=fstatSync(fd);if(stat.ino!==before.ino||stat.dev!==before.dev)fail('앱 연결 저장 파일이 변경되었습니다.');const bytes=readFileSync(fd);if(bytes.length!==stat.size||bytes.length>64*1024)fail('앱 연결 저장 파일을 읽는 동안 변경되었습니다.');return bytes.toString('utf8');}finally{closeSync(fd);}}
}
