import {abort,fail,record,trustedUrl,type FetchPort,MCP_ENDPOINTS} from './protocol.js';
type Provider = keyof typeof MCP_ENDPOINTS;
export type RemoteReadTool = {name:string;description?:string;inputSchema:Record<string,unknown>};
/** Explicit allowlist: neither remote annotations nor names supplied by an LLM can grant write capability. */
export const MCP_READ_ALLOWLIST:Record<Provider,readonly string[]>={
  notion:['notion-get-self','notion-search','notion-fetch','notion-get-users','notion-get-teams','notion-get-comments'],
  slack:['slack_search_public','slack_search_channels','slack_read_channel','slack_read_thread','slack_list_channel_members'],
  github:['get_me','search_repositories','search_code','get_file_contents','list_issues','issue_read','list_pull_requests','pull_request_read','search_issues','search_pull_requests'],
};
export class ReadOnlyMcp {
  private session:string|undefined;private nextId=1;private protocol='2025-03-26';private tools:RemoteReadTool[]|undefined;
  constructor(private fetcher:FetchPort,private provider:Provider,private token:string,private signal:AbortSignal){}
  private async rpc(method:string,params:Record<string,unknown>,notification=false):Promise<Record<string,unknown>>{
    abort(this.signal);const id=this.nextId++,headers:Record<string,string>={Authorization:`Bearer ${this.token}`,'Content-Type':'application/json',Accept:'application/json, text/event-stream','MCP-Protocol-Version':this.protocol};
    if(this.provider==='github')headers['X-MCP-Readonly']='true';if(this.session)headers['Mcp-Session-Id']=this.session;
    const signal=AbortSignal.any([this.signal,AbortSignal.timeout(20_000)]),response=await this.fetcher(trustedUrl(this.provider,MCP_ENDPOINTS[this.provider]),{method:'POST',headers,body:JSON.stringify({jsonrpc:'2.0',...(notification?{}:{id}),method,params}),redirect:'manual',signal});
    if(!response.ok)fail(response.status===401?'앱 인증이 만료되었거나 취소되었습니다. 다시 연결하세요.':response.status===403?'앱 권한 또는 조직 승인을 확인하세요.':'공식 MCP 서버가 요청을 완료하지 못했습니다.');
    const session=response.headers.get('mcp-session-id');if(session){if(session.length>512||/[\r\n]/.test(session))fail('MCP 세션 응답을 확인할 수 없습니다.');this.session=session;}
    if(notification){await response.body?.cancel();return {};}
    const reader=response.body?.getReader();if(!reader)fail('MCP 응답을 확인할 수 없습니다.');const decoder=new TextDecoder();let buffer='',size=0;
    const parse=(value:string):Record<string,unknown>|undefined=>{let raw:unknown;try{raw=JSON.parse(value);}catch{return;}const message=record(raw);if(message.id!==id)return;if(message.error)fail('앱의 읽기 도구가 요청을 거절했습니다. 권한과 입력을 확인하세요.');return record(message.result);};
    try{while(true){abort(signal);const next=await reader!.read();if(next.done)break;size+=next.value.byteLength;if(size>2*1024*1024)fail('MCP 응답이 조회 한도를 초과했습니다.');buffer+=decoder.decode(next.value,{stream:true});
      if(response.headers.get('content-type')?.includes('text/event-stream')){
        buffer=buffer.replaceAll('\r\n','\n');let cut:number;while((cut=buffer.indexOf('\n\n'))>=0){const event=buffer.slice(0,cut);buffer=buffer.slice(cut+2);const data=event.split('\n').filter(line=>line.startsWith('data:')).map(line=>line.slice(5).trimStart()).join('\n');if(data){const parsed=parse(data);if(parsed)return parsed;}}
      }
    }const parsed=parse(buffer+decoder.decode());if(parsed)return parsed;return fail('MCP 응답의 요청 ID를 확인할 수 없습니다.');}finally{await reader!.cancel().catch(()=>{});}
  }
  async list():Promise<RemoteReadTool[]>{
    if(this.tools)return structuredClone(this.tools);
    const init=await this.rpc('initialize',{protocolVersion:this.protocol,capabilities:{},clientInfo:{name:'VenditBot',version:'1'}});
    if(typeof init.protocolVersion!=='string'||!['2024-11-05','2025-03-26','2025-06-18','2025-11-25'].includes(init.protocolVersion))fail('지원되는 MCP 프로토콜을 확인할 수 없습니다.');this.protocol=init.protocolVersion;
    await this.rpc('notifications/initialized',{},true);const listed=await this.rpc('tools/list',{});if(!Array.isArray(listed.tools)||listed.tools.length>500)fail('MCP 도구 목록을 확인할 수 없습니다.');
    this.tools=listed.tools.map(record).filter(t=>typeof t.name==='string'&&MCP_READ_ALLOWLIST[this.provider].includes(t.name)).map(t=>({name:t.name as string,...(typeof t.description==='string'?{description:t.description.slice(0,1500)}:{}),inputSchema:record(t.inputSchema)}));return structuredClone(this.tools);
  }
  async call(name:string,args:Record<string,unknown>):Promise<Record<string,unknown>>{
    const tools=await this.list();if(!tools.some(tool=>tool.name===name))fail('이 연결에서 허용된 읽기 전용 도구가 아닙니다.');
    const result=await this.rpc('tools/call',{name,arguments:args});if(result.isError)fail('앱의 읽기 도구가 요청을 완료하지 못했습니다.');return result;
  }
}
