import type { RabbitProfile, RabbitRunRecord } from './rabbit-ui-state';
import type { ActionRules } from '../../source/shared/action-rules';
import type { AgentPolicy, AgentPolicySelection } from '../../source/shared/agent-policy';
import { mergeAvatarJob, type AvatarJob } from './avatar-jobs';
import type { ApiProviderProfile } from '../../source/shared/api-provider-config';

export type Profile = ApiProviderProfile & { hasKey: boolean; verified: boolean };
export type ToolStatus = { callId: string; name: string; path?: string; status: 'running' | 'completed' | 'failed'; summary?: string };
export type AgentConnection = { connectionId: string; model: string; effort?: string };
export type ConnectionAttempt = AgentConnection & { status: 'running' | 'failed' | 'completed'; error?: string };
export type Message = { routeSelection?: AgentPolicySelection; id: string; role: string; text: string; status?: string; error?: string; tools?: ToolStatus[]; attempts?: ConnectionAttempt[] };
export type Approval = { approvalId: string; sessionId: string; path: string; operation: 'write' | 'read' | 'list' | 'search' | 'manage'; preview?: string; existing?: boolean; tool?: string; category?: string; reason?: string };
export type TaskStatus = 'queued' | 'running' | 'completed' | 'failed' | 'cancelled';
export type AgentProfile = { automation?: { policyId: string }; id: string; name: string; instructions: string; avatarId?: string; connectionId: string; model: string; effort?: string; connections?: AgentConnection[]; workspacePath?: string; createdAt: string; updatedAt: string };
export type AgentDraft = Omit<AgentProfile, 'id' | 'createdAt' | 'updatedAt'> & { id?: string };
export type TeamProfile = { creation?: {requestId: string; inputHash: string; leaderAgentId: string; policyId: string}; autonomous?: boolean; id: string; name: string; instructions: string; topic?: string; leaderAgentId?: string; policies?: string; memberAgentIds: string[]; rounds: number; createdAt: string; updatedAt: string };
export type TeamDraft = Omit<TeamProfile, 'id' | 'createdAt' | 'updatedAt' | 'creation'> & { id?: string; leaderMode?: 'existing' | 'automatic'; requestId?: string; projectBrief?: string; workspacePath?: string };
export type TeamStep = { sessionId: string; agentId: string; agentName: string; round: number; kind: 'plan' | 'work' | 'summary'; task?: string; taskKind?: 'routine' | 'standard' | 'complex'; connections?: AgentConnection[]; parentSessionId?: string; status: TaskStatus | 'pending' };
export type TeamMessage = { id: string; fromAgentId?: string; fromAgentName: string; toAgentId?: string; text: string; kind: 'user' | 'agent' | 'result' | 'system'; sessionId?: string; createdAt: string };
export type TeamRunSummary = { autonomous?: boolean; id: string; previousRunId?: string; teamId: string; teamName: string; goal: string; topic?: string; leaderAgentId?: string; policies?: string; status: TaskStatus; rounds: number; createdAt: string; updatedAt: string; members: { id: string; name: string }[]; steps: TeamStep[]; finalSessionId?: string; messageCount: number; error?: string };
export type TeamRun = TeamRunSummary & { messages: TeamMessage[] };
export type Session = { routeSelection?: AgentPolicySelection; id: string; purpose?: 'avatar'; title: string; connectionId: string; model: string; effort?: string; connections?: AgentConnection[]; agentId?: string; agentName?: string; teamRunId?: string; teamStepIndex?: number; taskStatus?: TaskStatus; queuedPrompt?: string; createdAt: string; updatedAt: string; workspacePath?: string; messages: Message[] };
export type UpdateProgress = {
  stage: 'checking' | 'verifying-current' | 'verifying-archive' | 'copying-archive' | 'extracting' | 'verifying-package' | 'backing-up' | 'preparing-restart' | 'awaiting-quit';
  percent?: number; completedBytes?: number; totalBytes?: number; startedAt: string; updatedAt: string;
};
export type UpdateStatus = { phase: 'development' | 'idle' | 'available' | 'installing' | 'error'; currentVersion: string; version?: string; error?: string; progress?: UpdateProgress };
export type State = { rabbitConnections?: RabbitProfile[]; rabbitRuns?: RabbitRunRecord[]; actionRules?: ActionRules; policies?: AgentPolicy[]; avatarJobs?: AvatarJob[]; update?: UpdateStatus; profiles: Profile[]; agents: AgentProfile[]; teams?: TeamProfile[]; teamRuns?: TeamRunSummary[]; sessions: Session[]; queue: { running: string[]; queued: string[] }; activeRun: { sessionId: string } | null; unsavedSessionIds?: string[]; unsavedTeamRunIds?: string[]; unsavedRabbitRunIds?: string[]; version: string };
export type Auth = { installed?: boolean; phase: string; authenticated: boolean; inferenceVerified: boolean; credentialStorage?: 'session' | 'keyring' | 'provider-managed'; account?: { email?: string | null; plan?: string | null } | null; error?: string | null };
export type UiEvent =
  | { type: 'rabbit'; rabbitConnections: RabbitProfile[]; rabbitRuns: RabbitRunRecord[] }
  | { type: 'action-rules'; rules: ActionRules }
  | { type: 'policies'; policies: AgentPolicy[] }
  | { type: 'avatar-job'; job: AvatarJob }
  | { type: 'update'; update: UpdateStatus }
  | { type: 'session'; session: Session }
  | { type: 'storage'; unsavedSessionIds: string[]; unsavedTeamRunIds?: string[]; unsavedRabbitRunIds?: string[] }
  | { type: 'team-run'; run: TeamRunSummary }
  | { type: 'teams'; teams: TeamProfile[]; agents: AgentProfile[] }
  | { type: 'delta'; sessionId: string; messageId: string; delta: string }
  | { type: 'run-end'; sessionId: string; error?: string }
  | ({ type: 'tool-status'; sessionId: string; messageId: string } & ToolStatus)
  | ({ type: 'tool-approval' } & Approval)
  | { type: 'tool-approval-end'; approvalId: string }
  | { type: 'auth'; provider: string; status: Auth };
