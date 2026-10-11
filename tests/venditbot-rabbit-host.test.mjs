import assert from 'node:assert/strict';
import test from 'node:test';
import {randomUUID} from 'node:crypto';
import {build} from 'esbuild';
const result=await build({entryPoints:['source/venditbot/rabbit-host.ts'],bundle:true,platform:'node',format:'esm',write:false,plugins:[{name:'no-network',setup(b){b.onResolve({filter:/rabbit-project-client\.js$/},()=>({path:'client',namespace:'mock'}));b.onLoad({filter:/.*/,namespace:'mock'},()=>({contents:`export class RabbitProjectApiError extends Error {} export const testRabbitConnection=async c=>({projectId:c.projectId,repositories:[],pages:1,checkedAt:new Date().toISOString()}); export const submitRabbitRun=()=>{throw Error('unexpected POST')}; export const getRabbitRun=()=>{throw Error('unexpected GET')}; export const getRabbitEvents=getRabbitRun;`,loader:'js'}));}}]});
const {RabbitHost}=await import(`data:text/javascript;base64,${Buffer.from(result.outputFiles[0].text).toString('base64')}`);
function fixture(name='등록 프로젝트'){
 const date=new Date().toISOString(),connection={id:randomUUID(),name,baseUrl:'https://project.example',projectId:randomUUID(),baseRef:'main',workflowTemplate:'feature_pr',maxParallelTasks:2,timeoutSeconds:600,enabledForAgents:true,preferForProjectTasks:true,createdAt:date,updatedAt:date};
 let revision='ciphertext-1';const options={store:{listConnections:()=>[structuredClone(connection)],getConnection:()=>structuredClone(connection),listRuns:()=>[]},secrets:{has:()=>true,revision:()=>revision,read:async()=> 'rabbit_'+'a'.repeat(43)},authorize:async()=>true,changed(){},assertMutable(){}};
 return {connection,options,host:new RabbitHost(options),rotate(){revision='ciphertext-2';}};
}
test('Rabbit preference survives GET TTL expiry and process restart; neither grants a silent local fallback',async()=>{
 const {host,connection,options}=fixture();assert.equal(host.connections()[0].verified,false);assert.throws(()=>host.assertLocalWrite('등록 프로젝트의 파일 수정',{sessionId:'s'}),/Rabbit 우선/);
 await host.test(connection);assert.equal(host.connections()[0].verified,true);
 const now=Date.now;try{const expired=now()+300001;Date.now=()=>expired;assert.equal(host.connections()[0].verified,false);assert.throws(()=>host.assertLocalWrite('등록 프로젝트에서 작업',{sessionId:'s'}),/Rabbit 우선/);await assert.rejects(host.start(connection.id,{objective:'x',acceptance_criteria:['x']},randomUUID(),{sessionId:'s'}),/GET 검사/);}finally{Date.now=now;}
 const restarted=new RabbitHost(options);assert.equal(restarted.connections()[0].verified,false);assert.throws(()=>restarted.assertLocalWrite(connection.projectId+' 작업',{sessionId:'s'}),/Rabbit 우선/);
});
test('Rabbit project names require Unicode boundaries and supported Korean particles, never incidental substrings',()=>{
 for(const [name,yes,no]of [['API','API를 수정하세요','CAPITable의 형식을 설명하세요'],['봇','봇에서 작업','챗봇의 일반 지식을 설명하세요'],['C++ [qa]','C++ [qa]의 파일 수정','prefixC++ [qa]suffix']]){
  const {host,connection}=fixture(name);assert.equal(host.preferredForTask(yes).length,1);assert.equal(host.preferredForTask(no).length,0);assert.equal(host.preferredForTask(`${connection.baseUrl}/projects/${connection.projectId} 작업`).length,1);
 }
});
test('Rabbit GET verification is bound to config and ciphertext identity while preference remains enabled',async()=>{
 const {host,connection,rotate}=fixture();await host.test(connection);assert.equal(host.connections()[0].verified,true);rotate();assert.equal(host.connections()[0].verified,false);assert.throws(()=>host.assertLocalWrite('등록 프로젝트 작업',{sessionId:'s'}),/Rabbit 우선/);
 await host.test(connection);connection.updatedAt=new Date(Date.parse(connection.updatedAt)+1).toISOString();assert.equal(host.connections()[0].verified,false);assert.equal(host.preferredForTask('등록 프로젝트 작업').length,1);
 connection.enabledForAgents=false;connection.preferForProjectTasks=false;assert.doesNotThrow(()=>host.assertLocalWrite('등록 프로젝트 작업',{sessionId:'s'}));
});
