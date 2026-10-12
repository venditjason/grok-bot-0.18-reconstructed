import {validDevelopmentBinding, type DevelopmentBinding} from '../shared/development-routing.js';
import {createHash, randomUUID} from 'node:crypto';
import {existsSync, lstatSync, readFileSync, unlinkSync} from 'node:fs';
import {join} from 'node:path';
import {atomicWriteJson, type ConnectionRoute} from './local-store.js';
import {AgentStore, validAgentProfile} from './agent-store.js';
import {PolicyStore} from './policy-store.js';
import {TeamStore, type TeamProfile} from './team-store.js';
import {normalizeAgentPolicy, normalizeAgentPolicyDraft, type AgentPolicyDraft} from '../shared/agent-policy.js';
import type {ProviderModel} from '../shared/provider-model-catalog.js';
import {recommendRoutineConnections} from './delegation-policy.js';

export type AutomaticTeamInput = {development?: DevelopmentBinding;requestId: string; name: string; projectBrief: string; instructions: string; policies: string; memberAgentIds: string[]; workspacePath?: string};
export type AutomaticTeamCatalog = {connectionId: string; models: ProviderModel[]};
const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const bounded = (value: unknown, max: number, empty = false): string => {
  if (typeof value !== 'string' || value.length > max || value.includes('\0') || (!empty && !value.trim())) throw new Error('팀 이름과 프로젝트 내용을 입력 범위 안에서 확인하세요.');
  return value.trim();
};
export function normalizeAutomaticTeamInput(value: unknown): AutomaticTeamInput {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('대표 자동 생성 요청을 확인하세요.');
  const raw = value as Record<string, unknown>;
  if (raw.development !== undefined && !validDevelopmentBinding(raw.development)) throw new Error('개발을 맡길 Rabbit 프로젝트 설정을 확인하세요.');
  if (!uuid.test(String(raw.requestId ?? '')) || raw.id || raw.leaderMode !== 'automatic') throw new Error('자동 대표는 고유한 생성 요청으로 새 팀에서 만드세요.');
  if (!Array.isArray(raw.memberAgentIds) || raw.memberAgentIds.some(id => typeof id !== 'string' || !id || id.length > 100) || new Set(raw.memberAgentIds).size !== raw.memberAgentIds.length) throw new Error('초기 멤버를 중복 없이 선택하세요.');
  return {...(validDevelopmentBinding(raw.development) ? {development: {mode: 'rabbit' as const, connectionId: raw.development.connectionId}} : {}), requestId: String(raw.requestId).toLowerCase(), name: bounded(raw.name, 80), projectBrief: bounded(raw.projectBrief, 4000), instructions: bounded(raw.instructions ?? '', 8000, true), policies: bounded(raw.policies ?? '', 8000, true), memberAgentIds: [...raw.memberAgentIds] as string[], ...(raw.workspacePath ? {workspacePath: bounded(raw.workspacePath, 4096)} : {})};
}
export const automaticTeamFingerprint = (input: AutomaticTeamInput): string => createHash('sha256').update(JSON.stringify(input)).digest('hex');
export function planAutomaticTeam(input: AutomaticTeamInput, catalogs: AutomaticTeamCatalog[]): {leaderName: string; instructions: string; policies: string; connections: ConnectionRoute[]; policy: AgentPolicyDraft} {
  const connections: ConnectionRoute[] = catalogs.flatMap(catalog => {
    const model = catalog.models.find(model => model.isDefault);
    return model ? [{connectionId: catalog.connectionId, model: model.resolvedId ?? model.id, ...(model.defaultEffort && model.efforts.includes(model.defaultEffort) ? {effort: model.defaultEffort} : {})}] : [];
  }).slice(0, 8);
  if (!connections.length) throw new Error('자동 대표에 사용할 로그인 연결 또는 확인된 도구 지원 API 연결이 없습니다. 설정에서 연결을 확인하세요.');
  const routine = recommendRoutineConnections(connections, catalogs).connections;
  const complex = connections.map(route => {
    const model = catalogs.find(c => c.connectionId === route.connectionId)?.models.find(m => (m.resolvedId ?? m.id) === route.model)!;
    return {...route, ...(model.efforts.includes('high') ? {effort: 'high'} : {})};
  });
  const leaderName = `${input.name.replace(/\s+/g, ' ').slice(0, 75)} 대표`;
  const operating = '목표를 검증 가능한 단계로 분해하고 필요한 역할을 직접 생성한다. 작업 난이도에 따라 모델·effort를 선택하고 결과를 검토한 뒤 완료 근거와 남은 한계를 보고한다. 운영 지침은 update_team_policy로 개선하고 변경 이유를 팀에 공유한다. 관리자 보안·승인 규칙을 변경하거나 우회하지 않는다. 팀원 제외는 연결 해제이며 영구 삭제가 아니다.';
  return {leaderName, connections,
    instructions: `당신은 ${leaderName}입니다.\n프로젝트 내용:\n${input.projectBrief}\n\n임무: 사용자 목표를 이해하고 조사·구현·검증 역할을 구성해 결과를 완성하세요. add_team_member로 필요한 역할의 팀원을 생성하고 delegate_team_task로 구체적인 완료 기준을 전달하세요. list_team_models에서 실제 모델을 확인하고 routine/standard/complex 작업 강도와 지원 effort를 선택하세요. 간단한 답변은 직접 처리해도 됩니다.\n${operating}\n\n공동 지시:\n${input.instructions || '별도 공동 지시 없음'}`,
    policies: `${operating}${input.policies ? `\n\n사용자 운영 지침:\n${input.policies}` : ''}`,
    policy: normalizeAgentPolicyDraft({name: `${input.name.slice(0, 68)} 자동 작업 정책`, description: `프로젝트: ${input.projectBrief.slice(0, 1600)}\n공식 목록의 기본 모델과 지원 effort를 사용합니다. 가격·추론 권한은 보장하지 않습니다.`, defaultTaskKind: 'standard', rules: [
      {taskKind: 'routine', keywords: ['요약', '정리', '반복', '분류', 'format', 'summarize'], connections: routine},
      {taskKind: 'standard', keywords: [], connections},
      {taskKind: 'complex', keywords: ['설계', '아키텍처', '보안', '원인 분석', '마이그레이션', 'architecture', 'security'], connections: complex},
    ]}),
  };
}

