import {validDevelopmentBinding} from '../../source/shared/development-routing';
import { ACTION_RULE_CATEGORIES, type ActionRules } from '../../source/shared/action-rules';
import { normalizePolicyEfficiency, type AgentPolicyDraft } from '../../source/shared/agent-policy';
import type * as ReactTypes from 'react';
import type { AgentDraft, TeamDraft } from './ui-state';
const React: typeof ReactTypes = window.React;
const namespace = 'venditbot.drafts.v1.';
const maximumBytes = 2_000_000;
const recoveryFormat = 'venditbot-draft-recovery-v1';
export type DraftOriginal = { text: string; preserved: boolean };
export type DraftStorageStatus = { error?: string; original?: DraftOriginal; flush(): boolean; preserveOriginal(): boolean };
export type AgentEditDraft = { draft: AgentDraft; avatarPrompt: string; avatarMode?: 'image' | 'illustration'; avatarOwnerKey?: string; avatarRequestId?: string; avatarAppliedRequestId?: string };
export type ActionRulesEditDraft = { rules: ActionRules; expectedUpdatedAt: string };
export type PolicyEditDraft = { draft: AgentPolicyDraft & { id?: string }; expectedUpdatedAt: string; previewAgentId: string; previewText: string };
export type TeamEditDraft = { draft: TeamDraft; expectedUpdatedAt: string };
const object = (value: unknown): value is Record<string, unknown> => !!value && typeof value === 'object' && !Array.isArray(value);
const string = (value: unknown, max: number): value is string => typeof value === 'string' && value.length <= max && !value.includes('\0');
const validKey = (key: string) => /^[\w-]{1,100}$/.test(key) && !['__proto__', 'constructor', 'prototype'].includes(key);
const optional = (value: unknown, max: number) => value === undefined || string(value, max);
export function textDrafts(value: unknown): Record<string, string> | undefined {
  if (!object(value)) return;
  const entries = Object.entries(value);
  if (entries.length > 1000 || entries.some(([key, text]) => !/^(session:|agent:|chat:|message:|new-chat:|new-chat$)/.test(key) || !string(key, 200) || !string(text, 100000))) return;
  return Object.fromEntries(entries.filter(([, text]) => text !== '')) as Record<string, string>;
}
export function agentEditDrafts(value: unknown): Record<string, AgentEditDraft> | undefined {
  if (!object(value) || Object.keys(value).length > 201) return;
  const result: Record<string, AgentEditDraft> = {};
  for (const [key, record] of Object.entries(value)) {
    if (!validKey(key) || !object(record) || !object(record.draft)) return;
    const d = record.draft;
    if (d.development !== undefined && !validDevelopmentBinding(d.development)) return;
    if (!string(d.name, 80) || !string(d.instructions, 16000) || !string(d.connectionId, 200) || !string(d.model, 200) || !optional(d.id, 100) || !optional(d.effort, 40) || !optional(d.avatarId, 100) || !optional(d.workspacePath, 4096) || !optional(record.avatarOwnerKey, 120) || !optional(record.avatarRequestId, 100) || !optional(record.avatarAppliedRequestId, 100) || !string(record.avatarPrompt, 4000) || (record.avatarMode !== undefined && record.avatarMode !== 'image' && record.avatarMode !== 'illustration')) return;
    if (d.automation !== undefined && (!object(d.automation) || !string(d.automation.policyId, 100))) return;
    const routes = d.connections;
    if (routes !== undefined && (!Array.isArray(routes) || routes.length > 8 || routes.some(r => !object(r) || !string(r.connectionId, 200) || !string(r.model, 200) || !optional(r.effort, 40)))) return;
    const draft: AgentDraft = { name: d.name, instructions: d.instructions, connectionId: d.connectionId, model: d.model };
    for (const field of ['id', 'effort', 'avatarId', 'workspacePath'] as const) if (typeof d[field] === 'string') draft[field] = d[field];
    if (validDevelopmentBinding(d.development)) draft.development = {mode: 'rabbit', connectionId: d.development.connectionId};
    if (object(d.automation)) draft.automation = { policyId: d.automation.policyId as string };
    if (Array.isArray(routes)) draft.connections = routes.map(r => ({ connectionId: r.connectionId, model: r.model, ...(r.effort ? { effort: r.effort } : {}) }));
    result[key] = { draft, avatarPrompt: record.avatarPrompt, ...(record.avatarMode ? { avatarMode: record.avatarMode } : {}), ...Object.fromEntries(['avatarOwnerKey', 'avatarRequestId', 'avatarAppliedRequestId'].filter(key => typeof record[key] === 'string').map(key => [key, record[key]])) };
  }
  return result;
}
export function teamEditDrafts(value: unknown): Record<string, TeamEditDraft> | undefined {
  if (!object(value) || Object.keys(value).length > 51) return;
  const result: Record<string, TeamEditDraft> = {};
  for (const [key, record] of Object.entries(value)) {
    if (!validKey(key) || !object(record) || !object(record.draft)) return;
    const d = record.draft;
    if (d.development !== undefined && !validDevelopmentBinding(d.development)) return;
    if (!string(d.name, 80) || !string(d.instructions, 16000) || !optional(d.id, 100) || !optional(d.topic, 4000) || !optional(d.policies, 16000) || !optional(d.leaderAgentId, 100) || !optional(d.projectBrief, 4000) || !optional(d.workspacePath, 4096) || !optional(d.requestId, 100) || (d.leaderMode !== undefined && d.leaderMode !== 'existing' && d.leaderMode !== 'automatic') || (d.autonomous !== undefined && typeof d.autonomous !== 'boolean') || !Array.isArray(d.memberAgentIds) || d.memberAgentIds.some(id => !string(id, 100)) || !string(record.expectedUpdatedAt, 40)) return;
    const draft: TeamDraft = { name: d.name, instructions: d.instructions, memberAgentIds: [...d.memberAgentIds] as string[], rounds: 1 };
    if (validDevelopmentBinding(d.development)) draft.development = {mode: 'rabbit', connectionId: d.development.connectionId};
    if (typeof d.autonomous === 'boolean') draft.autonomous = d.autonomous;
    if (d.leaderMode === 'existing' || d.leaderMode === 'automatic') draft.leaderMode = d.leaderMode;
    for (const field of ['id', 'topic', 'policies', 'leaderAgentId', 'projectBrief', 'workspacePath', 'requestId'] as const) if (typeof d[field] === 'string') draft[field] = d[field];
    result[key] = { draft, expectedUpdatedAt: record.expectedUpdatedAt };
  }
  return result;
}
export function clearMatchingDraft<T>(records: Record<string, T>, key: string, submitted: T): Record<string, T> {
  if (JSON.stringify(records[key]) !== JSON.stringify(submitted)) return records;
  const next = { ...records }; delete next[key]; return next;
}
export class LocalDraftStore<T> {
  value: T;
  error?: string;
  private unreadable = false;
  private unreadableRaw?: string;
  private archivedOriginal?: string;
  get original(): DraftOriginal | undefined {
    return this.unreadableRaw !== undefined ? { text: this.unreadableRaw, preserved: false } : this.archivedOriginal !== undefined ? { text: this.archivedOriginal, preserved: true } : undefined;
  }
  private decode(raw: string): { value: T; original?: string } | undefined {
    if (raw.length > maximumBytes) return;
    const parsed: unknown = JSON.parse(raw);
    if (object(parsed) && parsed.format === recoveryFormat) {
      if (typeof parsed.original !== 'string') return;
      const value = this.sanitize(parsed.drafts); return value === undefined ? undefined : { value, original: parsed.original };
    }
    const value = this.sanitize(parsed); return value === undefined ? undefined : { value };
  }
  private encode(value: T, original = this.archivedOriginal): string {
    const raw = JSON.stringify(original === undefined ? value : { format: recoveryFormat, drafts: value, original });
    if (raw.length > maximumBytes) throw new Error('draft quota'); return raw;
  }
  constructor(private readonly storage: Pick<Storage, 'getItem' | 'setItem'> | undefined, private readonly key: string, initial: T, private readonly sanitize: (value: unknown) => T | undefined) {
    this.value = initial;
    if (!storage) return;
    let raw: string | null = null;
    try {
      raw = storage.getItem(namespace + key); if (raw === null) return;
      const decoded = this.decode(raw);
      if (!decoded) throw new Error('invalid draft'); this.value = decoded.value; this.archivedOriginal = decoded.original;
    } catch { this.unreadableRaw = raw ?? undefined; this.unreadable = true; this.error = '보관한 초안을 읽지 못했습니다. 원본은 유지하며 업데이트를 막았습니다.'; }
  }
  set(next: T): void { this.value = next; this.flush(); }
  flush(): boolean {
    if (this.unreadable) {
      try {
        if (!this.storage) return false;
        const raw = this.storage.getItem(namespace + this.key);
        let decoded: { value: T; original?: string } | undefined;
        try { decoded = raw === null ? undefined : this.decode(raw); }
        finally { if (raw !== null && !decoded) this.unreadableRaw = raw; }
        const recovered = raw === null ? {} : decoded?.value;
        if (!object(recovered) || !object(this.value)) return false;
        const merged = this.sanitize({ ...recovered, ...this.value });
        if (merged === undefined) return false;
        this.value = merged; this.archivedOriginal = decoded?.original; this.unreadableRaw = undefined; this.unreadable = false;
      } catch { return false; }
    }
    try {
      if (!this.storage) throw new Error('unavailable storage');
      const valid = this.sanitize(this.value); if (valid === undefined) throw new Error('invalid draft');
      const raw = this.encode(valid);
      this.storage.setItem(namespace + this.key, raw); this.error = undefined; return true;
    } catch { this.error = '작성 중인 초안을 저장하지 못했습니다. 내용을 보관한 뒤 저장을 다시 시도하세요.'; return false; }
  }
  /** Explicit recovery keeps the unreadable original alongside current editable drafts. */
  preserveOriginal(): boolean {
    if (!this.unreadable || this.unreadableRaw === undefined || !this.storage) return false;
    try {
      const original = this.unreadableRaw;
      if (this.storage.getItem(namespace + this.key) !== original) throw new Error('draft changed');
      const valid = this.sanitize(this.value); if (valid === undefined) throw new Error('invalid draft');
      this.storage.setItem(namespace + this.key, this.encode(valid, original));
      this.value = valid; this.archivedOriginal = original; this.unreadableRaw = undefined; this.unreadable = false; this.error = undefined; return true;
    } catch { this.error = '원본 보관에 실패했습니다. 기존 원본과 현재 입력을 유지합니다. 내용을 복사하고 다시 시도하세요.'; return false; }
  }
}
/** Writes synchronously in the input handler, before a reload/update can replace the renderer. */
export function useLocalDraft<T>(key: string, initial: T, sanitize: (value: unknown) => T | undefined): [T, ReactTypes.Dispatch<ReactTypes.SetStateAction<T>>, DraftStorageStatus] {
  const store = React.useRef<LocalDraftStore<T> | undefined>(undefined);
  if (!store.current) { let storage: Storage | undefined; try { storage = window.localStorage; } catch {} store.current = new LocalDraftStore(storage, key, initial, sanitize); }
  const [value, setValue] = React.useState(store.current.value), [error, setError] = React.useState(store.current.error);
  const [original, setOriginal] = React.useState(store.current.original);
  const sync = () => { setValue(store.current!.value); setError(store.current!.error); setOriginal(store.current!.original); };
  const set = (action: ReactTypes.SetStateAction<T>) => { const next = typeof action === 'function' ? (action as (previous: T) => T)(store.current!.value) : action; store.current!.set(next); sync(); };
  return [value, set, { error, original, flush: () => { const ok = store.current!.flush(); sync(); return ok; }, preserveOriginal: () => { const ok = store.current!.preserveOriginal(); sync(); return ok; } }];
}

