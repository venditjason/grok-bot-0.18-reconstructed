import { existsSync, lstatSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { atomicWriteJson, validConnections, connectionRouteKey, type ConnectionRoute } from './local-store.js';

export type AgentProfile = { id: string; name: string; instructions: string; connectionId: string; model: string; effort?: string; connections?: ConnectionRoute[]; workspacePath?: string; avatarId?: string; automation?: {policyId: string}; createdAt: string; updatedAt: string };
const maxAgentFileBytes = 4 * 1024 * 1024;
function bounded(value: unknown, limit: number, nonempty = false): value is string { return typeof value === 'string' && value.length <= limit && !value.includes('\0') && (!nonempty || !!value.trim()); }
function valid(value: unknown): value is AgentProfile {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  const a = value as AgentProfile;
  return bounded(a.id, 100, true) && bounded(a.name, 80, true) && bounded(a.instructions, 16000, true) && bounded(a.connectionId, 200, true) && bounded(a.model, 200, true)
    && (a.effort === undefined || bounded(a.effort, 40)) && (a.workspacePath === undefined || bounded(a.workspacePath, 4096, true))
    && (a.avatarId === undefined || (typeof a.avatarId === 'string' && /^[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/.test(a.avatarId)))
    && (a.automation === undefined || (!!a.automation && typeof a.automation === 'object' && !Array.isArray(a.automation) && Object.keys(a.automation).length === 1 && bounded(a.automation.policyId, 100, true)))
    && (a.connections === undefined || (validConnections(a.connections) && connectionRouteKey(a) === connectionRouteKey(a.connections[0]!)))
    && bounded(a.createdAt, 40, true) && Number.isFinite(Date.parse(a.createdAt)) && bounded(a.updatedAt, 40, true) && Number.isFinite(Date.parse(a.updatedAt));
}
export class AgentStore {
  private readonly file: string;
  private agents: AgentProfile[] = [];
  constructor(root: string) {
    this.file = join(root, 'agents.json');
    let stat;
    try { stat = lstatSync(this.file); } catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error; }
    if (stat && (!stat.isFile() || stat.isSymbolicLink() || stat.nlink !== 1 || stat.size > maxAgentFileBytes)) throw new Error('에이전트 저장 경로가 안전하지 않습니다.');
    if (!existsSync(this.file)) return;
    const raw = JSON.parse(readFileSync(this.file, 'utf8')) as {version?: number; agents?: unknown};
    if (raw.version !== 1 || !Array.isArray(raw.agents) || !raw.agents.every(valid) || new Set(raw.agents.map(a => a.id)).size !== raw.agents.length) throw new Error('에이전트 저장 데이터가 손상되었습니다. 원본은 보존했습니다.');
    this.agents = raw.agents;
  }
  list(): AgentProfile[] { return structuredClone(this.agents); }
  get(id: string): AgentProfile { const agent = this.agents.find(a => a.id === id); if (!agent) throw new Error('에이전트를 찾을 수 없습니다.'); return structuredClone(agent); }
  save(input: Omit<AgentProfile, 'id' | 'createdAt' | 'updatedAt'> & {id?: string}): AgentProfile {
    const previous = input.id ? this.get(input.id) : undefined;
    if (input.connections !== undefined && !validConnections(input.connections)) throw new Error('우선순위 연결은 중복 없이 1개부터 8개까지 지정하세요.');
    const normalized = structuredClone(input);
    if (normalized.connections) { delete normalized.effort; Object.assign(normalized, normalized.connections[0]); }
    const now = new Date(Math.max(Date.now(), previous ? Date.parse(previous.updatedAt) + 1 : 0)).toISOString(); const agent: AgentProfile = {...normalized, id: previous?.id ?? randomUUID(), createdAt: previous?.createdAt ?? now, updatedAt: now};
    if (!valid(agent)) throw new Error('에이전트 이름·지시문·연결·모델을 확인하세요.');
    const next = [agent, ...this.agents.filter(a => a.id !== agent.id)]; this.persist(next); return structuredClone(agent);
  }
  remove(id: string, expectedUpdatedAt?: string): void { const current = this.get(id); if (expectedUpdatedAt !== undefined && current.updatedAt !== expectedUpdatedAt) throw new Error('에이전트가 변경되어 생성 취소를 완료하지 못했습니다. 현재 에이전트는 보존했습니다.'); this.persist(this.agents.filter(a => a.id !== id)); }
  private persist(next: AgentProfile[]): void {
    const data = {version: 1, agents: next};
    // Character limits do not bound UTF-8 bytes. Never commit a file that the
    // next launch would reject, including a large edit of an existing agent.
    if (Buffer.byteLength(JSON.stringify(data, null, 2)) > maxAgentFileBytes) throw new Error('에이전트 전체 저장 한도 4MiB에 도달했습니다. 일부 지시문을 줄이거나 사용하지 않는 에이전트를 삭제하세요. 기존 데이터는 변경하지 않았습니다.');
    atomicWriteJson(this.file, data); this.agents = next;
  }
}

export {valid as validAgentProfile};
