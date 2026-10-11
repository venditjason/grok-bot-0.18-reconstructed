import type {ProviderModel} from '../shared/provider-model-catalog.js';
import type {ConnectionRoute} from './local-store.js';

type ConnectionCatalog = {connectionId: string; models: ProviderModel[]};
const preferredRoutineModels = ['claude-sonnet-5-5', 'gpt-6-luna'] as const;
const key = (route: ConnectionRoute): string => JSON.stringify([route.connectionId, route.model, route.effort ?? null]);

/** Prefer only a currently advertised model/effort on a member's own connection.
 * The host supplies authenticated catalogs; this pure policy makes no price or
 * entitlement claims and does not change the member's saved configuration.
 */
export function recommendRoutineConnections(original: ConnectionRoute[], catalogs: ConnectionCatalog[]): {connections: ConnectionRoute[]; warning?: string} {
  const configuredIds = [...new Set(original.map(route => route.connectionId))];
  let preferred: ConnectionRoute | undefined;
  for (const modelId of preferredRoutineModels) {
    for (const connectionId of configuredIds) {
      const advertised = catalogs.find(catalog => catalog.connectionId === connectionId)?.models.find(model => (model.resolvedId ?? model.id) === modelId && model.efforts.includes('low'));
      if (advertised) {preferred = {connectionId, model: modelId, effort: 'low'}; break;}
    }
    if (preferred) break;
  }
  if (!preferred) return {connections: original.map(route => ({...route})), warning: '현재 확인된 모델 목록에서 선호 모델과 low 추론 강도를 함께 찾지 못해 기존 연결 순서를 유지합니다.'};
  const seen = new Set<string>(), connections: ConnectionRoute[] = [];
  for (const route of [preferred, ...original]) {
    const identity = key(route);
    if (seen.has(identity)) continue;
    seen.add(identity); connections.push({...route});
    if (connections.length === 8) break;
  }
  return {connections};
}