export function policyEditDrafts(value: unknown): Record<string, PolicyEditDraft> | undefined {
  if (!object(value) || Object.keys(value).length > 51) return;
  const result: Record<string, PolicyEditDraft> = {};
  for (const [key, record] of Object.entries(value)) {
    if (!validKey(key) || !object(record) || !object(record.draft)) return;
    const d = record.draft;
    if (!optional(d.id, 100) || !string(d.name, 80) || !string(d.description, 2000) || !['routine', 'standard', 'complex'].includes(String(d.defaultTaskKind)) || !Array.isArray(d.rules) || d.rules.length !== 3 || !string(record.expectedUpdatedAt, 40) || !string(record.previewAgentId, 100) || !string(record.previewText, 8000)) return;
    if (new Set(d.rules.map(rule => object(rule) ? rule.taskKind : '')).size !== 3) return;
    const rules = [];
    for (const rule of d.rules) {
      if (!object(rule) || !['routine', 'standard', 'complex'].includes(String(rule.taskKind)) || !Array.isArray(rule.keywords) || rule.keywords.length > 32 || rule.keywords.some(word => !string(word, 80)) || !Array.isArray(rule.connections) || rule.connections.length < 1 || rule.connections.length > 8 || rule.connections.some(route => !object(route) || !string(route.connectionId, 200) || !string(route.model, 200) || !optional(route.effort, 40))) return;
      let efficiency;
      try { if (rule.efficiency !== undefined) efficiency = normalizePolicyEfficiency(rule.efficiency); } catch { return; }
      rules.push({ taskKind: rule.taskKind, keywords: [...rule.keywords], connections: rule.connections.map(route => ({ connectionId: route.connectionId, model: route.model, ...(route.effort ? { effort: route.effort } : {}) })), ...(efficiency ? { efficiency } : {}) });
    }
    result[key] = { draft: { ...(d.id ? { id: d.id } : {}), name: d.name, description: d.description, defaultTaskKind: d.defaultTaskKind, rules }, expectedUpdatedAt: record.expectedUpdatedAt, previewAgentId: record.previewAgentId, previewText: record.previewText } as PolicyEditDraft;
  }
  return result;
}

