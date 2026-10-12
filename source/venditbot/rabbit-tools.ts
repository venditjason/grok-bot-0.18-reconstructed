import {createHash} from 'node:crypto';
import {normalizeRabbitRunInput, type RabbitConnection, type RabbitRunInput} from '../shared/rabbit-project-api.js';
import type {RabbitRunRecord, RabbitRunSource} from './rabbit-store.js';

const schema = (properties: Record<string, unknown>, required: string[] = []) => ({type: 'object', properties, required, additionalProperties: false});
const connectionId = {type: 'string', description: 'An enabled project API connection ID returned by list_project_connections.'};
export const RABBIT_TOOLS = [
  {name: 'list_project_connections', description: 'List project API connections explicitly enabled by the user for agents. Does not expose API keys or LLM login credentials.', inputSchema: schema({})},
  {name: 'list_project_repositories', description: 'Read repositories from one enabled Rabbit project. Repository metadata does not guarantee checkout readiness. The project-key API cannot list or choose private execution lanes/models.', inputSchema: schema({connectionId}, ['connectionId'])},
  {name: 'start_project_run', description: 'Request one external Rabbit project run after host-enforced user approval. For reporting VenditBot bugs or requesting missing app capabilities, use submit_app_feedback so the saved report and designated development route are preserved. A 202 receipt means accepted, not completed. The remote scheduler chooses project lanes. Do not retry an uncertain request as a new run: preserve its local record ID for user review. No arbitrary remote commands, attachments, model/lane selection or remote approval bypass.', inputSchema: schema({connectionId, input: schema({objective: {type: 'string', maxLength: 20000}, acceptance_criteria: {type: 'array', minItems: 1, maxItems: 30, items: {type: 'string', maxLength: 2000}}, repository_id: {type: 'string'}, base_ref: {type: 'string'}, workflow_template: {type: 'string', enum: ['feature_pr','bugfix_pr','review_only']}, constraints: schema({max_parallel_tasks: {type: 'integer', minimum: 1, maximum: 4}, timeout_seconds: {type: 'integer', minimum: 60, maximum: 14400}})}, ['objective', 'acceptance_criteria'])}, ['connectionId','input'])},
  {name: 'get_project_run', description: 'Read status and bounded events for a local Rabbit run record created by this conversation, or by this same agent in the current team run. Cannot query arbitrary remote run IDs. Remote cancellation and approval are available only in the Rabbit owner UI.', inputSchema: schema({id: {type: 'string', description: 'Local run record ID returned by start_project_run.'}}, ['id'])},
];
export type RabbitToolPort = {
  connections(): RabbitConnection[];
  repositories(connection: RabbitConnection): Promise<unknown>;
  start(connection: RabbitConnection, input: RabbitRunInput, requestId: string, source: RabbitRunSource): Promise<RabbitRunRecord>;
  getRecord(id: string): RabbitRunRecord;
  refresh(record: RabbitRunRecord): Promise<RabbitRunRecord>;
  authorizeRead(tool: string): Promise<boolean>;
};
const failIfAborted = (signal?: AbortSignal): void => {if (signal?.aborted) throw new DOMException('프로젝트 API 요청을 중단했습니다. 원격 작업은 자동 취소되지 않습니다.', 'AbortError');};
function requestIdentity(sessionId: string, callId: string): string {
  const bytes = createHash('sha256').update(`venditbot-rabbit-v1\0${sessionId}\0${callId}`).digest().subarray(0,16);
  bytes[6] = (bytes[6]! & 15) | 64; bytes[8] = (bytes[8]! & 63) | 128;
  const hex = bytes.toString('hex'); return `${hex.slice(0,8)}-${hex.slice(8,12)}-${hex.slice(12,16)}-${hex.slice(16,20)}-${hex.slice(20)}`;
}
/** Turn-bound capability: only explicitly enabled connections and owned records.
 * The port owns network, durable idempotency and mandatory external approval. */
