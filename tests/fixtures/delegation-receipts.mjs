import {createHash} from 'node:crypto';
// Queue/roster/lifecycle fixtures supply a deterministic, host-owned file read
// observation. Security/negative suites use the raw coordinator instead.
const content='synthetic file receipt for coordinator lifecycle regressions';
export const receiptContract={inputReferences:['fixture:owned-file'],expectedArtifact:'fixture.txt exact content',ownedFiles:[],acceptance:{kind:'file_content_sha256',path:'fixture.txt',sha256:createHash('sha256').update(content).digest('hex')}};
export function withSuccessfulFileReceiptFixtures(Coordinator){return class ReceiptFixtureCoordinator extends Coordinator {
 constructor(store,port){const receipts=new Map();let coordinator;const originalGet=port.getSession.bind(port);
  const wrapped={artifactMatches:(_id,path,sha)=>path==='fixture.txt'&&sha===receiptContract.acceptance.sha256,getSession:id=>receipts.has(id)?structuredClone(receipts.get(id)):originalGet(id),enqueue:(id,prompt,hooks)=>port.enqueue(id,prompt,{...hooks,settled:async(session,error)=>{
   const run=store.findSessionRun(id),step=run?.steps.find(s=>s.sessionId===id),copy=structuredClone(session),answer=copy.messages.at(-1);
   if(run?.requiredPolicy && answer){answer.requiredPolicy=structuredClone(run.requiredPolicy);if(step?.kind==='work'&&answer.status==='completed'&&answer.tools===undefined)answer.tools=[{callId:'fixture-read-'+answer.id,name:'read_file',status:'completed',input:{path:'fixture.txt'},output:{path:'fixture.txt',content}}];receipts.set(id,copy);}
   if(!error&&step?.kind!=='work'&&answer?.status==='completed')for(const child of run?.steps??[]){if(child.kind==='work'&&child.status==='completed'&&child.contract&&!child.acceptanceReceipt)await coordinator.rawTools(id).execute('accept_team_result',{sessionId:child.sessionId},'fixture-accept-'+child.sessionId);}
   hooks.settled(copy,error);
  }})};super(store,new Proxy(port,{get(target,key){return key in wrapped ? wrapped[key] : target[key];}}));coordinator=this;
 }
 rawTools(id,signal){return super.tools(id,signal);}
 tools(id,signal){const tools=super.tools(id,signal);return tools?{...tools,execute:(name,args,callId)=>tools.execute(name,name==='delegate_team_task'&&args&&typeof args==='object'&&args.contract===undefined?{...args,contract:structuredClone(receiptContract)}:args,callId)}:tools;}
};}