export function actionRulesEdits(value: unknown): Record<string, ActionRulesEditDraft> | undefined {
  if (!object(value) || Object.keys(value).some(key => key !== 'current')) return;
  if (!value.current) return {};
  const record = value.current;
  if (!object(record) || !string(record.expectedUpdatedAt, 40) || !object(record.rules)) return;
  const r = record.rules;
  if (r.version !== 1 || !string(r.updatedAt, 40) || !['allow', 'ask', 'deny'].includes(String(r.defaultMode)) || !Array.isArray(r.rules) || r.rules.length !== ACTION_RULE_CATEGORIES.length || !Array.isArray(r.protectedPaths) || r.protectedPaths.length > 100) return;
  if (new Set(r.rules.map(rule => object(rule) ? rule.category : '')).size !== ACTION_RULE_CATEGORIES.length || r.rules.some(rule => !object(rule) || !(ACTION_RULE_CATEGORIES as readonly unknown[]).includes(rule.category) || !['ask', 'deny'].includes(String(rule.mode))) || r.protectedPaths.some(path => !object(path) || !string(path.id, 100) || !string(path.pathPrefix, 4096) || !['ask', 'deny'].includes(String(path.mode)))) return;
  return { current: { expectedUpdatedAt: record.expectedUpdatedAt, rules: { version: 1, updatedAt: r.updatedAt, defaultMode: r.defaultMode, rules: r.rules.map(rule => ({ category: rule.category, mode: rule.mode })), protectedPaths: r.protectedPaths.map(path => ({ id: path.id, pathPrefix: path.pathPrefix, mode: path.mode })) } as ActionRules } };
}

