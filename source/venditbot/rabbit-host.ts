import {randomUUID} from 'node:crypto';
import {normalizeRabbitConnectionDraft, normalizeRabbitRunInput, rabbitUuid, validateRabbitProjectApiKey, type RabbitConnection, type RabbitConnectionTest, type RabbitRunInput} from '../shared/rabbit-project-api.js';
import {testRabbitConnection, submitRabbitRun, getRabbitRun, getRabbitEvents, RabbitProjectApiError} from './rabbit-project-client.js';
import {RabbitStore, type RabbitRunRecord, type RabbitRunSource} from './rabbit-store.js';
import {EncryptedSecretStore, safeError} from './local-store.js';
import {sensitiveWorkspaceContent, type ActionApprovalRequest} from './workspace-tools.js';
const secretKey=(id:string)=>`VENDITBOT_RABBIT_${rabbitUuid(id).replaceAll('-','').toUpperCase()}`;
const binding=(c:RabbitConnection)=>JSON.stringify([c.baseUrl,c.projectId,c.allowInsecureLoopback===true]);
const errorText=(error:unknown)=>safeError(error).replace(/rabbit_[A-Za-z0-9_-]{43}/g,'[보호된 프로젝트 키]');
const abort=(signal:AbortSignal)=>{if(signal.aborted)throw new DOMException('프로젝트 요청을 중단했습니다. 이미 접수된 원격 작업은 자동 취소되지 않습니다.','AbortError');};
type Options={store:RabbitStore;secrets:EncryptedSecretStore;authorize:(request:ActionApprovalRequest,signal:AbortSignal,sessionId?:string)=>Promise<boolean>;changed:()=>void;assertMutable:(ownSecretMutation?:boolean)=>void};
/** Owns request lifetime and secret handling. Neither model tools nor renderer
 * receive project keys, fetch arbitrary URLs or fabricate owner permissions. */