export class RabbitTools {
  readonly definitions: typeof RABBIT_TOOLS;
  private readonly allowed: Set<string>;
  private readonly calls = new Map<string,{fingerprint:string;result:Promise<unknown>}>();
  private tail: Promise<unknown> = Promise.resolve();
  private readonly source: RabbitRunSource;
  constructor(private readonly port: RabbitToolPort, source: RabbitRunSource, private readonly signal?: AbortSignal) {
    this.source = structuredClone(source); this.allowed = new Set(port.connections().filter(c=>c.enabledForAgents).map(c=>c.id));
    this.definitions = this.allowed.size ? RABBIT_TOOLS : [];
  }
  execute(name: string, raw: unknown, callId: string): Promise<unknown> {
    let captured: unknown, fingerprint: string;
    try {captured=structuredClone(raw); fingerprint=JSON.stringify({name,args:captured});} catch {return Promise.reject(new Error('프로젝트 도구 입력 형식을 확인하세요.'));}
    const prior=this.calls.get(callId);if(prior)return prior.fingerprint===fingerprint?prior.result:Promise.reject(new Error('같은 프로젝트 도구 호출 ID의 입력이 다릅니다.'));
    if(typeof callId!=='string'||!callId||callId.length>200||this.calls.size>=100)return Promise.reject(new Error('프로젝트 도구 호출 ID 또는 한도를 확인하세요.'));
    const result=this.tail.then(async()=>{
      failIfAborted(this.signal);
      const definition=this.definitions.find(d=>d.name===name);
      if(!definition||!captured||typeof captured!=='object'||Array.isArray(captured))throw new Error('지원하지 않는 프로젝트 도구입니다.');
      const args=captured as Record<string,unknown>;
      if(Object.keys(args).some(key=>!Object.hasOwn(definition.inputSchema.properties,key)))throw new Error('프로젝트 도구에 허용하지 않은 입력이 있습니다.');
      const enabled=()=>this.port.connections().filter(c=>c.enabledForAgents&&this.allowed.has(c.id));
      if(name==='list_project_connections'){
        if(!await this.port.authorizeRead(name))throw new Error('프로젝트 목록 조회를 승인하지 않았습니다.');failIfAborted(this.signal);
        return {connections:enabled().map(c=>({id:c.id,name:c.name,baseUrl:c.baseUrl,projectId:c.projectId,workflowTemplate:c.workflowTemplate,baseRef:c.baseRef,preferForProjectTasks:c.preferForProjectTasks===true})),notice:'사용자가 허용한 프로젝트 API 연결입니다. 실행 레인·모델은 Rabbit 소유자 화면과 스케줄러가 관리합니다.'};
      }
      if(name==='get_project_run'){
        if(typeof args.id!=='string')throw new Error('로컬 프로젝트 실행 ID를 확인하세요.');const record=this.port.getRecord(args.id),actor=record.source;
        if(!actor||!(actor.sessionId===this.source.sessionId||(!!actor.teamRunId&&actor.teamRunId===this.source.teamRunId&&!!actor.agentId&&actor.agentId===this.source.agentId)))throw new Error('이 대화 또는 같은 팀의 본인이 시작한 프로젝트 실행만 조회할 수 있습니다.');
        if(!enabled().some(c=>c.id===record.connectionId))throw new Error('에이전트 사용이 허용되지 않은 프로젝트 연결입니다.');
        failIfAborted(this.signal);return this.port.refresh(record);
      }
      const connection=enabled().find(c=>c.id===args.connectionId);if(!connection)throw new Error('사용자가 에이전트 사용을 허용한 프로젝트 연결만 사용할 수 있습니다.');
      if(name==='list_project_repositories'){
        failIfAborted(this.signal);return this.port.repositories(connection);
      }
      const input=normalizeRabbitRunInput(args.input,connection);failIfAborted(this.signal);
      return this.port.start(connection,input,requestIdentity(this.source.sessionId,callId),this.source);
    });
    this.tail=result.catch(()=>{});this.calls.set(callId,{fingerprint,result});return result;
  }
}