const journalName = 'automatic-team-pending.json';
const files = ['agents.json', 'agent-policies.json'] as const;
type Journal = {version: 1; requestId: string; inputHash: string; avatarId?: string; before: Record<typeof files[number], unknown | null>};
function safeJson(root: string, name: string, maxBytes: number): unknown | null {
  const path = join(root, name);
  let stat: ReturnType<typeof lstatSync>;
  try {stat = lstatSync(path);} catch (error) {if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null; throw error;}
  if (!stat.isFile() || stat.isSymbolicLink() || stat.nlink !== 1 || stat.size > maxBytes || (name === journalName && ((stat.mode & 0o077) !== 0 || stat.uid !== process.getuid?.()))) throw new Error('자동 팀 생성 복구 파일이 안전하지 않습니다. 원본을 보존했습니다.');
  return JSON.parse(readFileSync(path, 'utf8'));
}
/** Run before opening stores. A durable team receipt is the commit marker; interrupted pre-commit writes are restored. */
export function recoverAutomaticTeamCreation(root: string): void {
  const raw = safeJson(root, journalName, 12 * 1024 * 1024) as Journal | null; if (!raw) return;
  if (raw.version !== 1 || !uuid.test(raw.requestId) || !/^[a-f0-9]{64}$/.test(raw.inputHash) || !raw.before || Object.keys(raw.before).sort().join() !== [...files].sort().join()) throw new Error('자동 팀 생성 복구 기록을 확인할 수 없습니다. 원본을 보존했습니다.');
  for (const file of files) {
    const data = raw.before[file] as Record<string, unknown> | null;
    if (data !== null && (typeof data !== 'object' || data.version !== 1 || !Array.isArray(data[file === 'agents.json' ? 'agents' : 'policies']))) throw new Error('자동 팀 생성 백업 형식이 올바르지 않습니다. 원본을 보존했습니다.');
  }
  for (const agent of (raw.before['agents.json'] as {agents: unknown[]} | null)?.agents ?? []) if (!validAgentProfile(agent)) throw new Error('Invalid saved agent recovery record.');
  for (const policy of (raw.before['agent-policies.json'] as {policies: unknown[]} | null)?.policies ?? []) normalizeAgentPolicy(policy);
  const teamData = safeJson(root, 'teams.json', 64 * 1024 * 1024) as {automaticCreations?: {requestId: string; inputHash: string}[]} | null;
  const committed = teamData?.automaticCreations?.some(item => item.requestId === raw.requestId && item.inputHash === raw.inputHash);
  if (raw.avatarId !== undefined && !uuid.test(raw.avatarId)) throw new Error('Invalid automatic avatar recovery identity.');
  if (!committed) for (const file of files) {
    // Atomic writers independently reject symlinks/hardlinks at the destination.
    if (raw.before[file] === null) {safeJson(root, file, 4 * 1024 * 1024); if (existsSync(join(root, file))) unlinkSync(join(root, file));}
    else atomicWriteJson(join(root, file), raw.before[file]);
  }
  if (!committed && raw.avatarId) {
    const directory = join(root, 'avatars');
    if (existsSync(directory)) {
      const stat = lstatSync(directory); if (!stat.isDirectory() || stat.isSymbolicLink()) throw new Error('Unsafe avatar recovery directory.');
      const file = raw.avatarId + '.json', record = safeJson(directory, file, 4 * 1024 * 1024) as {id?: string} | null;
      if (record) {if (record.id !== raw.avatarId) throw new Error('Avatar recovery identity changed.'); unlinkSync(join(directory, file));}
    }
  }
  unlinkSync(join(root, journalName));
}

