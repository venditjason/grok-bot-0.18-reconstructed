import { duplicateConnectionIndex, maxAgentConnections, type AgentConnection, type Auth, type Profile } from './ui-state';

export type CliProvider = 'codex' | 'claude-code';
export type CatalogModel = { id: string; resolvedId?: string; label: string; description?: string; isDefault: boolean; efforts: string[]; defaultEffort?: string };
export type ModelCatalog = { models: CatalogModel[]; fetchedAt: string; source: string; warning?: string };
export type ModelSelection = { model: string; effort?: string };
export type CatalogState = { accountKey: string; phase: 'idle' | 'loading' | 'ready' | 'error'; catalog?: ModelCatalog; error?: string };
export const emptySelection: ModelSelection = { model: '' };
/** Keep official aliases selectable while making their exact advertised version visible. */
export function catalogModelLabel(model: CatalogModel): string {
  const exact = model.resolvedId || model.id;
  const title = model.label === exact ? exact : `${model.label} · ${exact}`;
  return `${title}${model.resolvedId && model.id !== model.resolvedId ? ` (${model.id})` : ''}${model.isDefault ? ' · 기본' : ''}`;
}
export function isCliProvider(value: string): value is CliProvider { return value === 'codex' || value === 'claude-code'; }
export function accountKey(auth?: Auth): string { return auth?.authenticated ? JSON.stringify([auth.account?.email ?? null, auth.account?.plan ?? null]) : ''; }

export function catalogModelSelection(catalog: ModelCatalog, id: string): ModelSelection {
  const model = catalog.models.find(item => item.id === id) ?? catalog.models.find(item => item.resolvedId === id);
  if (!model) return { model: '' };
  return { model: model.id, ...(model.defaultEffort && model.efforts.includes(model.defaultEffort) ? { effort: model.defaultEffort } : {}) };
}

/** Refresh may preserve a valid choice, but never inherit effort from another model. */
export function reconcileModelSelection(catalog: ModelCatalog, previous: ModelSelection): ModelSelection {
  const selected = catalog.models.find(item => item.id === previous.model) ?? catalog.models.find(item => item.resolvedId === previous.model);
  if (!selected) return catalogModelSelection(catalog, catalog.models.find(item => item.isDefault)?.id ?? '');
  if (previous.effort && selected.efforts.includes(previous.effort)) return { model: selected.id, effort: previous.effort };
  return catalogModelSelection(catalog, selected.id);
}

export function selectionForRequest(state: CatalogState | undefined, auth: Auth | undefined, selection: ModelSelection): ModelSelection | undefined {
  if (!auth?.authenticated || state?.accountKey !== accountKey(auth) || state.phase !== 'ready') return;
  const model = state.catalog?.models.find(item => item.id === selection.model);
  if (!model || (selection.effort && !model.efforts.includes(selection.effort))) return;
  return { model: model.id, ...(selection.effort ? { effort: selection.effort } : {}) };
}

/** Validate every priority against its current account catalog or fixed API profile. */
export function agentConnectionsForRequest(routes: AgentConnection[], catalogs: Partial<Record<CliProvider, CatalogState>>, auth: Record<string, Auth>, profiles: Profile[]): AgentConnection[] {
  if (!routes.length || routes.length > maxAgentConnections) throw new Error(`AI 연결은 1개부터 ${maxAgentConnections}개까지 설정하세요.`);
  const canonical: AgentConnection[] = [];
  const connections = routes.map((route, index) => {
    if (isCliProvider(route.connectionId)) {
      const state = catalogs[route.connectionId];
      const selection = selectionForRequest(state, auth[route.connectionId], route);
      if (!selection) throw new Error(`${index + 1}순위 연결에 로그인한 뒤 공식 목록에서 모델과 추론 강도를 확인하세요.`);
      const model = state!.catalog!.models.find(item => item.id === selection.model)!;
      canonical.push({ connectionId: route.connectionId, ...selection, model: model.resolvedId || model.id });
      return { connectionId: route.connectionId, ...selection };
    }
    const profile = profiles.find(item => item.id === route.connectionId);
    if (!profile?.model) throw new Error(`${index + 1}순위에서 사용할 AI 연결을 선택하세요.`);
    const fixed = { connectionId: profile.id, model: profile.model };
    canonical.push(fixed); return fixed;
  });
  const duplicate = duplicateConnectionIndex(canonical);
  if (duplicate >= 0) throw new Error(`${duplicate + 1}순위가 앞선 연결과 같은 모델·추론 강도입니다. 다른 설정을 선택하거나 삭제하세요.`);
  return connections;
}

/** Independent provider generations discard stale success AND stale failure. */
export class CatalogRequestGate {
  private readonly generations = new Map<CliProvider, number>();
  begin(provider: CliProvider): number { const next = (this.generations.get(provider) ?? 0) + 1; this.generations.set(provider, next); return next; }
  current(provider: CliProvider, generation: number): boolean { return this.generations.get(provider) === generation; }
}