export type QueueEvent = { type: 'queue'; running: string[]; queued: string[] };

export const maxAgentConnections = 8;
/** Older saved agents and tasks retain their single connection as first priority. */
export function connectionRoutes(value: AgentConnection & { connections?: AgentConnection[] }): AgentConnection[] {
  return value.connections?.length ? value.connections : [{ connectionId: value.connectionId, model: value.model, ...(value.effort ? { effort: value.effort } : {}) }];
}

export function withAgentConnections(draft: AgentDraft, connections: AgentConnection[]): AgentDraft {
  const first = connections[0] ?? { connectionId: '', model: '' };
  return { ...draft, connectionId: first.connectionId, model: first.model, effort: first.effort, connections };
}

export function moveAgentConnection(connections: AgentConnection[], index: number, offset: -1 | 1): AgentConnection[] {
  const target = index + offset;
  if (index < 0 || index >= connections.length || target < 0 || target >= connections.length) return connections;
  const next = [...connections];
  [next[index], next[target]] = [next[target]!, next[index]!];
  return next;
}

/** Different models/efforts on the same provider are distinct fallback routes. */
export function duplicateConnectionIndex(connections: AgentConnection[]): number {
  const seen = new Set<string>();
  return connections.findIndex(route => {
    if (!route.connectionId || !route.model) return false;
    const key = JSON.stringify([route.connectionId, route.model, route.effort ?? '']);
    if (seen.has(key)) return true;
    seen.add(key); return false;
  });
}

