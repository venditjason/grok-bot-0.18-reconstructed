import {constants,lstatSync,openSync,closeSync,fstatSync,readSync,mkdirSync,type Stats} from 'node:fs';
import {join,isAbsolute} from 'node:path';
import {atomicWriteJson} from './local-store.js';
import {FEEDBACK_REPOSITORY,feedbackInput,type FeedbackInput,type FeedbackJob,type FeedbackBinding} from '../shared/feedback.js';
export type FeedbackDispatch='not_started'|'remote_submitting'|'remote_accepted'|'local_dispatching'|'local_started'|'settled';
export type FeedbackRecord=FeedbackJob&{binding?:FeedbackBinding;dispatch:FeedbackDispatch;remoteRunId?:string};
const MAX=16*1024*1024;
export function validateFeedbackBinding(x:FeedbackBinding):void {
 if(!x||Object.keys(x).some(k=>!['repository','workspacePath','baseBranch','allowLocalFallback','rabbitConnectionId','rabbitRepositoryId'].includes(k))||x.repository!==FEEDBACK_REPOSITORY||(x.workspacePath!==undefined&&(typeof x.workspacePath!=='string'||!isAbsolute(x.workspacePath)||x.workspacePath.includes('\0')))||typeof x.baseBranch!=='string'||!x.baseBranch||x.baseBranch.length>200||/[\s~^:?*[\\]/.test(x.baseBranch)||typeof x.allowLocalFallback!=='boolean')throw new Error('벤디트봇 리포트 저장소와 작업 폴더 설정을 확인하세요.');
 if(x.workspacePath===undefined&&(!x.rabbitConnectionId||!x.rabbitRepositoryId||x.allowLocalFallback))throw new Error('로컬 개발 실행은 검증된 작업 폴더가 필요합니다.');
 if((x.rabbitConnectionId===undefined)!==(x.rabbitRepositoryId===undefined))throw new Error('Rabbit 연결과 저장소를 함께 지정하세요.');
 for(const id of [x.rabbitConnectionId,x.rabbitRepositoryId])if(id!==undefined&&(typeof id!=='string'||!/^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/i.test(id)))throw new Error('Rabbit 리포트 저장소 ID를 확인하세요.');
}
export function readFeedbackPrivate(file:string):string|undefined {
 let before;try{before=lstatSync(file);}catch(e){if((e as NodeJS.ErrnoException).code==='ENOENT')return;throw e;}
 const safe=(s:Stats)=>{if(!s.isFile()||s.isSymbolicLink()||s.nlink!==1||s.size>MAX||(s.mode&0o077)||(process.getuid&&s.uid!==process.getuid()))throw new Error('리포트 저장 파일이 안전하지 않습니다. 원본을 보존했습니다.');};
 safe(before);const fd=openSync(file,constants.O_RDONLY|constants.O_NOFOLLOW|constants.O_NONBLOCK);
 try{const start=fstatSync(fd);safe(start);if(start.ino!==before.ino||start.dev!==before.dev)throw new Error('리포트 파일이 변경되었습니다.');
 const b=Buffer.alloc(start.size+1);let n=0;while(n<b.length){const c=readSync(fd,b,n,b.length-n,n);if(!c)break;n+=c;}
 const end=fstatSync(fd),path=lstatSync(file);safe(end);safe(path);if(n!==start.size||end.size!==start.size||end.mtimeMs!==start.mtimeMs||end.ctimeMs!==start.ctimeMs||path.ino!==end.ino||path.dev!==end.dev)throw new Error('리포트 읽기 중 변경되었습니다.');
 return new TextDecoder('utf-8',{fatal:true}).decode(b.subarray(0,n));}finally{closeSync(fd);}
}
function normalizeRecord(value:unknown):FeedbackRecord {
 if(!value||typeof value!=='object'||Array.isArray(value))throw new Error('리포트 저장 형식이 올바르지 않습니다.');
 const x=value as FeedbackRecord;feedbackInput({requestId:x.id,kind:x.kind,title:x.title,description:x.description});if(x.binding)validateFeedbackBinding(x.binding);
 if(!['queued','running','validating','ready_for_review','merged','failed','blocked','unknown'].includes(x.status)||!['not_started','remote_submitting','remote_accepted','local_dispatching','local_started','settled'].includes(x.dispatch)||!Number.isSafeInteger(x.revision)||x.revision<1||![x.createdAt,x.updatedAt].every(d=>typeof d==='string'&&Number.isFinite(Date.parse(d))))throw new Error('리포트 실행 기록이 올바르지 않습니다.');
 if(x.route!==undefined&&!['rabbit','local'].includes(x.route))throw new Error('리포트 실행 경로를 확인하세요.');
 for(const k of ['agentId','sessionId','remoteRunId','message'] as const)if(x[k]!==undefined&&(typeof x[k]!=='string'||!x[k]||x[k]!.length>(k==='message'?2000:100)||x[k]!.includes('\0')))throw new Error('리포트 상태 기록을 확인하세요.');
 if(x.status==='ready_for_review'&&(!x.headSha||!/^[a-f0-9]{40}$/.test(x.headSha)||!x.verificationId||!/^[a-zA-Z0-9][a-zA-Z0-9_.:/-]{0,199}$/.test(x.verificationId)||!x.prUrl||!/^https:\/\/github\.com\/venditjason\/grok-bot-0\.18-reconstructed\/pull\/[1-9]\d*$/.test(x.prUrl)||x.mergeSha!==undefined))throw new Error('검증된 PR 검토 증빙이 없습니다.');
 if(x.status==='merged'&&(!x.mergeSha||!/^[a-f0-9]{40}$/i.test(x.mergeSha)||!x.prUrl||!/^https:\/\/github\.com\/venditjason\/grok-bot-0\.18-reconstructed\/pull\/[1-9]\d*$/.test(x.prUrl)))throw new Error('검증된 병합 증빙이 없습니다.');
 return structuredClone(x);
}
export class FeedbackStore {
 private readonly file:string;private raw:string|undefined;private records:FeedbackRecord[]=[];
 constructor(private readonly root:string){mkdirSync(root,{recursive:true,mode:0o700});this.checkRoot();this.file=join(root,'feedback-jobs.json');this.raw=readFeedbackPrivate(this.file);
 if(this.raw!==undefined){const x=JSON.parse(this.raw) as {version:unknown;jobs:unknown};if(x.version!==1||!Array.isArray(x.jobs)||x.jobs.length>500)throw new Error('리포트 저장 형식이 손상되었습니다. 원본을 보존했습니다.');this.records=x.jobs.map(normalizeRecord);if(new Set(this.records.map(r=>r.id)).size!==this.records.length)throw new Error('중복 리포트 ID입니다.');}
 const interrupted=this.records.filter(r=>r.dispatch==='remote_submitting'||r.dispatch==='local_dispatching');
 if(interrupted.length)this.persist(this.records.map(r=>interrupted.some(i=>i.id===r.id)?{...r,status:'unknown',message:'앱 종료로 실행 접수 결과를 확인하지 못했습니다. 중복 실행하지 않고 기존 기록을 확인합니다.',revision:r.revision+1,updatedAt:new Date().toISOString()}:r));
 }
 private checkRoot(){const s=lstatSync(this.root);if(!s.isDirectory()||s.isSymbolicLink()||(s.mode&0o077)||(process.getuid&&s.uid!==process.getuid()))throw new Error('리포트 저장 폴더가 안전하지 않습니다.');}
 list():FeedbackRecord[]{return structuredClone(this.records);}
 get(id:string):FeedbackRecord{const r=this.records.find(r=>r.id===id);if(!r)throw new Error('리포트를 찾을 수 없습니다.');return structuredClone(r);}
 create(input:FeedbackInput,binding?:FeedbackBinding):FeedbackRecord{
  const x=feedbackInput(input),prior=this.records.find(r=>r.id===x.requestId);if(prior){if(prior.kind!==x.kind||prior.title!==x.title||prior.description!==x.description)throw new Error('같은 리포트 요청 ID에 다른 내용을 사용할 수 없습니다.');return structuredClone(prior);}
  if(binding)validateFeedbackBinding(binding);if(this.records.length>=500)throw new Error('리포트 기록 한도에 도달했습니다. 기존 기록은 보존했습니다.');
  const now=new Date().toISOString(),r:FeedbackRecord={id:x.requestId,kind:x.kind,title:x.title,description:x.description,...(binding?{binding:structuredClone(binding)}:{}),status:'queued',dispatch:'not_started',createdAt:now,updatedAt:now,revision:1,message:'요청을 이 Mac에 저장했습니다. 아직 실행 접수 전입니다.'};this.persist([r,...this.records]);return structuredClone(r);
 }
 bind(id:string,expectedRevision:number,binding:FeedbackBinding):FeedbackRecord{validateFeedbackBinding(binding);const r=this.get(id);if(r.revision!==expectedRevision||r.binding||r.dispatch!=='not_started')throw new Error('이미 지정되거나 시작한 리포트 경로를 바꿀 수 없습니다.');const next={...r,binding:structuredClone(binding),revision:r.revision+1,updatedAt:new Date().toISOString()};this.persist(this.records.map(x=>x.id===id?next:x));return structuredClone(next);}
 update(id:string,expectedRevision:number,patch:Partial<Omit<FeedbackRecord,'id'|'kind'|'title'|'description'|'binding'|'createdAt'|'revision'>>):FeedbackRecord{
  const old=this.get(id);if(old.revision!==expectedRevision)throw new Error('리포트 상태가 변경되었습니다. 다시 조회하세요.');
  if(old.status==='merged')throw new Error('검증된 병합 기록을 변경할 수 없습니다.');
  const r=normalizeRecord({...old,...patch,revision:old.revision+1,updatedAt:new Date(Math.max(Date.now(),Date.parse(old.updatedAt)+1)).toISOString()});this.persist(this.records.map(x=>x.id===id?r:x));return structuredClone(r);
 }
 private persist(records:FeedbackRecord[]):void{this.checkRoot();if(readFeedbackPrivate(this.file)!==this.raw)throw new Error('리포트 파일이 다른 곳에서 변경되었습니다. 원본을 보존했습니다.');
 const value={version:1,jobs:records},text=JSON.stringify(value,null,2);if(Buffer.byteLength(text)>MAX)throw new Error('리포트 저장 한도에 도달했습니다.');atomicWriteJson(this.file,value);this.raw=text;this.records=records;}
}
