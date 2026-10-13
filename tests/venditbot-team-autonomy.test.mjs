import {withSuccessfulFileReceiptFixtures} from './fixtures/delegation-receipts.mjs';
import assert from 'node:assert/strict';
import test from 'node:test';
import {mkdtemp,readFile,writeFile,rename,mkdir,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {randomUUID} from 'node:crypto';
import {setImmediate as tick} from 'node:timers/promises';
import {build} from 'esbuild';
const built=await build({stdin:{contents:"export * from './source/venditbot/team-store.ts';export * from './source/venditbot/team-coordinator.ts';export * from './source/venditbot/agent-store.ts';export * from './source/venditbot/task-queue.ts';",resolveDir:process.cwd()},bundle:true,platform:'node',format:'esm',write:false});
const {TeamStore,TeamCoordinator: RawTeamCoordinator,AgentStore,TaskQueue,validTeamRun}=await import('data:text/javascript;base64,'+Buffer.from(built.outputFiles[0].text).toString('base64'));
const TeamCoordinator=withSuccessfulFileReceiptFixtures(RawTeamCoordinator);
const draft={name:'대표',instructions:'검증된 역할',connectionId:'codex',model:'qa-model',effort:'low',connections:[{connectionId:'codex',model:'qa-model',effort:'low'},{connectionId:'claude-code',model:'qa-claude'}],workspacePath:'/synthetic/workspace'};
const deferred=()=>{let resolve;return {promise:new Promise(done=>resolve=done),resolve:value=>resolve(value)};};
async function fixture(t,autonomous=true){
 const root=await mkdtemp(join(tmpdir(),'vendit-autonomy-')),agents=new AgentStore(root),leader=agents.save(draft),store=new TeamStore(root),sessions=new Map(),jobs=new Map(),starts=[],removed=[];let coordinator,maxRunning=0;
 const queue=new TaskQueue({onChange:()=>{maxRunning=Math.max(maxRunning,queue.state().running.length);coordinator?.schedule();}});
 const port={createSessions(run){for(const step of run.steps)if(!sessions.has(step.sessionId))sessions.set(step.sessionId,{id:step.sessionId,messages:[],taskStatus:'queued'});},enqueue(id,prompt,hooks){const done=deferred();jobs.set(id,{done,prompt});queue.submit(id,async signal=>{starts.push(id);hooks.started();const cancel=()=>done.resolve({status:'cancelled',text:''});signal.addEventListener('abort',cancel,{once:true});try{const answer=await done.promise;sessions.get(id).messages.push({id:randomUUID(),role:'assistant',...answer});}finally{signal.removeEventListener('abort',cancel);hooks.settled(structuredClone(sessions.get(id)));}});},cancelSession:id=>queue.abort(id),getSession:id=>structuredClone(sessions.get(id)),listAgents:()=>agents.list(),listModels:async()=>({models:[]}),resolveDelegation:async member=>({connections:member.connections}),cloneAgent(template,changes){const {id,createdAt,updatedAt,...rest}=template;return agents.save({...rest,...changes});},removeAgent(id,revision){removed.push(id);agents.remove(id,revision);},queueState:()=>queue.state(),changed(){},teamChanged(){}};
 coordinator=new TeamCoordinator(store,port);const team=store.saveTeam({name:'자율 팀',instructions:'작업에 필요한 구성',topic:'',policies:'',leaderAgentId:leader.id,memberAgentIds:[leader.id],rounds:1,...(autonomous===undefined?{}:{autonomous})});
 const f={root,agents,leader,store,port,queue,coordinator,team,jobs,starts,removed,maxRunning:()=>maxRunning,async start(){const run=coordinator.start(team.id,'팀을 구성해 목표를 수행하세요.',store.getTeam(team.id).memberAgentIds.map(id=>agents.get(id)));await tick();f.run=run;return run;},tools(signal){return coordinator.tools(queue.state().running[0],signal);},async finish(text='완료'){const id=queue.state().running[0];assert.ok(id);jobs.get(id).done.resolve({status:'completed',text});await tick();await tick();}};
 t.after(async()=>{coordinator.stopForQuit();await queue.close(1000);await rm(root,{recursive:true,force:true});});return f;
}
test('legacy absent autonomy normalizes false, persists explicit boolean, and invalid stored flags preserve the original',async t=>{
 const f=await fixture(t,false),file=join(f.root,'teams.json');const data=JSON.parse(await readFile(file,'utf8'));delete data.teams[0].autonomous;await writeFile(file,JSON.stringify(data));const legacy=new TeamStore(f.root);assert.equal(legacy.getTeam(f.team.id).autonomous,false);legacy.saveTeam(legacy.getTeam(f.team.id));assert.equal(JSON.parse(await readFile(file,'utf8')).teams[0].autonomous,false);
 data.teams[0].autonomous='true';const invalid=JSON.stringify(data);await writeFile(file,invalid);assert.throws(()=>new TeamStore(f.root),/손상/);assert.equal(await readFile(file,'utf8'),invalid);
});
test('autonomous spawn defaults to the frozen leader settings, while manual teams still require a template',async t=>{
 const f=await fixture(t);await f.start();f.agents.save({...f.leader,model:'user-new-model',connections:[{connectionId:'codex',model:'user-new-model'}]});const result=await f.tools().execute('add_team_member',{name:'조사 담당',instructions:'새 조사 역할'},'spawn');const spawned=f.agents.get(result.createdAgent.id);assert.deepEqual(spawned.connections,draft.connections);assert.equal(spawned.workspacePath,draft.workspacePath);assert.equal(spawned.effort,'low');assert.equal(f.store.getRun(f.run.id).autonomous,true);assert.equal(f.coordinator.detail(f.run.id).autonomous,true);
 const manual=await fixture(t,false);await manual.start();await assert.rejects(manual.tools().execute('add_team_member',{name:'허용 안 됨'},'manual'),/templateAgentId/);assert.equal(manual.agents.list().length,1);const clone=await manual.tools().execute('add_team_member',{templateAgentId:manual.leader.id,name:'기존 방식'},'explicit');assert.ok(clone.createdAgent);
});
test('more than100 autonomous spawns and delegations persist, restart and execute with unchanged serial concurrency',async t=>{
 const f=await fixture(t);await f.start();const tools=f.tools(),ids=[];
 for(let i=0;i<205;i++){const result=await tools.execute('add_team_member',{name:'구성원 '+i},'spawn-'+i);ids.push(result.createdAgent.id);if(i===0)assert.deepEqual(await tools.execute('add_team_member',{name:'구성원 0'},'spawn-0'),result);}
 assert.equal(f.agents.list().length,206);assert.equal(f.store.getTeam(f.team.id).memberAgentIds.length,206);
 for(const id of ids)await tools.execute('delegate_team_task',{agentId:id,task:'독립 검증'},'work-'+id);
 const firstPage=await tools.execute('list_team_members',{limit:50},'members-page');assert.equal(firstPage.total,206);assert.equal(firstPage.nextOffset,50);assert.equal(firstPage.members.length,50);
 for(let i=0;i<210&&f.queue.state().running.length;i++)await f.finish();const run=f.store.getRun(f.run.id);assert.equal(run.status,'completed',run.error);assert.equal(run.steps.filter(s=>s.kind==='work'&&s.status==='completed').length,205);assert.equal(f.maxRunning(),1);assert.equal(new Set(f.starts).size,f.starts.length);assert.equal(new AgentStore(f.root).list().length,206);assert.equal(new TeamStore(f.root).getRun(run.id).status,'completed');assert.deepEqual(f.removed,[]);assert.ok([...f.jobs.values()].every(job=>Buffer.byteLength(job.prompt)<100000));assert.ok([...f.jobs.values()].some(job=>job.prompt.includes('omittedMembers')));
});
test('rosters and historical member snapshots larger than200 validate without fabricated count caps',async t=>{
 const f=await fixture(t);await f.start();const run=f.store.getRun(f.run.id),stamp=f.leader.updatedAt;
 for(let i=0;i<220;i++){const a={...f.leader,id:'historical-'+i,name:'구성원 '+i,createdAt:stamp,updatedAt:stamp};run.memberSnapshots.push(a);run.activeMemberAgentIds.push(a.id);}
 run.additions=220;run.status='completed';run.steps[0].status='completed';run.finalSessionId=run.steps[0].sessionId;assert.equal(validTeamRun(run),true);f.store.saveTeamAndRun(run);const loaded=new TeamStore(f.root);assert.equal(loaded.getTeam(f.team.id).memberAgentIds.length,221);assert.equal(loaded.getRun(run.id).memberSnapshots.length,221);
});
test('worker, foreign-team and forged deletion calls cannot expand management authority; unlink preserves agents and history',async t=>{
 const f=await fixture(t);await f.start();const leader=f.tools(),made=await leader.execute('add_team_member',{name:'작업자'},'spawn'),id=made.createdAgent.id;
 for(const name of ['delete_agent','deleteAgent','delete_team_member','remove_agent'])await assert.rejects(leader.execute(name,{agentId:id},name),/지원하지/);
 await assert.rejects(leader.execute('remove_team_member',{agentId:id,permanent:true},'forged-delete'),/인자/);
 const foreign=f.agents.save({...draft,name:'다른 팀'});await assert.rejects(leader.execute('remove_team_member',{agentId:foreign.id},'foreign'),/현재 팀원/);
 await leader.execute('delegate_team_task',{agentId:id,task:'검토'},'delegate');await assert.rejects(leader.execute('remove_team_member',{agentId:id},'busy'),/끝나지/);await f.finish('계획');const worker=f.tools();assert.equal(worker.definitions.some(x=>x.name==='add_team_member'),false);await assert.rejects(worker.execute('add_team_member',{name:'위조'},'worker-spawn'),/지원하지/);await f.finish('결과');
 await f.tools().execute('remove_team_member',{agentId:id},'unlink');assert.equal(f.agents.get(id).name,'작업자');assert.equal(f.store.getTeam(f.team.id).memberAgentIds.includes(id),false);assert.equal(f.store.getRun(f.run.id).memberSnapshots.some(a=>a.id===id),true);assert.equal(f.store.getRun(f.run.id).steps.some(s=>s.agentId===id&&s.status==='completed'),true);assert.deepEqual(f.removed,[]);
});
test('run autonomy cannot be promoted by a mid-run team edit and stale role revisions reject before clone',async t=>{
 const f=await fixture(t,false);await f.start();const run=f.store.getRun(f.run.id);f.store.saveTeam({...f.store.getTeam(f.team.id),autonomous:true});await assert.rejects(f.tools().execute('add_team_member',{},'stale'),/변경/);assert.equal(f.agents.list().length,1);assert.equal(f.store.getRun(run.id).autonomous,false);
});
test('cancelled spawn has no effects and storage failure rolls back only its new clone',async t=>{
 const f=await fixture(t);await f.start();const controller=new AbortController(),pending=f.tools(controller.signal).execute('add_team_member',{name:'취소'},'cancel');controller.abort();await assert.rejects(pending,{name:'AbortError'});assert.equal(f.agents.list().length,1);
 const file=join(f.root,'teams.json'),original=await readFile(file);await rename(file,file+'.safe');await mkdir(file);await assert.rejects(f.tools().execute('add_team_member',{name:'실패'},'failed'));assert.equal(f.agents.list().length,1);assert.equal(f.removed.length,1);assert.deepEqual(await readFile(file+'.safe'),original);await rm(file,{recursive:true});await rename(file+'.safe',file);
});
test('a durable spawn survives renderer notification failure and never invokes deletion rollback',async t=>{
 const f=await fixture(t);await f.start();f.port.changed=()=>{throw new Error('renderer gone');};f.port.teamChanged=()=>{throw new Error('renderer gone');};const result=await f.tools().execute('add_team_member',{name:'영구 저장됨'},'notify');assert.match(result.warning,/저장/);assert.equal(f.agents.get(result.createdAgent.id).name,'영구 저장됨');assert.equal(new TeamStore(f.root).getTeam(f.team.id).memberAgentIds.includes(result.createdAgent.id),true);assert.deepEqual(f.removed,[]);
});
test('rollback refuses to delete a newly created agent that changed after the clone revision',async t=>{
 const f=await fixture(t);await f.start();const originalClone=f.port.cloneAgent;let retained;
 f.port.cloneAgent=(template,changes)=>{const created=originalClone(template,changes);retained=f.agents.save({...created,instructions:'사용자가 수정한 역할'});f.store.saveTeam({...f.store.getTeam(f.team.id),name:'사용자가 수정한 팀'});return created;};
 await assert.rejects(f.tools().execute('add_team_member',{name:'보존'},'race'),/자동 정리하지 못했습니다/);assert.equal(f.agents.get(retained.id).instructions,'사용자가 수정한 역할');assert.equal(f.store.getTeam(f.team.id).memberAgentIds.length,1);
});
test('faulty clone results cannot turn rollback into deletion of an existing saved agent',async t=>{
 const f=await fixture(t);await f.start();f.port.cloneAgent=()=>f.leader;await assert.rejects(f.tools().execute('add_team_member',{name:'위조'},'collision'),/충돌/);assert.equal(f.agents.get(f.leader.id).id,f.leader.id);assert.deepEqual(f.removed,[]);
});

test('clearing recoverable storage state cannot report a durable commit as failed when notification throws',async t=>{
 const f=await fixture(t);await f.start();const file=join(f.root,'teams.json'),run=f.store.getRun(f.run.id);await rename(file,file+'.safe');await mkdir(file);assert.throws(()=>f.store.saveRun(run));assert.equal(f.store.unsavedIds().length,1);await rm(file,{recursive:true});await rename(file+'.safe',file);f.store.onStorage=()=>{throw new Error('notification failed');};
 const result=await f.tools().execute('add_team_member',{name:'저장된 구성원'},'storage-notify');assert.equal(f.store.unsavedIds().length,0);assert.equal(f.store.getTeam(f.team.id).memberAgentIds.includes(result.createdAgent.id),true);assert.equal(f.agents.get(result.createdAgent.id).name,'저장된 구성원');assert.deepEqual(f.removed,[]);
});
test('a legacy run without autonomy reads as false and tool input bytes remain bounded',async t=>{
 const f=await fixture(t,false);await f.start();const file=join(f.root,'teams.json'),data=JSON.parse(await readFile(file,'utf8'));delete data.runs[0].autonomous;await writeFile(file,JSON.stringify(data));const legacy=new TeamStore(f.root);assert.equal(legacy.getRun(f.run.id).autonomous,false);assert.equal(legacy.getRun(f.run.id).status,'cancelled');
 await assert.rejects(f.tools().execute('add_team_member',{name:'x'.repeat(1024*1024)},'too-large'),/1MiB/);assert.equal(f.agents.list().length,1);
});
