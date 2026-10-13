import { ChatScroll } from './chat-scroll';
import {ChatTurnList, validSendReceipts, type SendReceipts} from './chat-turns';
import { AttachmentList, useChatAttachments } from './chat-attachments';
import { ChatComposer } from './chat-composer';
import { FeedbackButton } from './feedback-ui';
import {AppConnectionsDialog,type AppConnectionGuard} from './app-connections-ui';
import {validRoutine,type Routine} from '../../source/shared/routines';
import {MessageHeader,ConnectionAttempts} from './message-header';
export {ConnectionAttempts} from './message-header';
import {RoutinesView} from './routines-ui';
import {blankRoutine,editRoutine,routineInput,routineEditDrafts,type RoutineEdit,type RoutineFilter} from './routine-drafts';
import {DevelopmentRoutingPicker} from './development-routing';
/** @jsxRuntime classic */
/** @jsx React.createElement */
/** @jsxFrag React.Fragment */
import type * as ReactTypes from 'react';
import type { ApiProviderProfile } from '../../source/shared/api-provider-config';
import { AgentAvatar, AgentAvatarEditor, type AgentAvatarAsset } from './agent-avatar';
import { Markdown } from './markdown-view';
import { AgentSidebarCards, TeamSidebarCards } from './sidebar-profiles';
import { SidebarResizeHandle, useSidebarWidth } from './sidebar-layout';
import type { ContextMenuAnchor } from './context-menu-position';
import { AgentMenu } from './agent-menu';
import { useSidebarOrder } from './sidebar-order';
import { SidebarAddMenu } from './sidebar-add-menu';
import { ActionApproval } from './action-approval';
import { ActionRulesSettings } from './action-rules-ui';
import { normalizeActionRules } from '../../source/shared/action-rules';
import { PolicySettings, AgentAutomationPicker, PolicySelectionSummary, blankPolicyEdit } from './policy-ui';
import { normalizeAgentPolicyDraft, type AgentPolicy, type AgentPolicySelection, type AgentPolicyRule, type EfficiencyPresetId, type TaskKind } from '../../source/shared/agent-policy';
import { avatarJobPending, mergeAvatarJob, type AvatarJob } from './avatar-jobs';
import { DraftRecovery } from './draft-recovery';
import { RabbitSettings } from './rabbit-settings';
import { mergeRabbitRun, type RabbitEditDraft, type RabbitWorkDraft } from './rabbit-ui-state';
import { useLocalDraft, textDrafts, agentEditDrafts, teamEditDrafts, policyEditDrafts, actionRulesEdits, rabbitEditDrafts, rabbitWorkDrafts, clearMatchingDraft, type AgentEditDraft, type TeamEditDraft, type PolicyEditDraft, type ActionRulesEditDraft } from './draft-storage';
import { UpdateControl } from './update-control';
import { TeamChat } from './team-chat';
import { TeamsOverview, TeamEditor, TeamRunView } from './teams-ui';
import { reduceStateEvent, reduceApprovalEvent, needsAuthPolling, credentialStorageNote, shouldSendOnEnter, refreshAfter, SnapshotClock, type Profile, type Approval, type State, type Auth, type UiEvent, type QueueEvent, type AgentProfile, type AgentDraft, sessionInProgress, sessionsForAgent, composerDraftKey, promoteSubmittedDraft, clearSubmittedDrafts, mergeAgentSnapshot, connectionRoutes, withAgentConnections, moveAgentConnection, maxAgentConnections, type AgentConnection, type ConnectionAttempt, type TeamProfile, type TeamDraft, type TeamRun, type TeamRunSummary, mergeTeamSnapshot, teamDraftForRequest, teamRunInProgress, UiEventBatcher, mergeTeamRunResult, teamEditConflict, visibleHistorySessions, latestAgentConversation, latestTeamConversation, teamConversationHistory, teamContinuationId } from './ui-state';
import { accountKey, isCliProvider, catalogModelSelection, reconcileModelSelection, selectionForRequest, CatalogRequestGate, catalogModelLabel, agentConnectionsForRequest, type CliProvider, type ModelCatalog, type ModelSelection, type CatalogState } from './model-catalog';

// VDS is the user's supplied upstream 2.11.0 bundle. Native input props are forwarded
// by its implementation even though its exported story declarations omit them.
declare global {
  interface Window {
    React: typeof ReactTypes;
    ReactDOM: { createRoot(element: HTMLElement): { render(node: ReactTypes.ReactNode): void } };
    VDS: Record<string, any>;
    venditbot?: { invoke(method: string, args?: unknown): Promise<any>; onEvent(callback: (event: any) => void): () => void };
  }
}
const React = window.React;
const { useEffect, useRef, useState } = React;
const { VDSProvider, Button, Icon, Badge, TextInput, TextArea, Checkbox, Dialog } = window.VDS;
const icons = window.VDS;
const names: Record<string, string> = { codex: 'Codex', 'claude-code': 'Claude', openai: 'OpenAI API', anthropic: 'Anthropic API', openrouter: 'OpenRouter', 'openai-compatible': 'OpenAI 호환 API' };
const endpoints: Record<string, string> = { openai: 'https://api.openai.com/v1', anthropic: 'https://api.anthropic.com/v1', openrouter: 'https://openrouter.ai/api/v1', 'openai-compatible': '' };
const blankState: State = { profiles: [], agents: [], teams: [], teamRuns: [], sessions: [], queue: { running: [], queued: [] }, activeRun: null, unsavedSessionIds: [], version: '불러오는 중' };
const blankAuth: Auth = { phase: 'disconnected', authenticated: false, inferenceVerified: false };
const phaseNames: Record<string, string> = { disconnected: '미연결', preparing: '연결 준비 중', 'awaiting-browser': '브라우저 로그인 대기', authenticated: '로그인됨 · 응답 미확인', testing: '연결 확인 중', ready: '사용 가능', cancelled: '취소됨', error: '연결 확인 필요', 'policy-blocked': '연결 조건 확인 필요' };
const panel = 'bg-background-base-elevate border border-solid border-line-outline-stroke rounded-xl';
function Glyph({ name, size = 18 }: { name: string; size?: number }) { const glyph = icons[`ic_${name}`]; return glyph ? <Icon glyph={glyph} size={size} /> : null; }
async function invoke(method: string, args?: unknown) { if (!window.venditbot) throw new Error('데스크톱 앱에서 연결과 대화 기능을 사용할 수 있습니다.'); return await window.venditbot.invoke(method, args); }
function authLabel(status: Auth) { return status.inferenceVerified ? '사용 가능' : phaseNames[status.phase] ?? status.phase; }
function emptyProfile(): ApiProviderProfile { return { schemaVersion: 1, id: '', name: '', provider: 'openai', authMethod: 'api-key', model: '', baseUrl: endpoints.openai!, protocol: 'responses', allowInsecureLoopback: false, capabilities: { tools: false, images: false, structuredOutput: false } }; }


export function ModelPicker({ provider, auth, state, selection, context, scope, disabled, onModel, onEffort, onRefresh }: { provider: CliProvider; auth: Auth; state?: CatalogState; selection: ModelSelection; context: '대화' | '연결 확인' | '에이전트' | '작업 정책'; scope?: string; disabled?: boolean; onModel(id: string): void; onEffort(effort: string): void; onRefresh(): void }) {
  const label = `${context}${scope ? ` ${scope}` : ''}`;
  const matching = state?.accountKey === accountKey(auth);
  const phase = matching ? state.phase : 'idle';
  const catalog = matching && phase === 'ready' ? state.catalog : undefined;
  const model = catalog?.models.find(item => item.id === selection.model);
  return <div className="model-picker" aria-label={`${names[provider]} ${label} 모델 설정`}>
    {!auth.authenticated ? <p className="typo-l1/r text-glyph-gray-description">로그인하면 사용 가능한 모델과 추론 강도를 불러옵니다.</p> : <>
      <div className="model-picker-fields">
        <label className="form-field typo-l1/m text-glyph-gray-description">{context} 모델<select aria-label={`${names[provider]} ${label} 모델`} className="select-control bg-background-base-normal text-glyph-gray-body border border-solid border-line-outline-stroke typo-b3/r" value={model?.id ?? ''} disabled={disabled || !catalog} onChange={event => onModel(event.target.value)}><option value="">{phase === 'loading' ? '모델 불러오는 중…' : '모델을 선택하세요'}</option>{catalog?.models.map(item => <option key={item.id} value={item.id}>{catalogModelLabel(item)}</option>)}</select></label>
        <label className="form-field typo-l1/m text-glyph-gray-description">추론 강도<select aria-label={`${names[provider]} ${label} 추론 강도`} className="select-control bg-background-base-normal text-glyph-gray-body border border-solid border-line-outline-stroke typo-b3/r" value={model && selection.effort && model.efforts.includes(selection.effort) ? selection.effort : ''} disabled={disabled || !model || !model.efforts.length} onChange={event => onEffort(event.target.value)}><option value="">{model && !model.efforts.length ? '이 모델은 별도 설정 없음' : '공급자 기본값'}</option>{model?.efforts.map(effort => <option key={effort} value={effort}>{effort}{effort === model.defaultEffort ? ' · 기본' : ''}</option>)}</select></label>
      </div>
      <div className="model-picker-status"><span className={`typo-l2/r ${phase === 'error' ? 'text-glyph-danger-body' : 'text-glyph-gray-caption'}`} role={phase === 'error' ? 'alert' : 'status'}>{phase === 'error' ? state?.error : phase === 'loading' ? '공식 모델 목록을 불러오고 있습니다.' : catalog ? `모델 목록 업데이트 · ${new Date(catalog.fetchedAt).toLocaleString()}` : '공식 모델 목록을 확인하세요.'}</span><Button kind="common" hierarchy="ghost" size="xsmall" disabled={disabled || phase === 'loading'} onPress={onRefresh}>{phase === 'error' ? '다시 시도' : '목록 새로고침'}</Button></div>
      {catalog?.warning && <p className="typo-l1/r text-glyph-warning-body" role="status">{catalog.warning}</p>}
      {model && <p className="model-exact-id typo-l2/r text-glyph-gray-description">모델 ID · {model.resolvedId || model.id}{model.resolvedId && model.resolvedId !== model.id ? ` · 선택 ID ${model.id}` : ''}</p>}
      {model?.description && <p className="model-description typo-l2/r text-glyph-gray-caption">{model.description}</p>}
    </>}
  </div>;
}

export function ConnectionRoutes({ routes, connectionName, label = '연결 우선순위' }: { routes: AgentConnection[]; connectionName(id: string): string; label?: string }) {
  return <ol className="connection-routes typo-l1/r text-glyph-gray-description" aria-label={label}>{routes.map((route, index) => <li key={index}><span className="route-priority typo-l2/m text-glyph-vendit-heading">{index + 1}순위</span><span>{connectionName(route.connectionId)} · {route.model}{route.effort ? ` · ${route.effort}` : ''}</span></li>)}</ol>;
}

export function AgentConnectionsEditor({ routes, profiles, auth, catalogs, disabled, onChange, onLoad, contextLabel }: { contextLabel?: string; routes: AgentConnection[]; profiles: Profile[]; auth: Record<string, Auth>; catalogs: Partial<Record<CliProvider, CatalogState>>; disabled?: boolean; onChange(routes: AgentConnection[]): void; onLoad(provider: CliProvider, refresh?: boolean): void }) {
  const update = (index: number, route: AgentConnection) => onChange(routes.map((item, at) => at === index ? route : item));
  return <div className="agent-connections"><div className="agent-connections-heading"><h3 className="typo-b3/sb text-glyph-gray-heading">AI 연결 우선순위</h3><span className="typo-l2/r text-glyph-gray-caption">{routes.length} / {maxAgentConnections}</span></div><p className="typo-l1/r text-glyph-gray-description">위에서부터 시도합니다. 응답이나 도구 실행이 시작되기 전 실패하면 다음 연결을 사용합니다. 시작 후 실패하면 중복 실행을 막기 위해 중단합니다.</p><p className="typo-l1/r text-glyph-gray-caption">연결 전환 시 이전 완료 대화를 다음 AI에 문맥으로 전달합니다.</p>{routes.map((route, index) => {
    const provider = isCliProvider(route.connectionId) ? route.connectionId : undefined;
    const profile = profiles.find(item => item.id === route.connectionId);
    return <section key={index} className="agent-connection-row bg-background-base-subtle border border-solid border-line-outline-stroke rounded-lg" aria-label={`${index + 1}순위 AI 연결`}><div className="agent-connections-heading"><span className="typo-b3/sb text-glyph-gray-heading">{index + 1}순위</span><div className="route-actions"><Button kind="common" hierarchy="ghost" size="xsmall" disabled={disabled || index === 0} onPress={() => onChange(moveAgentConnection(routes, index, -1))}>{index + 1}순위 위로</Button><Button kind="common" hierarchy="ghost" size="xsmall" disabled={disabled || index === routes.length - 1} onPress={() => onChange(moveAgentConnection(routes, index, 1))}>{index + 1}순위 아래로</Button><Button kind="common" hierarchy="ghost" size="xsmall" disabled={disabled || routes.length === 1} onPress={() => onChange(routes.filter((_, at) => at !== index))}>{index + 1}순위 삭제</Button></div></div>
      <label className="form-field typo-l1/m text-glyph-gray-description">AI 연결<select aria-label={`${contextLabel ?? '에이전트'} ${index + 1}순위 AI 연결`} className="select-control bg-background-base-normal text-glyph-gray-body border border-solid border-line-outline-stroke typo-b3/r" value={route.connectionId} disabled={disabled} onChange={event => { const id = event.target.value; update(index, { connectionId: id, model: profiles.find(item => item.id === id)?.model ?? '' }); if (isCliProvider(id) && auth[id]?.authenticated) onLoad(id); }}><option value="">연결을 선택하세요</option>{(['codex', 'claude-code'] as const).map(id => <option key={id} value={id}>{names[id]} · {auth[id]?.authenticated ? '로그인됨' : '로그인 필요'}</option>)}{profiles.map(item => <option key={item.id} value={item.id}>{item.name} · API</option>)}{route.connectionId && !provider && !profile && <option value={route.connectionId}>삭제된 API 연결 · 다시 선택하세요</option>}</select></label>
      {provider ? <ModelPicker provider={provider} auth={auth[provider] ?? blankAuth} state={catalogs[provider]} selection={route} context={contextLabel ? '작업 정책' : '에이전트'} scope={`${contextLabel ? `${contextLabel} ` : ''}${index + 1}순위`} disabled={disabled} onModel={id => { const catalog = catalogs[provider]?.catalog; if (catalog) update(index, { connectionId: provider, ...catalogModelSelection(catalog, id) }); }} onEffort={effort => update(index, { connectionId: provider, model: route.model, ...(effort ? { effort } : {}) })} onRefresh={() => onLoad(provider, true)} /> : profile && <TextInput label={`${index + 1}순위 API 모델 ID`} value={profile.model} readOnly desc="API 연결에 저장한 모델을 사용합니다. 다른 모델은 설정의 연결에서 별도 API 연결로 저장하세요." />}
    </section>;
  })}<Button kind="common" hierarchy="secondary" size="medium" disabled={disabled || routes.length >= maxAgentConnections} onPress={() => onChange([...routes, { connectionId: '', model: '' }])}>후순위 연결 추가</Button></div>;
}

