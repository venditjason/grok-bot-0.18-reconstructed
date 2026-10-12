import { app, BrowserWindow, ipcMain, Menu, safeStorage, shell, dialog, nativeImage } from 'electron';
import { existsSync, readFileSync, writeFileSync, lstatSync, renameSync, unlinkSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { randomUUID } from 'node:crypto';
import { PRODUCT_IDENTITY } from '../shared/product-identity.js';
import { resolveVenditBotPaths, ensureVenditBotDirectories } from '../shared/node/venditbot-paths.js';
import { SandSettingsStore } from '../shared/node/settings/sand-settings-store.js';
import { apiProfileSecretKey, normalizeApiProviderProfile, type ApiProviderProfile } from '../shared/api-provider-config.js';
import { streamApiProvider, validateApiProviderConnection } from '../host/extensions/inference/api-provider-transport.js';
import { configureProviderAuthRuntime, beginProviderLogin, getProviderAuthStatus, cancelProviderLogin, disconnectProvider, testProviderConnection, shutdownProviderAuthRuntime, shutdownProviderAuthRuntimeForUpdate, runCodexTurn, runClaudeTurn, listProviderModels, type LoginProvider } from '../shared/node/provider-auth-runtime.js';
import {FeedbackTools, FEEDBACK_TOOL_POLICY, explicitAppFeedbackRequest} from './feedback-tools.js';
import {FeedbackMainAdapter} from './feedback-main-adapter.js';
import {feedbackGithubInput, feedbackGithubProofResponse} from './feedback-github-proof.js';
import type {FeedbackBinding} from '../shared/feedback.js';
import {ChatAttachmentStore} from './chat-attachments.js';
import type {ChatAttachment} from '../shared/chat-attachments.js';
import { LocalSessionStore, EncryptedSecretStore, safeError, completedHistory, sessionMarkdown, connectionRoutes, connectionRouteKey, validConnections, type ConnectionRoute, type ConnectionAttempt, type ChatSession, type ChatMessage, type ToolRecord } from './local-store.js';
import { WORKSPACE_TOOLS, WORKSPACE_DEVELOPMENT_POLICY, sensitiveWorkspaceContent, WorkspaceExecutor, normalizeWorkspace, startMcpGateway, type WriteApproval, type ActionApprovalRequest, type McpGateway } from './workspace-tools.js';
import { AgentStore, type AgentProfile } from './agent-store.js';
import {ChatTurnQueue} from './chat-turn-queue.js';
import { TaskQueue } from './task-queue.js';
import { TeamStore, activeTeamRun } from './team-store.js';
import { TeamCoordinator } from './team-coordinator.js';
import { AvatarStore, avatarInstructions, parseAvatarResponse } from './agent-avatar.js';
import { generateCodexAvatarImage } from '../shared/node/codex-avatar-image.js';
import { randomDefaultAvatarScene } from './default-avatar.js';
import { startQuitWatchdog } from './quit-watchdog.js';
import { recommendRoutineConnections } from './delegation-policy.js';
import type { ProviderModel } from '../shared/provider-model-catalog.js';
import { LocalUpdater } from './local-updater.js';
import {AutomaticTeamCreator, recoverAutomaticTeamCreation} from './automatic-team.js';
import {PolicyStore} from './policy-store.js';
import {RoutineStore} from './routine-store.js';
import {RoutineScheduler} from './routine-scheduler.js';
import {RoutineHost} from './routine-host.js';
import {RoutineTools} from './routine-tools.js';
import {explicitRoutineMutation} from './routine-intent.js';
import {AppConnectorManager} from './app-connectors/manager.js';
import {AppConnectorTools} from './app-connectors/tools.js';
import {appConnectorId, type ConfigureAppConnectorInput} from '../shared/app-connectors.js';
import {normalizeRoutineInput, type SaveRoutineRequest} from '../shared/routines.js';
import {AvatarJobs} from './avatar-jobs.js';
import {varyAvatarScene, referenceAvatarImage} from './avatar-variation.js';
import {AgentManagementTools} from './agent-management-tools.js';
import {ActionRulesStore} from './action-rules-store.js';
import {RabbitStore} from './rabbit-store.js';
import {RabbitHost} from './rabbit-host.js';
import {RabbitTools} from './rabbit-tools.js';
import {normalizeRabbitConnectionDraft} from '../shared/rabbit-project-api.js';
import {evaluateActionRules} from '../shared/action-rules.js';
import {resolveAgentPolicy} from './agent-policy-resolver.js';
import {validDevelopmentBinding, assertDevelopmentWriteAllowed, developmentInstructions, type DevelopmentBinding} from '../shared/development-routing.js';
import {boundPolicyHistory, efficiencyInstructions, policyEfficiencyPreset} from './policy-efficiency.js';
import {normalizeAgentPolicyDraft, normalizePolicyConnections, type AgentPolicy, type AgentPolicySelection, type TaskKind} from '../shared/agent-policy.js';

const metadata = JSON.parse(readFileSync(join(app.getAppPath(), 'package.json'), 'utf8')) as {venditbotDevelopment?: boolean; version?: string};
const productVersion = typeof metadata.version === 'string' ? metadata.version : '0.2.0';
const paths = resolveVenditBotPaths({ development: !app.isPackaged || metadata.venditbotDevelopment === true });
ensureVenditBotDirectories(paths);
app.setName(paths.development ? PRODUCT_IDENTITY.developmentName : PRODUCT_IDENTITY.displayName);
app.setPath('userData', paths.profileRoot);
app.setPath('sessionData', paths.rendererDataRoot);
app.setAppLogsPath(paths.logsRoot);
// Acquire before opening stores: recovery must never mutate another running instance.
if (!app.requestSingleInstanceLock()) app.quit();
else {
const runtimeRoot = join(app.isPackaged ? process.resourcesPath : app.getAppPath(), 'runtimes');
const codexExecutable = join(runtimeRoot, 'codex', 'bin', 'codex');
const claudeExecutable = join(runtimeRoot, 'claude', 'claude');
configureProviderAuthRuntime({ paths,
  ...(existsSync(codexExecutable) ? { codexExecutable } : {}),
  ...(existsSync(claudeExecutable) ? { claudeExecutable } : {}),
  claudeLoginPolicy: { mode: 'personal-local' },
});
recoverAutomaticTeamCreation(paths.profileRoot);
const settings = new SandSettingsStore(join(paths.profileRoot, 'settings.json'), {failOnCorrupt: true});
const sessions = new LocalSessionStore(paths.profileRoot);
const chatAttachments = new ChatAttachmentStore(paths.profileRoot);
const agents = new AgentStore(paths.profileRoot);
const policies = new PolicyStore(paths.profileRoot);
const actionRules = new ActionRulesStore(paths.profileRoot);
const avatars = new AvatarStore(paths.profileRoot);
const secrets = new EncryptedSecretStore(paths.profileRoot, safeStorage);
const verifiedProfiles = new Set<string>();
const selectedWorkspaces = new Set<string>();
// If the disk becomes unavailable, keep the terminal answer exportable until quit.
const unsavedSessions = new Map<string, ChatSession>();
// Disk writes are batched while streaming. Reads must use the current in-memory
// conversation so a renderer refresh cannot replace received text with old JSON.
// Entries exist only for an executing queue job and are removed on settlement.
const liveSessions = new Map<string, ChatSession>();
const approvals = new Map<string, (approved: boolean) => void>();
let window: BrowserWindow | null = null;
let releaseStartup!: () => void;
const startupGate = new Promise<void>(resolve => { releaseStartup = resolve; });
let startupFailure: string | undefined;
let activeRun: { sessionId: string; controller: AbortController } | null = null;
let testing = false;
let credentialMutation = false;
let quitting = false;
let quitPending = false;
let boundedQuitReady = false;
let quitWatchdogArmed = false;
let updatePending = false;
let pendingRequests = 0;
let updateTimer: ReturnType<typeof setInterval> | undefined;
let updateHandoff: Awaited<ReturnType<LocalUpdater['prepare']>> | undefined;
let cancellingUpdate = false;
const updateReadOnly = new Set(['state', 'getTeamRun', 'getAgentAvatar']);
const updater = new LocalUpdater({development: paths.development, currentVersion: productVersion,
  channelRoot: join(app.getPath('appData'), 'VenditBot Updates'), userDataRoot: paths.dataRoot, profileId: paths.profileId,
  appPath: dirname(dirname(dirname(process.execPath))), executable: process.execPath,
  helperPath: join(app.isPackaged ? process.resourcesPath : app.getAppPath(), 'updater-helper.cjs'), onChange: update => emit({type: 'update', update}),
});
let unsavedTeamRunIds: string[] = [];
let unsavedRabbitRunIds: string[] = [];
let approvalTail: Promise<unknown> = Promise.resolve();
let teams: TeamCoordinator;
let routineHost: RoutineHost;
let routineError: string | undefined;
const routines = new RoutineStore(paths.profileRoot, {onChange: routines => emit({type: 'routines', routines})});
const avatarJobs = new AvatarJobs(sessions.list(), job => emit({type: 'avatar-job', job}));
const jobHooks = new Map<string, {started(): void; settled(session: ChatSession, error?: unknown): void}>();
const teamStore = new TeamStore(paths.profileRoot, ids => { unsavedTeamRunIds = ids; emitStorage(); });
const rabbitStore = new RabbitStore(paths.profileRoot, ids => {unsavedRabbitRunIds = ids; emitStorage();});
const rabbit = new RabbitHost({store: rabbitStore, secrets, authorize: authorizeAction, changed: emitRabbit,
  assertMutable: ownSecretMutation => {
    if (quitting || quitPending || updatePending) throw new Error('종료 또는 업데이트 중에는 프로젝트 API 요청을 시작할 수 없습니다.');
    if (credentialMutation && !ownSecretMutation) throw new Error('API 키 저장을 마친 뒤 프로젝트 요청을 시작하세요.');
  },
});

const feedbackProofControllers = new Set<AbortController>();
const feedback = new FeedbackMainAdapter({root: paths.profileRoot, agents, sessions, rabbit, rabbitStore,
  defaultRoute: () => agents.list().flatMap(agent => connectionRoutes(agent))[0] ?? settings.getApiProviderProfiles().map(p => ({connectionId:p.id,model:p.model}))[0],
  assertMutable: () => {if (quitting || quitPending || updatePending || credentialMutation) throw new Error('종료·업데이트·보안 저장 중에는 리포트 실행을 시작할 수 없습니다.');},
  verifyRabbitMerge: async (job, run) => {
    const input = feedbackGithubInput(job, run); if (!input) return;
    const controller = new AbortController(); feedbackProofControllers.add(controller);
    const timer = setTimeout(() => controller.abort(), 60_000); timer.unref();
    try {
      const tools = new AppConnectorTools({list: () => appConnectors.list(), grantRevision: id => appConnectors.grantRevision(id), read: (request, signal) => appConnectors.read(request, signal),
        authorizeRead: (id, operation, args) => authorizeAction({path:'.',operation:'read',tool:'read_connected_app',category:'sensitive_disclosure',
          reason:'리포트의 동일 PR·커밋 테스트와 실제 병합 여부를 GitHub에서 읽기 전용으로 확인합니다.',preview:JSON.stringify({app:id,operation,args}).slice(0,4000)},controller.signal,job.sessionId),
      },controller.signal);
      return feedbackGithubProofResponse(await tools.execute('read_connected_app',{id:'github',operation:'read_feedback_pr_verification',args:input},'feedback-proof-'+randomUUID()));
    } finally {clearTimeout(timer);controller.abort();feedbackProofControllers.delete(controller);}
  },
  isSessionBusy: id => liveSessions.has(id) || unsavedSessions.has(id) || taskQueue.state().running.includes(id) || taskQueue.state().queued.includes(id),
  changed: snapshot => emit({type:'feedback',snapshot}),
});

const appConnectors = new AppConnectorManager({root: paths.profileRoot, secrets, openExternal: url => shell.openExternal(url),
  changed: () => emit({type: 'app-connectors-changed', appConnectors: appConnectors.list()}),
  assertMutable: ownSecretMutation => {
    if (quitting || quitPending || updatePending) throw new Error('종료 또는 업데이트 중에는 앱 연결을 변경할 수 없습니다.');
    if (credentialMutation) throw new Error('보안 저장소 변경이 끝난 뒤 다시 시도하세요.');
  },
});
let chatTurns: ChatTurnQueue | undefined;
const taskQueue = new TaskQueue({maxQueued: 16,
  onChange: snapshot => { emit({type: 'queue', ...snapshot}); teams?.schedule(); chatTurns?.schedule(); },
  onError: (sessionId, error) => {
    if (activeRun?.sessionId === sessionId) activeRun = null;
    const message = safeError(error);
    try { const session = readSession(sessionId); session.taskStatus = 'failed'; for (const item of session.messages) if (item.status === 'running') {item.status = 'failed'; item.error = message;} try {saveSession(session);} catch {} emit({type: 'session', session}); } catch {}
    emit({type: 'run-end', sessionId, error: message});
  },
});
chatTurns = new ChatTurnQueue(paths.profileRoot, {
  canRun: () => !quitPending && !quitting && !updatePending && !credentialMutation,
  state: () => taskQueue.state(),
  start: (turn, hooks) => {enqueueSession(turn.sessionId, turn.text, {
    started: hooks.started,
    settled: (session, error) => hooks.settled(session.taskStatus ?? 'failed', error),
  }, run, turn.attachments);},
  cancel: cancelSession,
  changed: (turns, error) => emit({type: 'chat-turns', turns, ...(error ? {error} : {})}),
});
teams = new TeamCoordinator(teamStore, {
  createSessions: run => {
    const existing = new Set(sessions.list().map(s => s.id));
    const prepared = run.steps.flatMap((step, index) => {
      if (existing.has(step.sessionId)) return [];
      const member = run.memberSnapshots.find(a => a.id === step.agentId)!, connections = structuredClone(step.connections ?? connectionRoutes(member)), first = connections[0]!;
      const policy = run.policySnapshots?.find(p => p.agentId === member.id)?.policy;
      return [{id: step.sessionId, title: `${run.teamName} · ${member.name} · ${step.kind === 'summary' ? '최종 종합' : step.kind === 'plan' ? `${step.round}차 계획` : '위임 작업'}`.slice(0, 200), ...first, connections,
        ...(run.development ? {development: structuredClone(run.development)} : {}),
        agentId: member.id, agentName: member.name, instructions: member.instructions, ...(member.workspacePath ? {workspacePath: member.workspacePath} : {}), teamRunId: run.id, teamStepIndex: index,
        ...(step.routeSelection ? {routeSelection: step.routeSelection} : policy && !step.connections ? {policySnapshot: policy, policyAllowedConnections: connectionRoutes(member), policyTaskText: run.goal} : {}),
        createdAt: run.createdAt, updatedAt: run.createdAt, messages: []}];
    });
    if (prepared.length) sessions.createPrepared(prepared);
  },
  enqueue: enqueueSession, cancelSession, getSession: readSession, queueState: () => taskQueue.state(), changed: run => {emit({type: 'team-run', run}); routineHost?.teamChanged(run);},
  listAgents: () => agents.list(), listModels: listTeamModels, resolveDelegation, cloneAgent: (template, changes) => {
    const {id: _id, createdAt: _created, updatedAt: _updated, avatarId: _avatar, ...configuration} = template;
    return agents.save({...configuration, ...changes, avatarId: createDefaultAvatar()});
  }, removeAgent: (id, expectedUpdatedAt) => agents.remove(id, expectedUpdatedAt),
  renameAgent: renameSavedAgent,
  policyForAgent: member => member.automation ? policies.get(member.automation.policyId) : undefined,
  teamChanged: () => { emit({type: 'teams', teams: teamStore.listTeams(), agents: agents.list()}); },
});
routineHost = new RoutineHost({sessions, agents, teams: teamStore, coordinator: teams, queue: () => taskQueue.state(), enqueue: enqueueSession,
  unavailable: () => quitting || quitPending || updatePending || credentialMutation || testing || appConnectors.isBusy(),
});
const routineScheduler = new RoutineScheduler(routines, routineHost, {onError: reportRoutineError});
function reportRoutineError(error: unknown): void {routineError = safeError(error); emit({type: 'routine-error', error: routineError});}
function startRoutines(): void {if (!quitting && !quitPending && !updatePending) {void routineScheduler.start().catch(reportRoutineError); feedback.host.start();}}
function saveRoutine(request: SaveRoutineRequest) {
  const input = normalizeRoutineInput(request.routine);
  if (!routineHost.validateTarget(input.target)) throw new Error('루틴의 에이전트 또는 팀을 선택하세요.');
  return routines.save({...request, routine: input});
}
function setRoutineEnabled(id: string, enabled: boolean, revision: number) {
  if (enabled) {
    const current = routines.get(id);
    if (!routineHost.validateTarget(current.target)) throw new Error('루틴의 실행 대상이 없습니다.');
    for (const old of routines.reservations().filter(r => r.routineId === id && r.status === 'unknown')) {
      if (routineHost.isTargetBusy(old.target)) throw new Error('이전 실행 대상의 진행 중인 작업을 확인한 뒤 다시 활성화하세요.');
    }
  }
  return routines.setEnabled(id, enabled, revision);
}
const automaticTeams = new AutomaticTeamCreator(paths.profileRoot, agents, policies, teamStore, {
  async catalogs(input) {
    assertIdle(); const revision = configurationRevision();
    const developmentRevision = developmentConfigurationRevision(input.development);
    const members = input.memberAgentIds.map(id => agents.get(id));
    if (input.workspacePath && !selectedWorkspaces.has(input.workspacePath)) throw new Error('폴더 선택 버튼으로 자동 대표의 작업 폴더를 선택하세요.');
    if (input.workspacePath) normalizeWorkspace(input.workspacePath);
    const apis = settings.getApiProviderProfiles().filter(p => p.capabilities.tools && verifiedProfiles.has(p.id) && secrets.has(apiProfileSecretKey(p)));
    const loginCatalogs = await Promise.all((['codex', 'claude-code'] as const).map(async connectionId => {
      try {if (!(await getProviderAuthStatus(connectionId)).authenticated) return; return {connectionId, models: (await listProviderModels(connectionId)).models};} catch {return;}
    }));
    const catalogs = [...loginCatalogs.filter((item): item is NonNullable<typeof item> => !!item), ...apis.map(p => ({connectionId: p.id, models: [{id: p.model, label: p.model, isDefault: true, efforts: []}]}))];
    // Recheck login after catalog discovery; a disconnected provider must not be saved as a working leader.
    const stillConnected = await Promise.all(catalogs.map(async c => c.connectionId !== 'codex' && c.connectionId !== 'claude-code' || (await getProviderAuthStatus(c.connectionId)).authenticated));
    if (stillConnected.some(value => !value)) throw new Error('모델 확인 중 로그인이 해제되었습니다. 연결을 확인하고 다시 시도하세요.');
    return {catalogs, assertCurrent() {
      assertIdle(); assertConfigurationCurrent(revision);
      assertDevelopmentConfigurationCurrent(input.development, developmentRevision);
      if (members.some(member => JSON.stringify(agents.get(member.id)) !== JSON.stringify(member))) throw new Error('모델 확인 중 초기 멤버 설정이 변경되었습니다. 다시 확인하세요.');
      if (apis.some(p => !verifiedProfiles.has(p.id) || !secrets.has(apiProfileSecretKey(p)))) throw new Error('모델 확인 중 API 연결 상태가 변경되었습니다. 다시 확인하세요.');
      if (input.workspacePath) normalizeWorkspace(input.workspacePath);
    }};
  }, createAvatar: id => avatars.save(randomDefaultAvatarScene(), id).id,
  changed() {emit({type: 'policies', policies: policies.list()}); emit({type: 'teams', teams: teamStore.listTeams(), agents: agents.list()});},
});
const rendererPath = join(app.getAppPath(), 'renderer', 'index.html');
const rendererUrl = pathToFileURL(rendererPath).href;

function emit(event: unknown): void { if (window && !window.isDestroyed()) window.webContents.send('venditbot:event', event); }
function emitStorage(): void { emit({type: 'storage', unsavedSessionIds: [...unsavedSessions.keys()], unsavedTeamRunIds, unsavedRabbitRunIds}); }
function emitRabbit(): void { emit({type: 'rabbit', rabbitConnections: rabbit.connections(), rabbitRuns: rabbitStore.listRuns()}); }
function object(value: unknown): Record<string, unknown> { if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('잘못된 요청입니다.'); return value as Record<string, unknown>; }
function string(value: unknown, max = 200): string { if (typeof value !== 'string' || value.length > max || value.includes('\0')) throw new Error('입력값을 확인하세요.'); return value; }
function provider(value: unknown): LoginProvider { if (value !== 'codex' && value !== 'claude-code') throw new Error('알 수 없는 로그인 공급자입니다.'); return value; }
function profile(id: string): ApiProviderProfile { const found = settings.getApiProviderProfiles().find(p => p.id === id); if (!found) throw new Error('API 연결을 찾을 수 없습니다.'); return found; }
function selectedDevelopment(value: unknown, previous?: DevelopmentBinding): DevelopmentBinding | undefined {
  if (value === undefined) return undefined;
  if (!validDevelopmentBinding(value)) throw new Error('개발을 맡길 Rabbit 프로젝트 설정을 확인하세요.');
  // Preserve an existing unavailable reference while editing other settings; execution stays fail-closed.
  if (previous?.connectionId !== value.connectionId) rabbitStore.getConnection(value.connectionId);
  return {mode: 'rabbit', connectionId: value.connectionId};
}
function readAvatar(id: string) { try { return avatars.get(id); } catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') throw new Error('프로필 이미지를 찾을 수 없습니다. 다시 생성하세요.'); throw error; } }
function pruneAvatars(): void { avatars.prune([...agents.list(), ...teamStore.listRuns().flatMap(r => r.memberSnapshots)].flatMap(a => a.avatarId ? [a.avatarId] : []).concat([...sessions.list(), ...unsavedSessions.values()].flatMap(s => s.avatarRequest?.assetId ? [s.avatarRequest.assetId] : []))); }
function createDefaultAvatar(): string {
  try { pruneAvatars(); return avatars.save(randomDefaultAvatarScene()).id; }
  catch (error) { throw new Error(`기본 프로필 그림을 저장하지 못해 새 에이전트를 만들지 않았습니다. ${safeError(error)}`); }
}
function renameSavedAgent(id: string, name: string, expectedUpdatedAt: string): AgentProfile {
  const previous = agents.get(id);
  if (previous.updatedAt !== expectedUpdatedAt) throw new Error('에이전트 설정이 변경되었습니다. 최신 설정을 확인하고 다시 요청하세요.');
  const saved = agents.save({...previous, name});
  emit({type: 'teams', teams: teamStore.listTeams(), agents: agents.list()}); return saved;
}
function hasConnectionReference(id: string): boolean {
  return sessions.list().some(session => session.policyAllowedConnections?.some(route => route.connectionId === id)) || [...sessions.list(), ...agents.list()].some(item => item.connectionId === id || connectionRoutes(item).some(route => route.connectionId === id)) || policies.list().some(p => p.rules.some(r => r.connections.some(c => c.connectionId === id))) || teamStore.referencesConnection(id);
}
function hasDevelopmentReference(id: string): boolean {
  return [...agents.list(), ...sessions.list(), ...unsavedSessions.values(), ...liveSessions.values(), ...teamStore.listTeams()].some(item => item.development?.connectionId === id)
    || teamStore.listRuns().some(run => run.development?.connectionId === id || run.memberSnapshots.some(member => member.development?.connectionId === id));
}
function developmentConfigurationRevision(binding: DevelopmentBinding | undefined): string | undefined {
  return binding ? JSON.stringify(rabbitStore.listConnections().find(connection => connection.id === binding.connectionId) ?? null) : undefined;
}
function assertDevelopmentConfigurationCurrent(binding: DevelopmentBinding | undefined, revision: string | undefined): void {
  if (developmentConfigurationRevision(binding) !== revision) throw new Error('모델 확인 중 개발 대상 Rabbit 연결이 변경되었습니다. 최신 연결을 확인한 뒤 다시 저장하세요.');
}
function assertIdle(): void { if (activeRun || taskQueue.state().running.length || taskQueue.state().queued.length || teamStore.activeRunCount() || avatarJobs.active().length || rabbit.isBusy() || feedback.host.isBusy() || appConnectors.isBusy() || testing) throw new Error('진행 중이거나 대기 중인 작업을 마치거나 중단한 뒤 다시 시도하세요.'); }
function configurationRevision(): string { return JSON.stringify(settings.getApiProviderProfiles()); }
function assertConfigurationCurrent(revision: string, previousAgent?: AgentProfile, ownCredentialMutation = false): void {
  if (quitPending || quitting || updatePending) throw new Error('종료 또는 업데이트 준비 중에는 설정을 저장할 수 없습니다.');
  if (credentialMutation && !ownCredentialMutation) throw new Error('API 키를 안전하게 저장하고 있습니다. 완료 후 다시 시도하세요.');
  if (revision !== configurationRevision()) throw new Error('모델 확인 중 API 연결 설정이 변경되었습니다. 최신 설정으로 다시 시도하세요.');
  if (previousAgent && JSON.stringify(agents.get(previousAgent.id)) !== JSON.stringify(previousAgent)) throw new Error('모델 확인 중 에이전트 설정이 변경되었습니다. 최신 설정을 다시 불러오세요.');
}
function readSession(id: string): ChatSession { return structuredClone(liveSessions.get(id) ?? unsavedSessions.get(id) ?? sessions.get(id)); }
function saveSession(session: ChatSession): void {
  try { sessions.save(session); if (unsavedSessions.delete(session.id)) emitStorage(); }
  catch (error) { unsavedSessions.set(session.id, structuredClone(session)); emitStorage(); throw error; }
}
function cancelSession(id: string): boolean {
  const queue = taskQueue.state();
  const waiting = queue.queued.includes(id) || (queue.running.includes(id) && activeRun?.sessionId !== id);
  const cancelled = taskQueue.abort(id);
  if (waiting && cancelled) {
    const session = readSession(id); session.taskStatus = 'cancelled';
    // Even a failed disk write must publish the recoverable cancellation state.
    try { saveSession(session); }
    finally { emit({type: 'session', session}); emit({type: 'run-end', sessionId: id}); settleJob(id, new DOMException('작업을 중단했습니다.', 'AbortError')); }
  }
  return cancelled;
}
function settleJob(id: string, error?: unknown): void { const hooks = jobHooks.get(id); jobHooks.delete(id); hooks?.settled(readSession(id), error); }
function state() {
  return { chatTurns: chatTurns?.snapshot(), chatTurnStorageError: chatTurns?.error(), feedback: feedback.host.snapshot(), appConnectors: appConnectors.list(), routines: routines.list(), routineError, version: productVersion, update: updater.state(), agents: agents.list(), policies: policies.list(), actionRules: actionRules.get(), avatarJobs: avatarJobs.list(), rabbitConnections: rabbit.connections(), rabbitRuns: rabbitStore.listRuns(), teams: teamStore.listTeams(), teamRuns: teams.summaries(), queue: taskQueue.state(), profiles: settings.getApiProviderProfiles().map(p => ({ ...p, hasKey: secrets.has(apiProfileSecretKey(p)), verified: verifiedProfiles.has(p.id) })), sessions: sessions.list().map(s => {const current = liveSessions.get(s.id) ?? unsavedSessions.get(s.id); return current ? structuredClone(current) : s;}), unsavedSessionIds: [...unsavedSessions.keys()], unsavedTeamRunIds, unsavedRabbitRunIds, usage: settings.getInferenceRouterUsage(), activeRun: activeRun ? { sessionId: activeRun.sessionId } : null };
}
function enqueueSession(sessionId: string, text: string, hooks?: {started(): void; settled(session: ChatSession, error?: unknown): void}, operation = run, attachments?:ChatAttachment[]): {started: boolean; queued: boolean; sessionId: string} {
  const session = readSession(sessionId), queue = taskQueue.state();
  if (queue.running.includes(sessionId) || queue.queued.includes(sessionId)) throw new Error('이 작업은 이미 실행 중이거나 대기 중입니다.');
  if (queue.queued.length >= 16) throw new Error('대기 작업은 최대 16개입니다. 기존 작업을 마치거나 중단하세요.');
  if (session.automation && !session.teamRunId) session.policySnapshot = policies.get(session.automation.policyId);
  const queuedAttachments=attachments ?? (session.teamRunId ? teams.attachmentsFor(sessionId) : []);if(queuedAttachments.length)session.queuedAttachments=queuedAttachments;else delete session.queuedAttachments; session.taskStatus = 'queued'; session.queuedPrompt = text; saveSession(session); emit({type: 'session', session});
  if (hooks) jobHooks.set(sessionId, hooks);
  const position = taskQueue.submit(sessionId, async signal => {
    const controller = new AbortController(), abort = () => controller.abort(); signal.addEventListener('abort', abort, {once: true}); if (signal.aborted) controller.abort();
    activeRun = {sessionId, controller}; let failure: unknown;
    try { hooks?.started(); await operation(sessionId, text, controller); }
    catch (error) { failure = error; throw error; }
    finally {
      signal.removeEventListener('abort', abort); if (activeRun?.controller === controller) activeRun = null;
      try { settleJob(sessionId, failure ?? (unsavedSessions.has(sessionId) ? new Error('작업 결과를 저장하지 못했습니다. 내보내기로 보관하세요.') : undefined)); }
      finally { liveSessions.delete(sessionId); feedback.host.sync(); }
    }
  });
  return {started: position === 'running', queued: position === 'queued', sessionId};
}
async function runAvatarImage(sessionId: string, text: string, controller: AbortController, ready: (asset: ReturnType<AvatarStore['get']>) => void, referenceImage?: {bytes: Uint8Array; mimeType: 'image/png'}): Promise<void> {
  const session = readSession(sessionId), now = new Date().toISOString(); liveSessions.set(sessionId, session); session.taskStatus = 'running'; delete session.queuedPrompt; session.title = 'AI 프로필 이미지 생성';
  const answer: ChatMessage = {id: randomUUID(), role: 'assistant', text: '', createdAt: now, status: 'running'};
  session.messages.push({id: randomUUID(), role: 'user', text, createdAt: now, status: 'completed'}, answer); saveSession(session); emit({type: 'session', session});
  try {
    const result = await generateCodexAvatarImage({executable: codexExecutable, paths, model: session.model, ...(session.effort ? {effort: session.effort} : {}), prompt: text, signal: controller.signal, ...(referenceImage ? {referenceImage} : {})});
    if (controller.signal.aborted) throw new DOMException('이미지 생성을 중단했습니다.', 'AbortError');
    settings.recordInferenceUsage('codex', result.usage);
    const decoded = nativeImage.createFromBuffer(Buffer.from(result.bytes)); if (decoded.isEmpty()) throw new Error('생성된 이미지를 읽을 수 없습니다.');
    const {width, height} = decoded.getSize(); if (width < 1 || height < 1 || width > 4096 || height > 4096) throw new Error('생성된 이미지의 해상도 한도를 초과했습니다.');
    const side = Math.min(width, height), normalized = decoded.crop({x: Math.floor((width - side) / 2), y: Math.floor((height - side) / 2), width: side, height: side}).resize({width: 512, height: 512, quality: 'best'}).toPNG();
    if (controller.signal.aborted) throw new DOMException('이미지 생성을 중단했습니다.', 'AbortError');
    const asset = avatars.saveImagePng(normalized); answer.status = 'completed'; answer.text = 'AI 프로필 이미지를 생성했습니다. 에이전트 편집 화면에서 미리 보기를 확인하고 저장하세요.'; ready(asset);
  } catch (error) { answer.status = controller.signal.aborted ? 'cancelled' : 'failed'; answer.error = safeError(error); }
  finally {
    controller.abort(); session.taskStatus = answer.status === 'running' ? 'failed' : answer.status;
    try { saveSession(session); }
    finally { emit({type: 'session', session}); emit({type: 'run-end', sessionId}); }
  }
}
function cancelAvatarRequest(requestId?: string): boolean {
  const job = avatarJobs.cancel(requestId); if (!job) return false;
  if (job.sessionId) cancelSession(job.sessionId);
  return true;
}
async function generateAvatar(args: Record<string, unknown>, options: {referenceImage?: {bytes: Uint8Array; mimeType: 'image/png'}; applyAsset?: (id: string) => string | undefined} = {}): Promise<ReturnType<AvatarStore['get']>> {
  const {job, signal} = avatarJobs.begin(args.requestId, args.ownerKey);
  let sessionId: string | undefined;
  try {
    if (job.ownerKey.startsWith('agent:')) {const owner = agents.get(job.ownerKey.slice(6)); if (args.agentId !== undefined && args.agentId !== owner.id) throw new Error('이미지 대상 에이전트가 일치하지 않습니다.');}
    else if (args.agentId !== undefined) throw new Error('새 에이전트 초안에는 기존 에이전트 ID를 지정할 수 없습니다.');
    const prompt = string(args.prompt, 4000).trim(); if (!prompt) throw new Error('캐릭터 설명을 입력하세요.');
    const mode = args.mode ?? 'illustration'; if (mode !== 'illustration' && mode !== 'image') throw new Error('지원하지 않는 프로필 이미지 방식입니다.');
    const revision = configurationRevision(), connectionId = string(args.connectionId); if (mode === 'image' && connectionId !== 'codex') throw new Error('AI 사진 생성은 Codex 연결에서 지원합니다. 다른 연결은 일러스트 모드를 선택하세요.');
    const chosen = await selection(connectionId, string(args.model ?? '').trim(), args.effort == null || args.effort === '' ? undefined : string(args.effort, 40));
    assertConfigurationCurrent(revision);
    if (signal.aborted) throw new DOMException('이미지 생성을 중단했습니다.', 'AbortError');
    if (job.ownerKey.startsWith('agent:')) agents.get(job.ownerKey.slice(6));
    pruneAvatars();
    const session = sessions.create(connectionId, chosen.model, undefined, chosen.effort, {instructions: avatarInstructions, purpose: 'avatar', avatarRequest: {...job, phase: 'queued'}}); sessionId = session.id;
    avatarJobs.update(job.requestId, {sessionId, phase: 'queued'});
    session.avatarRequest = avatarJobs.get(job.requestId); saveSession(session);
    let imageAsset: ReturnType<AvatarStore['get']> | undefined;
    return await new Promise((resolve, reject) => {
      try { enqueueSession(session.id, prompt, {started: () => {
        if (signal.aborted) throw new DOMException('이미지 생성을 중단했습니다.', 'AbortError');
        avatarJobs.update(job.requestId, {phase: 'running'});
      }, settled: (finished, error) => {
        let asset = imageAsset;
        try {
          // A committed raster stays recoverable even if transcript persistence failed.
          if (!asset) {
            if (error) throw error; const answer = finished.messages.at(-1);
            if (answer?.role !== 'assistant' || answer.status !== 'completed') throw new Error(answer?.error ?? '캐릭터 생성을 중단했습니다.');
            if (signal.aborted) throw new DOMException('이미지 생성을 중단했습니다.', 'AbortError');
            if (mode === 'image') throw new Error('생성된 이미지가 없습니다.');
            asset = avatars.save(parseAvatarResponse(answer.text));
          }
          let warning: string | undefined;
          try {warning = options.applyAsset?.(asset.id);} catch (error) {warning = `이미지는 저장했지만 복제본에 적용하지 못했습니다. ${safeError(error)}`;}
          finished.avatarRequest = avatarJobs.update(job.requestId, {phase: 'completed', assetId: asset.id, ...(warning ? {error: warning} : {})});
          try {saveSession(finished);} catch { /* The durable asset remains available; the storage banner guards its transcript. */ }
          resolve(asset);
        } catch (failure) {
          finished.avatarRequest = avatarJobs.update(job.requestId, {phase: signal.aborted || finished.taskStatus === 'cancelled' ? 'cancelled' : 'failed', error: safeError(failure)});
          try {saveSession(finished);} catch {}
          reject(failure);
        }
      }}, mode === 'image' ? (id, text, controller) => runAvatarImage(id, text, controller, asset => {imageAsset = asset;}, options.referenceImage) : run); }
      catch (error) {reject(error);}
    });
  } catch (error) {
    const current = avatarJobs.get(job.requestId);
    if (current.phase !== 'completed' && current.phase !== 'cancelled') {
      const record = avatarJobs.update(job.requestId, {phase: signal.aborted ? 'cancelled' : 'failed', error: safeError(error)});
      if (sessionId) {const session = readSession(sessionId); session.avatarRequest = record; if (!taskQueue.state().running.includes(sessionId) && !taskQueue.state().queued.includes(sessionId) && session.taskStatus === 'queued') session.taskStatus = signal.aborted ? 'cancelled' : 'failed'; try {saveSession(session);} catch {}}
    }
    throw error;
  }
}
async function selection(connectionId: string, model: string, effort?: string): Promise<{model: string; effort?: string}> {
  if (connectionId === 'codex' || connectionId === 'claude-code') {
    const catalog = await listProviderModels(connectionId);
    const selected = model ? catalog.models.find(m => m.id === model || m.resolvedId === model) : catalog.models.find(m => m.isDefault) ?? catalog.models[0];
    if (!selected) throw new Error('공급자 모델 목록을 새로고침하고 사용할 모델을 선택하세요.');
    if (effort && !selected.efforts.includes(effort)) throw new Error('선택한 모델에서 지원하지 않는 effort입니다.');
    model = selected.resolvedId ?? selected.id; effort ??= selected.defaultEffort;
  } else { const selected = profile(connectionId); model ||= selected.model; if (effort) throw new Error('이 API 연결은 effort 설정을 지원하지 않습니다.'); }
  if (/\s/.test(model)) throw new Error('공백 없는 모델 ID를 입력하세요.');
  return {model, ...(effort ? {effort} : {})};
}
async function selectedConnections(data: Record<string, unknown>): Promise<ConnectionRoute[]> {
  const raw = data.connections === undefined ? [data] : data.connections;
  if (!Array.isArray(raw) || raw.length < 1 || raw.length > 8) throw new Error('우선순위 연결은 1개부터 8개까지 지정하세요.');
  const routes: ConnectionRoute[] = [];
  for (const item of raw) {
    const route = object(item), connectionId = string(route.connectionId);
    const chosen = await selection(connectionId, string(route.model ?? '').trim(), route.effort == null || route.effort === '' ? undefined : string(route.effort, 40));
    routes.push({connectionId, ...chosen});
  }
  if (!validConnections(routes)) throw new Error('같은 연결·모델·추론 강도의 중복 우선순위를 제거하세요.');
  return routes;
}
type TeamCatalog = {connectionId: string; label: string; models: ProviderModel[]; warning?: string};
async function teamCatalogs(members: AgentProfile[]): Promise<TeamCatalog[]> {
  const ids = [...new Set(members.flatMap(member => connectionRoutes(member).map(route => route.connectionId)))];
  return Promise.all(ids.map(async connectionId => {
    try {
      if (connectionId === 'codex' || connectionId === 'claude-code') {
        if (!(await getProviderAuthStatus(connectionId)).authenticated) return {connectionId, label: connectionId, models: [], warning: '로그인되지 않아 모델 목록을 제공하지 않습니다.'};
        const catalog = await listProviderModels(connectionId);
        return {connectionId, label: connectionId, models: catalog.models.slice(0, 64).map(model => ({id: model.id, ...(model.resolvedId ? {resolvedId: model.resolvedId} : {}), label: model.label, isDefault: model.isDefault, efforts: [...model.efforts], ...(model.defaultEffort ? {defaultEffort: model.defaultEffort} : {})})), ...(catalog.models.length > 64 ? {warning: '목록은 앞 64개 모델로 제한했습니다.'} : catalog.warning ? {warning: catalog.warning} : {})};
      }
      const selected = profile(connectionId);
      return {connectionId, label: selected.name, models: [{id: selected.model, label: selected.model, isDefault: true, efforts: []}]};
    } catch (error) { return {connectionId, label: connectionId, models: [], warning: safeError(error)}; }
  }));
}
async function listTeamModels(members: AgentProfile[]) {
  const catalogs = await teamCatalogs(members);
  return {agents: members.map(member => ({id: member.id, name: member.name, connectionIds: [...new Set(connectionRoutes(member).map(route => route.connectionId))], routineRecommendation: recommendRoutineConnections(connectionRoutes(member), catalogs)})), connections: catalogs,
    notice: '실제 목록과 지원 effort를 사용합니다. 계정별 추론 권한과 가격은 보장하지 않습니다. 루틴 선호는 비용 선호 정책이며 자동 감시 일정을 생성하지 않습니다.'};
}
async function resolveDelegation(member: AgentProfile, options: {taskKind?: TaskKind; task?: string; policy?: AgentPolicy; connections?: ConnectionRoute[]}): Promise<{connections: ConnectionRoute[]; warning?: string; routeSelection?: AgentPolicySelection}> {
  const original = connectionRoutes(member);
  if (options.policy) {
    const chosen = resolveAgentPolicy({policy: options.policy, originalConnections: original, text: options.task ?? '', ...(options.taskKind ? {taskKind: options.taskKind} : {}), catalogs: await teamCatalogs([member]), ...(options.connections ? {explicitConnections: options.connections} : {})});
    return {connections: chosen.connections, routeSelection: chosen, ...(chosen.warning ? {warning: chosen.warning} : {})};
  }
  if (options.connections) {
    const allowed = new Set(original.map(route => route.connectionId));
    if (options.connections.some(route => !allowed.has(route.connectionId))) throw new Error('이 멤버가 이미 설정한 연결 안에서만 작업 모델을 선택할 수 있습니다.');
    const catalogs = await teamCatalogs([member]);
    for (const route of options.connections) {
      const catalog = catalogs.find(c => c.connectionId === route.connectionId);
      if (!catalog?.models.length) throw new Error(catalog?.warning ?? '연결의 모델 목록을 확인할 수 없습니다.');
      if (route.connectionId !== 'codex' && route.connectionId !== 'claude-code' && route.model !== catalog.models[0]!.id) throw new Error('API 연결은 현재 프로필에 지정된 모델만 위임할 수 있습니다.');
    }
    return {connections: await selectedConnections({connections: options.connections})};
  }
  return options.taskKind === 'routine' ? recommendRoutineConnections(original, await teamCatalogs([member])) : {connections: original};
}
async function policyChoice(policy: AgentPolicy, originalConnections: ConnectionRoute[], text: string, taskKind?: TaskKind): Promise<AgentPolicySelection> {
  const stamp = new Date().toISOString(), member: AgentProfile = {id: 'policy-preview', name: '정책 선택', instructions: '정책 선택', ...originalConnections[0]!, connections: originalConnections, createdAt: stamp, updatedAt: stamp};
  return resolveAgentPolicy({policy, originalConnections, text, ...(taskKind ? {taskKind} : {}), catalogs: await teamCatalogs([member])});
}
async function authStatus() {
  const entries = await Promise.all((['codex', 'claude-code'] as const).map(async p => {
    try { const { executablePath: _path, ...status } = await getProviderAuthStatus(p); return [p, status]; }
    catch (error) { return [p, { provider: p, phase: 'error', authenticated: false, inferenceVerified: false, error: safeError(error) }]; }
  }));
  return Object.fromEntries(entries);
}
function requestApproval(request: WriteApproval | ActionApprovalRequest, signal: AbortSignal, sessionId?: string): Promise<boolean> {
  return new Promise(resolve => {
    if (signal.aborted) {resolve(false); return;}
    const approvalId = randomUUID();
    const settle = (value: boolean) => {clearTimeout(timer); signal.removeEventListener('abort', abort); approvals.delete(approvalId); emit({type: 'tool-approval-end', approvalId}); resolve(value);};
    const abort = () => settle(false), timer = setTimeout(abort, 5 * 60_000);
    approvals.set(approvalId, settle); signal.addEventListener('abort', abort, {once: true});
    emit({type: 'tool-approval', approvalId, ...(sessionId ? {sessionId} : {}), ...request});
  });
}
function authorizeAction(request: ActionApprovalRequest, signal: AbortSignal, sessionId?: string, forceApproval = false): Promise<boolean> {
  const result = approvalTail.then(async () => {
    if (signal.aborted) throw new DOMException('작업을 중단했습니다.', 'AbortError');
    const before = actionRules.get(), decision = evaluateActionRules(before, request);
    if (decision.mode === 'deny') throw new Error(`규칙에 따라 작업을 차단했습니다. ${decision.reason}`);
    if (decision.mode === 'allow' && !forceApproval) return true;
    const approved = await requestApproval({...request, reason: [request.reason, decision.reason].filter(Boolean).join(' · ')}, signal, sessionId);
    if (!approved || signal.aborted) return false;
    const current = actionRules.get();
    if (current.updatedAt !== before.updatedAt && evaluateActionRules(current, request).mode !== 'allow') throw new Error('승인 대기 중 작업 규칙이 변경되었습니다. 새 규칙으로 다시 요청하세요.');
    return true;
  });
  approvalTail = result.catch(() => {}); return result;
}
async function run(sessionId: string, text: string, controller: AbortController): Promise<void> {
  const session = readSession(sessionId);
  liveSessions.set(sessionId, session);
  const attachments=session.queuedAttachments;delete session.queuedAttachments;
  session.taskStatus = 'running'; delete session.queuedPrompt;
  const now = new Date().toISOString();
  const user: ChatMessage = {...(attachments?.length?{attachments}:{}), id: randomUUID(), role: 'user', text, createdAt: now, status: 'completed' };
  const answer: ChatMessage = { id: randomUUID(), role: 'assistant', text: '', createdAt: now, status: 'running' };
  session.messages.push(user, answer);
  if (session.messages.length === 2 && !session.teamRunId) session.title = text.replace(/\s+/g, ' ').slice(0, 45);
  saveSession(session); emit({ type: 'session', session });
  let history = completedHistory(session, user.id);
  let finalized = false;
  let localFailure = false;
  const local = <T>(operation: () => T): T => { try { return operation(); } catch (error) { localFailure = true; throw error; } };
  const persist = () => local(() => saveSession(session));
  const approve = (request: WriteApproval | ActionApprovalRequest) => requestApproval(request, controller.signal, sessionId);
  const authorize = (request: ActionApprovalRequest) => authorizeAction(request, controller.signal, sessionId);
  const projectSource = {sessionId, ...(session.agentId ? {agentId: session.agentId} : {}), ...(session.teamRunId ? {teamRunId: session.teamRunId} : {})};
  const projectTaskText = () => {
    if (!session.teamRunId) return text;
    const request = teams.userTaskContext(sessionId);
    if (!request) throw new Error('현재 팀의 사용자 요청을 확인할 수 없습니다.');
    return [request.goal, ...request.userInstructions].join('\n\n');
  };
  const boundRecords = session.development ? rabbitStore.listRuns().filter(record => record.connectionId === session.development!.connectionId && record.source && (record.source.sessionId === sessionId || !!session.teamRunId && record.source.teamRunId === session.teamRunId && record.source.agentId === session.agentId)).map(record => ({id: record.id, phase: record.phase, state: record.detail?.state})).slice(0,100) : [];
  const projectInstructions = session.agentId && session.purpose !== 'avatar' ? (session.development ? `${developmentInstructions(session.development)}\n기존 원격 실행 기록(새 요청으로 반복하지 마세요): ${JSON.stringify(boundRecords)}` : rabbit.instructions(projectTaskText(), projectSource)) : '';
  let systemInstructions = [session.instructions, session.agentId && session.purpose !== 'avatar' ? FEEDBACK_TOOL_POLICY : '', session.workspacePath && session.purpose !== 'avatar' ? WORKSPACE_DEVELOPMENT_POLICY : '', projectInstructions].filter(Boolean).join('\n\n');
  const authorizeWorkspace = async (request: ActionApprovalRequest) => {
    if (request.operation === 'write') {assertDevelopmentWriteAllowed(session.development); rabbit.assertLocalWrite(projectTaskText(), projectSource);}
    const allowed = await authorize(request);
    if (request.operation === 'write') {assertDevelopmentWriteAllowed(session.development); rabbit.assertLocalWrite(projectTaskText(), projectSource);}
    return allowed;
  };
  let executor: WorkspaceExecutor | undefined;
  const teamTools = teams.tools(sessionId, controller.signal);
  const currentAgent = session.agentId && !session.teamRunId ? agents.list().find(a => a.id === session.agentId) : undefined;
  const projectTools = session.agentId && session.purpose !== 'avatar' ? new RabbitTools({
    connections: () => rabbit.connections().filter(c => c.hasKey && (!session.development || c.id === session.development.connectionId)),
    repositories: connection => rabbit.test(connection, controller.signal, true),
    start: (connection, input, requestId, source) => rabbit.start(connection.id, input, requestId, source, controller.signal),
    getRecord: id => rabbitStore.getRun(id), refresh: record => rabbit.refresh(record.id, controller.signal, true),
    authorizeRead: tool => authorize({path: '.', operation: 'read', tool, category: 'routine'}),
  }, {sessionId, agentId: session.agentId, ...(session.teamRunId ? {teamRunId: session.teamRunId} : {})}, controller.signal) : undefined;
  const routineRun = session.teamRunId ? teams.sessionRun(sessionId) : undefined;
  const routineTools = session.agentId && session.purpose !== 'avatar' ? new RoutineTools({
    list: () => {agents.get(session.agentId!); return routines.list();},
    save: input => {agents.get(session.agentId!); return saveRoutine(input);},
    setEnabled: (id, enabled, revision) => {agents.get(session.agentId!); return setRoutineEnabled(id, enabled, revision);},
    remove: (id, revision) => {agents.get(session.agentId!); return routines.remove(id, revision);},
    isCurrentTeamLeader: (agentId, teamId) => {
      const run = teams.sessionRun(sessionId), team = teamStore.listTeams().find(t => t.id === teamId);
      return !!run && activeTeamRun(run) && run.teamId === teamId && run.leaderAgentId === agentId && team?.leaderAgentId === agentId && run.activeMemberAgentIds.includes(agentId);
    },
    authorizeMutation: (name, args) => {
      const humanRequest = projectTaskText();
      const explicitRoutine = explicitRoutineMutation(name, humanRequest, args.enabled);
      const request = {path: '.', operation: 'manage' as const, tool: name, category: 'routine' as const,
        reason: '현재 에이전트 또는 팀의 향후 반복 일정을 변경합니다. 현재 실행은 유지됩니다.', preview: JSON.stringify(args).slice(0, 4000)};
      // Only the actual human instruction may authorize automatic scheduling.
      // Model-supplied userRequest is context for review, never authority.
      return authorizeAction(request, controller.signal, sessionId, !explicitRoutine);
    },
  }, {sessionId, agentId: session.agentId, ...(routineRun ? {teamId: routineRun.teamId} : {})}, controller.signal) : undefined;
  const connectorTools = session.agentId && session.purpose !== 'avatar' ? new AppConnectorTools({
    list: () => appConnectors.list(), grantRevision: id => appConnectors.grantRevision(id), read: (input, signal) => appConnectors.read(input, signal),
    authorizeRead: (id, operation, args) => authorize({path: '.', operation: 'read', tool: 'read_connected_app',
      category: id && operation !== 'list_read_tools' ? 'sensitive_disclosure' : 'routine',
      reason: id && operation !== 'list_read_tools' ? `${id}에서 조회한 자료가 현재 AI 연결로 전달됩니다.` : '연결된 앱의 읽기 도구를 확인합니다.',
      preview: JSON.stringify({app: id, operation, args}).slice(0, 4000)}),
  }, controller.signal) : undefined;
  const appFeedbackTools = session.agentId && session.purpose !== 'avatar' ? new FeedbackTools({
    existing: id => feedback.host.snapshot().jobs.find(job => job.id === id),
    submit: input => feedback.host.submit(input),
    authorizeSubmit: input => authorizeAction({path: '.', operation: 'manage', tool: 'submit_app_feedback', category: 'routine',
      ...(sensitiveWorkspaceContent(JSON.stringify(input)) ? {categories: ['sensitive_disclosure'], preview: '[민감정보 형태 감지 — 미리보기 숨김]'} : {preview: JSON.stringify(input).slice(0, 8000)}),
      reason: '벤디트봇 자체 버그·개선 요청을 기존 리포트 개발 경로에 저장합니다. 저장은 개발 완료가 아닙니다.',
    }, controller.signal, sessionId, !explicitAppFeedbackRequest(projectTaskText())),
  }, sessionId, answer.id, controller.signal) : undefined;
  const agentTools = currentAgent ? new AgentManagementTools({agentId: currentAgent.id, expectedUpdatedAt: currentAgent.updatedAt, renameAgent: renameSavedAgent, signal: controller.signal}) : undefined;
  const execute = async (definition: {name?: unknown}, args: unknown, callId: string): Promise<unknown> => {
    if (finalized || controller.signal.aborted) throw new DOMException('작업을 중단했습니다.', 'AbortError');
    if (typeof definition.name !== 'string') throw new Error('도구 이름을 확인하세요.');
    const isFeedbackTool = appFeedbackTools?.definitions.some(tool => tool.name === definition.name);
    const isTeamTool = teamTools?.definitions.some(tool => tool.name === definition.name);
    const isAgentTool = agentTools?.definitions.some(tool => tool.name === definition.name);
    const isProjectTool = projectTools?.definitions.some(tool => tool.name === definition.name);
    const isRoutineTool = routineTools?.definitions.some(tool => tool.name === definition.name);
    const isConnectorTool = connectorTools?.definitions.some(tool => tool.name === definition.name);
    if (!isFeedbackTool && !isTeamTool && !isAgentTool && !isProjectTool && !isRoutineTool && !isConnectorTool && !executor) throw new Error('작업 폴더를 선택한 대화에서만 파일 도구를 사용할 수 있습니다.');
    const raw = args && typeof args === 'object' ? args as Record<string, unknown> : {};
    answer.tools ??= []; const prior = answer.tools.find(t => t.callId === callId);
    const record: ToolRecord = prior ?? {callId, name: definition.name, ...(typeof raw.path === 'string' ? {path: raw.path} : {}), status: 'running', input: structuredClone(raw)};
    if (!prior) answer.tools.push(record);
    emit({type: 'tool-status', sessionId, messageId: answer.id, ...record});
    try {
      if ((isTeamTool || isAgentTool) && !await authorize({path: '.', operation: 'manage', tool: definition.name, category: 'routine', reason: '현재 에이전트 또는 팀 범위의 작업 도구입니다.'})) throw new Error('사용자가 이 작업을 승인하지 않았습니다.');
      if (finalized || controller.signal.aborted) throw new DOMException('작업을 중단했습니다.', 'AbortError');
      const result = isFeedbackTool ? await appFeedbackTools!.execute(definition.name, args, callId) : isConnectorTool ? await connectorTools!.execute(definition.name, args, callId) : isRoutineTool ? await routineTools!.execute(definition.name, args, callId) : isTeamTool ? await teamTools!.execute(definition.name, args, callId) : isAgentTool ? await agentTools!.execute(definition.name, args, callId) : isProjectTool ? await projectTools!.execute(definition.name, args, callId) : await executor!.execute(definition.name, args, callId);
      record.output = structuredClone(result);
      record.status = 'completed'; record.summary = definition.name === 'write_file' ? ((result as {written?: boolean}).written ? '파일을 저장했습니다.' : '파일 수정을 거절했습니다.') : '완료';
      return result;
    } catch (error) { record.status = 'failed'; record.summary = safeError(error); record.output = {error: record.summary}; throw error; }
    finally { if (!finalized && activeRun?.controller === controller) { persist(); emit({type: 'tool-status', sessionId, messageId: answer.id, ...record}); emit({type: 'session', session}); } }
  };
  let lastSaved = Date.now();
  const addText = (delta: string) => {
    if (answer.text.length + delta.length > 2_000_000) throw new Error('응답 크기 제한에 도달했습니다.');
    answer.text += delta; emit({ type: 'delta', sessionId, messageId: answer.id, delta });
    if (Date.now() - lastSaved > 1500) { persist(); lastSaved = Date.now(); }
  };
  try {
    if (session.policySnapshot) {
      const chosen = await policyChoice(session.policySnapshot, session.policyAllowedConnections ?? connectionRoutes(session), session.policyTaskText ?? text);
      if (controller.signal.aborted) throw new DOMException('중단했습니다.', 'AbortError');
      session.connections = chosen.connections; session.routeSelection = chosen; answer.routeSelection = structuredClone(chosen);
      const first = chosen.connections[0]!; session.connectionId = first.connectionId; session.model = first.model; if (first.effort) session.effort = first.effort; else delete session.effort;
      persist(); emit({type: 'session', session});
    } else if (session.routeSelection) answer.routeSelection = structuredClone(session.routeSelection);
    const efficiency = session.routeSelection?.efficiency;
    let omittedPolicyTurns = 0;
    if (efficiency) {
      const bounded = boundPolicyHistory(history, efficiency); history = bounded.messages;
      omittedPolicyTurns = bounded.omittedTurns;
    }
    if (JSON.stringify(history).length > 500_000) throw new Error('대화가 너무 길어졌습니다. 새 대화에서 이어가세요. 현재 이력은 저장되어 있습니다.');
    // Resolve only selected completed turns after policy trimming; immutable copies are hash-checked before provider access.
    const completedUsers:ChatMessage[]=[];completedHistory(session,user.id,m=>{completedUsers.push(m);return m.text;});
    const selectedUsers=completedUsers.slice(-history.filter(m=>m.role==='user').length);let userIndex=0;
    history=history.map(message=>message.role==='user'?{...message,content:chatAttachments.content(selectedUsers[userIndex]!.text,selectedUsers[userIndex++]!.attachments)}:message);
    if (efficiency) {
      const bounded = boundPolicyHistory(history, efficiency); history = bounded.messages;
      systemInstructions = [systemInstructions, efficiencyInstructions(efficiency, omittedPolicyTurns + bounded.omittedTurns)].filter(Boolean).join('\n\n');
    }
    if(JSON.stringify(history).length>24*1024*1024)throw Error('첨부 문맥이 너무 큽니다. 새 대화에서 필요한 파일만 첨부해 주세요.');
    if (session.workspacePath) executor = new WorkspaceExecutor(session.workspacePath, approve, controller.signal, authorizeWorkspace);
    const tools = [...(appFeedbackTools?.definitions ?? []), ...(executor ? WORKSPACE_TOOLS : []), ...(teamTools?.definitions ?? []), ...(agentTools?.definitions ?? []), ...(projectTools?.definitions ?? []), ...(routineTools?.definitions ?? []), ...(connectorTools?.definitions ?? [])];
    const routes = connectionRoutes(session);
    for (const [index, route] of routes.entries()) {
      if (controller.signal.aborted) throw new DOMException('중단했습니다.', 'AbortError');
      const attempt: ConnectionAttempt = {...route, status: 'running'};
      (answer.attempts ??= []).push(attempt); persist(); emit({type: 'session', session});
      let completed = false, failed = false, failure: unknown, toolInvoked = false;
      let nextProviderSessionId: string | undefined, resumeParent: string | undefined, mcp: McpGateway | undefined;
      const attemptController = new AbortController();
      const abortAttempt = () => attemptController.abort();
      controller.signal.addEventListener('abort', abortAttempt, {once: true});
      if (controller.signal.aborted) abortAttempt();
      const executeAttempt = async (definition: {name?: unknown}, args: unknown, callId: string): Promise<unknown> => {
        if (attemptController.signal.aborted) throw new DOMException('종료된 연결 요청입니다.', 'AbortError');
        toolInvoked = true; return execute(definition, args, callId);
      };
      try {
        if (route.connectionId === 'codex') {
          for await (const event of runCodexTurn({ messages: history, model: route.model, ...(route.effort ? {effort: route.effort} : {}), ...(systemInstructions ? {systemInstructions} : {}), tools, executeTool: executeAttempt, signal: attemptController.signal })) {
            if (event.type === 'text-delta') addText(event.delta);
            if (event.type === 'done') { completed = true; if (!answer.text) addText(event.text); local(() => settings.recordInferenceUsage('codex', event.usage)); }
          }
        } else if (route.connectionId === 'claude-code') {
          const priorBinding = session.providerSessionBinding ?? (session.connectionId === 'claude-code' ? connectionRouteKey(session) : undefined);
          if (priorBinding !== connectionRouteKey(route)) { delete session.providerSessionId; delete session.providerSessionBinding; }
          // A native resume would restore omitted history and bypass the opt-in budget.
          const previous = efficiency ? undefined : session.providerSessionId;
          resumeParent = previous;
          if (tools.length) {
            try { mcp = await startMcpGateway((name, args, id) => executeAttempt({name}, args, id), attemptController.signal, tools); }
            catch (error) { localFailure = true; throw error; }
          }
          for await (const event of runClaudeTurn({ messages: history, model: route.model, ...(route.effort ? {effort: route.effort} : {}), ...(systemInstructions ? {systemInstructions} : {}), ...(previous ? {sessionId: previous} : {}), ...(!previous && (routes.length > 1 || efficiency || session.messages.some(message => message.routeSelection?.efficiency)) ? {historyHandoff: true} : {}), ...(mcp ? {mcpServer: {url: mcp.url, token: mcp.token}} : {}), signal: attemptController.signal })) {
            if (event.type === 'text-delta') addText(event.delta);
            if (event.type === 'done') { completed = true; if (!answer.text) addText(event.text); nextProviderSessionId = event.sessionId; local(() => settings.recordInferenceUsage('claude-code', event.usage)); }
          }
        } else {
          const selected = profile(route.connectionId);
          if (session.teamRunId) local(() => teams.noteToolAvailability(sessionId, selected.capabilities.tools));
          verifiedProfiles.delete(selected.id);
          let key: string | undefined;
          try { key = await secrets.read(apiProfileSecretKey(selected), attemptController.signal); }
          catch (error) { localFailure = true; throw error; }
          if (!key) throw new Error('API 키를 먼저 등록하세요.');
          for await (const event of streamApiProvider({ profile: {...selected, model: route.model}, apiKey: key, messages: history, ...(session.purpose === 'avatar' ? {maxOutputTokens: 16384} : {}), ...(selected.capabilities.tools ? {tools, executeTool: executeAttempt} : {}), signal: attemptController.signal, system: '당신은 벤디트봇입니다. 제공된 파일 도구로 선택한 작업 폴더에서 작업할 수 있습니다. 파일 수정에는 사용자 승인이 필요합니다.' + (systemInstructions ? `\n\n에이전트 역할 지시문:\n${systemInstructions}` : '') })) {
            if (event.type === 'text-delta') addText(event.delta);
            if (event.type === 'completed') { completed = true; verifiedProfiles.add(selected.id); }
            if (event.type === 'usage') local(() => settings.recordInferenceUsage(selected.provider, event.usage));
          }
        }
        if (controller.signal.aborted) throw new DOMException('중단했습니다.', 'AbortError');
        if (!completed) throw new Error('응답이 완료되기 전에 연결이 종료되었습니다.');
      } catch (error) { failed = true; failure = error; }
      finally {
        attemptController.abort(); controller.signal.removeEventListener('abort', abortAttempt);
        try { await mcp?.close(); } catch (error) { localFailure = true; if (!failed) { failed = true; failure = error; } }
      }
      if (failed) {
        attempt.status = 'failed'; attempt.error = controller.signal.aborted ? '사용자가 응답을 중단했습니다.' : safeError(failure);
        if (route.connectionId === 'claude-code') {
          // The CLI always forks a successful parent. A failed fork must not
          // discard that parent's safe retry point or silently resume the fork.
          if (resumeParent) { session.providerSessionId = resumeParent; session.providerSessionBinding = connectionRouteKey(route); }
          else { delete session.providerSessionId; delete session.providerSessionBinding; }
        }
        // Only a provider failure before any visible response or tool activity is
        // eligible. Local storage/setup failures and user cancellation never retry.
        if (controller.signal.aborted || localFailure || completed || answer.text || toolInvoked || answer.tools?.length || index === routes.length - 1) throw failure;
        persist(); emit({type: 'session', session}); continue;
      }
      attempt.status = 'completed';
      session.connectionId = route.connectionId; session.model = route.model;
      if (route.effort) session.effort = route.effort; else delete session.effort;
      if (!efficiency && route.connectionId === 'claude-code' && nextProviderSessionId) { session.providerSessionId = nextProviderSessionId; session.providerSessionBinding = connectionRouteKey(route); }
      else { delete session.providerSessionId; delete session.providerSessionBinding; }
      answer.status = 'completed'; break;
    }
  } catch (error) {
    answer.status = controller.signal.aborted ? 'cancelled' : 'failed';
    answer.error = controller.signal.aborted ? '사용자가 응답을 중단했습니다.' : safeError(error);
  } finally {
    finalized = true; controller.abort();
    session.taskStatus = answer.status === 'running' ? 'failed' : answer.status;
    for (const tool of answer.tools ?? []) if (tool.status === 'running') { tool.status = 'failed'; tool.summary = '응답 종료로 도구 실행이 중단되었습니다.'; }
    for (const attempt of answer.attempts ?? []) if (attempt.status === 'running') { attempt.status = 'failed'; attempt.error = answer.error ?? '응답이 종료되었습니다.'; }
    let cleanupError: string | undefined;
    try { saveSession(session); } catch (error) { cleanupError = `대화를 저장하지 못했습니다. 종료 전에 내보내기로 보관하세요. ${safeError(error)}`; }
    finally {
      if (activeRun?.controller === controller) activeRun = null;
      emit({ type: 'session', session }); emit({ type: 'run-end', sessionId, ...(cleanupError ? {error: cleanupError} : {}) });
    }
  }
}

function assertUpdateIdle(): void {
  assertIdle();
  if (secrets.isPending()) throw new Error('macOS 보안 저장소 요청이 처리 중입니다. 시스템 확인을 마친 뒤 업데이트하세요.');
  if (avatarJobs.active().length || pendingRequests) throw new Error('진행 중인 설정·연결·프로필 작업을 마친 뒤 업데이트하세요.');
  if (chatTurns?.error() || unsavedSessions.size || unsavedTeamRunIds.length || unsavedRabbitRunIds.length) throw new Error('저장되지 않은 작업이 있습니다. 저장 문제를 해결하고 작업을 보관한 뒤 업데이트하세요.');
}
function startUpdateChecks(): void {
  if (paths.development || updateTimer) return;
  const check = () => { if (!quitting && !quitPending && !updatePending) void updater.check().catch(() => {}); };
  check(); updateTimer = setInterval(check, 60_000); updateTimer.unref();
}
function stopUpdateChecks(): void { if (updateTimer) clearInterval(updateTimer); updateTimer = undefined; }
async function cancelUpdateHandoff(): Promise<void> {
  if (!updateHandoff || cancellingUpdate) return;
  const prepared = updateHandoff; quitting = false; cancellingUpdate = true;
  try {
    await prepared.cancel(); updateHandoff = undefined; updatePending = false;
    teams.resumeAfterQuit(); startUpdateChecks(); startRoutines(); window?.show(); window?.focus();
  } catch (error) {
    // Keep the parent alive and locked until the replacement helper is stopped.
    emit({type: 'update', update: {...updater.state(), phase: 'error', error: `업데이트 도우미 중단을 확인하지 못했습니다. 앱을 열어 두세요. ${safeError(error)}`}});
  } finally { cancellingUpdate = false; }
}
async function installUpdate(): Promise<{restarting: true}> {
  if (updatePending || quitPending || quitting) throw new Error('이미 업데이트 또는 종료를 준비하고 있습니다.');
  if (updater.state().phase === 'development') throw new Error('개발 앱에서는 운영 앱 업데이트를 설치하지 않습니다.');
  if (updater.state().phase !== 'available') throw new Error('설치할 업데이트를 먼저 확인하세요.');
  assertUpdateIdle(); updatePending = true; routineScheduler.stop(); feedback.host.stop();
  let prepared: Awaited<ReturnType<LocalUpdater['prepare']>> | undefined;
  try {
    const statuses = await authStatus();
    if (Object.values(statuses).some(value => ['preparing', 'awaiting-browser', 'testing'].includes((value as {phase: string}).phase))) throw new Error('진행 중인 로그인을 마치거나 취소한 뒤 업데이트하세요.');
    assertUpdateIdle(); teams.stopForQuit();
    await shutdownProviderAuthRuntimeForUpdate();
    assertUpdateIdle(); window?.webContents.session.flushStorageData(); prepared = await updater.prepare();
    // No task or IPC mutation may occur between the backup and helper handoff.
    assertUpdateIdle(); await prepared.launch(process.pid); assertUpdateIdle(); updateHandoff = prepared;
    quitting = true; stopUpdateChecks();
    app.quit(); return {restarting: true};
  } catch (error) {
    try { await prepared?.cancel(); }
    catch (cancelError) {
      updateHandoff = prepared; quitting = false;
      throw new Error(`업데이트 도우미 중단을 확인하지 못했습니다. 앱을 열어 두세요. ${safeError(cancelError)}`);
    }
    updateHandoff = undefined; quitting = false; updatePending = false; teams.resumeAfterQuit(); startUpdateChecks(); startRoutines(); window?.show(); window?.focus(); throw error;
  }
}
async function request(method: string, raw: unknown): Promise<unknown> {
  if (updatePending && !updateReadOnly.has(method)) throw new Error('업데이트를 준비하고 있습니다. 완료될 때까지 작업과 설정 변경을 기다려 주세요.');
  if (credentialMutation && !['state', 'authStatus', 'getTeamRun', 'getAgentAvatar', 'exportSession', 'exportTeamRun', 'exportRabbitRun', 'cancel', 'cancelTeamRun', 'cancelAgentAvatar'].includes(method)) throw new Error('API 키를 안전하게 저장하고 있습니다. 완료 후 다시 시도하세요.');
  if ((quitPending || quitting) && !['state', 'authStatus', 'exportSession', 'exportTeamRun', 'exportRabbitRun', 'getTeamRun', 'cancel', 'cancelTeamRun', 'cancelAgentAvatar'].includes(method)) throw new Error('종료 처리를 확인하고 있습니다. 앱으로 돌아온 뒤 다시 시도하세요.');
  if (!['state', 'exportSession', 'exportTeamRun', 'getTeamRun', 'getAgentAvatar'].includes(method)) automaticTeams.assertReady();
  const args = raw == null ? {} : object(raw);
  switch (method) {
    case 'state': return state();
    case 'listFeedback': return feedback.host.snapshot();
    case 'submitFeedback': return feedback.host.submit(args);
    case 'refreshFeedback': return feedback.host.refresh(string(args.id, 100));
    case 'openFeedbackAgent': {const result=feedback.host.openAgent();emit({type:'teams',teams:teamStore.listTeams(),agents:agents.list()});return result;}
    case 'saveFeedbackConfiguration': return feedback.saveConfiguration(args as unknown as FeedbackBinding);
    case 'stageChatAttachments': return chatAttachments.stage(args.files as {name:unknown;bytes:unknown}[]);
    case 'selectChatAttachments': {if(!window)return [];const selected=await dialog.showOpenDialog(window,{title:'메시지 첨부',properties:['openFile','multiSelections'],filters:[{name:'이미지·텍스트·코드',extensions:['png','jpg','jpeg','webp','gif','txt','md','csv','json','ts','tsx','js','py','log','yaml','yml','xml']}]});if(selected.canceled)return [];if(updatePending||quitPending||quitting)throw Error('종료·업데이트 준비 중에는 첨부를 저장할 수 없습니다.');return chatAttachments.select(selected.filePaths);}
    case 'appConnectorsList': return appConnectors.list();
    case 'appConnectorsConfigure': return appConnectors.configure(args as unknown as ConfigureAppConnectorInput);
    case 'appConnectorsConnect': {
      if (args.consentAccepted !== true) throw new Error('앱 접근 권한을 확인한 뒤 연결에 동의하세요.');
      return appConnectors.connect({id: appConnectorId(args.id), consentAccepted: true});
    }
    case 'appConnectorsCancel': return appConnectors.cancel({id: appConnectorId(args.id)});
    case 'appConnectorsDisconnect': return appConnectors.disconnect({id: appConnectorId(args.id)});
    case 'appConnectorsTest': return appConnectors.test({id: appConnectorId(args.id), ...(args.resourceId === undefined ? {} : {resourceId: string(args.resourceId, 200)})});
    case 'saveRoutine': return saveRoutine({routine: normalizeRoutineInput(args.routine), ...(args.expectedRevision === undefined ? {} : {expectedRevision: args.expectedRevision as number}), ...(args.requestId === undefined ? {} : {requestId: string(args.requestId, 100)})});
    case 'setRoutineEnabled': {
      if (typeof args.enabled !== 'boolean') throw new Error('루틴의 활성 상태를 확인하세요.');
      return setRoutineEnabled(string(args.id, 100), args.enabled, args.expectedRevision as number);
    }
    case 'deleteRoutine': return routines.remove(string(args.id, 100), args.expectedRevision as number);
    case 'checkUpdate': return updater.check();
    case 'installUpdate': return installUpdate();
    case 'authStatus': return authStatus();
    case 'listModels': return listProviderModels(provider(args.provider), {refresh: args.refresh === true});
    case 'login': {
      assertIdle(); const p = provider(args.provider); const result = await beginProviderLogin(p);
      if (result.authUrl) {
        const url = new URL(result.authUrl);
        if (url.protocol !== 'https:' || !['auth.openai.com', 'chatgpt.com', 'claude.ai', 'platform.claude.com'].includes(url.hostname)) throw new Error('지원하지 않는 로그인 주소입니다.');
        await shell.openExternal(url.href);
      }
      emit({ type: 'auth', provider: p, status: result }); return result;
    }
    case 'cancelLogin': return cancelProviderLogin(provider(args.provider));
    case 'disconnect': {
      assertIdle(); const p = provider(args.provider); const result = await disconnectProvider(p);
      for (const saved of sessions.list()) if (connectionRoutes(saved).some(route => route.connectionId === p)) {
        const session = readSession(saved.id); delete session.providerSessionId; delete session.providerSessionBinding; saveSession(session);
      }
      return result;
    }
    case 'testAuth': {
      assertIdle(); testing = true;
      try { return await testProviderConnection(provider(args.provider), args.model == null ? undefined : string(args.model), args.effort == null ? undefined : string(args.effort, 40)); }
      finally { testing = false; }
    }
    case 'saveProfile': {
      assertIdle(); const selected = normalizeApiProviderProfile(args.profile);
      const all = settings.getApiProviderProfiles(); const old = all.find(p => p.id === selected.id);
      if (!old && hasConnectionReference(selected.id)) throw new Error('이전 작업이 참조하는 연결 ID입니다. 새 연결을 만드세요.');
      if (all.length >= 50 && !old) throw new Error('연결은 최대 50개까지 등록할 수 있습니다.');
      const key = args.apiKey == null ? '' : string(args.apiKey, 8192).trim();
      const bindingChanged = old && (old.provider !== selected.provider || old.baseUrl !== selected.baseUrl || old.protocol !== selected.protocol);
      if (bindingChanged && hasConnectionReference(old.id)) throw new Error('대화나 에이전트의 우선순위에서 사용한 연결의 공급자·주소는 변경할 수 없습니다. 새 API 연결을 만드세요.');
      if ((!old || bindingChanged) && !key) throw new Error('새 공급자 또는 주소에 사용할 API 키를 입력하세요.');
      const revision = configurationRevision(), reference = apiProfileSecretKey(selected);
      const commit = () => settings.setApiProviderProfiles([...all.filter(p => p.id !== selected.id), selected]);
      if (key) {
        credentialMutation = true;
        try {
          await secrets.write(reference, key, {
            beforeCommit: () => {
              assertConfigurationCurrent(revision, undefined, true); assertIdle();
              if (bindingChanged && hasConnectionReference(old.id)) throw new Error('저장 중 이 연결을 참조하는 작업이 생겼습니다. 새 API 연결을 만드세요.');
            },
            afterCommit: commit,
            ...(bindingChanged && apiProfileSecretKey(old) !== reference ? {removeKeys: [apiProfileSecretKey(old)]} : {}),
          });
        } finally { credentialMutation = false; }
      } else commit();
      verifiedProfiles.delete(selected.id);
      return state();
    }
    case 'deleteProfile': {
      assertIdle(); const selected = profile(string(args.id));
      if (hasConnectionReference(selected.id)) throw new Error('이 연결을 참조하는 에이전트나 대화가 있습니다. 에이전트의 연결을 수정하고, 필요한 대화를 내보낸 뒤 해당 대화를 삭제하세요.');
      secrets.remove(apiProfileSecretKey(selected), () => settings.setApiProviderProfiles(settings.getApiProviderProfiles().filter(p => p.id !== selected.id)));
      verifiedProfiles.delete(selected.id); return state();
    }
    case 'testApi': {
      assertIdle(); const selected = profile(string(args.id)); testing = true; verifiedProfiles.delete(selected.id);
      try {
        const signal = AbortSignal.timeout(60_000), apiKey = await secrets.read(apiProfileSecretKey(selected), signal);
        if (!apiKey) throw new Error('API 키를 등록하세요.');
        if (quitPending || quitting) throw new Error('앱 종료 중에는 연결 확인을 시작하지 않습니다.');
        const result = await validateApiProviderConnection({ profile: selected, apiKey, signal }); settings.recordInferenceUsage(selected.provider, result.usage); verifiedProfiles.add(selected.id); return result;
      }
      finally { testing = false; }
    }
    case 'createSession': {
      if (args.agentId != null) {
        const agent = agents.get(string(args.agentId)), connections = connectionRoutes(agent), first = connections[0]!;
        return sessions.create(first.connectionId, first.model, agent.workspacePath, first.effort, {connections, agentId: agent.id, agentName: agent.name, instructions: agent.instructions, ...(agent.development ? {development: structuredClone(agent.development)} : {}), ...(agent.automation ? {automation: agent.automation, policyAllowedConnections: connections} : {})});
      }
      const revision = configurationRevision(), connectionId = string(args.connectionId); const chosen = await selection(connectionId, string(args.model ?? '').trim(), args.effort == null || args.effort === '' ? undefined : string(args.effort, 40));
      assertConfigurationCurrent(revision);
      const workspace = args.workspacePath == null || args.workspacePath === '' ? undefined : string(args.workspacePath, 4096);
      if (workspace && !selectedWorkspaces.has(workspace)) throw new Error('폴더 선택 버튼으로 작업 폴더를 선택하세요.');
      return sessions.create(connectionId, chosen.model, workspace, chosen.effort);
    }
    case 'saveAgent': {
      const data = object(args.agent); const id = data.id == null || data.id === '' ? undefined : string(data.id); const old = id ? agents.get(id) : undefined;
      const name = string(data.name, 80).trim(), instructions = string(data.instructions, 16000).trim();
      if (!name || !instructions) throw new Error('에이전트 이름과 역할 지시문을 입력하세요.');
      const development = selectedDevelopment(data.development, old?.development), developmentRevision = developmentConfigurationRevision(development);
      const revision = configurationRevision(), connections = await selectedConnections(data);
      assertConfigurationCurrent(revision, old);
      assertDevelopmentConfigurationCurrent(development, developmentRevision);
      const workspacePath = data.workspacePath == null || data.workspacePath === '' ? undefined : string(data.workspacePath, 4096);
      if (workspacePath && workspacePath !== old?.workspacePath && !selectedWorkspaces.has(workspacePath)) throw new Error('폴더 선택 버튼으로 작업 폴더를 선택하세요.');
      if (workspacePath) normalizeWorkspace(workspacePath);
      const automation = data.automation == null ? undefined : {policyId: policies.get(string(object(data.automation).policyId, 100)).id};
      const avatarId = data.avatarId === '' ? undefined : data.avatarId == null ? old?.avatarId ?? createDefaultAvatar() : string(data.avatarId, 100); if (avatarId) readAvatar(avatarId);
      agents.save({...(id ? {id} : {}), name, instructions, ...connections[0]!, connections, ...(workspacePath ? {workspacePath} : {}), ...(avatarId ? {avatarId} : {}), ...(automation ? {automation} : {}), ...(development ? {development} : {})}); return state();
    }
    case 'saveRabbitConnection': {
      assertIdle();
      const input = object(args.connection);
      if (input.id) {
        const previous = rabbitStore.getConnection(string(input.id, 100)), next = normalizeRabbitConnectionDraft(input);
        if (hasDevelopmentReference(previous.id) && (previous.baseUrl !== next.baseUrl || previous.projectId !== next.projectId || previous.allowInsecureLoopback !== next.allowInsecureLoopback)) throw new Error('에이전트·팀 또는 대화가 개발 대상으로 참조하는 연결의 서버·프로젝트는 바꿀 수 없습니다. 별도 Rabbit 연결을 추가한 뒤 새 작업에 지정하세요.');
      }
      credentialMutation = true;
      try {await rabbit.saveConnection(args.connection, args.apiKey, args.expectedUpdatedAt == null ? undefined : string(args.expectedUpdatedAt, 40)); return state();}
      finally {credentialMutation = false;}
    }
    case 'deleteRabbitConnection': {assertIdle(); rabbit.removeConnection(string(args.id, 100), string(args.expectedUpdatedAt, 40)); return state();}
    case 'testRabbitConnection': {assertIdle(); return rabbit.test(rabbitStore.getConnection(string(args.id, 100)));}
    case 'startRabbitRun': return rabbit.start(string(args.connectionId, 100), args.input, string(args.requestId, 100));
    case 'retryRabbitRun': return rabbit.retry(string(args.id, 100));
    case 'refreshRabbitRun': return rabbit.refresh(string(args.id, 100));
    case 'openRabbitProject': {
      const connection = rabbitStore.getConnection(string(args.connectionId, 100)); await shell.openExternal(`${connection.baseUrl}/projects/${encodeURIComponent(connection.projectId)}`); return {opened: true};
    }
    case 'exportRabbitRun': {
      if (!window) return {saved: false}; const run = rabbitStore.getRun(string(args.id, 100));
      const result = await dialog.showSaveDialog(window, {title: '프로젝트 실행 기록 내보내기', defaultPath: `벤디트봇-프로젝트-${run.id.slice(0, 8)}.json`, filters: [{name: 'JSON', extensions: ['json']}]});
      if (result.canceled || !result.filePath) return {saved: false}; exportPrivate(result.filePath, JSON.stringify({version: 1, run}, null, 2)); return {saved: true, path: result.filePath};
    }
    case 'saveActionRules': {
      const saved = actionRules.save(args.rules, string(args.expectedUpdatedAt, 40)); emit({type: 'action-rules', rules: saved}); return state();
    }
    case 'policyEfficiencyPreset': {
      const connections = normalizePolicyConnections(args.connections), revision = configurationRevision();
      const stamp = new Date().toISOString(), member: AgentProfile = {id: 'efficiency-preview', name: '절약 설정', instructions: '절약 설정', ...connections[0]!, connections, createdAt: stamp, updatedAt: stamp};
      const result = policyEfficiencyPreset(args.preset, connections, await teamCatalogs([member]));
      assertConfigurationCurrent(revision); return result;
    }
    case 'savePolicy': {
      const rawPolicy = object(args.policy), draft = normalizeAgentPolicyDraft(rawPolicy);
      const id = rawPolicy.id == null || rawPolicy.id === '' ? undefined : string(rawPolicy.id, 100);
      const revision = configurationRevision();
      // Pin official aliases/default effort at save time; API profiles have one fixed model.
      const rules = [];
      for (const rule of draft.rules) {
        for (const route of rule.connections) if (route.connectionId !== 'codex' && route.connectionId !== 'claude-code' && route.model !== profile(route.connectionId).model) throw new Error('API 정책에는 연결 프로필의 고정 모델을 사용하세요.');
        rules.push({...rule, connections: await selectedConnections({connections: rule.connections})});
      }
      assertConfigurationCurrent(revision);
      policies.save({...draft, rules, ...(id ? {id} : {})}, args.expectedUpdatedAt == null ? undefined : string(args.expectedUpdatedAt, 40));
      emit({type: 'policies', policies: policies.list()}); return state();
    }
    case 'deletePolicy': {
      const id = string(args.id, 100);
      if (agents.list().some(a => a.automation?.policyId === id) || sessions.list().some(s => s.automation?.policyId === id)) throw new Error('이 정책을 사용하는 에이전트나 대화가 있습니다. 정책 연결을 해제하고 필요한 대화를 보관한 뒤 삭제하세요.');
      policies.remove(id, string(args.expectedUpdatedAt, 40)); emit({type: 'policies', policies: policies.list()}); return state();
    }
    case 'previewAgentPolicy': {
      const agent = agents.get(string(args.agentId)), text = string(args.text, 100000);
      if (!agent.automation) throw new Error('이 에이전트는 수동 모델 설정을 사용합니다.');
      const kind = args.taskKind; if (kind !== undefined && kind !== 'routine' && kind !== 'standard' && kind !== 'complex') throw new Error('작업 종류를 확인하세요.');
      return policyChoice(policies.get(agent.automation.policyId), connectionRoutes(agent), text, kind);
    }
    case 'cloneAgent': {
      const original = agents.get(string(args.id));
      if (args.expectedUpdatedAt !== undefined && args.expectedUpdatedAt !== original.updatedAt) throw new Error('에이전트 설정이 변경되었습니다. 최신 설정을 다시 불러오세요.');
      const {id: _id, createdAt: _created, updatedAt: _updated, ...configuration} = original;
      let avatarId = original.avatarId;
      const scene = avatarId ? avatars.getScene(avatarId) : undefined;
      if (scene) {pruneAvatars(); avatarId = avatars.save(varyAvatarScene(scene)).id;}
      else if (!avatarId) avatarId = createDefaultAvatar();
      const agent = agents.save({...configuration, name: `${original.name.slice(0, 73)}의 복제본`, avatarId});
      let avatarRequestId: string | undefined;
      if (!scene && original.avatarId) {
        avatarRequestId = randomUUID(); const requestId = avatarRequestId;
        const failed = (error: unknown) => avatarJobs.recordFailure(requestId, `agent:${agent.id}`, `복제본과 원본 사진은 저장했습니다. 사진 변형을 시작하지 못했습니다. ${safeError(error)}`);
        try {
          const route = connectionRoutes(agent).find(r => r.connectionId === 'codex');
          const referenceImage = referenceAvatarImage(readAvatar(original.avatarId));
          if (!route || !referenceImage) failed(new Error('이 에이전트에 Codex 연결을 추가한 뒤 사진 변형을 다시 시도하세요.'));
          else {
            void generateAvatar({requestId, ownerKey: `agent:${agent.id}`, agentId: agent.id, mode: 'image', ...route, prompt: '첨부된 프로필 사진의 인물 또는 캐릭터 정체성과 구도를 유지하면서 배경과 색상에 작은 변화를 준 새 프로필 이미지를 만드세요.'}, {referenceImage, applyAsset: assetId => {
              let current; try {current = agents.get(agent.id);} catch {return '복제본이 삭제되어 생성 이미지를 자동 적용하지 않았습니다.';}
              if (current.updatedAt !== agent.updatedAt || current.avatarId !== agent.avatarId) return '복제본 설정이 변경되어 생성 이미지를 자동 적용하지 않았습니다. 미리 보기에서 선택할 수 있습니다.';
              agents.save({...current, avatarId: assetId}); emit({type: 'teams', teams: teamStore.listTeams(), agents: agents.list()}); return undefined;
            }}).catch(failed);
          }
        } catch (error) {failed(error);}
      }
      return {state: state(), agent, ...(avatarRequestId ? {avatarRequestId} : {})};
    }
    case 'cloneTeam': {
      const original = teamStore.getTeam(string(args.id));
      if (args.expectedUpdatedAt !== undefined && args.expectedUpdatedAt !== original.updatedAt) throw new Error('팀 설정이 변경되었습니다. 최신 설정을 다시 불러오세요.');
      const {id: _id, createdAt: _created, updatedAt: _updated, creation: _creation, ...configuration} = original;
      const team = teamStore.saveTeam({...configuration, name: `${original.name.slice(0, 73)}의 복제본`}); return {state: state(), team};
    }
    case 'getAgentAvatar': return readAvatar(string(args.id, 100));
    case 'cancelAgentAvatar': return {cancelled: cancelAvatarRequest(args.requestId == null ? undefined : string(args.requestId, 100))};
    case 'generateAgentAvatar': return generateAvatar(args);
    case 'deleteAgent': {
      const id = string(args.id); if (teamStore.listTeams().some(team => team.memberAgentIds.includes(id))) throw new Error('이 에이전트를 사용하는 팀이 있습니다. 팀의 멤버 구성을 먼저 변경하세요.');
      for (const job of avatarJobs.active()) if (job.ownerKey === `agent:${id}`) cancelAvatarRequest(job.requestId);
      agents.remove(id); return state();
    }
    case 'cancelAutomaticTeamCreation': return {cancelled: automaticTeams.cancel(string(args.requestId, 100))};
    case 'saveTeam': {
      const submitted = object(args.team);
      if (submitted.leaderMode === 'automatic') {selectedDevelopment(submitted.development); await automaticTeams.create(submitted); return state();}
      if (submitted.leaderMode !== undefined && submitted.leaderMode !== 'existing') throw new Error('대표 생성 방식을 확인하세요.');
      const data = object(args.team), id = data.id == null || data.id === '' ? undefined : string(data.id);
      if (id && string(args.expectedUpdatedAt ?? data.updatedAt ?? '', 40) !== teamStore.getTeam(id).updatedAt) throw new Error('팀 설정이 변경되었습니다. 최신 팀 설정을 다시 불러온 뒤 저장하세요.');
      if (!Array.isArray(data.memberAgentIds) || data.memberAgentIds.length < 1) throw new Error('등록된 에이전트 중 대표를 포함해 팀 멤버를 선택하세요.');
      if (data.autonomous !== undefined && typeof data.autonomous !== 'boolean') throw new Error('대표 자율주행 설정을 확인하세요.');
      const memberAgentIds = data.memberAgentIds.map(value => agents.get(string(value)).id);
      const development = selectedDevelopment(data.development, id ? teamStore.getTeam(id).development : undefined);
      teamStore.saveTeam({...(id ? {id} : {}), ...(development ? {development} : {}), name: string(data.name, 80).trim(), instructions: string(data.instructions ?? '', 16000).trim(), topic: string(data.topic ?? '', 4000).trim(), policies: string(data.policies ?? '', 16000).trim(), leaderAgentId: string(data.leaderAgentId ?? memberAgentIds[0]), memberAgentIds, rounds: Number(data.rounds ?? 1), autonomous: data.autonomous === undefined ? (id ? teamStore.getTeam(id).autonomous === true : false) : data.autonomous === true}); return state();
    }
    case 'deleteTeam': { teamStore.removeTeam(string(args.id)); return state(); }
    case 'startTeamRun': {
      if (testing) throw new Error('연결 확인 후 팀 작업을 시작하세요.');
      const team = teamStore.getTeam(string(args.teamId)); return teams.start(team.id, string(args.goal, 8000), team.memberAgentIds.map(id => agents.get(id)), args.contextRunId == null ? undefined : string(args.contextRunId), undefined, chatAttachments.resolve(args.attachmentIds));
    }
    case 'getTeamRun': return teams.detail(string(args.id));
    case 'cancelTeamRun': return teams.cancel(string(args.id));
    case 'postTeamMessage': return teams.postUser(string(args.runId), string(args.text, 8000), args.toAgentId == null || args.toAgentId === '' ? undefined : string(args.toAgentId),chatAttachments.resolve(args.attachmentIds));
    case 'deleteTeamRun': { teamStore.removeRun(string(args.id)); return state(); }
    case 'exportTeamRun': {
      if (!window) return {saved: false}; const run = teams.detail(string(args.id));
      const result = await dialog.showSaveDialog(window, {title: '팀 작업 내보내기', defaultPath: `벤디트봇-팀-${run.id.slice(0,8)}.json`, filters: [{name: 'JSON', extensions: ['json']}]});
      if (result.canceled || !result.filePath) return {saved: false};
      exportPrivate(result.filePath, JSON.stringify({version: 1, run, sessions: run.steps.map(step => readSession(step.sessionId))}, null, 2)); return {saved: true, path: result.filePath};
    }
    case 'selectWorkspace': {
      assertIdle(); if (!window) return null;
      const result = await dialog.showOpenDialog(window, {title: '벤디트봇 작업 폴더 선택', properties: ['openDirectory'], buttonLabel: '이 폴더에서 작업'});
      if (result.canceled || !result.filePaths[0]) return null;
      const path = normalizeWorkspace(result.filePaths[0]); selectedWorkspaces.add(path); return {path};
    }
    case 'respondApproval': {
      const approval = approvals.get(string(args.approvalId)); if (!approval || typeof args.approved !== 'boolean') throw new Error('이 승인 요청은 만료되었습니다.');
      approval(args.approved); return {handled: true};
    }
    case 'renameSession': {
      assertIdle(); const session = readSession(string(args.id)); const title = string(args.title, 200).trim(); if (!title) throw new Error('대화 이름을 입력하세요.'); session.title = title; saveSession(session); return readSession(session.id);
    }
    case 'deleteSession': {
      assertIdle(); const id = string(args.id); if (teams.sessionRun(id)) throw new Error('팀 작업이 참조하는 대화입니다. 팀 작업을 내보낸 뒤 팀 기록을 먼저 삭제하세요.');
      chatTurns?.removeSession(id); sessions.remove(id); if (unsavedSessions.delete(id)) emitStorage(); return state();
    }
    case 'exportSession': {
      if (!window) return {saved: false}; const session = readSession(string(args.id)); const format = args.format === 'json' ? 'json' : 'markdown';
      const extension = format === 'json' ? 'json' : 'md';
      const result = await dialog.showSaveDialog(window, {title: '대화 내보내기', defaultPath: `벤디트봇-${session.id.slice(0,8)}.${extension}`, filters: [{name: format === 'json' ? 'JSON' : 'Markdown', extensions: [extension]}]});
      if (result.canceled || !result.filePath) return {saved: false};
      const queuedMessages = chatTurns?.snapshot().filter(turn => turn.sessionId === session.id && turn.status !== 'completed') ?? [];
      exportPrivate(result.filePath, format === 'json' ? JSON.stringify({version: 1, session, ...(queuedMessages.length ? {queuedMessages} : {})}, null, 2) : sessionMarkdown(session) + (queuedMessages.length ? '\n\n' + queuedMessages.map(turn => `## 대기 메시지 (${turn.status})\n\n${turn.text}\n${turn.attachments.map(file => file.name).join(', ')}`).join('\n\n') : ''));
      return {saved: true, path: result.filePath};
    }
    case 'send': {
      if (testing) throw new Error('연결 확인 후 작업을 시작하세요.');
      const sessionId = string(args.sessionId); const session = readSession(sessionId);
      if (session.purpose === 'avatar') throw new Error('프로필 그림 생성 작업입니다. 에이전트 편집 화면에서 다시 생성하세요.');
      if (session.teamRunId) throw new Error('팀에서 관리하는 작업입니다. 팀 대화방에 메시지를 보내거나 새 팀 작업을 시작하세요.');
      const attachments=chatAttachments.resolve(args.attachmentIds);const text = string(args.text, 100_000).trim() || (attachments.length?'첨부한 자료를 확인해 주세요.':''); if (!text) throw new Error('메시지를 입력하세요.');
      const wasIdle = !taskQueue.state().running.length;
      const turn = chatTurns!.submit({id: args.requestId == null ? randomUUID() : string(args.requestId, 100), sessionId, text, attachments});
      const started = wasIdle && taskQueue.state().running.includes(sessionId);
      return {...turn, started, queued: !started && turn.status === 'queued'};
    }
    case 'retryChatTurn': chatTurns!.retry(string(args.id)); return state();
    case 'cancelChatTurn': chatTurns!.cancel(string(args.id)); return state();
    case 'resumeChatTurns': chatTurns!.resume(string(args.sessionId)); return state();
    case 'cancel': {
      const id = args.sessionId == null ? activeRun?.sessionId : string(args.sessionId); if (!id) return {cancelled: false};
      const teamRun = teams.sessionRun(id); if (teamRun && activeTeamRun(teamRun)) { teams.cancel(teamRun.id); return {cancelled: true}; }
      return {cancelled: cancelSession(id)};
    }
    default: throw new Error('지원하지 않는 요청입니다.');
  }
}
function exportPrivate(path: string, content: string): void {
  if (existsSync(path) && (!lstatSync(path).isFile() || lstatSync(path).isSymbolicLink() || lstatSync(path).nlink !== 1)) throw new Error('일반 파일로만 내보낼 수 있습니다.');
  const temporary = `${path}.venditbot-${randomUUID()}.tmp`;
  try { writeFileSync(temporary, content, {mode: 0o600, flag: 'wx'}); renameSync(temporary, path); }
  finally { if (existsSync(temporary)) unlinkSync(temporary); }
}

  app.on('second-instance', () => { if (window?.isMinimized()) window.restore(); window?.focus(); });
  app.on('window-all-closed', () => app.quit());
  const prepareQuit = async (): Promise<void> => {
    quitPending = true; boundedQuitReady = false; routineScheduler.stop(); feedback.host.stop();
    for (const controller of feedbackProofControllers) controller.abort();
    try {
      teams.stopForQuit();
      for (const job of avatarJobs.active()) cancelAvatarRequest(job.requestId);
      // Stop waiting jobs before the active job settles, without permanently
      // closing the queue. Returning from the warning must leave the app usable.
      const snapshot = taskQueue.state();
      for (const id of [...snapshot.queued, ...snapshot.running]) {
        try { cancelSession(id); } catch (error) { console.error(safeError(error)); }
      }
      const appsDrained = await appConnectors.abortAndWait(4000);
      if (!appsDrained) throw new Error('앱 연결 정리가 아직 끝나지 않았습니다. 연결 취소를 확인한 뒤 다시 종료하세요.');
      const rabbitDrained = await rabbit.abortAndWait(4000);
      const drained = await taskQueue.waitForIdle(4000);
      if (!rabbitDrained) throw new Error('프로젝트 API 요청 정리가 아직 끝나지 않았습니다. 다시 종료하세요.');
      if (feedback.host.isBusy()) throw new Error('리포트 상태 저장이 아직 끝나지 않았습니다. 잠시 뒤 다시 종료하세요.');
      if (!drained) {
        if (window && !window.isDestroyed()) await dialog.showMessageBox(window, {type: 'warning', title: '작업 중단 확인', message: '작업이 아직 종료되지 않았습니다.', detail: '응답과 파일 작업 정리가 끝난 뒤 다시 종료하세요.', buttons: ['앱으로 돌아가기'], defaultId: 0, cancelId: 0});
        return;
      }
      // Cancellation cleanup can be the first write that discovers a disk error.
      // Recheck only after settlement, while the renderer remains open to export.
      if (chatTurns?.error() || unsavedSessions.size || unsavedTeamRunIds.length || unsavedRabbitRunIds.length) {
        if (!window || window.isDestroyed()) return;
        const {response} = await dialog.showMessageBox(window, {type: 'warning', title: '저장되지 않은 작업', message: '저장되지 않은 작업이 있습니다.', detail: '종료하면 메모리에만 남아 있는 응답이 사라집니다. 앱으로 돌아가 작업을 내보내거나 저장 문제를 해결하세요.', buttons: ['앱으로 돌아가기', '저장하지 않고 종료'], defaultId: 0, cancelId: 0, noLink: true});
        if (response !== 1) return;
      }
      // A pending OS Keychain operation can keep Chromium's shutdown worker
      // alive. Prepare a narrow post-window-close escape only after real work
      // and provider children have settled; beforeunload still has the final say.
      if (secrets.isPending()) { shutdownProviderAuthRuntime(); await shutdownProviderAuthRuntimeForUpdate(); boundedQuitReady = true; }
      window?.webContents.session.flushStorageData();
      quitting = true; stopUpdateChecks();
      shutdownProviderAuthRuntime(); app.quit();
    } catch (error) { quitting = false; console.error(safeError(error)); }
    finally {
      if (!quitting) { boundedQuitReady = false; quitPending = false; teams.resumeAfterQuit(); startRoutines(); window?.show(); window?.focus(); }
    }
  };
  app.on('before-quit', event => {
    if (quitting) return; event.preventDefault();
    if (updatePending) { if (updateHandoff) void cancelUpdateHandoff(); return; }
    if (!quitPending) void prepareQuit();
  });
  app.on('will-quit', () => {
    if (!quitting || updatePending || !boundedQuitReady || !secrets.isPending() || quitWatchdogArmed || (window && !window.isDestroyed())) return;
    quitWatchdogArmed = true;
    const failed = () => console.error('macOS 보안 저장소 대기 중 앱 종료 확인 프로세스를 시작하지 못했습니다.');
    try { startQuitWatchdog({executable: process.execPath, parentPid: process.pid, onError: failed}); } catch { failed(); }
  });
  void app.whenReady().then(async () => {
    Menu.setApplicationMenu(Menu.buildFromTemplate([
      { label: '벤디트봇', submenu: [{ role: 'about', label: '벤디트봇 정보' }, { type: 'separator' }, { role: 'hide', label: '벤디트봇 가리기' }, { role: 'quit', label: '벤디트봇 종료' }] },
      { label: '편집', submenu: [{ role: 'undo' }, { role: 'redo' }, { type: 'separator' }, { role: 'cut' }, { role: 'copy' }, { role: 'paste' }, { role: 'selectAll' }] },
      { label: '보기', submenu: [{ role: 'resetZoom' }, { role: 'zoomIn' }, { role: 'zoomOut' }, { role: 'togglefullscreen' }] },
    ]));
    app.setAboutPanelOptions({ applicationName: '벤디트봇', applicationVersion: productVersion, copyright: 'VenditBot · 개인용 로컬 AI 작업 공간' });
    window = new BrowserWindow({ width: 1220, height: 850, minWidth: 860, minHeight: 640, title: '벤디트봇', backgroundColor: '#ffffff', show: false, webPreferences: { preload: join(app.getAppPath(), 'preload.cjs'), contextIsolation: true, nodeIntegration: false, sandbox: true, webSecurity: true } });
    window.on('close', event => { if (!quitting) {event.preventDefault(); app.quit();} });
    window.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));
    window.webContents.on('will-navigate', event => event.preventDefault());
    window.webContents.on('will-prevent-unload', () => {
      if (updatePending) void cancelUpdateHandoff();
      else if (quitting) { boundedQuitReady = false; quitting = false; quitPending = false; teams.resumeAfterQuit(); startUpdateChecks(); startRoutines(); window?.show(); window?.focus(); }
    });
    window.webContents.session.setPermissionRequestHandler((_contents, _permission, callback) => callback(false));
    ipcMain.handle('venditbot:request', async (event, payload: unknown) => {
      try {
        if (!window || event.sender !== window.webContents || event.senderFrame !== window.webContents.mainFrame || event.senderFrame.url !== rendererUrl) throw new Error('허용되지 않은 화면의 요청입니다.');
        const data = object(payload), method = string(data.method);
        await startupGate;
        if (startupFailure) throw new Error(startupFailure);
        const tracked = !updateReadOnly.has(method) && method !== 'checkUpdate' && method !== 'installUpdate';
        if (tracked) pendingRequests++;
        try { return { ok: true, value: await request(method, data.args) }; }
        finally { if (tracked) pendingRequests--; }
      } catch (error) { return { ok: false, error: safeError(error) }; }
    });
    await window.loadFile(rendererPath); await updater.acknowledgeStartup(); releaseStartup(); window.show();
    startUpdateChecks(); startRoutines();
  }).catch(async error => {
    startupFailure = safeError(error); releaseStartup(); console.error(startupFailure);
    try { await shutdownProviderAuthRuntimeForUpdate(); } catch { shutdownProviderAuthRuntime(); }
    app.exit(1);
  });
}
