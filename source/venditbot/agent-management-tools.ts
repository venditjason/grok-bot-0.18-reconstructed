export type RenamedAgent = {id: string; name: string; updatedAt: string};
export type RenameAgent = (id: string, name: string, expectedUpdatedAt: string) => RenamedAgent;
export const AGENT_MANAGEMENT_TOOLS = [{
  name: 'rename_self',
  description: 'Change only your own saved agent name when requested by the user. Keeps your ID, role, connections and past conversation snapshots. No workspace is required. This tool cannot delete an agent, manage other agents, or grant team leader authority.',
  inputSchema: {type: 'object', properties: {name: {type: 'string', minLength: 1, maxLength: 80}}, required: ['name'], additionalProperties: false},
}];

export function normalizeManagedName(value: unknown): string {
  if (typeof value !== 'string' || /[\u0000-\u001f\u007f]/.test(value)) throw new Error('이름은 제어 문자 없이 1~80자로 입력하세요.');
  const name = value.trim();
  if (!name || name.length > 80) throw new Error('이름은 1~80자로 입력하세요.');
  return name;
}
const abort = (signal?: AbortSignal): void => {if (signal?.aborted) throw new DOMException('작업을 중단했습니다.', 'AbortError');};

/** The host binds identity and a saved revision before inference. Tool arguments
 * cannot choose another agent or update its role. renameAgent must synchronously
 * compare that revision and commit only the name before emitting UI updates.
 */
export class AgentManagementTools {
  readonly definitions = AGENT_MANAGEMENT_TOOLS;
  private revision: string;
  private readonly calls = new Map<string, {fingerprint: string; result: Promise<unknown>}>();
  private tail: Promise<unknown> = Promise.resolve();
  constructor(private readonly options: {agentId: string; expectedUpdatedAt: string; renameAgent: RenameAgent; signal?: AbortSignal}) {
    if (!options.agentId || options.agentId.length > 100 || /[\u0000-\u001f\u007f]/.test(options.agentId) || options.expectedUpdatedAt.length > 40 || !Number.isFinite(Date.parse(options.expectedUpdatedAt))) throw new Error('이름을 변경할 에이전트와 저장 버전을 확인하세요.');
    this.revision = options.expectedUpdatedAt;
    this.options = {...options};
  }
  execute(name: string, raw: unknown, callId: string): Promise<unknown> {
    let fingerprint: string, captured: unknown;
    try {captured = structuredClone(raw); fingerprint = JSON.stringify({name, raw: captured});} catch {return Promise.reject(new Error('이름 변경 인자를 확인하세요.'));}
    const prior = this.calls.get(callId);
    if (prior) return prior.fingerprint === fingerprint ? prior.result : Promise.reject(new Error('같은 도구 호출 ID의 인자가 일치하지 않습니다.'));
    if (typeof callId !== 'string' || !callId || callId.length > 200 || /[\u0000-\u001f\u007f]/.test(callId) || this.calls.size >= 100) return Promise.reject(new Error('이름 변경 도구 호출 ID 또는 한도를 확인하세요.'));
    const result = this.tail.then(() => {
      abort(this.options.signal);
      if (name !== 'rename_self' || !captured || typeof captured !== 'object' || Array.isArray(captured) || Object.keys(captured).some(key => key !== 'name')) throw new Error('이름 변경 도구에는 새 이름만 전달하세요.');
      const nextName = normalizeManagedName((captured as {name?: unknown}).name);
      abort(this.options.signal);
      const renamed = this.options.renameAgent(this.options.agentId, nextName, this.revision);
      this.revision = renamed.updatedAt;
      return {renamed: true, agent: {id: renamed.id, name: renamed.name, updatedAt: renamed.updatedAt}};
    });
    this.tail = result.catch(() => {}); this.calls.set(callId, {fingerprint, result}); return result;
  }
}
