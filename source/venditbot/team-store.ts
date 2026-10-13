import type {PublishedCandidateProof} from './rabbit-delegation.js';
import {validRequiredPolicy, type RequiredPolicyPin} from '../shared/required-delegation-policy.js';
import {delegationContract, type DelegationContract} from './delegation-evidence.js';
import {validChatAttachments,type ChatAttachment} from '../shared/chat-attachments.js';
import {validDevelopmentBinding, type DevelopmentBinding} from '../shared/development-routing.js';
import {lstatSync, readFileSync} from 'node:fs';
import {join} from 'node:path';
import {randomUUID} from 'node:crypto';
import {atomicWriteJson, connectionRoutes, validConnections, type ConnectionRoute} from './local-store.js';
import {validAgentProfile, type AgentProfile} from './agent-store.js';
import {normalizeAgentPolicy, validAgentPolicySelection, type AgentPolicy, type AgentPolicySelection} from '../shared/agent-policy.js';
import {normalizeManagedName} from './agent-management-tools.js';

export type TeamStatus = 'queued' | 'running' | 'completed' | 'failed' | 'cancelled';
export type TeamStepStatus = TeamStatus | 'pending';
export type TeamCreation = {requestId: string; inputHash: string; leaderAgentId: string; policyId: string};
export type TeamProfile = {development?: DevelopmentBinding;creation?: TeamCreation; autonomous?: boolean; id: string; name: string; instructions: string; topic: string; policies: string; leaderAgentId: string; memberAgentIds: string[]; rounds: number; createdAt: string; updatedAt: string};
export type TeamMessage = {attachments?:ChatAttachment[];id: string; fromAgentId?: string; fromAgentName: string; toAgentId?: string; text: string; kind: 'user' | 'agent' | 'result' | 'system'; sessionId?: string; createdAt: string};
export type TeamStep = {supersedesSessionId?: string; correction?: {category:'procedure'|'resource'|'verification';change:string;regression:string}; contract?: DelegationContract; acceptanceReceipt?: {scope:'file_artifact';sessionId:string;messageId:string;callId:string;sha256:string}|PublishedCandidateProof;sessionId: string; agentId: string; agentName: string; round: number; kind: 'plan' | 'work' | 'summary'; taskKind?: 'routine' | 'standard' | 'complex'; connections?: ConnectionRoute[]; routeSelection?: AgentPolicySelection; task?: string; parentSessionId?: string; status: TeamStepStatus};
export type TeamContext = {runId: string; goal: string; policies: string; result: string; excerpt: boolean};
export type StoredTeamRun = {requiredPolicy?: RequiredPolicyPin;routineDispatchId?: string;development?: DevelopmentBinding;autonomous?: boolean; id: string; teamId: string; teamName: string; teamUpdatedAt: string; previousRunId?: string; context?: TeamContext[]; policySnapshots?: {agentId: string; policy: AgentPolicy}[]; goal: string; instructions: string; topic: string; policies: string; leaderAgentId: string; activeMemberAgentIds: string[]; memberSnapshots: AgentProfile[]; additions: number; status: TeamStatus; rounds: number; createdAt: string; updatedAt: string; steps: TeamStep[]; messages: TeamMessage[]; finalSessionId?: string; error?: string};
export type TeamRunSummary = Omit<StoredTeamRun, 'instructions' | 'memberSnapshots' | 'messages' | 'teamUpdatedAt' | 'activeMemberAgentIds' | 'additions' | 'context' | 'policySnapshots'> & {members: {id: string; name: string}[]; messageCount: number};
export type TeamRunDetail = TeamRunSummary & {messages: TeamMessage[]};
export const teamLimits = {teams: 50, runs: 200, active: 4, plans: 3, delegated: 8, messages: 200, toolInputBytes: 1024 * 1024, messageCharacters: 8000} as const;
export const teamDelegationLimit = (run: Pick<StoredTeamRun, 'memberSnapshots'>): number => Math.max(teamLimits.delegated, run.memberSnapshots.length - 1);
// Message room grows with the actual roster; the durable file remains bounded to 64 MiB.
export const teamMessageLimit = (run: Pick<StoredTeamRun, 'memberSnapshots'>): number => Math.max(teamLimits.messages, teamDelegationLimit(run) + teamLimits.plans * 2 + 40);
export const activeTeamRun = (run: {status: TeamStatus}): boolean => run.status === 'queued' || run.status === 'running';
const text = (value: unknown, max: number, nonempty = true): value is string => typeof value === 'string' && value.length <= max && !value.includes('\0') && (!nonempty || !!value.trim());
const date = (value: unknown): boolean => text(value, 40) && Number.isFinite(Date.parse(value));
const ids = (value: unknown, min = 1): value is string[] => Array.isArray(value) && value.length >= min && value.every(id => text(id, 100)) && new Set(value).size === value.length;
export function validTeam(value: unknown): value is TeamProfile {
  if (!value || typeof value !== 'object') return false;
  const t = value as TeamProfile;
  return (t.development === undefined || validDevelopmentBinding(t.development)) && (t.creation === undefined || (!!t.creation && typeof t.creation === 'object' && /^[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/.test(t.creation.requestId) && /^[a-f0-9]{64}$/.test(t.creation.inputHash) && text(t.creation.leaderAgentId, 100) && text(t.creation.policyId, 100))) && (t.autonomous === undefined || typeof t.autonomous === 'boolean') && text(t.id, 100) && text(t.name, 80) && text(t.instructions, 16000, false) && text(t.topic, 4000, false) && text(t.policies, 16000, false) && Number.isInteger(t.rounds) && t.rounds >= 1 && t.rounds <= 3 && date(t.createdAt) && date(t.updatedAt)
    && ids(t.memberAgentIds) && t.memberAgentIds.includes(t.leaderAgentId);
}
export function validTeamRun(value: unknown): value is StoredTeamRun {
  if (!value || typeof value !== 'object') return false;
  const r = value as StoredTeamRun;
  if(r.requiredPolicy!==undefined&&!validRequiredPolicy(r.requiredPolicy))return false;
  try {for(const step of r.steps??[]){
    if(step.contract)delegationContract(step.contract);
    if(step.supersedesSessionId!==undefined && (!text(step.supersedesSessionId,100)||!step.correction||!['procedure','resource','verification'].includes(step.correction.category)||!text(step.correction.change,2000)||!text(step.correction.regression,2000)))return false;
    if(step.acceptanceReceipt?.scope==='published_candidate_verified'&&(step.contract?.acceptance.kind!=='rabbit_verified_pr'||JSON.stringify(step.acceptanceReceipt).length>131072||!Array.isArray(step.acceptanceReceipt.tasks)||!step.acceptanceReceipt.tasks.length||step.acceptanceReceipt.tasks.length>100))return false;
    if(step.acceptanceReceipt!==undefined && (!['file_artifact','published_candidate_verified'].includes(step.acceptanceReceipt.scope)||!text(step.acceptanceReceipt.sessionId,100)||step.acceptanceReceipt.sessionId!==step.sessionId||!text(step.acceptanceReceipt.messageId,100)||!text(step.acceptanceReceipt.callId,200)||!/^[a-f0-9]{64}$/.test(step.acceptanceReceipt.sha256)))return false;
  }}catch{return false;}
  if ((r.routineDispatchId !== undefined && !/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(r.routineDispatchId)) || (r.development !== undefined && !validDevelopmentBinding(r.development)) || (r.autonomous !== undefined && typeof r.autonomous !== 'boolean') || !text(r.id, 100) || !text(r.teamId, 100) || !text(r.teamName, 80) || !text(r.goal, 8000) || !text(r.instructions, 16000, false) || !text(r.topic, 4000, false) || !text(r.policies, 16000, false) || !date(r.teamUpdatedAt) || !date(r.createdAt) || !date(r.updatedAt)
    || (r.previousRunId !== undefined && !text(r.previousRunId, 100)) || (r.context !== undefined && (!Array.isArray(r.context) || r.context.length > 3 || JSON.stringify(r.context).length > 32000 || !r.context.every(c => c && text(c.runId, 100) && text(c.goal, 2000) && text(c.policies, 2000, false) && text(c.result, 5500, false) && typeof c.excerpt === 'boolean')))
    || !Number.isInteger(r.rounds) || r.rounds < 1 || r.rounds > 3 || !Number.isSafeInteger(r.additions) || r.additions < 0
    || !['queued', 'running', 'completed', 'failed', 'cancelled'].includes(r.status) || (r.error !== undefined && !text(r.error, 2000, false))
    || !Array.isArray(r.memberSnapshots) || r.memberSnapshots.length < 1 || !r.memberSnapshots.every(validAgentProfile) || new Set(r.memberSnapshots.map(a => a.id)).size !== r.memberSnapshots.length
    || !ids(r.activeMemberAgentIds) || !r.activeMemberAgentIds.includes(r.leaderAgentId) || !r.activeMemberAgentIds.every(id => r.memberSnapshots.some(a => a.id === id))) return false;
  if (r.policySnapshots !== undefined) {
    if (!Array.isArray(r.policySnapshots) || new Set(r.policySnapshots.map(p => p?.agentId)).size !== r.policySnapshots.length) return false;
    try {for (const p of r.policySnapshots) {if (!p || !r.memberSnapshots.some(a => a.id === p.agentId && a.automation?.policyId === p.policy?.id)) return false; normalizeAgentPolicy(p.policy);}} catch {return false;}
  }
  if (!Array.isArray(r.steps) || r.steps.length < 1 || r.steps.length > teamDelegationLimit(r) + teamLimits.plans + 1 || new Set(r.steps.map(s => s?.sessionId)).size !== r.steps.length || !r.steps.every((s, index) => {
    const member = r.memberSnapshots.find(a => a.id === s?.agentId), parent = s?.parentSessionId ? r.steps.slice(0, index).find(step => step.sessionId === s.parentSessionId) : undefined;
    return s && !!member && text(s.sessionId, 100) && s.agentName === member.name && Number.isInteger(s.round) && s.round >= 1 && s.round <= 4
      && (s.taskKind === undefined || ['routine', 'standard', 'complex'].includes(s.taskKind)) && (s.connections === undefined || validConnections(s.connections))
      && (s.routeSelection === undefined || validAgentPolicySelection(s.routeSelection))
      && ['plan', 'work', 'summary'].includes(s.kind) && (s.kind === 'work' ? s.agentId !== r.leaderAgentId && text(s.task, 8000) && parent?.kind === 'plan' : s.agentId === r.leaderAgentId && s.parentSessionId === undefined)
      && ['pending', 'queued', 'running', 'completed', 'failed', 'cancelled'].includes(s.status);
  }) || r.steps.filter(s => s.kind === 'plan').length > 3 || r.steps.filter(s => s.kind === 'work').length > teamDelegationLimit(r) || r.steps.filter(s => s.kind === 'summary').length > 1
    || r.steps[0]?.kind !== 'plan' || (r.finalSessionId !== undefined && !r.steps.some(s => s.sessionId === r.finalSessionId && s.agentId === r.leaderAgentId))) return false;
  return Array.isArray(r.messages) && r.messages.length <= teamMessageLimit(r) && new Set(r.messages.map(m => m?.id)).size === r.messages.length && r.messages.every(m => {
    if (!m || (m.attachments!==undefined&&(!validChatAttachments(m.attachments)||m.kind!=='user'||m.fromAgentId!==undefined)) || !text(m.id, 100) || !text(m.text, teamLimits.messageCharacters) || !date(m.createdAt) || !['user', 'agent', 'result', 'system'].includes(m.kind)) return false;
    const sender = r.memberSnapshots.find(a => a.id === m.fromAgentId);
    return (m.fromAgentId === undefined ? (m.kind === 'user' || m.kind === 'system') && text(m.fromAgentName, 80) : !!sender && m.fromAgentName === sender.name && (m.kind === 'agent' || m.kind === 'result'))
      && (m.toAgentId === undefined || r.memberSnapshots.some(a => a.id === m.toAgentId))
      && (m.sessionId === undefined || r.steps.some(s => s.sessionId === m.sessionId && (m.fromAgentId === undefined || s.agentId === m.fromAgentId)));
  });
}
export function summarizeTeamRun(run: StoredTeamRun): TeamRunSummary {
  const {instructions: _instructions, memberSnapshots, messages, teamUpdatedAt: _revision, activeMemberAgentIds, additions: _additions, context: _context, policySnapshots: _policies, ...summary} = run;
  return structuredClone({...summary, members: activeMemberAgentIds.map(id => {const a = memberSnapshots.find(a => a.id === id)!; return {id: a.id, name: a.name};}), messageCount: messages.length});
}
export const teamRunDetail = (run: StoredTeamRun): TeamRunDetail => ({...summarizeTeamRun(run), messages: structuredClone(run.messages)});

/** Definitions commit transactionally; failed progress writes remain recoverable in memory. */
export class TeamStore {
  private readonly file: string;
  private teams: TeamProfile[] = [];
  private automaticCreations: {requestId: string; inputHash: string; teamId: string}[] = [];
  private runs: StoredTeamRun[] = [];
  private readonly unsaved = new Map<string, StoredTeamRun>();
  constructor(root: string, private readonly onStorage?: (ids: string[]) => void) {
    this.file = join(root, 'teams.json');
    let stat; try { stat = lstatSync(this.file); } catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') return; throw error; }
    if (!stat.isFile() || stat.isSymbolicLink() || stat.nlink !== 1 || stat.size > 64 * 1024 * 1024) throw new Error('안전하지 않거나 너무 큰 팀 저장 파일입니다.');
    const data = JSON.parse(readFileSync(this.file, 'utf8')) as {version?: number; teams?: unknown; runs?: unknown; automaticCreations?: {requestId: string; inputHash: string; teamId: string}[]};
    if (data.version !== 1 || !Array.isArray(data.teams) || data.teams.length > teamLimits.teams || !data.teams.every(validTeam) || new Set(data.teams.map(t => t.id)).size !== data.teams.length
      || !Array.isArray(data.runs) || data.runs.length > teamLimits.runs || !data.runs.every(validTeamRun) || new Set(data.runs.map(r => r.id)).size !== data.runs.length) throw new Error('팀 저장 데이터가 손상되었습니다. 원본은 보존했습니다.');
    if (data.automaticCreations !== undefined && (!Array.isArray(data.automaticCreations) || data.automaticCreations.some(c => !c || !/^[a-f0-9-]{36}$/.test(c.requestId) || !/^[a-f0-9]{64}$/.test(c.inputHash) || !text(c.teamId, 100)) || new Set(data.automaticCreations.map(c => c.requestId)).size !== data.automaticCreations.length)) throw new Error('자동 팀 생성 이력이 손상되었습니다. 원본을 보존했습니다.');
    this.automaticCreations = data.automaticCreations ?? [];
    this.teams = data.teams.map(team => ({...team, autonomous: team.autonomous ?? false})); this.runs = data.runs.map(run => ({...run, autonomous: run.autonomous ?? false}));
    for (const run of this.listRuns()) if (activeTeamRun(run)) {
      run.status = 'cancelled'; run.error = '앱 종료로 중단된 팀 작업입니다. 자동 재실행하지 않습니다.';
      for (const step of run.steps) if (['pending', 'queued', 'running'].includes(step.status)) step.status = 'cancelled';
      try { this.saveRun(run); } catch { /* Recovery stays exportable even when the disk is unavailable. */ }
    }
  }
  automaticCreation(requestId: string, inputHash: string): TeamProfile | undefined {
    const previous = this.automaticCreations.find(c => c.requestId === requestId); if (!previous) return;
    if (previous.inputHash !== inputHash) throw new Error('같은 생성 요청 ID에 다른 팀 내용이 전달되었습니다.');
    if (!this.teams.some(t => t.id === previous.teamId)) throw new Error('이 요청으로 만든 팀은 삭제되었습니다. 새 팀 초안에서 다시 생성하세요.');
    return this.getTeam(previous.teamId);
  }
  listTeams(): TeamProfile[] { return structuredClone(this.teams); }
  getTeam(id: string): TeamProfile { const team = this.teams.find(t => t.id === id); if (!team) throw new Error('팀을 찾을 수 없습니다.'); return structuredClone(team); }
  private values(): StoredTeamRun[] { const all = new Map(this.runs.map(r => [r.id, r])); for (const [id, run] of this.unsaved) all.set(id, run); return [...all.values()].sort((a, b) => b.createdAt.localeCompare(a.createdAt)); }
  listRuns(): StoredTeamRun[] { return structuredClone(this.values()); }
  listSummaries(): TeamRunSummary[] { return this.values().map(summarizeTeamRun); }
  listActiveRuns(): StoredTeamRun[] { return structuredClone(this.values().filter(activeTeamRun)); }
  runCount(): number { return this.values().length; }
  activeRunCount(): number { return this.values().filter(activeTeamRun).length; }
  findSessionRun(sessionId: string): StoredTeamRun | undefined { const found = this.values().find(r => r.steps.some(s => s.sessionId === sessionId)); return found ? structuredClone(found) : undefined; }
  referencesConnection(id: string): boolean { return this.values().some(r => r.memberSnapshots.some(a => a.connectionId === id || connectionRoutes(a).some(route => route.connectionId === id))); }
  getRun(id: string): StoredTeamRun { const run = this.unsaved.get(id) ?? this.runs.find(r => r.id === id); if (!run) throw new Error('팀 작업을 찾을 수 없습니다.'); return structuredClone(run); }
  unsavedIds(): string[] { return [...this.unsaved.keys()]; }
  saveTeam(input: Omit<TeamProfile, 'id' | 'createdAt' | 'updatedAt'> & {id?: string}): TeamProfile {
    const previous = input.id ? this.getTeam(input.id) : undefined;
    if (!previous && this.teams.length >= teamLimits.teams) throw new Error('팀은 최대 50개까지 저장할 수 있습니다.');
    const now = new Date(Math.max(Date.now(), previous ? Date.parse(previous.updatedAt) + 1 : 0)).toISOString(), team = {...structuredClone(input), ...(previous?.creation ? {creation: previous.creation} : {}), autonomous: input.autonomous ?? previous?.autonomous ?? false, id: previous?.id ?? randomUUID(), createdAt: previous?.createdAt ?? now, updatedAt: now};
    if (!validTeam(team)) throw new Error('팀 이름·대표·한 명 이상의 등록된 멤버·운영 정책을 확인하세요.');
    const creation = !previous && team.creation ? {requestId: team.creation.requestId, inputHash: team.creation.inputHash, teamId: team.id} : undefined;
    if (creation && this.automaticCreations.some(c => c.requestId === creation.requestId)) throw new Error('이미 처리한 자동 팀 생성 요청입니다.');
    this.commit([team, ...this.teams.filter(t => t.id !== team.id)], this.listRuns(), creation ? [...this.automaticCreations, creation] : this.automaticCreations); return structuredClone(team);
  }
  /** A leader edit changes its run and the persistent team in one atomic file write. */
  saveTeamAndRun(run: StoredTeamRun, changes: {name?: string} = {}): void {
    const previous = this.getTeam(run.teamId);
    if (previous.updatedAt !== run.teamUpdatedAt) throw new Error('팀 설정이 다른 화면 또는 작업에서 변경되었습니다. 현재 작업을 마친 뒤 새 설정으로 다시 시작하세요.');
    const updatedAt = new Date(Math.max(Date.now(), Date.parse(previous.updatedAt) + 1)).toISOString();
    const name = changes.name === undefined ? previous.name : normalizeManagedName(changes.name);
    const team = {...previous, name, policies: run.policies, memberAgentIds: [...run.activeMemberAgentIds], updatedAt};
    const next = {...structuredClone(run), ...(changes.name === undefined ? {} : {teamName: name}), teamUpdatedAt: updatedAt, updatedAt};
    if (!validTeam(team) || !validTeamRun(next)) throw new Error('팀 구성 변경이 올바르지 않습니다.');
    this.commit(this.teams.map(t => t.id === team.id ? team : t), [next, ...this.listRuns().filter(r => r.id !== run.id)]);
  }
  removeTeam(id: string): void { this.getTeam(id); if (this.listRuns().some(r => r.teamId === id && activeTeamRun(r))) throw new Error('진행 중인 팀 작업을 먼저 중단하세요.'); this.commit(this.teams.filter(t => t.id !== id), this.listRuns()); }
  saveRun(input: StoredTeamRun): void {
    const run = structuredClone({...input, autonomous: input.autonomous ?? false, updatedAt: new Date().toISOString()});
    if (!validTeamRun(run)) throw new Error('팀 작업 데이터의 형식 또는 크기 제한을 확인하세요.');
    const all = this.listRuns(); if (!all.some(r => r.id === run.id) && all.length >= teamLimits.runs) throw new Error('팀 작업은 최대 200개입니다. 이전 작업을 내보낸 뒤 삭제하세요.');
    try { this.commit(this.teams, [run, ...all.filter(r => r.id !== run.id)]); }
    catch (error) { this.unsaved.set(run.id, run); try { this.onStorage?.(this.unsavedIds()); } catch {} throw error; }
  }
  removeRun(id: string): void { const run = this.getRun(id); if (activeTeamRun(run)) throw new Error('진행 중인 팀 작업을 먼저 중단하세요.'); this.commit(this.teams, this.listRuns().filter(r => r.id !== id)); }
  private commit(teams: TeamProfile[], runs: StoredTeamRun[], automaticCreations = this.automaticCreations): void {
    const data = {version: 1, teams, runs, automaticCreations};
    if (Buffer.byteLength(JSON.stringify(data, null, 2)) > 64 * 1024 * 1024) throw new Error('팀 전체 저장 한도 64MiB에 도달했습니다. 기존 데이터는 보존했습니다.');
    atomicWriteJson(this.file, data); this.automaticCreations = structuredClone(automaticCreations); this.teams = structuredClone(teams); this.runs = structuredClone(runs);
    if (this.unsaved.size) { this.unsaved.clear(); try { this.onStorage?.([]); } catch { /* Notification failure cannot undo a durable team commit. */ } }
  }
}
