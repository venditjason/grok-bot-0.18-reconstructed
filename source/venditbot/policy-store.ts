import {existsSync, lstatSync, readFileSync} from 'node:fs';
import {join} from 'node:path';
import {randomUUID} from 'node:crypto';
import {normalizeAgentPolicy, normalizeAgentPolicyDraft, type AgentPolicy} from '../shared/agent-policy.js';
import {atomicWriteJson} from './local-store.js';

const maxBytes = 4 * 1024 * 1024;
/** Private, versioned policy definitions. A stale editor may never overwrite a newer policy. */
export class PolicyStore {
  private readonly file: string;
  private policies: AgentPolicy[] = [];
  constructor(root: string) {
    this.file = join(root, 'agent-policies.json');
    let stat; try {stat = lstatSync(this.file);} catch (error) {if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;}
    if (stat && (!stat.isFile() || stat.isSymbolicLink() || stat.nlink !== 1 || stat.size > maxBytes)) throw new Error('자동 모델 정책 저장 경로가 안전하지 않습니다. 원본을 보존했습니다.');
    if (!existsSync(this.file)) return;
    const raw = JSON.parse(readFileSync(this.file, 'utf8')) as {version?: number; policies?: unknown};
    if (raw.version !== 1 || !Array.isArray(raw.policies) || raw.policies.length > 50) throw new Error('자동 모델 정책 저장 형식을 읽을 수 없습니다. 원본을 보존했습니다.');
    this.policies = raw.policies.map(normalizeAgentPolicy);
    if (new Set(this.policies.map(p => p.id)).size !== this.policies.length) throw new Error('중복된 자동 모델 정책 ID입니다. 원본을 보존했습니다.');
  }
  list(): AgentPolicy[] {return structuredClone(this.policies);}
  get(id: string): AgentPolicy {const found = this.policies.find(p => p.id === id); if (!found) throw new Error('자동 모델 정책을 찾을 수 없습니다. 설정에서 정책을 확인하세요.'); return structuredClone(found);}
  save(input: unknown, expectedUpdatedAt?: string): AgentPolicy {
    if (!input || typeof input !== 'object' || Array.isArray(input)) throw new Error('자동 모델 정책 형식을 확인하세요.');
    const raw = input as {id?: unknown}, id = raw.id === undefined || raw.id === '' ? undefined : raw.id;
    if (id !== undefined && typeof id !== 'string') throw new Error('자동 모델 정책 ID가 올바르지 않습니다.');
    const previous = id ? this.get(id) : undefined;
    if (previous && expectedUpdatedAt !== previous.updatedAt) throw new Error('자동 모델 정책이 변경되었습니다. 최신 정책을 다시 불러온 뒤 저장하세요.');
    if (!previous && this.policies.length >= 50) throw new Error('자동 모델 정책은 최대 50개까지 저장할 수 있습니다.');
    const draft = normalizeAgentPolicyDraft(input), stamp = new Date(Math.max(Date.now(), previous ? Date.parse(previous.updatedAt) + 1 : 0)).toISOString();
    const policy = normalizeAgentPolicy({...draft, id: previous?.id ?? randomUUID(), createdAt: previous?.createdAt ?? stamp, updatedAt: stamp});
    this.persist([policy, ...this.policies.filter(p => p.id !== policy.id)]); return structuredClone(policy);
  }
  remove(id: string, expectedUpdatedAt: string): void {if (this.get(id).updatedAt !== expectedUpdatedAt) throw new Error('자동 모델 정책이 변경되었습니다. 최신 정책을 다시 불러온 뒤 삭제하세요.'); this.persist(this.policies.filter(p => p.id !== id));}
  private persist(next: AgentPolicy[]): void {
    const data = {version: 1, policies: next};
    if (Buffer.byteLength(JSON.stringify(data, null, 2)) > maxBytes) throw new Error('자동 모델 정책 전체 저장 한도 4MiB에 도달했습니다. 기존 정책은 변경하지 않았습니다.');
    atomicWriteJson(this.file, data); this.policies = next;
  }
}
