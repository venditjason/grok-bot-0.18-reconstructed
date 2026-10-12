export type NativeWebSearchEvent={type:'native-web-search';callId:string;status:'running'|'completed'|'failed';input:Record<string,unknown>;output?:unknown};
const short=(s:unknown)=>typeof s==='string'?s.slice(0,2000):undefined;
/** Allowlisted fields only: native protocol payloads may contain unrelated private context. */
export function webInput(raw:unknown):Record<string,unknown>{
  if(!raw||typeof raw!=='object')return {};
  const x=raw as Record<string,unknown>,result:Record<string,unknown>={};
  for(const key of ['type','query','url','pattern'])if(short(x[key])!==undefined)result[key]=short(x[key]);
  if(Array.isArray(x.queries))result.queries=x.queries.filter(v=>typeof v==='string').slice(0,5).map(v=>v.slice(0,2000));
  return result;
}
/** Claude emits tool_use/tool_result messages around its approved WebSearch builtin. */
export class ClaudeWebEvents {
  private calls=new Map<string,Record<string,unknown>>();private done=new Set<string>();
  read(message:any):NativeWebSearchEvent[]{
    const events:NativeWebSearchEvent[]=[];
    if(!Array.isArray(message?.message?.content))return events;
    for(const block of message.message.content){
      if(message.type==='assistant'&&(block.type==='tool_use'||block.type==='server_tool_use')&&block.name==='WebSearch'&&typeof block.id==='string'&&block.id.length<=200&&!this.calls.has(block.id)){
        if(this.calls.size>=50)throw Error('공식 웹 검색 횟수 제한을 초과했습니다.');
        const input=webInput(block.input);this.calls.set(block.id,input);events.push({type:'native-web-search',callId:block.id,status:'running',input});
      }
      if(message.type==='user'&&block.type==='tool_result'&&typeof block.tool_use_id==='string'&&this.calls.has(block.tool_use_id)&&!this.done.has(block.tool_use_id)){
        this.done.add(block.tool_use_id);events.push({type:'native-web-search',callId:block.tool_use_id,status:block.is_error===true?'failed':'completed',input:this.calls.get(block.tool_use_id)!,output:{native_result_received:true,success:block.is_error!==true}});
      }
    }
    return events;
  }
}