/** Only the matching live message may receive streamed updates. */
export function reduceStateEvent(state: State, event: UiEvent | QueueEvent): State {
  if (event.type === 'rabbit') return { ...state, rabbitConnections: event.rabbitConnections, rabbitRuns: event.rabbitRuns };
  if (event.type === 'action-rules') return { ...state, actionRules: event.rules };
  if (event.type === 'policies') return { ...state, policies: event.policies };
  if (event.type === 'avatar-job') return { ...state, avatarJobs: mergeAvatarJob(state.avatarJobs, event.job) };
  if (event.type === 'update') return { ...state, update: event.update };
  if (event.type === 'teams') return { ...state, teams: event.teams, agents: event.agents };
  if (event.type === 'team-run') return { ...state, teamRuns: [event.run, ...(state.teamRuns ?? []).filter(run => run.id !== event.run.id)] };
  if (event.type === 'storage') return { ...state, unsavedSessionIds: [...new Set(event.unsavedSessionIds)], unsavedTeamRunIds: [...new Set(event.unsavedTeamRunIds ?? [])], unsavedRabbitRunIds: [...new Set(event.unsavedRabbitRunIds ?? [])] };
  if (event.type === 'queue') return { ...state, queue: { running: event.running, queued: event.queued }, activeRun: event.running[0] ? { sessionId: event.running[0] } : null };
  if (event.type === 'session') return { ...state, sessions: [event.session, ...state.sessions.filter(session => session.id !== event.session.id)] };
  if (event.type === 'run-end') return state.activeRun?.sessionId === event.sessionId ? { ...state, activeRun: null } : state;
  if (event.type !== 'delta' && event.type !== 'tool-status') return state;
  return { ...state, sessions: state.sessions.map(session => session.id !== event.sessionId ? session : {
    ...session, messages: session.messages.map(message => {
      if (message.id !== event.messageId || message.status !== 'running') return message;
      if (event.type === 'delta') return { ...message, text: message.text + event.delta };
      const tool: ToolStatus = { callId: event.callId, name: event.name, status: event.status, ...(event.path ? { path: event.path } : {}), ...(event.summary ? { summary: event.summary } : {}) };
      const tools = message.tools ?? [];
      return { ...message, tools: tools.some(item => item.callId === tool.callId) ? tools.map(item => item.callId === tool.callId ? tool : item) : [...tools, tool] };
    }),
  }) };
}

export function reduceApprovalEvent(approvals: Approval[], event: UiEvent | QueueEvent): Approval[] {
  if (event.type === 'tool-approval') return approvals.some(item => item.approvalId === event.approvalId) ? approvals : [...approvals, event];
  if (event.type === 'tool-approval-end') return approvals.filter(item => item.approvalId !== event.approvalId);
  if (event.type === 'run-end') return approvals.filter(item => item.sessionId !== event.sessionId);
  return approvals;
}

export function sessionInProgress(state: State, sessionId: string): boolean {
  return state.activeRun?.sessionId === sessionId || (state.queue?.running.includes(sessionId) ?? false) || (state.queue?.queued.includes(sessionId) ?? false);
}

export function sessionsForAgent(sessions: Session[], agentId: string): Session[] {
  return sessions.filter(session => session.agentId === agentId).sort((left, right) => right.updatedAt.localeCompare(left.updatedAt));
}

/** Team-managed work and profile generation must never become an agent's default chat. */
export function latestAgentConversation(sessions: Session[], agentId: string): Session | undefined {
  return sessionsForAgent(sessions, agentId).find(session => !session.teamRunId && session.purpose !== 'avatar');
}

export function latestTeamConversation(runs: TeamRunSummary[], teamId: string): TeamRunSummary | undefined {
  return runs.filter(run => run.teamId === teamId).sort((a, b) => b.updatedAt.localeCompare(a.updatedAt))[0];
}

/** Follow explicit continuation links, never mix independent goals or another team's history. */
export function teamConversationHistory(runs: TeamRunSummary[], selectedId: string): TeamRunSummary[] {
  const history: TeamRunSummary[] = [], seen = new Set<string>();
  let run = runs.find(item => item.id === selectedId);
  const teamId = run?.teamId;
  while (run && run.teamId === teamId && !seen.has(run.id) && history.length < 30) {
    history.unshift(run); seen.add(run.id);
    run = run.previousRunId ? runs.find(item => item.id === run!.previousRunId) : undefined;
  }
  return history;
}

export function teamContinuationId(runs: TeamRunSummary[], selected?: TeamRunSummary): string | undefined {
  if (!selected) return undefined;
  if (selected.status === 'completed') return selected.id;
  const seen = new Set([selected.id]);
  let previousId = selected.previousRunId, completedId: string | undefined;
  while (previousId) {
    if (seen.has(previousId)) return undefined;
    const previous = runs.find(run => run.id === previousId);
    if (!previous || previous.teamId !== selected.teamId) return undefined;
    seen.add(previous.id);
    if (!completedId && previous.status === 'completed') completedId = previous.id;
    previousId = previous.previousRunId;
  }
  return completedId;
}

