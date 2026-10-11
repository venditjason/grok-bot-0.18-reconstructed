import { createInterface } from 'node:readline';
import { appendFileSync } from 'node:fs';
const png = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jfnkAAAAASUVORK5CYII=';
const send = value => process.stdout.write(JSON.stringify(value)+'\n');
const mode = process.env.AVATAR_MODE;
for await (const line of createInterface({input:process.stdin})) {
  const request=JSON.parse(line), {id,method}=request;
  appendFileSync(process.env.AVATAR_LOG,JSON.stringify(request)+'\n');
  if(id==null)continue;
  let result={};
  if(method==='account/read')result={account:mode==='unauthenticated'?null:{type:'chatgpt',email:'mock@example.invalid'}};
  if(method==='modelProvider/capabilities/read')result={imageGeneration:mode!=='unsupported'};
  if(method==='model/list')result={data:[{model:'mock-model',displayName:'Mock',isDefault:true,supportedReasoningEfforts:[{reasoningEffort:'low'}],defaultReasoningEffort:'low'}],nextCursor:null};
  if(method==='thread/start')result={thread:{id:'image-thread'}};
  if(method==='turn/start') {
    send({id,result:{turn:{id:'image-turn'}}});
    if(mode==='hanging')continue;
    const notify=(method,params)=>send({method,params:{threadId:'image-thread',turnId:'image-turn',...params}});
    setTimeout(()=>{
      send({method:'item/completed',params:{threadId:'unrelated',item:{type:'imageGeneration',status:'failed'}}});
      notify('item/started',{item:{type:'imageGeneration',id:'generated'}});
      if(mode==='limit'){notify('item/completed',{item:{type:'imageGeneration',status:'failed',failure:{type:'usageLimitExceeded',limitId:'images',resetsAt:123}}});return;}
      if(mode==='second'){notify('item/started',{item:{type:'imageGeneration',id:'second'}});return;}
      if(mode!=='no-image')notify('item/completed',{item:{type:'imageGeneration',status:'completed',result:mode==='path-result'?'/private/sensitive/secret.png':png,savedPath:'/private/sensitive/secret.png'}});
      if(mode==='close-after-image'){process.exit(0);return;}
      notify('thread/tokenUsage/updated',{tokenUsage:{total:{inputTokens:20,outputTokens:12,cachedInputTokens:5}}});
      notify('turn/completed',{turn:{id:'image-turn',status:mode==='failed'?'failed':'completed'}});
    },10);
  } else send({id,result});
}