export class AutomaticTeamCreator {
  private readonly pending = new Map<string, {hash: string; promise: Promise<TeamProfile>; cancelled: boolean}>();
  private recoveryRequired = false;
  constructor(private readonly root: string, private readonly agents: AgentStore, private readonly policies: PolicyStore, private readonly teams: TeamStore, private readonly ports: {
    catalogs(input: AutomaticTeamInput): Promise<{catalogs: AutomaticTeamCatalog[]; assertCurrent(): void}>;
    createAvatar(id: string): string;
    changed(): void;
  }) {}
  assertReady(): void {if (this.recoveryRequired) throw new Error('자동 팀 저장 복구가 필요합니다. 다른 설정을 변경하지 말고 앱을 다시 시작하세요.');}
  cancel(requestId: string): boolean {const active = this.pending.get(requestId); if (!active) return false; active.cancelled = true; return true;}
  create(raw: unknown): Promise<TeamProfile> {
    this.assertReady(); const input = normalizeAutomaticTeamInput(raw), hash = automaticTeamFingerprint(input);
    const prior = this.teams.automaticCreation(input.requestId, hash); if (prior) return Promise.resolve(prior);
    const pending = this.pending.get(input.requestId);
    if (pending) {if (pending.hash !== hash) return Promise.reject(new Error('같은 생성 요청 ID에 다른 팀 내용이 전달되었습니다.')); return pending.promise;}
    const promise = this.perform(input, hash); this.pending.set(input.requestId, {hash, promise, cancelled: false});
    void promise.finally(() => {this.pending.delete(input.requestId);}).catch(() => {}); return promise;
  }
  private async perform(input: AutomaticTeamInput, hash: string): Promise<TeamProfile> {
    const observed = await this.ports.catalogs(input), plan = planAutomaticTeam(input, observed.catalogs);
    this.assertReady();
    if (this.pending.get(input.requestId)?.cancelled) throw new Error('대표 자동 생성을 취소했습니다. 에이전트와 팀을 저장하지 않았습니다.');
    observed.assertCurrent();
    input.memberAgentIds.forEach(id => this.agents.get(id));
    if (existsSync(join(this.root, journalName))) throw new Error('이전 자동 팀 생성 복구를 마친 뒤 다시 시도하세요.');
    const before = Object.fromEntries(files.map(file => [file, safeJson(this.root, file, 4 * 1024 * 1024)])) as Journal['before'];
    const avatarId = randomUUID();
    if (existsSync(join(this.root, 'avatars', avatarId + '.json'))) throw new Error('Avatar identity collision.');
    atomicWriteJson(join(this.root, journalName), {version: 1, requestId: input.requestId, inputHash: hash, avatarId, before});
    let saved: TeamProfile | undefined;
    try {
      if (this.ports.createAvatar(avatarId) !== avatarId) throw new Error('Automatic avatar identity changed.');
      const policy = this.policies.save(plan.policy);
      const leader = this.agents.save({...(input.development ? {development: structuredClone(input.development)} : {}), name: plan.leaderName, instructions: plan.instructions, ...plan.connections[0]!, connections: plan.connections, avatarId, automation: {policyId: policy.id}, ...(input.workspacePath ? {workspacePath: input.workspacePath} : {})});
      saved = this.teams.saveTeam({...(input.development ? {development: structuredClone(input.development)} : {}), name: input.name, topic: input.projectBrief, instructions: input.instructions, policies: plan.policies, leaderAgentId: leader.id, memberAgentIds: [leader.id, ...input.memberAgentIds], autonomous: true, rounds: 1, creation: {requestId: input.requestId, inputHash: hash, leaderAgentId: leader.id, policyId: policy.id}});
    } catch (error) {
      try {recoverAutomaticTeamCreation(this.root); this.agents.reload(); this.policies.reload();}
      catch {this.recoveryRequired = true; throw new Error('자동 팀 생성 중 저장 복구를 완료하지 못했습니다. 복구 기록과 기존 데이터를 보존했습니다. 앱을 다시 시작하세요.');}
      throw error;
    }
    // The durable team receipt is authoritative, including after notification or journal-cleanup failures.
    try {recoverAutomaticTeamCreation(this.root);} catch {this.recoveryRequired = true;}
    try {this.ports.changed();} catch {}
    return saved;
  }
}