/** Internal image-generation transcripts remain available only when recovery is needed. */
export function visibleHistorySessions(state: Pick<State, 'sessions' | 'unsavedSessionIds'>): Session[] {
  const unsaved = new Set(state.unsavedSessionIds ?? []);
  return state.sessions.filter(session => session.purpose !== 'avatar' || unsaved.has(session.id)).sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
}

/** Keep the user's draft intact when a representative or another editor changes the team. */
export function teamEditConflict(draft: TeamDraft, expectedUpdatedAt: string, teams: TeamProfile[]): string | undefined {
  if (!draft.id) return undefined;
  const current = teams.find(team => team.id === draft.id);
  if (!current) return '편집 중인 팀이 삭제되었습니다. 입력한 내용은 이 화면에 남아 있습니다.';
  if (current.updatedAt !== expectedUpdatedAt) return '편집 중 팀 구성이 변경되었습니다. 입력한 내용을 확인한 뒤 최신 설정을 다시 불러오세요.';
  return undefined;
}

/** Drafts belong to one task or one agent's unsubmitted new task. */
export function composerDraftKey(sessionId: string, agentId: string): string {
  return sessionId ? `session:${sessionId}` : agentId ? `agent:${agentId}` : 'new-chat';
}

/** Follow a newly created task only when the user has not navigated elsewhere. */
export function promoteSubmittedDraft(drafts: Record<string, string>, sourceKey: string, targetKey: string, submitted: string, following: boolean): Record<string, string> {
  const next = { ...drafts, [targetKey]: following ? drafts[sourceKey] ?? submitted : submitted };
  if (following) delete next[sourceKey];
  return next;
}

/** A delayed send acknowledgement must never erase text typed since submission. */
export function clearSubmittedDrafts(drafts: Record<string, string>, keys: string[], submitted: string): Record<string, string> {
  const next = { ...drafts };
  for (const key of keys) if (next[key] === submitted) delete next[key];
  return next;
}

/** Agent CRUD changes no conversation, queue, storage, or credential state. */
export function mergeAgentSnapshot(state: State, snapshot: Pick<State, 'agents'>): State {
  return { ...state, agents: snapshot.agents };
}

/** Team settings responses must not replace live member sessions or run events. */
export function mergeTeamSnapshot(state: State, snapshot: Pick<State, 'teams'>): State {
  return { ...state, teams: snapshot.teams ?? [] };
}

/** Native events win over older or equal-timestamp mutation acknowledgements. */
export function mergeTeamRunResult(state: State, run: TeamRunSummary): State {
  const existing = state.teamRuns?.find(item => item.id === run.id);
  if (existing && existing.updatedAt >= run.updatedAt) return state;
  return reduceStateEvent(state, { type: 'team-run', run });
}

export function teamRunInProgress(run?: TeamRunSummary): boolean {
  return run?.status === 'queued' || run?.status === 'running';
}

export function teamDraftForRequest(draft: TeamDraft, agents: AgentProfile[]): TeamDraft {
  if (!draft.name.trim()) throw new Error('팀 이름을 입력하세요.');
  const automatic = !draft.id && draft.leaderMode === 'automatic';
  if (automatic && (!draft.projectBrief?.trim() || !draft.requestId)) throw new Error('프로젝트 내용을 입력하고 대표 자동 생성 방식을 다시 확인하세요.');
  if (!automatic && draft.memberAgentIds.length < 1) throw new Error('팀 대표로 사용할 에이전트를 한 명 이상 선택하세요.');
  if (new Set(draft.memberAgentIds).size !== draft.memberAgentIds.length) throw new Error('같은 에이전트를 중복 선택할 수 없습니다.');
  const availableIds = new Set(agents.map(agent => agent.id));
  if (draft.memberAgentIds.some(id => !availableIds.has(id))) throw new Error('삭제된 에이전트가 있습니다. 팀 멤버를 다시 선택하세요.');
  const leaderAgentId = draft.leaderAgentId || draft.memberAgentIds[0]!;
  if (!automatic && !draft.memberAgentIds.includes(leaderAgentId)) throw new Error('팀 멤버 중 대표를 선택하세요.');
  if (draft.autonomous !== undefined && typeof draft.autonomous !== 'boolean') throw new Error('대표 자율주행 설정이 올바르지 않습니다.');
  return { ...draft, ...(automatic ? {projectBrief: draft.projectBrief!.trim()} : {}), autonomous: automatic || draft.autonomous === true, name: draft.name.trim(), instructions: draft.instructions.trim(), topic: (draft.topic ?? '').trim(), policies: (draft.policies ?? '').trim(), leaderAgentId, rounds: 1, memberAgentIds: [...draft.memberAgentIds] };
}