// Rabbit credentials deliberately have no field in either durable draft schema.
export function rabbitEditDrafts(value: unknown): Record<string, import('./rabbit-ui-state').RabbitEditDraft> | undefined {
  if (!object(value) || Object.keys(value).length > 51) return;
  const result: Record<string, import('./rabbit-ui-state').RabbitEditDraft> = {};
  for (const [key, record] of Object.entries(value)) {
    if (!validKey(key) || !object(record) || !object(record.draft)) return;
    const d = record.draft;
    if (!optional(d.id, 100) || !string(d.name, 80) || !string(d.baseUrl, 4096) || !string(d.projectId, 100) || !optional(d.repositoryId, 100) || !string(d.baseRef, 240) || !['feature_pr', 'bugfix_pr', 'review_only'].includes(String(d.workflowTemplate)) || !Number.isInteger(d.maxParallelTasks) || Number(d.maxParallelTasks) < 1 || Number(d.maxParallelTasks) > 4 || !Number.isInteger(d.timeoutSeconds) || Number(d.timeoutSeconds) < 0 || Number(d.timeoutSeconds) > 14400 || typeof d.enabledForAgents !== 'boolean' || (d.preferForProjectTasks !== undefined && typeof d.preferForProjectTasks !== 'boolean') || !string(record.endpoint, 4096) || !string(record.expectedUpdatedAt, 40)) return;
    result[key] = { draft: { ...(d.id ? { id: d.id } : {}), name: d.name, baseUrl: d.baseUrl, projectId: d.projectId, ...(d.repositoryId ? { repositoryId: d.repositoryId } : {}), baseRef: d.baseRef, workflowTemplate: d.workflowTemplate, maxParallelTasks: d.maxParallelTasks, timeoutSeconds: d.timeoutSeconds, enabledForAgents: d.enabledForAgents, ...(d.preferForProjectTasks === undefined ? {} : { preferForProjectTasks: d.preferForProjectTasks }), ...(d.allowInsecureLoopback === true ? { allowInsecureLoopback: true } : {}) }, endpoint: record.endpoint, expectedUpdatedAt: record.expectedUpdatedAt } as import('./rabbit-ui-state').RabbitEditDraft;
  }
  return result;
}
export function rabbitWorkDrafts(value: unknown): Record<string, import('./rabbit-ui-state').RabbitWorkDraft> | undefined {
  if (!object(value) || Object.keys(value).length > 100) return;
  const result: Record<string, import('./rabbit-ui-state').RabbitWorkDraft> = {};
  for (const [key, record] of Object.entries(value)) {
    if (!validKey(key) || !object(record) || !string(record.objective, 20000) || !string(record.criteria, 61000)) return;
    let pending: import('./rabbit-ui-state').RabbitWorkDraft['pending'];
    if (record.pending !== undefined) {
      if (!object(record.pending) || !string(record.pending.requestId, 100) || !object(record.pending.input)) return;
      const input = record.pending.input;
      if (!string(input.objective, 20000) || !Array.isArray(input.acceptance_criteria) || input.acceptance_criteria.length > 30 || input.acceptance_criteria.some(item => !string(item, 2000)) || !object(input.constraints) || !['feature_pr', 'bugfix_pr', 'review_only'].includes(String(input.workflow_template)) || !optional(input.repository_id, 100) || !optional(input.base_ref, 240) || !Number.isInteger(input.constraints.max_parallel_tasks) || Number(input.constraints.max_parallel_tasks) < 1 || Number(input.constraints.max_parallel_tasks) > 4 || !Number.isInteger(input.constraints.timeout_seconds) || Number(input.constraints.timeout_seconds) < 60 || Number(input.constraints.timeout_seconds) > 14400) return;
      pending = { requestId: record.pending.requestId, input: { objective: input.objective, acceptance_criteria: [...input.acceptance_criteria], workflow_template: input.workflow_template, ...(input.repository_id ? { repository_id: input.repository_id } : {}), ...(input.base_ref ? { base_ref: input.base_ref } : {}), attachments: [], constraints: { max_parallel_tasks: input.constraints.max_parallel_tasks, timeout_seconds: input.constraints.timeout_seconds, environment: 'development', api_cost_limit_usd: 0 } } as import('../../source/shared/rabbit-project-api').RabbitRunInput };
    }
    result[key] = { objective: record.objective, criteria: record.criteria, ...(pending ? { pending } : {}) };
  }
  return result;
}