export class RabbitHost {
  private readonly verified=new Map<string,{revision:string;keyRevision:string;checkedAt:number;repositories:RabbitConnectionTest['repositories']}>();
  private readonly pending=new Map<string,{controller:AbortController;done:Promise<unknown>}>();
  constructor(private readonly options:Options){}
  connections(){return this.options.store.listConnections().map(c=>({...c,hasKey:this.options.secrets.has(secretKey(c.id)),verified:this.isVerified(c)}));}
  isBusy(){return this.pending.size>0;}
  private isVerified(connection:RabbitConnection):boolean {
    const result=this.verified.get(connection.id),age=result?Date.now()-result.checkedAt:-1;return !!result&&result.revision===JSON.stringify(connection)&&result.keyRevision===this.options.secrets.revision(secretKey(connection.id))&&age>=0&&age<300_000;
  }
  preferredForTask(text:string):RabbitConnection[] {
    const normalized=text.normalize('NFKC').toLowerCase();
    const mentioned=(value:string)=>{
      const escaped=value.normalize('NFKC').toLowerCase().replace(/[.*+?^${}()|[\]\\]/g,'\\$&');
      return new RegExp(`(^|[^\\p{L}\\p{N}_])${escaped}(?=$|[^\\p{L}\\p{N}_]|(?:에서|에게|으로|을|를|의|에|은|는|와|과|이|가|도)(?=$|[^\\p{L}\\p{N}_]))`,'u').test(normalized);
    };
    // The user's routing preference survives cache expiry and restart. Fresh GET
    // verification is required to execute remotely, never an excuse for local
    // fallback. Match saved identities only, not disposable repository cache.
    return this.options.store.listConnections().filter(c=>c.enabledForAgents&&c.preferForProjectTasks&&[c.projectId,c.name,`${c.baseUrl}/projects/${c.projectId}`].some(mentioned));
  }
  private owns(run:RabbitRunRecord,source:RabbitRunSource):boolean {return !!run.source&&(run.source.sessionId===source.sessionId||!!source.teamRunId&&source.teamRunId===run.source.teamRunId);}
  private unresolved(run:RabbitRunRecord):boolean {return ['prepared','submitting','unknown','accepted'].includes(run.phase)&&!(run.detail&&['completed','failed','cancelled'].includes(run.detail.state));}
  instructions(text:string,source:RabbitRunSource):string {
    const preferred=this.preferredForTask(text),pending=this.options.store.listRuns().filter(r=>this.owns(r,source)&&this.unresolved(r));
    return `Rabbit project tools are separate from AI model connections. Never claim remote acceptance means completion. Never automatically execute the same work locally after an accepted/unknown remote submission. Use get_project_run; only the Rabbit owner UI can cancel or approve remote actions. ${preferred.length?`The user explicitly prefers Rabbit for the projects mentioned in this current task: ${JSON.stringify(preferred.map(c=>({id:c.id,name:c.name,projectId:c.projectId,verificationRequired:!this.isVerified(c)})))}. A missing/expired verification does not permit local fallback. For executable project work, inspect the registered repositories and request start_project_run with user approval before local writes. Do not submit ordinary conversation or explanation. Local writes for these matched projects are blocked by the host until the preference is explicitly disabled; a rejected approval is not permission to fall back locally.`:''} ${pending.length?`Outstanding remote records for this conversation/team: ${JSON.stringify(pending.map(r=>({id:r.id,phase:r.phase,state:r.detail?.state})))}. Local writes are blocked while these outcomes are unresolved.`:''}`;
  }
  assertLocalWrite(text:string,source:RabbitRunSource):void {
    if(this.options.store.listRuns().some(r=>this.owns(r,source)&&this.unresolved(r)))throw new Error('같은 대화 또는 팀의 Rabbit 작업이 접수 중이거나 결과가 불확실하여 로컬 중복 실행을 막았습니다. 원격 완료·실패·취소 상태를 먼저 조회하세요.');
    if(this.preferredForTask(text).length)throw new Error('현재 요청이 Rabbit 우선 프로젝트를 명시했습니다. start_project_run으로 외부 실행 승인을 요청하세요. 로컬 작업으로 바꾸려면 사용자가 해당 연결의 Rabbit 우선 설정을 해제해야 합니다.');
  }
  private checked(connection:RabbitConnection,forAgent=false):RabbitConnection {
    const current=this.options.store.getConnection(connection.id);
    if(current.updatedAt!==connection.updatedAt||binding(current)!==binding(connection))throw new Error('요청 중 프로젝트 연결 설정이 변경되었습니다. 다시 확인하세요.');
    if(forAgent&&!current.enabledForAgents)throw new Error('이 프로젝트 연결은 에이전트 사용을 허용하지 않았습니다.');return current;
  }
  private async key(connection:RabbitConnection,signal:AbortSignal,forAgent=false):Promise<string>{
    const value=await this.options.secrets.read(secretKey(connection.id),signal);abort(signal);this.checked(connection,forAgent);return validateRabbitProjectApiKey(value);
  }
  async saveConnection(input:unknown,key:unknown,expectedUpdatedAt?:string):Promise<RabbitConnection>{
    this.options.assertMutable(true);if(this.isBusy())throw new Error('프로젝트 API 요청이 끝난 뒤 연결을 변경하세요.');
    if(!input||typeof input!=='object'||Array.isArray(input))throw new Error('프로젝트 연결 입력을 확인하세요.');
    const raw=input as Record<string,unknown>,draft=normalizeRabbitConnectionDraft(raw),id=raw.id==null||raw.id===''?randomUUID():rabbitUuid(raw.id),previous=raw.id?this.options.store.getConnection(id):undefined;
    if(previous&&expectedUpdatedAt!==previous.updatedAt)throw new Error('프로젝트 연결 설정이 변경되었습니다. 최신 설정을 다시 불러오세요.');
    const next={...draft,id},newBinding=!previous||binding({...previous,...draft})!==binding(previous);
    const supplied=typeof key==='string'?key.trim():key;if(supplied!==undefined&&supplied!==''&&typeof supplied!=='string')throw new Error('프로젝트 API 키 형식을 확인하세요.');
    if(newBinding&&!supplied)throw new Error('새 서버 또는 프로젝트에 사용할 프로젝트 API 키를 입력하세요.');
    if(newBinding&&previous&&this.options.store.listRuns().some(r=>r.connectionId===id))throw new Error('실행 기록이 있는 연결의 서버·프로젝트를 바꿀 수 없습니다.');
    const revision=JSON.stringify(this.options.store.listConnections());let saved:RabbitConnection|undefined;
    const commit=()=>{saved=this.options.store.saveConnection(next,expectedUpdatedAt,previous?undefined:{create:true});};
    if(supplied){
      const validated=validateRabbitProjectApiKey(supplied);
      await this.options.secrets.write(secretKey(id),validated,{beforeCommit:()=>{this.options.assertMutable(true);if(this.isBusy()||JSON.stringify(this.options.store.listConnections())!==revision)throw new Error('프로젝트 연결 저장 중 설정이나 요청 상태가 변경되었습니다.');},afterCommit:commit});
    }else commit();
    this.verified.delete(id);this.options.changed();return saved!;
  }
  removeConnection(id:string,expectedUpdatedAt:string):void {
    this.options.assertMutable();if(this.isBusy())throw new Error('프로젝트 API 요청이 끝난 뒤 연결을 삭제하세요.');
    this.options.secrets.remove(secretKey(id),()=>this.options.store.removeConnection(id,expectedUpdatedAt));this.verified.delete(id);this.options.changed();
  }
  private operation<T>(id:string,signal:AbortSignal|undefined,fn:(signal:AbortSignal)=>Promise<T>):Promise<T>{
    try{this.options.assertMutable();}catch(error){return Promise.reject(error);}
    if(this.pending.has(id))return Promise.reject(new Error('같은 프로젝트 요청을 이미 처리 중입니다.'));
    if(this.pending.size>=4)return Promise.reject(new Error('동시 프로젝트 API 요청은 최대 4개입니다. 기존 요청이 끝난 뒤 시도하세요.'));
    const controller=new AbortController(),forward=()=>controller.abort();signal?.addEventListener('abort',forward,{once:true});if(signal?.aborted)forward();
    const done=Promise.resolve().then(()=>{abort(controller.signal);return fn(controller.signal);}).finally(()=>{signal?.removeEventListener('abort',forward);this.pending.delete(id);this.options.changed();});
    this.pending.set(id,{controller,done});return done;
  }
  test(input:RabbitConnection,signal?:AbortSignal,forAgent=false){
    this.verified.delete(input.id);
    return this.operation(`test:${input.id}`,signal,async current=>{
      // Tool listings add presentation fields (hasKey/verified). Bind evidence
      // to the canonical saved revision, never to those transient fields.
      const connection=this.checked(input,forAgent);
      if(!await this.options.authorize({path:'.',operation:'read',tool:'list_project_repositories',category:'routine',reason:`${connection.name}의 등록 저장소를 조회합니다.`},current))throw new Error('프로젝트 저장소 조회를 승인하지 않았습니다.');
      const keyRevision=this.options.secrets.revision(secretKey(connection.id));
      const key=await this.key(connection,current,forAgent),result=await testRabbitConnection(connection,key,current);abort(current);this.checked(connection,forAgent);
      if(!keyRevision||keyRevision!==this.options.secrets.revision(secretKey(connection.id)))throw new Error('연결 검사 중 프로젝트 API 키가 변경되었습니다. 다시 검사하세요.');
      this.verified.set(connection.id,{revision:JSON.stringify(connection),keyRevision,checkedAt:Date.now(),repositories:structuredClone(result.repositories)});this.options.changed();return result;
    });
  }
  start(connectionId:string,input:unknown,requestId:string,source?:RabbitRunSource,signal?:AbortSignal):Promise<RabbitRunRecord>{
    return this.operation(`run:${rabbitUuid(requestId)}`,signal,async current=>{
      const connection=this.options.store.getConnection(connectionId);if(source&&!connection.enabledForAgents)throw new Error('에이전트 사용을 허용한 프로젝트만 실행할 수 있습니다.');
      const body=normalizeRabbitRunInput(input,connection),existing=this.options.store.listRuns().find(r=>r.id===requestId);
      if(source&&connection.preferForProjectTasks&&!existing&&!this.isVerified(connection))throw new Error('Rabbit 우선 연결의 GET 검사가 없거나 만료되었습니다. list_project_repositories로 다시 확인하세요. 로컬 중복 실행으로 전환하지 않습니다.');
      const record=this.options.store.prepareRun(connectionId,body,requestId,source);this.options.changed();
      if(existing)return record; // Unknown/submitting never becomes an automatic retry.
      return this.submit(record,current,!!source);
    });
  }
  retry(id:string,signal?:AbortSignal):Promise<RabbitRunRecord>{
    return this.operation(`run:${rabbitUuid(id)}`,signal,current=>{const record=this.options.store.getRun(id);if(record.receipt)return Promise.resolve(record);return this.submit(record,current,false);});
  }
  private async submit(record:RabbitRunRecord,signal:AbortSignal,forAgent:boolean):Promise<RabbitRunRecord>{
    const connection=this.options.store.getConnection(record.connectionId),request=record.request,sensitive=sensitiveWorkspaceContent(JSON.stringify(request));
    let sent=false;
    try{
      if(!await this.options.authorize({path:'.',operation:'manage',tool:'start_project_run',category:'external_publish',...(sensitive?{categories:['external_publish','sensitive_disclosure']}:{}),preview:sensitive?'[민감정보 형태가 감지되어 요청 미리보기를 숨겼습니다.]':JSON.stringify(request,null,2).slice(0,8000),reason:`${connection.name} (${connection.baseUrl})에 외부 작업을 접수합니다. 202는 완료가 아닌 접수입니다. 이후 고위험 동작의 승인은 Rabbit 자체 규칙을 따르며 이 앱에서 원격 취소할 수 없습니다.`},signal,record.source?.sessionId))throw new Error('외부 프로젝트 실행을 승인하지 않았습니다.');
      abort(signal);const key=await this.key(connection,signal,forAgent);this.options.assertMutable();
      if(forAgent&&connection.preferForProjectTasks&&!this.isVerified(connection))throw new Error('승인 대기 중 Rabbit GET 검사 또는 프로젝트 API 키가 만료·변경되었습니다. list_project_repositories로 다시 확인하세요. 자동 재접수하지 않습니다.');
      // Synchronous durable boundary immediately before the only POST.
      this.options.store.beginSubmission(record.id);sent=true;this.options.changed();
      const receipt=await submitRabbitRun(record.connectionSnapshot,key,request,record.idempotencyKey,signal);
      const saved=this.options.store.completeSubmission(record.id,receipt);this.options.changed();return saved;
    }catch(error){
      const uncertain=sent&&(error instanceof RabbitProjectApiError?error.uncertain:true);
      const saved=this.options.store.failSubmission(record.id,{uncertain,error:errorText(error)});this.options.changed();return saved;
    }
  }
  refresh(id:string,signal?:AbortSignal,forAgent=false):Promise<RabbitRunRecord>{
    return this.operation(`read:${rabbitUuid(id)}`,signal,async current=>{
      const record=this.options.store.getRun(id);const connection=this.options.store.getConnection(record.connectionId);
      if(!await this.options.authorize({path:'.',operation:'read',tool:'get_project_run',category:'routine',reason:`${connection.name}에 접수된 작업 상태와 이벤트를 조회합니다.`},current,record.source?.sessionId))throw new Error('프로젝트 실행 조회를 승인하지 않았습니다.');
      abort(current);this.checked(connection,forAgent);if(!record.receipt)return record;
      const key=await this.key(connection,current,forAgent),detail=await getRabbitRun(record.connectionSnapshot,key,record.receipt.run_id,current),page=await getRabbitEvents(record.connectionSnapshot,key,record.receipt.run_id,record.events?.next_cursor,current);abort(current);this.checked(connection,forAgent);
      // Continue from the durable cursor, retaining the latest bounded window.
      // Always replaying page one would hide every result after event 100.
      const events={...page,items:[...(record.events?.items??[]),...page.items].slice(-100)};
      const saved=this.options.store.saveObservation(id,detail,events);this.options.changed();return saved;
    });
  }
  async abortAndWait(timeoutMs=4000):Promise<boolean>{
    const pending=[...this.pending.values()];for(const item of pending)item.controller.abort();if(!pending.length)return true;
    let timer:ReturnType<typeof setTimeout>|undefined;try{return await Promise.race([Promise.allSettled(pending.map(p=>p.done)).then(()=>true),new Promise<false>(resolve=>{timer=setTimeout(()=>resolve(false),timeoutMs);})]);}finally{if(timer)clearTimeout(timer);}
  }
}