export function moveTeamMember(ids: string[], index: number, offset: -1 | 1): string[] {
  const target = index + offset;
  if (index < 0 || index >= ids.length || target < 0 || target >= ids.length) return ids;
  const next = [...ids]; [next[index], next[target]] = [next[target]!, next[index]!]; return next;
}

/** Batch only streamed text. Every non-delta is an ordering barrier and flushes first. */
export class UiEventBatcher {
  private pending: Extract<UiEvent, { type: 'delta' }>[] = [];
  private cancelScheduled?: () => void;
  constructor(private readonly apply: (events: (UiEvent | QueueEvent)[]) => void, private readonly schedule: (flush: () => void) => () => void = flush => {
    const timer = setTimeout(flush, 40); return () => clearTimeout(timer);
  }) {}
  push(event: UiEvent | QueueEvent): void {
    if (event.type !== 'delta') { this.flush(); this.apply([event]); return; }
    const previous = this.pending.at(-1);
    if (previous?.sessionId === event.sessionId && previous.messageId === event.messageId) previous.delta += event.delta;
    else this.pending.push({ ...event });
    if (!this.cancelScheduled) this.cancelScheduled = this.schedule(() => this.flush());
  }
  flush(): void {
    this.cancelScheduled?.(); this.cancelScheduled = undefined;
    if (!this.pending.length) return;
    const events = this.pending; this.pending = []; this.apply(events);
  }
  dispose(): void { this.flush(); }
}

export function needsAuthPolling(auth: Record<string, Auth>): boolean {
  return Object.values(auth).some(status => status.phase === 'preparing' || status.phase === 'awaiting-browser');
}

export function credentialStorageNote(provider: string, storage: Auth['credentialStorage']): string {
  if (provider !== 'codex') return 'Claude 로그인 정보는 벤디트봇 전용 인증 영역에서 공식 CLI가 관리합니다.';
  if (storage === 'session') return '현재 실행 모드는 로그인 정보를 세션 동안만 유지합니다. 앱을 다시 실행하면 다시 로그인하세요.';
  return 'Codex 로그인은 벤디트봇 전용 macOS 키체인에 저장되어 앱 재실행 후 복원됩니다. 키체인 접근이 거부되면 연결을 완료하지 않습니다.';
}

export function shouldSendOnEnter(event: { key: string; shiftKey: boolean; isComposing?: boolean; keyCode?: number }): boolean {
  return event.key === 'Enter' && !event.shiftKey && !event.isComposing && event.keyCode !== 229;
}

/** Refresh errors must not hide the failed test/login's actual error. */
export async function refreshAfter<T>(operation: () => Promise<T>, refresh: () => Promise<unknown>): Promise<T> {
  let result: T;
  try { result = await operation(); }
  catch (error) { await refresh().catch(() => {}); throw error; }
  await refresh(); return result;
}

/** A response started before a native event or local edit cannot replace newer UI state. */
export class SnapshotClock {
  private revision = 0;
  private request = 0;
  private cancelRetry?: () => void;
  changed(): void { this.revision++; }
  cancel(): void { this.request++; this.cancelRetry?.(); }
  async read<T>(load: () => Promise<T>, apply: (value: T) => void, retryOnChange = false): Promise<T> {
    this.cancel();
    const request = this.request;
    for (;;) {
      const before = this.revision;
      const result = await load();
      if (request !== this.request) return result;
      if (before === this.revision) { apply(result); return result; }
      if (!retryOnChange) return result;
      // A discarded cold-start response has no complete predecessor to retain.
      // Re-read the whole snapshot; never merge stale fields over newer events.
      // Yield between attempts so sustained streams cannot create an IPC spin.
      await new Promise<void>(resolve => {
        const finish = () => { clearTimeout(timer); this.cancelRetry = undefined; resolve(); };
        const timer = setTimeout(finish, 32);
        this.cancelRetry = finish;
      });
      if (request !== this.request) return result;
    }
  }
}