type AppView = 'routines' | 'drafts' | 'chat' | 'settings' | 'agents' | 'agent' | 'agent-edit' | 'teams' | 'team' | 'team-edit' | 'team-run';
// Initial snapshots also allow deterministic rendering checks without native IPC.
export function App({ initialState = blankState, initialAuth = { codex: blankAuth, 'claude-code': blankAuth }, initialView = 'chat', initialAgentId = '', initialSessionId = '', initialCatalogs = {}, initialTeamId = '', initialTeamRunId = '', initialTeamDetails = {} }: { initialState?: State; initialAuth?: Record<string, Auth>; initialView?: AppView; initialAgentId?: string; initialSessionId?: string; initialCatalogs?: Partial<Record<CliProvider, CatalogState>>; initialTeamId?: string; initialTeamRunId?: string; initialTeamDetails?: Record<string, TeamRun> } = {}) {
  const sidebar = useSidebarWidth();
  const [appConnectionsOpen,setAppConnectionsOpen]=useState(false);
  const [composerFocus,setComposerFocus]=useState(0);
  const [feedbackGuard,setFeedbackGuard]=useState({dirty:false,pending:false});
  const [appConnectionGuard,setAppConnectionGuard]=useState<AppConnectionGuard>({dirty:false,pending:false});
  const [state, setState] = useState<State>(initialState);
  const [sendReceipts, setSendReceipts, sendReceiptStorage] = useLocalDraft<SendReceipts>('chat-send-receipts', {}, validSendReceipts);
  const [connectionSection, setConnectionSection] = useState<'models' | 'rabbit'>('models');
  const [rabbitEditKey, setRabbitEditKey] = useState('new');
  const [rabbitEdits, setRabbitEdits, rabbitEditStorage] = useLocalDraft<Record<string, RabbitEditDraft>>('rabbit-edits', {}, rabbitEditDrafts);
  const [rabbitWork, setRabbitWork, rabbitWorkStorage] = useLocalDraft<Record<string, RabbitWorkDraft>>('rabbit-work', {}, rabbitWorkDrafts);
  const [rabbitGuard, setRabbitGuard] = useState({ keyDirty: false, pending: false });
  const [settingsSection, setSettingsSection] = useState<'connections' | 'routines' | 'policies' | 'rules' | 'updates'>('connections');
  const routineEditorClock=useRef(0);
  const [routineFilter,setRoutineFilter]=useState<RoutineFilter>();
  const [routineKey,setRoutineKey]=useState('');
  const [routineEdits,setRoutineEdits,routineStorage]=useLocalDraft<Record<string,RoutineEdit>>('routine-edits',{},routineEditDrafts);
  const [deleteRoutine,setDeleteRoutine]=useState<Routine>();
  const [acknowledgeRoutine,setAcknowledgeRoutine]=useState<Routine>();
  const [savedRuleEdits, setSavedRuleEdits, ruleEditStorage] = useLocalDraft<Record<string, ActionRulesEditDraft>>('action-rules', {}, actionRulesEdits);
  const [policyKey, setPolicyKey] = useState('new');
  const [deletePolicyId, setDeletePolicyId] = useState('');
  const [policyPreview, setPolicyPreview] = useState<AgentPolicySelection>();
  const policyPreviewRevision = useRef(0);
  const [savedPolicyEdits, setSavedPolicyEdits, policyEditStorage] = useLocalDraft<Record<string, PolicyEditDraft>>('policy-edits', {}, policyEditDrafts);
  const [auth, setAuth] = useState<Record<string, Auth>>(initialAuth);
  const [view, setViewState] = useState<AppView>(initialView);
  const [sessionId, setSessionId] = useState(initialSessionId);
  const [agentId, setAgentId] = useState(initialAgentId);
  const [agentDraft, setAgentDraftState] = useState<AgentDraft>({ name: '', instructions: '', connectionId: '', model: '' });
  const [teamId, setTeamId] = useState(initialTeamId);
  const [teamRunId, setTeamRunId] = useState(initialTeamRunId);
  const [teamDraft, setTeamDraftState] = useState<TeamDraft>({ name: '', instructions: '', memberAgentIds: [], rounds: 1, autonomous: false });
  const [teamEditUpdatedAt, setTeamEditUpdatedAt] = useState('');
  const [teamDrafts, setTeamDrafts, teamPromptStorage] = useLocalDraft<Record<string, string>>('team-prompts', {}, textDrafts);
  const [savedAgentEdits, setSavedAgentEdits, agentEditStorage] = useLocalDraft<Record<string, AgentEditDraft>>('agent-edits', {}, agentEditDrafts);
  const [savedTeamEdits, setSavedTeamEdits, teamEditStorage] = useLocalDraft<Record<string, TeamEditDraft>>('team-edits', {}, teamEditDrafts);
  const agentEditorActive = useRef(false), teamEditorActive = useRef(false);
  const [teamRecipients, setTeamRecipients] = useState<Record<string, string>>({});
  const [teamDetails, setTeamDetails] = useState<Record<string, TeamRun>>(initialTeamDetails);
  const [teamDetailErrors, setTeamDetailErrors] = useState<Record<string, string>>({});
  const [teamLoading, setTeamLoading] = useState<Record<string, boolean>>({});
  const [deleteTeamId, setDeleteTeamId] = useState('');
  const [deleteTeamRunId, setDeleteTeamRunId] = useState('');
  const teamReadGenerations = useRef(new Map<string, number>());
  const [avatarAssets, setAvatarAssets] = useState<Record<string, AgentAvatarAsset>>({});
  const avatarAssetsRef = useRef(avatarAssets); avatarAssetsRef.current = avatarAssets;
  const [avatarPrompt, setAvatarPromptState] = useState('');
  const [avatarModePreference, setAvatarModePreferenceState] = useState<'image' | 'illustration'>();
  const [avatarErrors, setAvatarErrors] = useState<Record<string, string>>({});
  const avatarRequests = useRef(new Set<string>());
  const avatarLoads = useRef(new Set<string>());
  const agentEditRevision = useRef(0);
  const viewRef = useRef(view); viewRef.current = view;
  const [deleteAgentId, setDeleteAgentId] = useState('');
  const [agentMenuId, setAgentMenuId] = useState('');
  const [teamMenuId, setTeamMenuId] = useState('');
  const [menuAnchor, setMenuAnchor] = useState<ContextMenuAnchor | undefined>(undefined);
  const [addMenuOpen, setAddMenuOpen] = useState(false);
  const addMenuAnchor = useRef<HTMLDivElement>(null);
  const [connectionId, setConnectionId] = useState('');
  const [promptDrafts, setPromptDrafts, promptStorage] = useLocalDraft<Record<string, string>>('prompts', {}, textDrafts);
  const [notice, setNotice] = useState<{ text: string; error: boolean } | null>(null);
  const [busy, setBusy] = useState<Record<string, boolean>>({});
  const [draft, setDraft] = useState<ApiProviderProfile>(emptyProfile);
  const apiDraftBase = useRef(JSON.stringify(emptyProfile()));
  const apiFormRevision = useRef(0);
  const [apiKey, setApiKey] = useState('');
  const [deleteId, setDeleteId] = useState('');
  const [workspacePath, setWorkspacePath] = useState('');
  const [approvals, setApprovals] = useState<Approval[]>([]);
  const [sessionAction, setSessionAction] = useState<'rename' | 'delete' | 'export' | null>(null);
  const [renameTitle, setRenameTitle] = useState('');
  const [visibleCount, setVisibleCount] = useState(50);
  const [catalogs, setCatalogs] = useState<Partial<Record<CliProvider, CatalogState>>>(initialCatalogs);
  const [modelSelections, setModelSelections] = useState<Record<CliProvider, ModelSelection>>({ codex: { model: '' }, 'claude-code': { model: '' } });
  const catalogGate = useRef(new CatalogRequestGate());
  const catalogAccounts = useRef<Record<CliProvider, string>>({ codex: '', 'claude-code': '' });
  const authRef = useRef(auth); authRef.current = auth;
  const started = useRef(false);
  const stateClock = useRef(new SnapshotClock());
  const eventBatcher = useRef<UiEventBatcher | undefined>(undefined);
  const authClock = useRef(new SnapshotClock());
  const busyActions = useRef(new Set<string>());
  const viewRevision = useRef(0);
  const setView = (next: AppView) => { viewRevision.current++; setViewState(next); if (next === 'chat' || next === 'team') setComposerFocus(value => value + 1); };
  const agentDraftRef = useRef(agentDraft); agentDraftRef.current = agentDraft;
  const teamDraftRef = useRef(teamDraft); teamDraftRef.current = teamDraft;
  const avatarPromptRef = useRef(avatarPrompt); avatarPromptRef.current = avatarPrompt;
  const avatarModeRef = useRef(avatarModePreference); avatarModeRef.current = avatarModePreference;
  const saveAgentEdit = (next: AgentDraft, promptText = avatarPromptRef.current, mode = avatarModeRef.current) => { if (agentEditorActive.current) setSavedAgentEdits(previous => ({ ...previous, [next.id ?? 'new']: { ...previous[next.id ?? 'new'], draft: next, avatarPrompt: promptText, ...(mode ? { avatarMode: mode } : {}) } })); };
  const setAgentDraft: ReactTypes.Dispatch<ReactTypes.SetStateAction<AgentDraft>> = action => { const next = typeof action === 'function' ? action(agentDraftRef.current) : action; if (next === agentDraftRef.current) return; if (!avatarJobPending(selectedAvatarJob) && JSON.stringify(connectionRoutes(next)[0]) !== JSON.stringify(connectionRoutes(agentDraftRef.current)[0])) clearAvatarError(); agentDraftRef.current = next; setAgentDraftState(next); saveAgentEdit(next); };
  const setTeamDraft: ReactTypes.Dispatch<ReactTypes.SetStateAction<TeamDraft>> = action => { const next = typeof action === 'function' ? action(teamDraftRef.current) : action; teamDraftRef.current = next; setTeamDraftState(next); if (teamEditorActive.current) setSavedTeamEdits(previous => ({ ...previous, [next.id ?? 'new']: { draft: next, expectedUpdatedAt: teamEditUpdatedAt } })); };
  const setAvatarPrompt = (text: string) => { avatarPromptRef.current = text; setAvatarPromptState(text); saveAgentEdit(agentDraftRef.current, text); };
  const setAvatarModePreference = (mode: 'image' | 'illustration') => { if (avatarModeRef.current !== mode && !avatarJobPending(selectedAvatarJob)) clearAvatarError(); avatarModeRef.current = mode; setAvatarModePreferenceState(mode); saveAgentEdit(agentDraftRef.current, avatarPromptRef.current, mode); };
  const promptKey = composerDraftKey(sessionId, agentId);
  const prompt = promptDrafts[promptKey] ?? '';
  const setPrompt = (text: string) => setPromptDrafts(previous => ({ ...previous, [promptKey]: text }));
  const current = state.sessions.find(session => session.id === sessionId);
  const running = state.activeRun != null;
  const runHere = state.activeRun?.sessionId === sessionId || !!state.queue?.running.includes(sessionId);
  const queuedHere = !!state.queue?.queued.includes(sessionId);
  const sessionBusy = sessionInProgress(state, sessionId);
  const steerHere = state.activeRun?.sessionId === sessionId && state.activeRun.inputCapability === 'steer' && !(state.chatTurns ?? []).some(turn => turn.sessionId === sessionId && (turn.delivery?.phase === 'unknown' || ['queued','paused'].includes(turn.status) || turn.status === 'failed' && !turn.continueAfter));
  const agents = state.agents ?? [];
  const selectedAgent = agents.find(agent => agent.id === agentId);
  const teams = state.teams ?? [], teamRuns = state.teamRuns ?? [];
  const sidebarOrder = useSidebarOrder(agents.map(agent => agent.id), teams.map(team => team.id));
  const sidebarAgents = sidebarOrder.agents.map(id => agents.find(agent => agent.id === id)!).filter(Boolean);
  const sidebarTeams = sidebarOrder.teams.map(id => teams.find(team => team.id === id)!).filter(Boolean);
  const policies = state.policies ?? [];
  const ruleRecord = savedRuleEdits.current ?? (state.actionRules ? { rules: state.actionRules, expectedUpdatedAt: state.actionRules.updatedAt } : undefined);
  const ruleConflict = ruleRecord && state.actionRules && ruleRecord.expectedUpdatedAt !== state.actionRules.updatedAt ? '규칙이 변경되었습니다. 현재 초안을 보관하고 최신 규칙을 다시 불러오세요.' : undefined;
  const selectedPolicy = policies.find(policy => policy.id === policyKey);
  const policyRecord = savedPolicyEdits[policyKey] ?? (selectedPolicy ? { draft: selectedPolicy, expectedUpdatedAt: selectedPolicy.updatedAt, previewAgentId: '', previewText: '' } : blankPolicyEdit());
  const policyConflict = policyRecord.draft.id && (!selectedPolicy || selectedPolicy.updatedAt !== policyRecord.expectedUpdatedAt) ? '정책이 변경되었거나 삭제되었습니다. 현재 초안을 보관하고 최신 정책을 다시 불러오세요.' : undefined;
  const routines=state.routines??[];
  const selectedRoutine=routines.find(r=>r.id===(routineEdits[routineKey]?.draft.id??routineKey));
  const routineRecord=routineEdits[routineKey]??(selectedRoutine?editRoutine(selectedRoutine):undefined);
  const routineConflict=routineRecord?.draft.id&&(!selectedRoutine||selectedRoutine.revision!==routineRecord.expectedRevision)?'루틴이 변경되었거나 삭제되었습니다. 최신 내용을 확인해 주세요.':undefined;
  const selectedTeam = teams.find(team => team.id === teamId);
  const teamConflict = teamEditConflict(teamDraft, teamEditUpdatedAt, teams);
  const historySessions = visibleHistorySessions(state);
  const selectedTeamRun = teamRuns.find(run => run.id === teamRunId);
  const teamChatHistory = teamConversationHistory(teamRuns, teamRunId);
  const teamChatKey = teamRunId ? `chat:${teamRunId}` : `new-chat:${teamId}`;
  const teamChatPrompt = teamDrafts[teamChatKey] ?? '';
  const setTeamChatPrompt = (text: string) => setTeamDrafts(previous => ({ ...previous, [teamChatKey]: text }));
  const attachmentKey = view === 'team' ? `team:${teamChatKey}` : promptKey;
  const attachments = useChatAttachments(attachmentKey, invoke);
  const canAttach = view === 'team' ? !!selectedTeam : view === 'chat' && !current?.teamRunId && current?.purpose !== 'avatar';
  const teamMessageKey = `message:${teamRunId}`;
  const teamMessage = teamDrafts[teamMessageKey] ?? '';
  const setTeamMessage = (text: string) => setTeamDrafts(previous => ({ ...previous, [teamMessageKey]: text }));
  const taskLabels: Record<string, string> = { queued: '대기 중', running: '실행 중', completed: '완료', failed: '실패', cancelled: '중단됨' };
  const taskLabel = (id: string, fallback?: string) => state.queue?.running.includes(id) ? '실행 중' : state.queue?.queued.includes(id) ? '대기 중' : taskLabels[fallback ?? ''] ?? '대화';
  const approval = approvals[0];
  const selectedProfile = state.profiles.find(profile => profile.id === connectionId);
  const connectionName = (id: string) => state.profiles.find(profile => profile.id === id)?.name ?? names[id] ?? '삭제된 API 연결';
  const avatarEditKey = agentDraft.id ?? 'new';
  const avatarOwnerKey = agentDraft.id ? `agent:${agentDraft.id}` : savedAgentEdits.new?.avatarOwnerKey;
  const selectedAvatarJob = state.avatarJobs?.find(job => job.ownerKey === avatarOwnerKey);
  const avatarError = selectedAvatarJob ? avatarErrors[selectedAvatarJob.requestId] ?? selectedAvatarJob.error : undefined;
  const clearAvatarError = () => { if (selectedAvatarJob) setAvatarErrors(previous => ({ ...previous, [selectedAvatarJob.requestId]: '' })); };
  const avatarUrl = (id?: string) => id ? avatarAssets[id]?.dataUrl : undefined;
  const avatarRoute = connectionRoutes(agentDraft)[0]!;
  const avatarMode = avatarRoute.connectionId === 'codex' ? avatarModePreference ?? 'image' : 'illustration';
  const avatarRouteSelection = isCliProvider(avatarRoute.connectionId) ? selectionForRequest(catalogs[avatarRoute.connectionId], auth[avatarRoute.connectionId], avatarRoute) : state.profiles.find(profile => profile.id === avatarRoute.connectionId);
  const avatarConnectionLabel = avatarRoute.connectionId ? `${connectionName(avatarRoute.connectionId)} · ${avatarRouteSelection?.model || '모델 선택 필요'}${avatarRoute.effort ? ` · ${avatarRoute.effort}` : ''}` : '';
  const notify = (text: string, error = false) => setNotice({ text, error });
  const refresh = () => stateClock.current.read(() => {
    // A live snapshot already includes received deltas; paint them before replacing state.
    eventBatcher.current?.flush();
    return invoke('state') as Promise<State>;
  }, setState, true);
  const refreshAuth = () => authClock.current.read(() => invoke('authStatus') as Promise<Record<string, Auth>>, setAuth, true);
  const loadAvatar = async (id: string) => {
    if (avatarAssetsRef.current[id] || avatarLoads.current.has(id)) return;
    avatarLoads.current.add(id);
    try { const asset = await invoke('getAgentAvatar', { id }) as AgentAvatarAsset; avatarAssetsRef.current = { ...avatarAssetsRef.current, [id]: asset }; setAvatarAssets(previous => ({ ...previous, [id]: asset })); }
    catch { /* Missing assets retain the agent's initial without blocking navigation. */ }
    finally { avatarLoads.current.delete(id); }
  };
  const loadTeamDetail = async (id: string) => {
    const generation = (teamReadGenerations.current.get(id) ?? 0) + 1;
    teamReadGenerations.current.set(id, generation);
    setTeamLoading(previous => ({ ...previous, [id]: true }));
    try {
      const detail = await invoke('getTeamRun', { id }) as TeamRun;
      if (teamReadGenerations.current.get(id) !== generation) return;
      setTeamDetails(previous => ({ ...previous, [id]: detail }));
      setTeamDetailErrors(previous => ({ ...previous, [id]: '' }));
    } catch (error) {
      if (teamReadGenerations.current.get(id) === generation) setTeamDetailErrors(previous => ({ ...previous, [id]: error instanceof Error ? error.message : '팀 대화를 불러오지 못했습니다.' }));
    } finally {
      if (teamReadGenerations.current.get(id) === generation) setTeamLoading(previous => ({ ...previous, [id]: false }));
    }
  };
  const loadCatalog = async (provider: CliProvider, refresh = false) => {
    const identity = accountKey(authRef.current[provider]);
    const generation = catalogGate.current.begin(provider);
    if (catalogAccounts.current[provider] !== identity) {
      const changedKnownAccount = !!catalogAccounts.current[provider];
      catalogAccounts.current[provider] = identity;
      setModelSelections(previous => ({ ...previous, [provider]: { model: '' } }));
      if (changedKnownAccount) setAgentDraft(previous => withAgentConnections(previous, connectionRoutes(previous).map(route => route.connectionId === provider ? { connectionId: provider, model: '' } : route)));
    }
    if (!identity) { setCatalogs(previous => ({ ...previous, [provider]: { phase: 'idle', accountKey: '' } })); setModelSelections(previous => ({ ...previous, [provider]: { model: '' } })); return; }
    setCatalogs(previous => ({ ...previous, [provider]: { phase: 'loading', accountKey: identity } }));
    try {
      const catalog = await invoke('listModels', { provider, refresh }) as ModelCatalog;
      if (!catalogGate.current.current(provider, generation) || accountKey(authRef.current[provider]) !== identity) return;
      if (!catalog.models.length) throw new Error('사용 가능한 모델 목록이 비어 있습니다. 계정 연결을 확인한 뒤 다시 시도하세요.');
      setCatalogs(previous => ({ ...previous, [provider]: { phase: 'ready', accountKey: identity, catalog } }));
      setModelSelections(previous => ({ ...previous, [provider]: reconcileModelSelection(catalog, previous[provider]) }));
    } catch (error) {
      if (!catalogGate.current.current(provider, generation) || accountKey(authRef.current[provider]) !== identity) return;
      setCatalogs(previous => ({ ...previous, [provider]: { phase: 'error', accountKey: identity, error: error instanceof Error ? error.message : '공식 모델 목록을 불러오지 못했습니다.' } }));
    }
  };
  const chooseModel = (provider: CliProvider, id: string) => { const catalog = catalogs[provider]?.catalog; if (catalog) setModelSelections(previous => ({ ...previous, [provider]: catalogModelSelection(catalog, id) })); };
  const chooseEffort = (provider: CliProvider, effort: string) => setModelSelections(previous => {
    const selected = previous[provider], available = catalogs[provider]?.catalog?.models.find(item => item.id === selected.model);
    return { ...previous, [provider]: { model: selected.model, ...(effort && available?.efforts.includes(effort) ? { effort } : {}) } };
  });
  const action = async (id: string, operation: () => Promise<void>) => {
    if (busyActions.current.has(id)) return;
    busyActions.current.add(id);
    setBusy(previous => ({ ...previous, [id]: true })); setNotice(null);
    try { await operation(); } catch (error) { notify(error instanceof Error ? error.message : '작업을 완료하지 못했습니다.', true); }
    finally { busyActions.current.delete(id); setBusy(previous => ({ ...previous, [id]: false })); }
  };
  useEffect(() => {
    if (started.current) return; started.current = true;
    if (!window.venditbot) { notify('미리보기 화면입니다. 실제 연결은 벤디트봇 앱에서 시작하세요.'); return; }
    const batcher = new UiEventBatcher(events => {
      setState(previous => events.reduce(reduceStateEvent, previous));
      for (const event of events) {
        if (event.type === 'delta') continue;
        setApprovals(previous => reduceApprovalEvent(previous, event));
        if (event.type === 'run-end') { if (event.error) notify(event.error, true); else void refresh().catch(error => notify(error.message, true)); void refreshAuth().catch(() => {}); }
        if (event.type === 'auth') { authClock.current.changed(); setAuth(previous => ({ ...previous, [event.provider]: event.status })); }
      }
    });
    eventBatcher.current = batcher;
    const unsubscribe = window.venditbot.onEvent((event: UiEvent | QueueEvent) => {
      // Invalidate snapshots immediately, before the delayed text paint.
      if (event.type !== 'auth') stateClock.current.changed();
      batcher.push(event);
    });
    void Promise.all([refresh(), refreshAuth()]).catch(error => notify(error.message, true));
    return () => { unsubscribe(); batcher.dispose(); stateClock.current.cancel(); authClock.current.cancel(); started.current = false; if (eventBatcher.current === batcher) eventBatcher.current = undefined; };

  }, []);
  const awaitingAuth = needsAuthPolling(auth);
  const codexAccount = accountKey(auth.codex), claudeAccount = accountKey(auth['claude-code']);
  useEffect(() => { void loadCatalog('codex'); }, [codexAccount]);
  useEffect(() => { void loadCatalog('claude-code'); }, [claudeAccount]);
  useEffect(() => { if (!awaitingAuth || !window.venditbot) return; const timer = setInterval(() => void refreshAuth().catch(() => {}), 2000); return () => clearInterval(timer); }, [awaitingAuth]);
  useEffect(() => { if (view === 'settings' && window.venditbot) void Promise.all([refresh(), refreshAuth()]).catch(error => notify(error.message, true)); }, [view]);
  useEffect(() => {
    if (view === 'settings') document.querySelectorAll<HTMLElement>('[data-settings-panel]').forEach(panel => { panel.scrollTop = 0; });
  }, [view, settingsSection, connectionSection]);
  useEffect(() => setVisibleCount(50), [sessionId]);
  useEffect(() => { if (window.venditbot) for (const agent of agents) if (agent.avatarId) void loadAvatar(agent.avatarId); }, [agents]);
  useEffect(() => { if ((view === 'team-run' || view === 'team') && teamRunId && window.venditbot) void loadTeamDetail(teamRunId); }, [view, teamRunId, selectedTeamRun]);
  useEffect(() => { if (view === 'team' && window.venditbot) for (const run of teamChatHistory.slice(0, -1)) if (!teamDetails[run.id]) void loadTeamDetail(run.id); }, [view, teamChatHistory.map(run => run.id).join('|')]);
  const newChat = () => { setSessionId(''); setAgentId(''); setView('chat'); setNotice(null); };
  const newAgentTask = (id: string) => { setSessionId(''); setAgentId(id); setView('chat'); setNotice(null); };
  const openSession = (id: string) => { const session = state.sessions.find(item => item.id === id); if (!session) { notify('작업 대화를 준비 중입니다. 잠시 뒤 다시 열어주세요.'); return; } setSessionId(id); setAgentId(session?.agentId ?? ''); setView('chat'); setNotice(null); };
  const chooseConnection = (id: string) => { setConnectionId(id); if (isCliProvider(id) && auth[id]?.authenticated && catalogs[id]?.phase !== 'loading') void loadCatalog(id); };
  const send = () => void action('send', async () => {
    const attachmentIds = attachments.files.map(file => file.id), sourceAttachmentKey = attachmentKey;
    const text = prompt.trim() || (attachmentIds.length ? '첨부한 내용을 확인해 주세요.' : ''); if (!text || attachments.busy || !attachments.storage.flush() || current?.teamRunId || current?.purpose === 'avatar') return;
    const submitted = prompt, submittedKey = promptKey, submittedView = viewRevision.current;
    if (!current && !selectedAgent && !connectionId) { notify('먼저 사용할 AI 연결을 선택하세요.', true); return; }
    let target = current;
    if (!target) {
      const selection = isCliProvider(connectionId) ? selectionForRequest(catalogs[connectionId], auth[connectionId], modelSelections[connectionId]) : selectedProfile ? { model: selectedProfile.model } : undefined;
      if (!selectedAgent && !selection) throw new Error('로그인 후 공식 모델 목록에서 사용할 모델을 선택하세요.');
      target = await invoke('createSession', selectedAgent ? { agentId: selectedAgent.id } : { connectionId, ...selection, ...(workspacePath ? { workspacePath } : {}) });
      const following = viewRevision.current === submittedView;
      if (following) { attachments.promote(sourceAttachmentKey, composerDraftKey(target!.id, '')); setSessionId(target!.id); }
      setPromptDrafts(previous => promoteSubmittedDraft(previous, submittedKey, composerDraftKey(target!.id, ''), submitted, following));
      stateClock.current.changed(); setState(previous => ({ ...previous, sessions: [target!, ...previous.sessions.filter(session => session.id !== target!.id)] }));
    }
    const content = JSON.stringify([text, attachmentIds]);
    const requestId = sendReceipts[target!.id]?.content === content ? sendReceipts[target!.id]!.id : crypto.randomUUID();
    setSendReceipts(previous => ({...previous, [target!.id]: {id: requestId, content}}));
    if (!sendReceiptStorage.flush()) throw new Error('전송 요청을 저장하지 못했습니다. 입력은 보관했습니다.');
    await invoke('send', { requestId, sessionId: target!.id, text, ...(attachmentIds.length ? {attachmentIds} : {}) });
    attachments.clear([sourceAttachmentKey, composerDraftKey(target!.id, '')], attachmentIds);
    setPromptDrafts(previous => clearSubmittedDrafts(previous, [submittedKey, composerDraftKey(target!.id, '')], submitted));
    setSendReceipts(previous => {const next = {...previous}; delete next[target!.id]; return next;});
  });
  const login = (provider: string) => void action(`login-${provider}`, async () => {
    authClock.current.changed(); setAuth(previous => ({ ...previous, [provider]: { ...previous[provider]!, phase: 'preparing', error: null } }));
    await refreshAfter(() => invoke('login', { provider }), refreshAuth);
  });
  const resetDraft = () => { apiFormRevision.current++; apiDraftBase.current = JSON.stringify(emptyProfile()); setDraft(emptyProfile()); setApiKey(''); setDeleteId(''); };
  const editProfile = (profile: Profile) => { apiFormRevision.current++; const next = { schemaVersion: 1, id: profile.id, name: profile.name, provider: profile.provider, authMethod: 'api-key', model: profile.model, baseUrl: profile.baseUrl, protocol: profile.protocol, allowInsecureLoopback: profile.allowInsecureLoopback, capabilities: profile.capabilities } as ApiProviderProfile; apiDraftBase.current = JSON.stringify(next); setDraft(next); setApiKey(''); setDeleteId(''); document.getElementById('api-form')?.scrollIntoView({ behavior: 'smooth', block: 'center' }); };
  const changeProvider = (provider: ApiProviderProfile['provider']) => { setDraft(previous => ({ ...previous, provider, baseUrl: endpoints[provider]!, protocol: provider === 'anthropic' ? 'anthropic-messages' : provider === 'openrouter' ? 'chat-completions' : 'responses', allowInsecureLoopback: false })); setApiKey(''); };
  const saveProfile = () => void action('save-profile', async () => {
    if (!draft.name.trim() || !draft.model.trim()) throw new Error('연결 이름과 모델 ID를 입력하세요.');
    const revision = apiFormRevision.current, submittedKey = apiKey;
    const profile = { ...draft, id: draft.id || crypto.randomUUID() };
    await invoke('saveProfile', { profile, ...(apiKey.trim() ? { apiKey: apiKey.trim() } : {}) });
    if (apiFormRevision.current === revision) {
      apiDraftBase.current = JSON.stringify(profile);
      setApiKey(previous => previous === submittedKey ? '' : previous);
      setDraft(previous => JSON.stringify(previous) === JSON.stringify(draft) ? profile : !draft.id && !previous.id ? { ...previous, id: profile.id } : previous);
    }
    await refresh(); notify('연결을 저장했습니다. 연결 테스트로 모델 응답을 확인하세요.');
  });
  const respondApproval = (approved: boolean) => { if (!approval) return; void action('approval', async () => { await invoke('respondApproval', { approvalId: approval.approvalId, approved }); setApprovals(previous => previous.filter(item => item.approvalId !== approval.approvalId)); }); };
  const exportSession = (format: 'markdown' | 'json') => void action('session-export', async () => { if (!current) return; const result = await invoke('exportSession', { id: current.id, format }); if (result.saved) { setSessionAction(null); notify('대화를 선택한 파일에 저장했습니다.'); } });
  const allBusy = Object.values(busy).some(Boolean);
  const editAgent = (agent?: AgentProfile) => {
    agentEditRevision.current++; agentEditorActive.current = true; const restored = savedAgentEdits[agent?.id ?? 'new']; setAvatarModePreferenceState(restored?.avatarMode); setAvatarPromptState(restored?.avatarPrompt ?? '');
    const previewAvatar = restored?.draft.avatarId ?? agent?.avatarId; if (previewAvatar) void loadAvatar(previewAvatar);
    setAgentDraftState(restored?.draft ?? (agent ? withAgentConnections({ id: agent.id, name: agent.name, instructions: agent.instructions, ...(agent.avatarId ? { avatarId: agent.avatarId } : {}), ...(agent.automation ? { automation: { ...agent.automation } } : {}), connectionId: agent.connectionId, model: agent.model, ...(agent.workspacePath ? { workspacePath: agent.workspacePath } : {}) }, connectionRoutes(agent).map(route => ({ ...route }))) : withAgentConnections({ name: '', instructions: '', connectionId: '', model: '' }, [{ connectionId: '', model: '' }])));
    if (agent) setAgentId(agent.id);
    setView('agent-edit'); setNotice(null);
    for (const id of new Set(agent ? connectionRoutes(agent).map(route => route.connectionId) : [])) if (isCliProvider(id) && auth[id]?.authenticated) void loadCatalog(id);
  };
  useEffect(() => {
    if (view !== 'agent-edit') return;
    setAgentDraft(previous => {
      let changed = false;
      const routes = connectionRoutes(previous).map(route => {
        if (!isCliProvider(route.connectionId)) return route;
        const status = auth[route.connectionId], catalog = catalogs[route.connectionId];
        if (!status?.authenticated || catalog?.accountKey !== accountKey(status) || catalog.phase !== 'ready' || !catalog.catalog) return route;
        const selection = reconcileModelSelection(catalog.catalog, route);
        if (selection.model === route.model && selection.effort === route.effort) return route;
        changed = true; return { connectionId: route.connectionId, ...selection };
      });
      return changed ? withAgentConnections(previous, routes) : previous;
    });
  }, [catalogs, auth, view]);
  const applyAvatarResult = (job: AvatarJob) => {
    if (job.phase !== 'completed' || !job.assetId) return;
    let updatedDraft: AgentDraft | undefined;
    setSavedAgentEdits(previous => {
      const entry = Object.entries(previous).find(([, record]) => record.avatarRequestId === job.requestId && record.avatarOwnerKey === job.ownerKey);
      if (!entry || entry[1].avatarAppliedRequestId === job.requestId) return previous;
      const [key, record] = entry;
      const visible = viewRef.current === 'agent-edit' && (agentDraftRef.current.id ?? 'new') === key;
      const draft = { ...(visible ? agentDraftRef.current : record.draft), avatarId: job.assetId };
      if (visible) updatedDraft = draft;
      return { ...previous, [key]: { ...record, draft, avatarAppliedRequestId: job.requestId } };
    });
    if (updatedDraft) { agentDraftRef.current = updatedDraft; setAgentDraftState(updatedDraft); }
    void loadAvatar(job.assetId);
  };
  useEffect(() => { for (const job of state.avatarJobs ?? []) if (job.phase === 'completed' && Object.values(savedAgentEdits).some(record => record.avatarOwnerKey === job.ownerKey && record.avatarRequestId === job.requestId && record.avatarAppliedRequestId !== job.requestId)) applyAvatarResult(job); }, [state.avatarJobs, savedAgentEdits]);
  const generateAvatar = async () => {
    const key = agentDraft.id ?? 'new', ownerKey = agentDraft.id ? `agent:${agentDraft.id}` : savedAgentEdits.new?.avatarOwnerKey ?? `draft:${crypto.randomUUID()}`;
    if (avatarRequests.current.has(ownerKey) || avatarJobPending(state.avatarJobs?.find(job => job.ownerKey === ownerKey))) return;
    const requestId = crypto.randomUUID(); avatarRequests.current.add(ownerKey);
    const job: AvatarJob = { requestId, ownerKey, phase: 'validating' };
    const updateJob = (next: AvatarJob) => { stateClock.current.changed(); setState(previous => ({ ...previous, avatarJobs: mergeAvatarJob(previous.avatarJobs, next) })); };
    setSavedAgentEdits(previous => ({ ...previous, [key]: { ...previous[key], draft: agentDraft, avatarPrompt, avatarMode, avatarOwnerKey: ownerKey, avatarRequestId: requestId } }));
    updateJob(job);
    try {
      const [route] = agentConnectionsForRequest([connectionRoutes(agentDraft)[0]!], catalogs, auth, state.profiles);
      if (!avatarPrompt.trim()) throw new Error('원하는 프로필 모습을 입력하세요.');
      const asset = await invoke('generateAgentAvatar', { requestId, ownerKey, ...(agentDraft.id ? { agentId: agentDraft.id } : {}), mode: avatarMode, prompt: avatarPrompt.trim(), ...route }) as AgentAvatarAsset;
      avatarAssetsRef.current = { ...avatarAssetsRef.current, [asset.id]: asset }; setAvatarAssets(previous => ({ ...previous, [asset.id]: asset }));
      const completed: AvatarJob = { ...job, phase: 'completed', assetId: asset.id }; updateJob(completed); applyAvatarResult(completed);
    } catch (error) { updateJob({ ...job, phase: 'failed', error: error instanceof Error ? error.message : '프로필 이미지를 생성하지 못했습니다.' }); }
    finally { avatarRequests.current.delete(ownerKey); }
  };
  const cancelAvatar = async () => {
    const job = selectedAvatarJob; if (!job || !avatarJobPending(job)) return;
    const key = `avatar-cancel-${job.requestId}`; if (busyActions.current.has(key)) return;
    busyActions.current.add(key); setBusy(previous => ({ ...previous, [key]: true }));
    try { await invoke('cancelAgentAvatar', { requestId: job.requestId }); }
    catch (error) { setAvatarErrors(previous => ({ ...previous, [job.requestId]: error instanceof Error ? error.message : '이 프로필 생성을 취소하지 못했습니다.' })); }
    finally { busyActions.current.delete(key); setBusy(previous => ({ ...previous, [key]: false })); }
  };
  const saveAgent = () => void action('save-agent', async () => {
    if (avatarRequests.current.has(avatarOwnerKey ?? '') || avatarJobPending(selectedAvatarJob)) throw new Error('이 에이전트의 프로필 생성 완료 또는 취소 후 저장하세요.');
    if (!agentDraft.name.trim() || !agentDraft.instructions.trim()) throw new Error('에이전트 이름과 역할 지시를 입력하세요.');
    const connections = agentConnectionsForRequest(connectionRoutes(agentDraft), catalogs, auth, state.profiles);
    const submittedView = viewRevision.current, editKey = agentDraft.id ?? 'new', submittedEdit = savedAgentEdits[editKey];
    const existingIds = new Set(agents.map(agent => agent.id));
    const next = await invoke('saveAgent', { agent: { ...withAgentConnections(agentDraft, connections), name: agentDraft.name.trim(), instructions: agentDraft.instructions.trim() } }) as State;
    stateClock.current.changed(); setState(previous => mergeAgentSnapshot(previous, next));
    const saved = agentDraft.id ? next.agents.find(agent => agent.id === agentDraft.id) : next.agents.find(agent => !existingIds.has(agent.id));
    if (submittedEdit) setSavedAgentEdits(previous => clearMatchingDraft(previous, editKey, submittedEdit));
    if (viewRevision.current === submittedView) { agentEditorActive.current = false; if (saved) openAgent(saved.id); else setView('agents'); }
    notify('에이전트를 저장했습니다. 새 작업에서 역할과 연결 우선순위를 사용합니다.');
  });
  const cloneAgent = () => void action(`clone-agent-${agentMenuId}`, async () => {
    const source = agents.find(agent => agent.id === agentMenuId); if (!source) return;
    const submittedView = viewRevision.current;
    const result = await invoke('cloneAgent', { id: source.id, expectedUpdatedAt: source.updatedAt }) as { state: State; agent: AgentProfile; avatarRequestId?: string };
    stateClock.current.changed(); setState(previous => mergeAgentSnapshot(previous, result.state)); setAgentMenuId(current => current === source.id ? '' : current);
    if (result.avatarRequestId) { const { createdAt, updatedAt, ...draft } = result.agent; setSavedAgentEdits(previous => ({ ...previous, [draft.id]: { draft, avatarPrompt: '', avatarMode: 'image', avatarOwnerKey: `agent:${draft.id}`, avatarRequestId: result.avatarRequestId } })); }
    if (viewRevision.current === submittedView) editAgent(result.agent);
    notify(`${result.agent.name}을 만들었습니다.`);
  });
  const cloneTeam = () => void action(`clone-team-${teamMenuId}`, async () => {
    const source = teams.find(team => team.id === teamMenuId); if (!source) return;
    const submittedView = viewRevision.current;
    const result = await invoke('cloneTeam', { id: source.id, expectedUpdatedAt: source.updatedAt }) as { state: State; team: TeamProfile };
    stateClock.current.changed(); setState(previous => mergeTeamSnapshot(previous, result.state)); setTeamMenuId(current => current === source.id ? '' : current);
    if (viewRevision.current === submittedView) editTeam(result.team);
    notify(`${result.team.name}을 만들었습니다.`);
  });
  const editPolicy = (id: string, reload = false) => { policyPreviewRevision.current++; if (reload) setSavedPolicyEdits(previous => { const next = { ...previous }; delete next[id]; return next; }); setPolicyKey(id); setPolicyPreview(undefined); setDeletePolicyId(''); };
  const applyEfficiencyPreset = (kind: TaskKind, preset: EfficiencyPresetId) => void action('policy-efficiency-preset', async () => {
    const selectedView = viewRevision.current, revision = ++policyPreviewRevision.current, key = policyKey, submitted = policyRecord;
    const rule = submitted.draft.rules.find(rule => rule.taskKind === kind);
    if (!rule) throw new Error('절약 설정을 적용할 작업 종류를 확인하세요.');
    const result = await invoke('policyEfficiencyPreset', { preset, connections: rule.connections }) as Pick<AgentPolicyRule, 'keywords' | 'connections' | 'efficiency'>;
    if (selectedView !== viewRevision.current || revision !== policyPreviewRevision.current) return;
    setSavedPolicyEdits(previous => ({ ...previous, [key]: { ...submitted, draft: { ...submitted.draft, rules: submitted.draft.rules.map(current => current.taskKind === kind ? { ...current, ...result } : current) } } }));
    setPolicyPreview(undefined);
    notify('절약 설정을 초안에 적용했습니다. 선택된 모델을 확인한 뒤 정책을 저장하세요.');
  });
  const savePolicy = () => void action('save-policy', async () => {
    if (policyConflict) throw new Error(policyConflict);
    const key = policyKey, submitted = policyRecord;
    const policy = { ...normalizeAgentPolicyDraft({ ...submitted.draft, rules: submitted.draft.rules.map(rule => ({ ...rule, keywords: rule.keywords.map(word => word.trim()).filter(Boolean), connections: agentConnectionsForRequest(rule.connections, catalogs, auth, state.profiles) })) }), ...(submitted.draft.id ? { id: submitted.draft.id } : {}) };
    const next = await invoke('savePolicy', { policy, ...(policy.id ? { expectedUpdatedAt: submitted.expectedUpdatedAt } : {}) }) as State;
    stateClock.current.changed(); setState(previous => ({ ...previous, policies: next.policies }));
    setSavedPolicyEdits(previous => clearMatchingDraft(previous, key, submitted));
    notify('작업 정책을 저장했습니다. 이후 요청부터 새 정책을 사용합니다.');
  });
  const deletePolicy = () => void action('delete-policy', async () => {
    const policy = policies.find(policy => policy.id === deletePolicyId); if (!policy) return;
    const next = await invoke('deletePolicy', { id: policy.id, expectedUpdatedAt: policy.updatedAt }) as State;
    stateClock.current.changed(); setState(previous => ({ ...previous, policies: next.policies })); setDeletePolicyId(''); if (policyKey === policy.id) setPolicyKey('new');
  });
  const previewPolicy = () => void action('preview-policy', async () => {
    const selectedView = viewRevision.current, revision = ++policyPreviewRevision.current;
    const result = await invoke('previewAgentPolicy', { agentId: policyRecord.previewAgentId, text: policyRecord.previewText }) as AgentPolicySelection;
    if (viewRevision.current === selectedView && policyPreviewRevision.current === revision) setPolicyPreview(result);
  });
  const saveActionRules = () => void action('save-action-rules', async () => {
    if (!ruleRecord) throw new Error('저장한 규칙을 먼저 불러오세요.');
    if (ruleConflict) throw new Error(ruleConflict);
    const submitted = ruleRecord;
    const next = await invoke('saveActionRules', { rules: normalizeActionRules(submitted.rules), expectedUpdatedAt: submitted.expectedUpdatedAt }) as State;
    stateClock.current.changed(); setState(previous => ({ ...previous, actionRules: next.actionRules }));
    setSavedRuleEdits(previous => clearMatchingDraft(previous, 'current', submitted)); notify('작업 규칙을 저장했습니다.');
  });
  const openAgent = (id: string) => { setAgentId(id); setSessionId(latestAgentConversation(state.sessions, id)?.id ?? ''); setView('chat'); setNotice(null); };
  const openTeam = (id: string) => { setTeamId(id); setTeamRunId(latestTeamConversation(teamRuns, id)?.id ?? ''); setView('team'); setNotice(null); };
  const newTeamChat = () => { setTeamRunId(''); setView('team'); setNotice(null); };
  const openTeamRun = (id: string) => { const run = teamRuns.find(item => item.id === id); if (run) setTeamId(run.teamId); setTeamRunId(id); setView('team'); setNotice(null); };
  const showTeamDetails = (id: string) => { setTeamRunId(id); setView('team-run'); setNotice(null); };
  const editTeam = (team?: TeamProfile, reload = false) => {
    teamEditorActive.current = true; const key = team?.id ?? 'new', restored = reload ? undefined : savedTeamEdits[key];
    if (reload) setSavedTeamEdits(previous => { const next = { ...previous }; delete next[key]; return next; });
    setTeamDraftState(restored?.draft ?? (team ? { id: team.id, name: team.name, instructions: team.instructions, topic: team.topic ?? '', leaderAgentId: team.leaderAgentId ?? team.memberAgentIds[0], policies: team.policies ?? '', memberAgentIds: [...team.memberAgentIds], rounds: 1, autonomous: team.autonomous === true } : { name: '', instructions: '', memberAgentIds: [], rounds: 1, autonomous: false }));
    setTeamEditUpdatedAt(restored?.expectedUpdatedAt ?? team?.updatedAt ?? '');
    if (team) setTeamId(team.id); setView('team-edit'); setNotice(null);
  };
  const saveTeam = () => void action('save-team', async () => {
    if (teamConflict) throw new Error(teamConflict);
    const submittedView = viewRevision.current, editKey = teamDraft.id ?? 'new', submittedEdit = savedTeamEdits[editKey];
    const draft = teamDraftForRequest(teamDraft, agents), previousIds = new Set(teams.map(team => team.id));
    let next: State;
    try { next = await invoke('saveTeam', { team: draft, ...(draft.id ? { expectedUpdatedAt: teamEditUpdatedAt } : {}) }) as State; }
    catch (error) { await refresh().catch(() => {}); throw error; }
    stateClock.current.changed(); setState(previous => mergeTeamSnapshot(draft.leaderMode === 'automatic' ? {...mergeAgentSnapshot(previous, next), policies: next.policies} : previous, next));
    const saved = next.teams?.find(team => draft.id ? team.id === draft.id : draft.leaderMode === 'automatic' ? team.creation?.requestId === draft.requestId : !previousIds.has(team.id));
    if (submittedEdit) setSavedTeamEdits(previous => clearMatchingDraft(previous, editKey, submittedEdit));
    if (viewRevision.current === submittedView) { teamEditorActive.current = false; if (saved) openTeam(saved.id); else setView('teams'); }
    notify('팀을 저장했습니다. 대표에게 바로 이야기하세요.');
  });
  const cancelTeamEdit = () => {
    const draft = teamDraftRef.current;
    if (busy['save-team'] && draft.leaderMode === 'automatic' && draft.requestId) {
      void action('cancel-auto-team', async () => {await invoke('cancelAutomaticTeamCreation', {requestId: draft.requestId}); await refresh(); setView('teams');});
    } else setView(draft.id && selectedTeam ? 'team' : 'teams');
  };
  const selectTeamWorkspace = () => void action('team-workspace', async () => {const result = await invoke('selectWorkspace') as {path: string} | null; if (result) setTeamDraft(previous => ({...previous, workspacePath: result.path}));});
  const sendTeamChat = () => void action('team-chat-send', async () => {
    if (!selectedTeam || attachments.busy || !attachments.storage.flush() || (!teamChatPrompt.trim() && !attachments.files.length)) return;
    const attachmentIds = attachments.files.map(file => file.id), sourceAttachmentKey = attachmentKey;
    const submitted = teamChatPrompt, submittedText = submitted.trim() || '첨부한 내용을 확인해 주세요.', key = teamChatKey, submittedView = viewRevision.current;
    if (teamRunInProgress(selectedTeamRun)) {
      const run = await invoke('postTeamMessage', { runId: selectedTeamRun!.id, text: submittedText, ...(attachmentIds.length ? {attachmentIds} : {}) }) as TeamRun;
      stateClock.current.changed(); setState(previous => mergeTeamRunResult(previous, run));
      setTeamDrafts(previous => clearSubmittedDrafts(previous, [key], submitted));
      attachments.clear([sourceAttachmentKey], attachmentIds); await loadTeamDetail(run.id); return;
    }
    const contextRunId = teamContinuationId(teamRuns, selectedTeamRun);
    const run = await invoke('startTeamRun', { teamId: selectedTeam.id, goal: submittedText, ...(attachmentIds.length ? {attachmentIds} : {}), ...(contextRunId ? { contextRunId } : {}) }) as TeamRun;
    stateClock.current.changed(); setState(previous => mergeTeamRunResult(previous, run));
    const following = viewRevision.current === submittedView, targetKey = `chat:${run.id}`;
    setTeamDrafts(previous => clearSubmittedDrafts(promoteSubmittedDraft(previous, key, targetKey, submitted, following), [key, targetKey], submitted));
    if (following) attachments.promote(sourceAttachmentKey, `team:${targetKey}`);
    attachments.clear([sourceAttachmentKey, `team:${targetKey}`], attachmentIds);
    if (following) { setTeamRunId(run.id); setView('team'); }
  });
  const postTeamMessage = () => void action(`team-message-${teamRunId}`, async () => {
    if (!selectedTeamRun || !teamRunInProgress(selectedTeamRun) || !teamMessage.trim()) return;
    const id = teamRunId, key = teamMessageKey, submitted = teamMessage, recipient = selectedTeamRun.members.some(member => member.id === teamRecipients[teamRunId]) ? teamRecipients[teamRunId] : undefined;
    const run = await invoke('postTeamMessage', { runId: id, text: submitted.trim(), ...(recipient ? { toAgentId: recipient } : {}) }) as TeamRun;
    stateClock.current.changed(); setState(previous => mergeTeamRunResult(previous, run));
    setTeamDrafts(previous => clearSubmittedDrafts(previous, [key], submitted));
    await loadTeamDetail(id);
  });
  const cancelTeam = (id: string) => void action(`cancel-team-${id}`, async () => {
    const run = await invoke('cancelTeamRun', { id }) as TeamRun;
    stateClock.current.changed(); setState(previous => mergeTeamRunResult(previous, run)); await loadTeamDetail(id);
  });
  const resumeAgentDraft = (key: string) => { const record = savedAgentEdits[key]; if (!record) return; agentEditRevision.current++; agentEditorActive.current = true; setAgentDraftState(record.draft); setAvatarPromptState(record.avatarPrompt); setAvatarModePreferenceState(record.avatarMode); setAgentId(record.draft.id ?? ''); if (record.draft.avatarId) void loadAvatar(record.draft.avatarId); setView('agent-edit'); };
  const resumeTeamDraft = (key: string) => { const record = savedTeamEdits[key]; if (!record) return; teamEditorActive.current = true; setTeamDraftState(record.draft); setTeamEditUpdatedAt(record.expectedUpdatedAt); setTeamId(record.draft.id ?? ''); setView('team-edit'); };
  const resumeTextDraft = (key: string, team: boolean) => {
    if (team) {
      if (key.startsWith('new-chat:')) { const id = key.slice(9); if (teams.some(item => item.id === id)) { setTeamId(id); setTeamRunId(''); setView('team'); return; } }
      else { const id = key.slice(key.indexOf(':') + 1); if (teamRuns.some(run => run.id === id)) { openTeamRun(id); if (key.startsWith('message:')) setView('team-run'); return; } }
    } else if (key === 'new-chat') { newChat(); return; }
    else if (key.startsWith('session:') && state.sessions.some(session => session.id === key.slice(8))) { openSession(key.slice(8)); return; }
    else if (key.startsWith('agent:') && agents.some(agent => agent.id === key.slice(6))) { newAgentTask(key.slice(6)); return; }
    notify('연결된 대화나 설정이 없습니다. 초안 내용을 펼쳐 복사할 수 있습니다.');
  };
  const openRoutines=(filter?:RoutineFilter)=>{setRoutineFilter(filter);setView('routines');setNotice(null);};
  const openRoutineEditor=(key:string,reload=false)=>{
    routineEditorClock.current++;
    if(key===''){setRoutineKey('');return;}
    const nextKey=key==='new'?(routineFilter?`new-${routineFilter.kind}-${routineFilter.id}`:'new'):key;
    const current=routines.find(r=>r.id===nextKey);
    setRoutineEdits(previous=>{
      if(previous[nextKey]&&!reload)return previous;
      const next={...previous};
      if(reload&&previous[nextKey])next[`saved-${crypto.randomUUID()}`]=previous[nextKey]!;
      next[nextKey]=current?editRoutine(current):blankRoutine(routineFilter);return next;
    });setRoutineKey(nextKey);
  };
  const copyRoutineDraft=()=>{if(!routineRecord)return;routineEditorClock.current++;const key=`new-${crypto.randomUUID()}`,{id,...draft}=routineRecord.draft;setRoutineEdits(previous=>({...previous,[key]:{draft,requestId:crypto.randomUUID()}}));setRoutineKey(key);};
  const acceptRoutine=(routine:Routine)=>{if(!validRoutine(routine))throw Error('루틴 저장 결과를 확인하지 못했습니다. 초안을 유지하고 목록을 다시 확인해 주세요.');stateClock.current.changed();setState(previous=>{
    const current=previous.routines?.find(r=>r.id===routine.id);
    if(current&&(current.revision>routine.revision||(current.revision===routine.revision&&current.updatedAt>routine.updatedAt)))return previous;
    return {...previous,routines:[routine,...(previous.routines??[]).filter(r=>r.id!==routine.id)]};
  });};
  const saveRoutine=()=>void action('save-routine',async()=>{
    if(!routineRecord||routineConflict)throw Error(routineConflict??'저장할 루틴을 선택해 주세요.');
    const key=routineKey,submitted=routineRecord,at=viewRevision.current,editorAt=routineEditorClock.current,input=routineInput(submitted.draft);
    if(!(input.target.kind==='agent'?agents:teams).some(item=>item.id===input.target.id))throw Error('실행할 대상이 없어졌습니다. 초안을 유지하고 다른 대상을 선택해 주세요.');
    if(!routineStorage.flush())throw Error('루틴 초안을 보관하지 못해 저장을 시작하지 않았습니다.');
    let saved:Routine;
    try{saved=await invoke('saveRoutine',{routine:input,...(input.id?{expectedRevision:submitted.expectedRevision}:{requestId:submitted.requestId})}) as Routine;}
    catch(error){try{await refresh();}catch{}throw error;}
    acceptRoutine(saved);
    setRoutineEdits(previous=>{if(JSON.stringify(previous[key])===JSON.stringify(submitted))return clearMatchingDraft(previous,key,submitted);if(!previous[key])return previous;return {...previous,[key]:{...previous[key]!,draft:{...previous[key]!.draft,id:saved.id},expectedRevision:saved.revision}};});
    if(viewRevision.current===at&&routineEditorClock.current===editorAt)setRoutineKey(saved.id);
    notify('루틴을 저장했습니다. 이미 시작한 작업은 그대로 유지됩니다.');
    await refresh();
  });
  const applyRoutineToggle=(routine:Routine)=>void action('toggle-routine',async()=>{try{acceptRoutine(await invoke('setRoutineEnabled',{id:routine.id,enabled:!routine.enabled,expectedRevision:routine.revision}) as Routine);}catch(error){try{await refresh();}catch{}throw error;}setAcknowledgeRoutine(undefined);await refresh();notify(routine.enabled?'앞으로의 예약을 껐습니다. 진행 중인 작업은 유지됩니다.':'루틴 예약을 켰습니다.');});
  const toggleRoutine=(routine:Routine)=>{if(!routine.enabled&&routine.lastStatus==='unknown'){setAcknowledgeRoutine(routine);return;}applyRoutineToggle(routine);};
  const confirmDeleteRoutine=()=>void action('delete-routine',async()=>{if(!deleteRoutine)return;const selected=deleteRoutine;try{const result=await invoke('deleteRoutine',{id:selected.id,expectedRevision:selected.revision});if(result?.id!==selected.id||result.deleted!==true)throw Error('루틴 삭제 결과를 확인하지 못했습니다. 목록을 새로고침해 주세요.');}catch(error){try{await refresh();}catch{}throw error;}stateClock.current.changed();setState(previous=>({...previous,routines:(previous.routines??[]).filter(r=>r.id!==selected.id)}));setDeleteRoutine(undefined);await refresh();notify('예약을 삭제했습니다. 기존 작업과 초안은 보관했습니다.');});
  const routineView=<RoutinesView routines={routines} routineError={state.routineError} agents={agents} teams={teams} filter={routineFilter} record={routineRecord} editKey={routineKey} busy={allBusy} conflict={routineConflict} deleting={deleteRoutine} acknowledging={acknowledgeRoutine} onConfirmAcknowledge={()=>{if(acknowledgeRoutine)applyRoutineToggle(acknowledgeRoutine);}} onCancelAcknowledge={()=>setAcknowledgeRoutine(undefined)} onFilter={setRoutineFilter} onEdit={openRoutineEditor} onChange={record=>{routineEditorClock.current++;setRoutineEdits(previous=>({...previous,[routineKey]:record}));}} onSave={saveRoutine} onToggle={toggleRoutine} onDelete={setDeleteRoutine} onConfirmDelete={confirmDeleteRoutine} onCancelDelete={()=>setDeleteRoutine(undefined)} onCopy={copyRoutineDraft}/>;
  const draftStores = [promptStorage, teamPromptStorage, agentEditStorage, teamEditStorage, policyEditStorage, ruleEditStorage, rabbitEditStorage, rabbitWorkStorage, routineStorage, attachments.storage];
  const originalDrafts = draftStores.flatMap((store, index) => store.original ? [{ key: String(index), label: ['대화', '팀 대화', '에이전트 설정', '팀 설정', '작업 정책', '작업 규칙', 'Rabbit 연결', 'Rabbit 작업', '루틴', '첨부 파일'][index]!, ...store.original, onPreserve: () => { store.preserveOriginal(); } }] : []);
  const draftStorageError = draftStores.find(store => store.error)?.error;
  const draftCount = originalDrafts.length + Object.values(promptDrafts).filter(Boolean).length + Object.values(teamDrafts).filter(Boolean).length + Object.keys(savedAgentEdits).length + Object.keys(savedTeamEdits).length + Object.keys(savedPolicyEdits).length + Object.keys(savedRuleEdits).length + Object.keys(rabbitEdits).length + Object.keys(rabbitWork).length + Object.keys(routineEdits).length + Object.values(attachments.drafts).filter(files => files.length).length;
  const apiDraftDirty = rabbitGuard.keyDirty || !!apiKey || JSON.stringify(draft) !== apiDraftBase.current;
  const updateBlockReason = attachments.busy ? '첨부 파일 준비가 끝난 뒤 업데이트하세요.' : attachments.storage.error ? '첨부 초안을 저장한 뒤 업데이트하세요.' : feedbackGuard.pending ? '개선 요청 접수가 끝난 뒤 업데이트하세요.' : feedbackGuard.dirty ? '개선 요청 초안을 저장한 뒤 업데이트하세요.' : appConnectionGuard.dirty ? '앱 연결 등록 설정을 저장하거나 입력을 초기화한 뒤 업데이트하세요.' : appConnectionGuard.pending ? '앱 연결 요청 또는 공식 승인이 끝난 뒤 업데이트하세요.' : draftStorageError ? '초안을 저장한 뒤 업데이트하세요.' : rabbitGuard.keyDirty ? 'Rabbit 연결 설정을 저장하거나 입력을 초기화한 뒤 업데이트하세요.' : apiDraftDirty ? '연결 설정을 저장하거나 초기화한 뒤 업데이트하세요.' : rabbitGuard.pending ? 'Rabbit 요청 확인 후 업데이트하세요.' : awaitingAuth ? '로그인 완료 또는 취소 후 업데이트하세요.' : state.avatarJobs?.some(avatarJobPending) ? '프로필 생성 완료 또는 취소 후 업데이트하세요.' : undefined;
  const unloadBlocked = useRef(false); unloadBlocked.current = attachments.busy || feedbackGuard.dirty || feedbackGuard.pending || !!draftStorageError || apiDraftDirty || appConnectionGuard.dirty || appConnectionGuard.pending;
  useEffect(() => { const guard = (event: BeforeUnloadEvent) => { if (unloadBlocked.current) { event.preventDefault(); event.returnValue = ''; } }; window.addEventListener?.('beforeunload', guard); return () => window.removeEventListener?.('beforeunload', guard); }, []);
  const updateWorking = attachments.busy || feedbackGuard.pending || appConnectionGuard.pending || rabbitGuard.pending || running || !!state.queue?.running.length || !!state.queue?.queued.length || teamRuns.some(teamRunInProgress) || !!state.avatarJobs?.some(avatarJobPending);
  const updateUnsaved = !!state.unsavedSessionIds?.length || !!state.unsavedTeamRunIds?.length || !!state.unsavedRabbitRunIds?.length;
  const updateApp = (install: boolean) => void action(install ? 'install-update' : 'check-update', async () => {
    if (install && (updateBlockReason || busyActions.current.size > 1)) throw new Error(updateBlockReason ?? '진행 중인 작업을 마친 뒤 업데이트하세요.');
    if (install && (updateWorking || updateUnsaved)) throw new Error(updateWorking ? '작업 완료 후 업데이트하세요.' : '저장되지 않은 기록을 먼저 보관하세요.');
    if (install && !draftStores.map(store => store.flush()).every(Boolean)) throw new Error('초안을 저장하지 못해 업데이트를 시작하지 않았습니다. 초안 내용을 보관하고 다시 시도하세요.');
    await refreshAfter(() => invoke(install ? 'installUpdate' : 'checkUpdate'), refresh);
  });
  const exportTeam = (id: string) => void action(`export-team-${id}`, async () => { const result = await invoke('exportTeamRun', { id }); if (result.saved) notify('팀 대화와 작업 기록을 JSON 파일에 저장했습니다.'); });
  const pageTitle = view === 'routines' ? '루틴' : view === 'drafts' ? '보관한 초안' : view === 'teams' ? '협업 팀' : view === 'team-edit' ? teamDraft.id ? '팀 편집' : '팀 만들기' : view === 'team' ? selectedTeam?.name ?? selectedTeamRun?.teamName ?? '팀' : view === 'team-run' ? selectedTeamRun?.teamName ?? '팀 작업' : view === 'settings' ? '설정' : view === 'agents' ? '에이전트' : view === 'agent-edit' ? agentDraft.id ? '에이전트 편집' : '에이전트 만들기' : view === 'agent' ? selectedAgent?.name ?? '에이전트' : selectedAgent ? selectedAgent.name : current?.title || '새 대화';

  return <div className="app-layout" style={{ gridTemplateColumns: `${sidebar.width}px 6px minmax(0, 1fr)` }}>
    <AppConnectionsDialog open={appConnectionsOpen} onOpenChange={setAppConnectionsOpen} invoke={invoke} onGuard={setAppConnectionGuard}/>
    <aside id="workspace-sidebar" className="sidebar bg-background-base-subtle border-r border-solid border-line-separator-stroke">
      <div className="brand">
        <div className="brand-heading"><div className="brand-symbol bg-background-vendit-normal text-glyph-accent-white-heading" aria-hidden="true">V</div><span className="brand-name text-glyph-gray-heading">벤디트봇</span><span className="brand-version text-glyph-gray-caption" title={`현재 버전 ${state.version}`}>({state.version})</span>
          {state.update?.phase === 'available' && state.update.version && <Button className="brand-update" kind="vendit" hierarchy="secondary" size="xsmall" aria-label={`${state.update.version} 업데이트 설치`} title={`${state.update.version} 새 버전이 있습니다`} onPress={() => { setSettingsSection('updates'); setView('settings'); if (!allBusy && !updateWorking && !updateUnsaved && !updateBlockReason) updateApp(true); }}>업데이트</Button>}
        </div>
        <div className="brand-tools"><Button className="app-connect-button" kind="common" hierarchy="ghost" size="medium" aria-haspopup="dialog" onPress={()=>setAppConnectionsOpen(true)}>앱 연결</Button><FeedbackButton invoke={invoke} onGuard={setFeedbackGuard} onOpenReportAgent={async (id, session) => { await refresh(); if (session) { setSessionId(session); setAgentId(id ?? ''); setView('chat'); } else if (id) { setAgentId(id); setSessionId(''); setView('chat'); } }} /></div>
      </div>
      <div className="sidebar-scroll" role="region" aria-label="팀·에이전트·대화 목록" tabIndex={0}>
      <div className="sidebar-heading sidebar-heading-actions typo-l1/m text-glyph-gray-caption"><span>협업 팀</span><Button kind="common" hierarchy="naked" size="xsmall" onPress={() => { setView('teams'); setNotice(null); }}>전체 팀</Button></div>
      <TeamSidebarCards teams={sidebarTeams} agents={agents} selectedId={view.startsWith('team') ? teamId : undefined} avatarUrl={avatarUrl} onOpen={openTeam} onCreate={() => editTeam()} onMenu={(id, anchor) => { viewRevision.current++; setMenuAnchor(anchor); setAgentMenuId(''); setTeamMenuId(id); }} onReorder={(id, target) => sidebarOrder.reorder('teams', id, target)} />
      <div className="sidebar-heading sidebar-heading-actions typo-l1/m text-glyph-gray-caption"><span>에이전트</span><Button kind="common" hierarchy="naked" size="xsmall" onPress={() => { setView('agents'); setNotice(null); }}>전체 보기</Button></div>
      <AgentSidebarCards teams={teams} agents={sidebarAgents} selectedId={view === 'chat' || view.startsWith('agent') ? agentId : undefined} avatarUrl={avatarUrl} onOpen={openAgent} onMenu={(id, anchor) => { viewRevision.current++; setMenuAnchor(anchor); setTeamMenuId(''); setAgentMenuId(id); }} onReorder={(id, target) => sidebarOrder.reorder('agents', id, target)} />
      <div className="sidebar-heading sidebar-heading-actions typo-l1/m text-glyph-gray-caption"><span>최근 작업·대화</span><Button kind="common" hierarchy="naked" size="xsmall" onPress={newChat}>새 대화</Button></div>
      <nav className="history" aria-label="대화 목록">{historySessions.length === 0 ? <p className="px-3 typo-b3/r text-glyph-gray-caption">첫 대화를 시작해 보세요.</p> : historySessions.map(session => <Button key={session.id} kind={session.id === sessionId && view === 'chat' ? 'vendit' : 'common'} hierarchy={session.id === sessionId && view === 'chat' ? 'secondary' : 'ghost'} size="medium" onPress={() => openSession(session.id)}><span className="history-title">{session.title || '새 대화'}</span></Button>)}</nav>
      </div>
      <div className="sidebar-footer"><Button kind={view==='routines'?'vendit':'common'} hierarchy="secondary" size="medium" onPress={()=>openRoutines()}>루틴</Button><div className="sidebar-footer-actions" ref={addMenuAnchor} onBlur={event => { if (event.relatedTarget && !event.currentTarget.contains(event.relatedTarget as Node)) setAddMenuOpen(false); }}><Button data-add-trigger kind="common" hierarchy="secondary" size="large" aria-haspopup="menu" aria-expanded={addMenuOpen} aria-controls="sidebar-add-menu" onPress={() => setAddMenuOpen(previous => !previous)}>+ 추가</Button><Button kind={view === 'settings' ? 'vendit' : 'common'} hierarchy="secondary" size="large" left={{ glyph: icons.ic_gear }} onPress={() => { setAddMenuOpen(false); setView('settings'); }}>설정</Button>{addMenuOpen && <SidebarAddMenu anchor={addMenuAnchor} onClose={() => setAddMenuOpen(false)} onAgent={() => editAgent()} onTeam={() => editTeam()} />}</div></div>
    </aside>
    <SidebarResizeHandle width={sidebar.width} maximum={sidebar.maximum} onChange={sidebar.change} />
    <main className="main bg-background-base-normal" onDragOver={event => { if (event.dataTransfer.types.includes('Files')) { event.preventDefault(); event.dataTransfer.dropEffect = canAttach && !attachments.busy ? 'copy' : 'none'; } }} onDrop={event => { if (event.dataTransfer.types.includes('Files')) { event.preventDefault(); if (canAttach && !attachments.busy) attachments.drop(Array.from(event.dataTransfer.files)); } }}>
      <header className="topbar border-b border-solid border-line-separator-stroke"><div className="topbar-title"><h1 className="typo-b1/sb text-glyph-gray-heading">{pageTitle}</h1><span className="typo-l2/r text-glyph-gray-caption">{state.version}</span></div><div className="topbar-actions">{view === 'chat' && selectedAgent && <><Button kind="common" hierarchy="ghost" size="small" onPress={()=>openRoutines({kind:'agent',id:selectedAgent.id})}>에이전트 루틴</Button><Button kind="common" hierarchy="ghost" size="small" onPress={() => editAgent(selectedAgent)}>에이전트 설정</Button><Button kind="common" hierarchy="secondary" size="small" onPress={() => newAgentTask(selectedAgent.id)}>새 대화</Button></>}{(view === 'team' || view === 'team-run') && <>{selectedTeam && <><Button kind="common" hierarchy="ghost" size="small" onPress={()=>openRoutines({kind:'team',id:selectedTeam.id})}>팀 루틴</Button><Button kind="common" hierarchy="ghost" size="small" onPress={() => editTeam(selectedTeam)}>팀 설정</Button><Button kind="common" hierarchy="secondary" size="small" onPress={newTeamChat}>새 대화</Button></>}{teamRuns.some(run => run.teamId === teamId) && <select aria-label="팀 대화 기록" className="chat-history-select select-control bg-background-base-normal text-glyph-gray-body border border-solid border-line-outline-stroke typo-l1/r" value={teamRunId} onChange={event => { if (event.target.value) openTeamRun(event.target.value); }}><option value="">이전 대화</option>{teamRuns.filter(run => run.teamId === teamId).sort((a, b) => b.updatedAt.localeCompare(a.updatedAt)).map(run => <option key={run.id} value={run.id}>{run.goal.slice(0, 70)}</option>)}</select>}</>}{!!((state.queue?.running.length ?? 0) + (state.queue?.queued.length ?? 0)) && <Badge kind="vendit">실행 {state.queue?.running.length ?? 0} · 대기 {state.queue?.queued.length ?? 0}</Badge>}{current && view === 'chat' && <><Button kind="common" hierarchy="ghost" size="xsmall" disabled={running} onPress={() => { setRenameTitle(current.title); setSessionAction('rename'); }}>이름</Button><Button kind="common" hierarchy="ghost" size="xsmall" onPress={() => setSessionAction('export')}>내보내기</Button><Button kind="common" hierarchy="ghost" size="xsmall" disabled={running || !!(current.teamRunId && teamRuns.some(run => run.id === current.teamRunId))} onPress={() => setSessionAction('delete')}>삭제</Button></>}<Button kind="common" hierarchy="ghost" size="small" right={{ glyph: icons.ic_arrow_right }} onPress={() => setView(view === 'settings' ? 'agents' : 'settings')}>{view === 'settings' ? '에이전트로 돌아가기' : 'AI 연결하기'}</Button></div></header>
      {(sidebar.error || sidebarOrder.error) && <p className="notice typo-l2/r text-glyph-warning-body" role="status">{sidebar.error || sidebarOrder.error}</p>}
      {draftStorageError && <div className="notice rounded-lg bg-background-danger-subtle text-glyph-danger-body typo-b3/r" role="alert"><span>{draftStorageError}</span><Button kind="common" hierarchy="secondary" size="xsmall" onPress={() => { draftStores.forEach(store => store.flush()); }}>초안 저장 다시 시도</Button><Button kind="common" hierarchy="ghost" size="xsmall" onPress={() => setView('drafts')}>초안 보기</Button></div>}
      {draftCount > 0 && !draftStorageError && <div className="draft-preservation-row typo-l2/r text-glyph-gray-caption"><span>작성 중인 초안 {draftCount}개를 이 Mac에 보관합니다.</span><Button kind="common" hierarchy="ghost" size="xsmall" onPress={() => setView('drafts')}>초안 보기</Button></div>}
      {!!state.unsavedSessionIds?.length && <div className="notice rounded-lg bg-background-danger-subtle text-glyph-danger-body typo-b3/r" role="alert" aria-label="저장되지 않은 작업"><span>저장되지 않은 작업이 있습니다. 앱 종료 전 대화를 내보내세요.</span><Button kind="common" hierarchy="secondary" size="xsmall" onPress={() => openSession(state.unsavedSessionIds![0]!)}>작업 열기</Button></div>}
      {!!state.unsavedTeamRunIds?.length && <div className="notice rounded-lg bg-background-danger-subtle text-glyph-danger-body typo-b3/r" role="alert" aria-label="저장되지 않은 팀 작업"><span>저장되지 않은 팀 작업이 있습니다. 앱 종료 전 팀 기록을 내보내세요.</span><Button kind="common" hierarchy="secondary" size="xsmall" onPress={() => openTeamRun(state.unsavedTeamRunIds![0]!)}>팀 작업 열기</Button><Button kind="common" hierarchy="secondary" size="xsmall" onPress={() => exportTeam(state.unsavedTeamRunIds![0]!)}>팀 기록 내보내기</Button></div>}
      {!!state.unsavedRabbitRunIds?.length && <div className="notice rounded-lg bg-background-danger-subtle text-glyph-danger-body typo-b3/r" role="alert" aria-label="저장되지 않은 Rabbit 작업"><span>저장되지 않은 Rabbit 접수 기록이 있습니다. 새 접수 전에 기록을 내보내 보관하세요.</span><Button kind="common" hierarchy="secondary" size="xsmall" onPress={() => { setConnectionSection('rabbit'); setSettingsSection('connections'); setView('settings'); }}>Rabbit 작업 열기</Button><Button kind="common" hierarchy="secondary" size="xsmall" onPress={() => void action('export-rabbit-recovery', async () => { const result = await invoke('exportRabbitRun', { id: state.unsavedRabbitRunIds![0]! }); if (result.saved) notify('Rabbit 접수 기록을 JSON 파일로 보관했습니다.'); })}>Rabbit 기록 내보내기</Button></div>}
      {notice && <div className={`notice rounded-lg ${notice.error ? 'bg-background-danger-subtle text-glyph-danger-body' : 'bg-background-vendit-subtle text-glyph-vendit-heading'} typo-b3/r`} role={notice.error ? 'alert' : 'status'}><span>{notice.text}</span><Button kind="common" hierarchy="naked" size="xsmall" onPress={() => setNotice(null)}>닫기</Button></div>}
      <div hidden={view !== 'settings'} className="settings-tab-header"><nav className="settings-sections" aria-label="설정 항목"><Button kind={settingsSection==='routines'?'vendit':'common'} hierarchy="secondary" size="medium" aria-current={settingsSection==='routines'?'page':undefined} onPress={()=>{setRoutineFilter(undefined);setSettingsSection('routines');}}>루틴</Button><Button kind={settingsSection === 'connections' ? 'vendit' : 'common'} hierarchy="secondary" size="medium" aria-current={settingsSection === 'connections' ? 'page' : undefined} onPress={() => setSettingsSection('connections')}>연결</Button><Button kind={settingsSection === 'policies' ? 'vendit' : 'common'} hierarchy="secondary" size="medium" aria-current={settingsSection === 'policies' ? 'page' : undefined} onPress={() => setSettingsSection('policies')}>작업 정책</Button><Button kind={settingsSection === 'rules' ? 'vendit' : 'common'} hierarchy="secondary" size="medium" aria-current={settingsSection === 'rules' ? 'page' : undefined} onPress={() => setSettingsSection('rules')}>규칙</Button><Button kind={settingsSection === 'updates' ? 'vendit' : 'common'} hierarchy="secondary" size="medium" aria-current={settingsSection === 'updates' ? 'page' : undefined} onPress={() => setSettingsSection('updates')}>업데이트</Button></nav></div>
      <section hidden={view!=='settings'||settingsSection!=='routines'} className="view-body" data-settings-panel aria-label="루틴 설정">{view==='settings'&&settingsSection==='routines'&&routineView}</section>
      <section hidden={view !== 'settings' || settingsSection !== 'updates'} className="view-body" data-settings-panel aria-label="업데이트 설정"><div className="settings-page"><h2 className="typo-h1/b text-glyph-gray-heading">업데이트</h2><p className="typo-b3/r text-glyph-gray-description mt-2">검증을 마친 새 버전을 확인하고 설치합니다. 작업과 작성 중인 초안은 보관됩니다.</p><UpdateControl update={state.update} blockedReason={updateBlockReason} working={updateWorking} unsaved={updateUnsaved} busy={allBusy} installRequested={!!busy['install-update']} onCheck={() => updateApp(false)} onInstall={() => updateApp(true)} /></div></section>
      <nav hidden={view !== 'settings' || settingsSection !== 'connections'} className="connection-sections settings-sections" aria-label="연결 종류"><Button kind={connectionSection === 'models' ? 'vendit' : 'common'} hierarchy="secondary" size="small" aria-current={connectionSection === 'models' ? 'page' : undefined} onPress={() => setConnectionSection('models')}>AI 모델 API</Button><Button kind={connectionSection === 'rabbit' ? 'vendit' : 'common'} hierarchy="secondary" size="small" aria-current={connectionSection === 'rabbit' ? 'page' : undefined} onPress={() => setConnectionSection('rabbit')}>프로젝트 레인 API(Rabbit)</Button></nav>
      <div hidden={view !== 'settings' || settingsSection !== 'connections' || connectionSection !== 'rabbit'} className="view-body" data-settings-panel><div className="settings-page"><RabbitSettings connections={state.rabbitConnections ?? []} runs={state.rabbitRuns ?? []} edits={rabbitEdits} onEdits={setRabbitEdits} work={rabbitWork} onWork={setRabbitWork} editKey={rabbitEditKey} onEditKey={setRabbitEditKey} active={view === 'settings' && settingsSection === 'connections' && connectionSection === 'rabbit'} invoke={invoke} onConnections={connections => setState(previous => ({ ...previous, rabbitConnections: connections }))} onRun={run => setState(previous => ({ ...previous, rabbitRuns: mergeRabbitRun(previous.rabbitRuns, run) }))} onGuard={setRabbitGuard} onFlushWork={rabbitWorkStorage.flush} /></div></div>
      {view === 'routines' ? <div className="view-body">{routineView}</div> : view === 'drafts' ? <div className="view-body"><DraftRecovery extras={[...Object.entries(attachments.drafts).filter(([,files]) => files.length).map(([key,files]) => ({key:`attachments-${key}`,label:`첨부 파일 · ${files.length}개`,body:JSON.stringify(files,null,2),onContinue:()=>{resumeTextDraft(key.startsWith('team:')?key.slice(5):key,key.startsWith('team:'));}})),...Object.entries(routineEdits).map(([key,record])=>({key:`routine-${key}`,label:`루틴 · ${record.draft.name||'새 루틴'}`,body:JSON.stringify(record,null,2),onContinue:()=>{setRoutineKey(key);setRoutineFilter(undefined);setView('routines');}})),...Object.entries(rabbitEdits).map(([key, record]) => ({ key: `rabbit-edit-${key}`, label: `Rabbit 연결 · ${record.draft.name || '새 연결'}`, body: JSON.stringify(record, null, 2), onContinue: () => { setRabbitEditKey(key); setConnectionSection('rabbit'); setSettingsSection('connections'); setView('settings'); } })), ...Object.entries(rabbitWork).map(([key, record]) => ({ key: `rabbit-work-${key}`, label: `Rabbit 작업 · ${state.rabbitConnections?.find(item => item.id === key)?.name ?? key}`, body: JSON.stringify(record, null, 2), onContinue: () => { setConnectionSection('rabbit'); setSettingsSection('connections'); setView('settings'); } }))]} originals={originalDrafts} prompts={promptDrafts} teamPrompts={teamDrafts} agentEdits={savedAgentEdits} teamEdits={savedTeamEdits} policyEdits={savedPolicyEdits} ruleEdits={savedRuleEdits} onRules={() => { setSettingsSection('rules'); setView('settings'); }} onPolicy={key => { editPolicy(key); setSettingsSection('policies'); setView('settings'); }} onPrompt={resumeTextDraft} onAgent={resumeAgentDraft} onTeam={resumeTeamDraft} /></div> : view === 'teams' ? <div className="view-body"><TeamsOverview teams={teams} runs={teamRuns} agents={agents} onCreate={() => editTeam()} onOpen={openTeam} onRun={openTeamRun} /></div> : view === 'team-edit' ? <div className="view-body"><TeamEditor draft={teamDraft} agents={agents} rabbitConnections={state.rabbitConnections} onManageRabbit={() => { setConnectionSection('rabbit'); setSettingsSection('connections'); setView('settings'); }} busy={allBusy} conflict={teamConflict} onReload={teams.some(team => team.id === teamDraft.id) ? () => editTeam(teams.find(team => team.id === teamDraft.id)!, true) : undefined} onChange={setTeamDraft} onSave={saveTeam} onCancel={cancelTeamEdit} onSelectWorkspace={selectTeamWorkspace} onDelete={teamDraft.id ? () => setDeleteTeamId(teamDraft.id!) : undefined} deleteDisabled={teamRuns.some(run => run.teamId === teamDraft.id && teamRunInProgress(run))} /></div> : view === 'team' ? <TeamChat attachments={attachments.files} attachmentBusy={attachments.busy} attachmentError={attachments.error || attachments.storage.error} onChooseAttachments={attachments.choose} onRemoveAttachment={attachments.remove} focusRequest={composerFocus} team={selectedTeam} leaderName={agents.find(agent => agent.id === (selectedTeam?.leaderAgentId ?? selectedTeam?.memberAgentIds[0]))?.name ?? ''} history={teamChatHistory} details={teamDetails} sessions={state.sessions} prompt={teamChatPrompt} busy={!!busy['team-chat-send']} error={teamDetailErrors[teamRunId]} loading={teamLoading[teamRunId]} onPrompt={setTeamChatPrompt} onSend={sendTeamChat} onCancel={() => cancelTeam(teamRunId)} onDetails={showTeamDetails} onRetry={() => void loadTeamDetail(teamRunId)} /> : view === 'team-run' ? <div className="view-body">{selectedTeamRun ? <><div className="team-run-navigation"><Button kind="common" hierarchy="ghost" size="small" onPress={() => setView('team')}>팀 대화로 돌아가기</Button><Button kind="common" hierarchy="ghost" size="small" disabled={allBusy} onPress={() => exportTeam(selectedTeamRun.id)}>팀 기록 내보내기</Button>{!teamRunInProgress(selectedTeamRun) && <Button kind="common" hierarchy="ghost" size="small" disabled={allBusy} onPress={() => setDeleteTeamRunId(selectedTeamRun.id)}>팀 작업 삭제</Button>}</div><TeamRunView run={selectedTeamRun} detail={teamDetails[teamRunId]} sessions={state.sessions} loading={teamLoading[teamRunId]} error={teamDetailErrors[teamRunId]} message={teamMessage} recipient={selectedTeamRun.members.some(member => member.id === teamRecipients[teamRunId]) ? teamRecipients[teamRunId]! : ''} busy={allBusy} onMessage={setTeamMessage} onRecipient={id => setTeamRecipients(previous => ({ ...previous, [teamRunId]: id }))} onSend={postTeamMessage} onCancel={() => cancelTeam(teamRunId)} onRetry={() => void loadTeamDetail(teamRunId)} onOpenSession={openSession} /></> : <p className="settings-page typo-b3/r text-glyph-gray-description">팀 작업을 찾을 수 없습니다. 팀 화면에서 다시 선택하세요.</p>}</div> : view === 'agents' ? <div className="view-body"><div className="settings-page agent-page">
        <div className="agent-page-heading"><div><div className="typo-l1/m text-glyph-vendit-heading">AGENTS</div><h2 className="typo-h1/b text-glyph-gray-heading mt-2">역할을 정하고, 일을 맡기세요</h2><p className="typo-b3/r text-glyph-gray-description mt-2">에이전트마다 지시, 모델, 작업 폴더를 저장하고 작업을 이어가세요.</p></div><Button kind="vendit" size="medium" onPress={() => editAgent()}>에이전트 만들기</Button></div>
        <p className="typo-l1/r text-glyph-gray-caption">이 Mac에서는 한 작업씩 실행합니다. 추가 작업은 대기열에서 순서대로 시작합니다.</p>
        {agents.length ? <div className="agent-grid">{agents.map(agent => {
          const tasks = sessionsForAgent(state.sessions, agent.id), pending = tasks.filter(task => sessionInProgress(state, task.id)).length;
          return <section key={agent.id} className={`agent-card ${panel}`} aria-label={agent.name}><div className="card-heading"><div className="agent-identity"><AgentAvatar name={agent.name} url={avatarUrl(agent.avatarId)} size="medium" /><h3 className="typo-h3/b text-glyph-gray-heading">{agent.name}</h3></div>{pending > 0 && <Badge kind="common">진행 {pending}</Badge>}</div><p className="agent-description typo-b3/r text-glyph-gray-description">{agent.instructions}</p><ConnectionRoutes routes={connectionRoutes(agent)} connectionName={connectionName} /><p className="typo-l2/r text-glyph-gray-caption">{agent.workspacePath ? '작업 폴더 연결됨' : '텍스트 작업'} · 작업 {tasks.length}개</p><div className="agent-card-actions"><Button kind="common" hierarchy="ghost" size="small" onPress={()=>openRoutines({kind:'agent',id:agent.id})}>루틴</Button><Button kind="common" hierarchy="secondary" size="medium" onPress={() => openAgent(agent.id)}>대화 열기</Button><Button kind="vendit" size="medium" onPress={() => newAgentTask(agent.id)}>새 대화</Button></div></section>;
        })}</div> : <section className={`agent-empty ${panel}`}><Glyph name="person" size={32} /><h3 className="typo-h3/b text-glyph-gray-heading">첫 에이전트를 만들어 보세요</h3><p className="typo-b3/r text-glyph-gray-description">코드 검토, 문서 작성처럼 맡길 역할을 정하면 같은 설정으로 새 작업을 시작할 수 있습니다.</p><Button kind="vendit" size="large" onPress={() => editAgent()}>에이전트 만들기</Button></section>}
      </div></div> : view === 'agent-edit' ? <div className="view-body"><div className="settings-page agent-editor">
        <div><div className="typo-l1/m text-glyph-vendit-heading">AGENT SETTINGS</div><h2 className="typo-h1/b text-glyph-gray-heading mt-2">{agentDraft.id ? '에이전트 역할 다듬기' : '새 에이전트 만들기'}</h2><p className="typo-b3/r text-glyph-gray-description mt-2">저장한 지시와 연결 설정은 이 에이전트의 새 작업에 적용됩니다.</p></div>
        <section className={`agent-form ${panel}`} aria-label="에이전트 설정">
          <TextInput label="에이전트 이름" placeholder="예: 코드 검토 도우미" value={agentDraft.name} maxLength={80} onChange={(event: ReactTypes.ChangeEvent<HTMLInputElement>) => setAgentDraft(previous => ({ ...previous, name: event.target.value }))} />
          <AgentAvatarEditor name={agentDraft.name} url={avatarUrl(agentDraft.avatarId)} hasAvatar={!!agentDraft.avatarId} prompt={avatarPrompt} mode={avatarMode} imageAvailable={avatarRoute.connectionId === 'codex'} onMode={setAvatarModePreference} connectionLabel={avatarConnectionLabel} available={!!avatarRouteSelection?.model} busy={avatarJobPending(selectedAvatarJob)} phase={selectedAvatarJob?.phase} disabled={!!busy['save-agent']} cancelling={!!busy[`avatar-cancel-${selectedAvatarJob?.requestId}`]} error={avatarError} onPrompt={setAvatarPrompt} onGenerate={generateAvatar} onCancel={cancelAvatar} onRemove={() => setAgentDraft(previous => ({ ...previous, avatarId: '' }))} />
          <label className="form-field typo-l1/m text-glyph-gray-description">역할과 지시<TextArea aria-label="역할과 지시" placeholder="맡길 역할, 작업 방식, 결과물 형식을 구체적으로 적어주세요." value={agentDraft.instructions} rows={6} maxLength={16000} onChange={(event: ReactTypes.ChangeEvent<HTMLTextAreaElement>) => setAgentDraft(previous => ({ ...previous, instructions: event.target.value }))} /></label>
          <DevelopmentRoutingPicker scope="agent" value={agentDraft.development} connections={state.rabbitConnections} disabled={allBusy} onChange={development => setAgentDraft(previous => ({ ...previous, development }))} onManage={() => { setConnectionSection('rabbit'); setSettingsSection('connections'); setView('settings'); }} />
          <AgentAutomationPicker policyId={agentDraft.automation?.policyId} policies={policies} onChange={id => setAgentDraft(previous => ({ ...previous, automation: id ? { policyId: id } : undefined }))} onManage={() => { setSettingsSection('policies'); setView('settings'); }} />
          <AgentConnectionsEditor routes={connectionRoutes(agentDraft)} profiles={state.profiles} auth={auth} catalogs={catalogs} disabled={allBusy} onChange={routes => setAgentDraft(previous => withAgentConnections(previous, routes))} onLoad={(provider, refresh) => void loadCatalog(provider, refresh)} />
          <div className="agent-workspace"><div><div className="typo-l1/m text-glyph-gray-description">작업 폴더</div><p className="agent-path typo-b3/r text-glyph-gray-body">{agentDraft.workspacePath || '선택한 폴더 안에서 파일 도구를 사용합니다.'}</p></div><div className="flex gap-2"><Button kind="common" hierarchy="secondary" size="small" disabled={allBusy || running} onPress={() => void action('agent-workspace', async () => { const result = await invoke('selectWorkspace'); if (result?.path) setAgentDraft(previous => ({ ...previous, workspacePath: result.path })); })}>{agentDraft.workspacePath ? '폴더 변경' : '폴더 선택'}</Button>{agentDraft.workspacePath && <Button kind="common" hierarchy="ghost" size="small" onPress={() => setAgentDraft(previous => ({ ...previous, workspacePath: undefined }))}>해제</Button>}</div></div>
          <p className="typo-l1/r text-glyph-gray-caption">파일 도구는 설정의 규칙을 따릅니다. 승인이 필요한 작업은 대상과 내용을 확인한 뒤 실행합니다.</p>
          <div className="agent-form-actions">{agentDraft.id && <Button kind="common" hierarchy="ghost" size="medium" disabled={allBusy} onPress={() => setDeleteAgentId(agentDraft.id!)}>에이전트 삭제</Button>}<Button kind="common" hierarchy="secondary" size="medium" onPress={() => agentDraft.id && selectedAgent ? openAgent(selectedAgent.id) : setView('agents')}>취소</Button><Button kind="vendit" size="medium" disabled={allBusy || avatarJobPending(selectedAvatarJob) || !agentDraft.name.trim() || !agentDraft.instructions.trim()} loading={!!busy['save-agent']} onPress={saveAgent}>에이전트 저장</Button></div>
        </section>
      </div></div> : view === 'agent' ? <div className="view-body"><div className="settings-page agent-page">
        {selectedAgent ? <><div className="agent-page-heading"><div><div className="typo-l1/m text-glyph-vendit-heading">AGENT</div><div className="agent-identity"><AgentAvatar name={selectedAgent.name} url={avatarUrl(selectedAgent.avatarId)} size="medium" /><h2 className="typo-h1/b text-glyph-gray-heading mt-2">{selectedAgent.name}</h2></div><ConnectionRoutes routes={connectionRoutes(selectedAgent)} connectionName={connectionName} /></div><div className="flex gap-2"><Button kind="common" hierarchy="ghost" size="medium" onPress={()=>openRoutines({kind:'agent',id:selectedAgent.id})}>에이전트 루틴</Button><Button kind="common" hierarchy="secondary" size="medium" disabled={allBusy} onPress={() => editAgent(selectedAgent)}>편집</Button><Button kind="common" hierarchy="ghost" size="medium" disabled={allBusy} onPress={() => setDeleteAgentId(selectedAgent.id)}>삭제</Button><Button kind="vendit" size="medium" onPress={() => newAgentTask(selectedAgent.id)}>새 작업 시작</Button></div></div>
        <details className={`agent-instructions ${panel}`}><summary className="typo-b3/sb text-glyph-gray-heading">역할과 작업 설정</summary><p className="agent-instructions-text typo-b3/r text-glyph-gray-body">{selectedAgent.instructions}</p><p className="agent-path typo-l1/r text-glyph-gray-caption">{selectedAgent.workspacePath || '작업 폴더 없음 · 텍스트 작업'}</p></details>
        <div className="section-heading"><h3 className="typo-h3/b text-glyph-gray-heading">작업 이력</h3><span className="typo-l1/r text-glyph-gray-caption">추가 작업은 대기열에서 순서대로 실행합니다.</span></div>
        <div className="agent-task-list">{sessionsForAgent(state.sessions, selectedAgent.id).length ? sessionsForAgent(state.sessions, selectedAgent.id).map(task => <div key={task.id} className={`agent-task-row ${panel}`}><div><h4 className="typo-b3/sb text-glyph-gray-heading">{task.title}</h4><p className="typo-l2/r text-glyph-gray-caption">{new Date(task.updatedAt).toLocaleString()}</p></div><Badge kind={task.taskStatus === 'failed' ? 'destructive' : task.taskStatus === 'completed' ? 'success' : 'common'}>{taskLabel(task.id, task.taskStatus)}</Badge><Button kind="common" hierarchy="secondary" size="small" onPress={() => openSession(task.id)}>열기</Button>{sessionInProgress(state, task.id) && <Button kind="destructive" hierarchy="ghost" size="small" onPress={() => void action(`cancel-${task.id}`, async () => { await invoke('cancel', { sessionId: task.id }); })}>취소</Button>}</div>) : <p className="typo-b3/r text-glyph-gray-description">아직 맡긴 작업이 없습니다. 새 작업을 시작해 보세요.</p>}</div></> : <p className="typo-b3/r text-glyph-gray-description">에이전트를 찾을 수 없습니다. 에이전트 목록에서 다시 선택하세요.</p>}
      </div></div> : view === 'settings' ? <div className="view-body" data-settings-panel hidden={settingsSection === 'routines' || settingsSection === 'updates' || (settingsSection === 'connections' && connectionSection === 'rabbit')}><div className="settings-page">

        {settingsSection === 'rules' ? <ActionRulesSettings record={ruleRecord} busy={!!busy['save-action-rules']} conflict={ruleConflict} onChange={record => setSavedRuleEdits({ current: record })} onReload={() => setSavedRuleEdits({})} onSave={saveActionRules} /> : settingsSection === 'policies' ? <PolicySettings policies={policies} agents={agents} editKey={policyKey} record={policyRecord} conflict={policyConflict} busy={allBusy} preview={policyPreview} deleteId={deletePolicyId} onEdit={editPolicy} onChange={record => { policyPreviewRevision.current++; setSavedPolicyEdits(previous => ({ ...previous, [policyKey]: record })); setPolicyPreview(undefined); }} onSave={savePolicy} onDelete={setDeletePolicyId} onConfirmDelete={deletePolicy} onPreview={previewPolicy} onApplyEfficiencyPreset={applyEfficiencyPreset} renderConnections={(routes, onChange, label) => <AgentConnectionsEditor routes={routes} profiles={state.profiles} auth={auth} catalogs={catalogs} disabled={allBusy} onChange={onChange} onLoad={(provider, refresh) => void loadCatalog(provider, refresh)} contextLabel={label} />} /> : <>
        <div className="settings-heading"><div className="typo-l1/m text-glyph-vendit-heading">CONNECTIONS</div><h2 className="typo-h1/b text-glyph-gray-heading mt-2">나에게 맞는 AI 연결</h2><p className="typo-b3/r text-glyph-gray-description">로그인과 API 연결을 한곳에서 관리하세요. 인증 상태와 실제 응답 가능 여부를 따로 확인합니다.</p></div>
        <div className="auth-grid">{(['codex', 'claude-code'] as const).map(provider => {
          const status = auth[provider] ?? blankAuth, waiting = ['preparing', 'awaiting-browser'].includes(status.phase), pending = busy[`login-${provider}`] || busy[`test-${provider}`] || busy[`disconnect-${provider}`];
          return <section className={`auth-card ${panel}`} key={provider} aria-label={`${names[provider]} 연결`}>
            <div className="card-heading"><div className="provider-name"><span className="provider-symbol bg-background-base-subtle text-glyph-gray-heading typo-h2/b">{provider === 'codex' ? 'C' : '✳'}</span><h3 className="typo-h3/b text-glyph-gray-heading">{names[provider]}</h3></div><Badge kind={status.inferenceVerified ? 'success' : status.phase === 'error' ? 'destructive' : 'common'}>{authLabel(status)}</Badge></div>
            <div className="card-details typo-b3/r text-glyph-gray-description"><p>{status.account?.email || (provider === 'codex' ? 'ChatGPT 계정으로 연결' : 'Claude 계정으로 연결')}</p>{status.account?.plan && <p className="typo-l1/r">{status.account.plan}</p>}{status.error && <p className="error-copy text-glyph-danger-body" role="status">{status.error}</p>}{status.installed === false && <p className="typo-l1/r text-glyph-gray-caption">이 앱에서 사용할 공식 실행 파일 준비가 필요합니다.</p>}</div>
            {status.authenticated && <><p className="typo-l1/r text-glyph-gray-caption">{credentialStorageNote(provider, status.credentialStorage)}</p><ModelPicker provider={provider} auth={status} state={catalogs[provider]} selection={modelSelections[provider]} context="연결 확인" disabled={running || pending} onModel={id => chooseModel(provider, id)} onEffort={effort => chooseEffort(provider, effort)} onRefresh={() => void loadCatalog(provider, true)} /></>}
            <div className="card-actions">{waiting ? <Button kind="common" hierarchy="secondary" size="medium" onPress={() => void action(`cancel-login-${provider}`, async () => { await refreshAfter(() => invoke('cancelLogin', { provider }), refreshAuth); })}>로그인 취소</Button> : <Button kind="vendit" hierarchy={status.authenticated ? 'secondary' : 'primary'} size="medium" loading={!!busy[`login-${provider}`]} disabled={running || pending} onPress={() => login(provider)}>{status.authenticated ? '다시 로그인' : '로그인으로 연결'}</Button>}{status.authenticated && <Button kind="common" hierarchy="secondary" size="medium" disabled={!status.authenticated || running || pending || waiting || !selectionForRequest(catalogs[provider], status, modelSelections[provider])} loading={!!busy[`test-${provider}`]} onPress={() => void action(`test-${provider}`, async () => { const selected = selectionForRequest(catalogs[provider], status, modelSelections[provider]); if (!selected) throw new Error('공식 모델 목록에서 모델을 선택하세요.'); await refreshAfter(() => invoke('testAuth', { provider, ...selected }), refreshAuth); notify(`${names[provider]}의 실제 모델 응답을 확인했습니다.`); })}>응답 확인</Button>}{status.authenticated && <Button kind="common" hierarchy="ghost" size="small" disabled={running || pending} onPress={() => void action(`disconnect-${provider}`, async () => { await refreshAfter(() => invoke('disconnect', { provider }), refreshAuth); })}>연결 해제</Button>}</div>
          </section>;
        })}</div>
        <div className="section-heading"><div><h3 className="typo-h3/b text-glyph-gray-heading">AI 모델 API 연결</h3><p className="typo-l1/r text-glyph-gray-description mt-1">사용할 공급자와 모델을 직접 선택하세요.</p></div><Button kind="common" hierarchy="secondary" size="small" left={{ glyph: icons.ic_plus }} onPress={resetDraft}>새 연결</Button></div>
        <div className="profile-list">{state.profiles.map(profile => <div key={profile.id} className={`profile-row ${panel}`}><div className="profile-label"><div className="flex items-center gap-2"><span className="typo-b2/sb text-glyph-gray-heading">{profile.name}</span><Badge kind={profile.verified ? 'success' : 'common'}>{profile.verified ? '응답 확인됨' : profile.hasKey ? '키 저장됨' : '키 필요'}</Badge></div><div className="profile-meta typo-l1/r text-glyph-gray-description">{names[profile.provider]} · {profile.model}</div></div><div className="profile-actions">{deleteId === profile.id ? <div className="delete-confirm"><span className="typo-l1/r text-glyph-danger-body">연결과 키를 삭제할까요?</span><Button kind="destructive" size="small" loading={!!busy[`delete-${profile.id}`]} onPress={() => void action(`delete-${profile.id}`, async () => { await invoke('deleteProfile', { id: profile.id }); await refresh(); if (draft.id === profile.id) resetDraft(); setDeleteId(''); })}>삭제</Button><Button kind="common" hierarchy="ghost" size="small" onPress={() => setDeleteId('')}>취소</Button></div> : <><Button kind="vendit" hierarchy="secondary" size="small" disabled={!profile.hasKey || running || allBusy} loading={!!busy[`api-test-${profile.id}`]} onPress={() => void action(`api-test-${profile.id}`, async () => { await refreshAfter(() => invoke('testApi', { id: profile.id }), refresh); notify(`${profile.name}의 실제 모델 응답을 확인했습니다.`); })}>연결 테스트</Button><Button kind="common" hierarchy="ghost" size="small" onPress={() => editProfile(profile)}>수정</Button><Button kind="common" hierarchy="ghost" size="small" disabled={running || allBusy} onPress={() => setDeleteId(profile.id)}>삭제</Button></>}</div></div>)}</div>
        <section id="api-form" className={`api-form ${panel}`} aria-label="API 연결 설정"><h3 className="typo-b1/sb text-glyph-gray-heading mb-5">{draft.id ? 'API 연결 수정' : '새 API 연결'}</h3><div className="form-grid">
          <label className="form-field typo-l1/m text-glyph-gray-description">공급자<select className="select-control bg-background-base-normal text-glyph-gray-body border border-solid border-line-outline-stroke typo-b3/r" value={draft.provider} onChange={event => changeProvider(event.target.value as ApiProviderProfile['provider'])}>{['openai', 'anthropic', 'openrouter', 'openai-compatible'].map(id => <option value={id} key={id}>{names[id]}</option>)}</select></label>
          <TextInput label="연결 이름" placeholder="예: 업무용 API" value={draft.name} onChange={(event: ReactTypes.ChangeEvent<HTMLInputElement>) => setDraft(previous => ({ ...previous, name: event.target.value }))} maxLength={100} />
          <TextInput label="모델 ID" placeholder="이 계정에서 사용할 정확한 모델 ID" value={draft.model} onChange={(event: ReactTypes.ChangeEvent<HTMLInputElement>) => setDraft(previous => ({ ...previous, model: event.target.value }))} maxLength={200} />
          <TextInput label="API 키" type="password" autoComplete="off" spellCheck={false} placeholder={draft.id ? '변경할 때만 새 키 입력' : 'API 키를 입력하세요'} value={apiKey} onChange={(event: ReactTypes.ChangeEvent<HTMLInputElement>) => setApiKey(event.target.value.slice(0, 8192))} desc="저장 후에는 원문을 다시 표시하지 않습니다." />
          <div className="form-wide"><TextInput label="Base URL" type="url" placeholder="https://your-provider.example/v1" value={draft.baseUrl} readOnly={draft.provider !== 'openai-compatible'} onChange={(event: ReactTypes.ChangeEvent<HTMLInputElement>) => setDraft(previous => ({ ...previous, baseUrl: event.target.value }))} desc={draft.provider === 'openai-compatible' ? '공급자나 주소·프로토콜을 바꾸면 새 API 키가 필요합니다.' : '공식 공급자는 지정된 주소를 사용합니다.'} /></div>
          <label className="form-field typo-l1/m text-glyph-gray-description">API 프로토콜<select className="select-control bg-background-base-normal text-glyph-gray-body border border-solid border-line-outline-stroke typo-b3/r" value={draft.protocol} disabled={draft.provider === 'anthropic' || draft.provider === 'openrouter'} onChange={event => setDraft(previous => ({ ...previous, protocol: event.target.value as ApiProviderProfile['protocol'] }))}>{draft.provider === 'anthropic' ? <option value="anthropic-messages">Anthropic Messages</option> : <><option value="responses">Responses</option><option value="chat-completions">Chat Completions</option></>}</select></label>
          {draft.provider === 'openai-compatible' && <label className="check-label typo-b3/r text-glyph-gray-body"><Checkbox kind="square" aria-label="로컬 loopback 서버의 HTTP 허용" checked={draft.allowInsecureLoopback} onCheckedChange={(checked: boolean) => setDraft(previous => ({ ...previous, allowInsecureLoopback: checked }))} />로컬 loopback 서버의 HTTP 허용</label>}
        </div><div className="check-row"><label className="check-label typo-b3/r text-glyph-gray-body"><Checkbox kind="square" aria-label="이 모델의 도구 호출 지원" checked={draft.capabilities.tools} onCheckedChange={(checked: boolean) => setDraft(previous => ({ ...previous, capabilities: { ...previous.capabilities, tools: checked } }))} />이 모델의 도구 호출 지원</label></div><div className="form-actions"><p className="typo-l1/r text-glyph-gray-description">연결 테스트도 소량의 API 사용량이 발생합니다.</p><div className="flex gap-2"><Button kind="common" hierarchy="ghost" size="medium" onPress={resetDraft}>초기화</Button><Button kind="vendit" size="medium" disabled={running || allBusy} loading={!!busy['save-profile']} onPress={saveProfile}>연결 저장</Button></div></div></section>
        <div className="settings-note bg-background-base-subtle rounded-lg typo-l1/r text-glyph-gray-description"><p>API 키는 이 Mac의 안전한 저장소로 암호화합니다. 키 저장만으로 응답 가능 상태가 되지는 않습니다.</p><p>공식 CLI 계정 연결은 이 Mac에서 개인용으로 사용합니다. Codex 로그인은 벤디트봇 전용 macOS 키체인에서 복원하며, 접근이 거부되면 연결을 완료하지 않습니다.</p><p>현재 텍스트 대화와 작업 폴더의 파일 목록·읽기·검색·규칙에 따른 쓰기를 지원합니다.</p><p>대화는 선택한 연결과 모델을 사용합니다. 연결을 바꾸려면 새 대화를 시작하세요.</p></div>
      </>}</div></div> : <>
        <ChatScroll sessionKey={`${view}:${sessionId || agentId}`}><div className="chat-width">{current?.queuedPrompt ? <div className="queued-task"><Badge kind="common">{taskLabel(current.id, current.taskStatus)}</Badge><h2 className="typo-h2/b text-glyph-gray-heading">{queuedHere ? '앞선 작업이 끝나면 시작합니다' : '아직 실행하지 않은 작업 요청'}</h2><p className="queued-prompt typo-b2/r text-glyph-gray-body">{current.queuedPrompt}</p>{!sessionBusy && !current.teamRunId && current.purpose !== 'avatar' && <Button kind="common" hierarchy="secondary" size="medium" onPress={() => setPrompt(current.queuedPrompt ?? '')}>내용을 입력창에 가져오기</Button>}</div> : !current || current.messages.length === 0 ? <div className="welcome"><div className="typo-l1/m text-glyph-vendit-heading">생각에서 실행까지</div><h2 className="typo-d1/b text-glyph-gray-heading">{selectedAgent ? <>{selectedAgent.name}에게<br />어떤 작업을 맡길까요?</> : <>어떤 일을<br />함께 시작할까요?</>}</h2><p className="welcome-subtitle typo-b1/r text-glyph-gray-description">{selectedAgent ? '저장한 역할과 모델, 작업 폴더로 실행합니다.' : <>원하는 AI를 연결하고,<br />당신의 작업에 집중하세요.</>}</p><div className="welcome-grid">{[{ icon: 'calendar', title: '계획을 구체적으로', text: '이 프로젝트의 개발 계획을 단계별로 정리해 줘.' }, { icon: 'magnifier', title: '내용을 꼼꼼하게', text: '작성한 내용을 검토하고 개선점을 알려 줘.' }, { icon: 'plus', title: '복잡한 문제를 명료하게', text: '복잡한 문제를 작은 단계로 나누는 것을 도와줘.' }].map(item => <Button key={item.title} kind="common" hierarchy="secondary" size="large" onPress={() => setPrompt(item.text)}><span className="suggestion"><Glyph name={item.icon} size={22} /><span className="typo-b3/m">{item.title}</span></span></Button>)}</div></div> : <div className="messages">{current.messages.length > visibleCount && <Button kind="common" hierarchy="ghost" size="small" onPress={() => setVisibleCount(previous => previous + 50)}>이전 메시지 더 보기 ({current.messages.length - visibleCount})</Button>}{current.messages.slice(-visibleCount).map(message => <article key={message.id} data-message-id={message.id} className={`message ${message.role === 'user' ? 'user bg-background-base-subtle' : 'assistant bg-background-base-normal'} rounded-xl`}><AttachmentList files={message.attachments}/>{message.acceptedInputs?.map(input => <div key={input.id} className="accepted-chat-input bg-background-base-subtle rounded-lg"><span className="typo-l2/m">진행 중 전달한 추가 지시</span><p className="message-text typo-b3/r">{input.text}</p></div>)}<MessageHeader message={message} connectionName={connectionName} assistantName={selectedAgent?.name || current.agentName || '벤디트봇'}/>{message.text ? <div className="message-text typo-b2/r text-glyph-gray-body">{message.role === 'assistant' ? <Markdown text={message.text} /> : message.text}</div> : message.status === 'running' ? <p className="message-wait typo-b3/r text-glyph-gray-description" role="status">응답을 기다리고 있습니다…</p> : null}{message.tools?.length ? <div className="tool-status-list">{message.tools.map(tool => <details key={tool.callId} className="tool-status bg-background-base-subtle rounded-lg"><summary className="typo-l1/r text-glyph-gray-description"><span>{tool.status === 'running' ? '실행 중' : tool.status === 'completed' ? '완료' : '실패'}</span> · {tool.name}{tool.path ? ` · ${tool.path}` : ''}</summary>{tool.summary && <pre className="typo-c2/m text-glyph-gray-body">{tool.summary}</pre>}</details>)}</div> : null}{message.status === 'running' && message.providerStatus === 'retrying' && <p className="message-wait typo-b3/r text-glyph-gray-description" role="status">공급자가 같은 요청을 다시 연결하고 있습니다. 새 요청을 보내지 않습니다.</p>}{message.error && <p className="message-error typo-b3/r text-glyph-danger-body">{message.error}</p>}</article>)}</div>}</div></ChatScroll>
        <footer className="composer-wrap"><div className="chat-width"><div className="connection-bar">{current ? <details className="task-connections chat-connection-details"><summary className="typo-l2/m text-glyph-gray-caption">사용 중인 연결 · {connectionName(current.connectionId)} · {current.model}</summary><span className="typo-l2/m text-glyph-gray-caption">{current.agentName ? `${current.agentName}의 작업 · 저장된 연결 순서` : '이 대화의 연결'}</span><ConnectionRoutes routes={connectionRoutes(current)} connectionName={connectionName} label="작업의 연결 우선순위" /></details> : selectedAgent ? <details className="task-connections chat-connection-details"><summary className="typo-l2/m text-glyph-gray-caption">{connectionName(selectedAgent.connectionId)} · {selectedAgent.model}</summary><Badge kind="common">{selectedAgent.name}</Badge><ConnectionRoutes routes={connectionRoutes(selectedAgent)} connectionName={connectionName} />{connectionRoutes(selectedAgent).length > 1 && <p className="typo-l2/r text-glyph-gray-caption">공급자 요청을 보내기 전에 실패한 경우에만 다음 연결을 사용합니다. 연결 전환 시 이전 완료 대화를 다음 AI에 문맥으로 전달합니다.</p>}</details> : <><select aria-label="사용할 AI 연결" className="select-control bg-background-base-elevate text-glyph-gray-body border border-solid border-line-outline-stroke typo-b3/r" value={connectionId} onChange={event => chooseConnection(event.target.value)}><option value="">AI 연결 선택</option>{(['codex', 'claude-code'] as const).map(id => <option key={id} value={id}>{names[id]} · {auth[id]?.authenticated ? '로그인됨' : '로그인 필요'}</option>)}{state.profiles.map(profile => <option key={profile.id} value={profile.id}>{profile.name} · API</option>)}</select>{selectedProfile && <div className="model-input"><TextInput aria-label="API 대화 모델" value={selectedProfile.model} readOnly /></div>}</>}</div>{!current && !selectedAgent && isCliProvider(connectionId) && <ModelPicker provider={connectionId} auth={auth[connectionId] ?? blankAuth} state={catalogs[connectionId]} selection={modelSelections[connectionId]} context="대화" disabled={allBusy || running} onModel={id => chooseModel(connectionId, id)} onEffort={effort => chooseEffort(connectionId, effort)} onRefresh={() => void loadCatalog(connectionId, true)} />}<div className={`workspace-bar typo-l1/r text-glyph-gray-description${selectedAgent ? ' agent-chat-workspace' : ''}`}>{current ? <span>{current.workspacePath ? `작업 폴더 · ${current.workspacePath}` : '작업 폴더 없음 · 텍스트 대화'}</span> : selectedAgent ? <span>{selectedAgent.workspacePath ? `작업 폴더 · ${selectedAgent.workspacePath}` : '작업 폴더 없음 · 텍스트 작업'}</span> : <><Button kind="common" hierarchy="ghost" size="xsmall" disabled={allBusy || running} onPress={() => void action('workspace', async () => { const result = await invoke('selectWorkspace'); if (result?.path) setWorkspacePath(result.path); })}>{workspacePath ? '폴더 변경' : '작업 폴더 선택'}</Button><span>{workspacePath || '선택한 폴더 안에서만 파일 도구를 사용합니다.'}</span>{workspacePath && <Button kind="common" hierarchy="naked" size="xsmall" onPress={() => setWorkspacePath('')}>해제</Button>}</>}</div>{current?.purpose === 'avatar' ? <div className="team-member-composer bg-background-base-subtle rounded-lg"><p className="typo-b3/r text-glyph-gray-description">프로필 이미지 생성 기록입니다. 복구가 필요하면 위의 내보내기로 기록을 저장하세요.</p></div> : current?.teamRunId ? <div className="team-member-composer bg-background-base-subtle rounded-lg"><p className="typo-b3/r text-glyph-gray-description">{teamRuns.some(run => run.id === current.teamRunId) ? '팀 순서에 따라 진행하는 멤버 작업입니다. 추가 지시는 팀 공유 대화에서 전달하세요.' : '팀 작업의 멤버 기록입니다. 내용을 확인하거나 내보낼 수 있습니다.'}</p><div className="flex gap-2">{teamRuns.some(run => run.id === current.teamRunId) && <Button kind="vendit" hierarchy="secondary" size="medium" onPress={() => openTeamRun(current.teamRunId!)}>팀 대화로 이동</Button>}{teamRunInProgress(teamRuns.find(run => run.id === current.teamRunId)) && <Button kind="destructive" hierarchy="ghost" size="medium" onPress={() => cancelTeam(current.teamRunId!)}>팀 작업 중단</Button>}</div></div> : <><ChatTurnList turns={(state.chatTurns ?? []).filter(turn => turn.sessionId === sessionId)} storageError={state.chatTurnStorageError} busy={!!busy['chat-turn']} onCancel={id => void action('chat-turn', async () => {await invoke('cancelChatTurn', {id});})} onRetry={id => void action('chat-turn', async () => {await invoke('retryChatTurn', {id});})} onResume={() => void action('chat-turn', async () => {await invoke('resumeChatTurns', {sessionId});})}/><ChatComposer queueWhileRunning activeInputMode={!attachments.files.length && steerHere ? 'steer' : 'fifo'} label="메시지" placeholder={`${selectedAgent?.name || current?.agentName || '벤디트봇'}에게 할 일을 알려주세요…`} value={prompt} onChange={setPrompt} onSend={send} focusRequest={composerFocus} disabled={attachments.busy} sending={!!busy.send} onChooseAttachments={attachments.choose} canSend={(!!prompt.trim() || !!attachments.files.length) && !(!current && !selectedAgent && isCliProvider(connectionId) && !selectionForRequest(catalogs[connectionId], auth[connectionId], modelSelections[connectionId]))} onCancel={sessionBusy ? () => void action('cancel', async () => { await invoke('cancel', { sessionId }); }) : undefined} cancelLabel={queuedHere ? '대기 작업 취소' : '응답 중단'} hint={sessionBusy ? !attachments.files.length && steerHere ? "Enter로 진행 중 응답에 지시를 추가합니다" : "Enter로 다음 메시지 추가 · 앞 응답이 끝나면 순서대로 답변합니다" : "Enter 입력 · Shift + Enter 줄바꿈 · 이미지·텍스트 파일 최대 5개"}><AttachmentList files={attachments.files} onRemove={attachments.remove}/>{(attachments.error || attachments.storage.error) && <p className="attachment-error typo-l1/r text-glyph-danger-body" role="alert">{attachments.error || attachments.storage.error}</p>}{attachments.busy && <p role="status" className="typo-l1/r">첨부 파일 준비 중…</p>}</ChatComposer></>}<p className="footnote typo-l2/r text-glyph-gray-caption">메시지는 선택한 서비스로 전송됩니다. 연결별 이용 한도와 API 요금이 적용됩니다.</p></div></footer>
      </>}
    </main>
    <AgentMenu anchor={menuAnchor} agent={agents.find(agent => agent.id === agentMenuId)} busy={busy[`clone-agent-${agentMenuId}`]} onClose={() => setAgentMenuId('')} onClone={cloneAgent} onOpen={() => { openAgent(agentMenuId); setAgentMenuId(''); }} onEdit={() => { const agent = agents.find(agent => agent.id === agentMenuId); if (agent) editAgent(agent); setAgentMenuId(''); }} onDelete={() => { setDeleteAgentId(agentMenuId); setAgentMenuId(''); }} canMoveUp={sidebarOrder.agents.indexOf(agentMenuId) > 0} canMoveDown={sidebarOrder.agents.indexOf(agentMenuId) >= 0 && sidebarOrder.agents.indexOf(agentMenuId) < sidebarOrder.agents.length - 1} onMove={offset => sidebarOrder.move('agents', agentMenuId, offset)} />
    <AgentMenu anchor={menuAnchor} kind="팀" agent={teams.find(team => team.id === teamMenuId)} busy={busy[`clone-team-${teamMenuId}`]} onClose={() => setTeamMenuId('')} onClone={cloneTeam} onOpen={() => { openTeam(teamMenuId); setTeamMenuId(''); }} onEdit={() => { const team = teams.find(team => team.id === teamMenuId); if (team) editTeam(team); setTeamMenuId(''); }} onDelete={() => { setDeleteTeamId(teamMenuId); setTeamMenuId(''); }} canMoveUp={sidebarOrder.teams.indexOf(teamMenuId) > 0} canMoveDown={sidebarOrder.teams.indexOf(teamMenuId) >= 0 && sidebarOrder.teams.indexOf(teamMenuId) < sidebarOrder.teams.length - 1} onMove={offset => sidebarOrder.move('teams', teamMenuId, offset)} />
    <Dialog.Root open={!!deleteTeamId} onOpenChange={(open: boolean) => { if (!open) setDeleteTeamId(''); }}><Dialog.Portal managed={false}><Dialog.Content size="normal"><Dialog.Header hideCloseIcon title="팀을 삭제할까요?" description="팀 설정을 삭제합니다. 이미 만들어진 팀 작업 기록은 유지됩니다." /><div className="dialog-body"><p className="typo-b3/sb text-glyph-gray-heading">{teams.find(team => team.id === deleteTeamId)?.name}</p>{notice?.error && <p role="alert" className="typo-b3/r text-glyph-danger-body">{notice.text}</p>}</div><Dialog.Footer RightComponent={() => <><Button kind="common" hierarchy="secondary" size="medium" onPress={() => setDeleteTeamId('')}>취소</Button><Button kind="destructive" size="medium" disabled={allBusy} onPress={() => void action('delete-team', async () => { const next = await invoke('deleteTeam', { id: deleteTeamId }) as State; stateClock.current.changed(); setState(previous => mergeTeamSnapshot(previous, next)); setDeleteTeamId(''); setTeamId(''); setView('teams'); })}>팀 삭제</Button></>} /></Dialog.Content></Dialog.Portal></Dialog.Root>
    <Dialog.Root open={!!deleteTeamRunId} onOpenChange={(open: boolean) => { if (!open) setDeleteTeamRunId(''); }}><Dialog.Portal managed={false}><Dialog.Content size="normal"><Dialog.Header hideCloseIcon title="팀 작업 기록을 삭제할까요?" description="이 팀의 공유 대화와 진행 기록을 삭제합니다. 멤버 작업 대화는 개별 이력에서 확인할 수 있습니다." /><div className="dialog-body">{notice?.error && <p role="alert" className="typo-b3/r text-glyph-danger-body">{notice.text}</p>}</div><Dialog.Footer RightComponent={() => <><Button kind="common" hierarchy="secondary" size="medium" onPress={() => setDeleteTeamRunId('')}>취소</Button><Button kind="destructive" size="medium" disabled={allBusy} onPress={() => void action('delete-team-run', async () => { const id = deleteTeamRunId; await invoke('deleteTeamRun', { id }); stateClock.current.changed(); setState(previous => ({ ...previous, teamRuns: (previous.teamRuns ?? []).filter(run => run.id !== id) })); setDeleteTeamRunId(''); setTeamRunId(''); setView(selectedTeam ? 'team' : 'teams'); })}>팀 작업 삭제</Button></>} /></Dialog.Content></Dialog.Portal></Dialog.Root>
    <Dialog.Root open={!!deleteAgentId} onOpenChange={(open: boolean) => { if (!open) setDeleteAgentId(''); }}><Dialog.Portal managed={false}><Dialog.Content size="normal"><Dialog.Header hideCloseIcon title="에이전트를 삭제할까요?" description="이 에이전트의 저장된 역할과 연결 설정을 삭제합니다." /><div className="dialog-body"><p className="typo-b2/sb text-glyph-gray-heading">{agents.find(agent => agent.id === deleteAgentId)?.name}</p>{notice?.error && <p role="alert" className="typo-b3/r text-glyph-danger-body">{notice.text}</p>}</div><Dialog.Footer RightComponent={() => <><Button kind="common" hierarchy="secondary" size="medium" onPress={() => setDeleteAgentId('')}>취소</Button><Button kind="destructive" size="medium" disabled={allBusy} loading={!!busy['delete-agent']} onPress={() => void action('delete-agent', async () => { const next = await invoke('deleteAgent', { id: deleteAgentId }) as State; stateClock.current.changed(); setState(previous => mergeAgentSnapshot(previous, next)); setDeleteAgentId(''); setAgentId(''); setView('agents'); })}>에이전트 삭제</Button></>} /></Dialog.Content></Dialog.Portal></Dialog.Root>
    <ActionApproval approval={approval} busy={busy.approval} error={notice?.error ? notice.text : undefined} onRespond={respondApproval} />
    <Dialog.Root open={!!sessionAction} onOpenChange={(open: boolean) => { if (!open) setSessionAction(null); }}><Dialog.Portal managed={false}><Dialog.Content size="normal"><Dialog.Header hideCloseIcon title={sessionAction === 'rename' ? '대화 이름 바꾸기' : sessionAction === 'delete' ? '대화를 삭제할까요?' : '대화 내보내기'} description={sessionAction === 'delete' ? '이 Mac에 저장된 대화 기록이 삭제됩니다.' : sessionAction === 'export' ? '대화 내용을 원하는 파일 형식으로 저장하세요.' : '이 대화를 찾기 쉬운 이름으로 저장하세요.'} /><div className="dialog-body">{sessionAction === 'rename' && <TextInput label="대화 이름" value={renameTitle} maxLength={100} onChange={(event: ReactTypes.ChangeEvent<HTMLInputElement>) => setRenameTitle(event.target.value)} />}{sessionAction === 'delete' && <p className="typo-b2/sb text-glyph-gray-heading">{current?.title}</p>}{notice?.error && <p className="typo-b3/r text-glyph-danger-body" role="alert">{notice.text}</p>}</div><Dialog.Footer RightComponent={() => sessionAction === 'export' ? <><Button kind="common" hierarchy="ghost" size="medium" onPress={() => setSessionAction(null)}>닫기</Button><Button kind="common" hierarchy="secondary" size="medium" disabled={busy['session-export']} onPress={() => exportSession('json')}>JSON</Button><Button kind="vendit" size="medium" disabled={busy['session-export']} onPress={() => exportSession('markdown')}>Markdown</Button></> : <><Button kind="common" hierarchy="secondary" size="medium" onPress={() => setSessionAction(null)}>취소</Button><Button kind={sessionAction === 'delete' ? 'destructive' : 'vendit'} size="medium" disabled={!!busy['session-action'] || (sessionAction === 'rename' && !renameTitle.trim())} loading={!!busy['session-action']} onPress={() => void action('session-action', async () => { if (!current) return; if (sessionAction === 'rename') await invoke('renameSession', { id: current.id, title: renameTitle.trim() }); else { await invoke('deleteSession', { id: current.id }); setSessionId(''); } await refresh(); setSessionAction(null); })}>{sessionAction === 'delete' ? '대화 삭제' : '이름 저장'}</Button></>} /></Dialog.Content></Dialog.Portal></Dialog.Root>
  </div>;
}
window.ReactDOM.createRoot(document.getElementById('app')!).render(<VDSProvider preferScheme="light"><App /></VDSProvider>);
