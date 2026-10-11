import {classifyPolicyTask, normalizeAgentPolicy, normalizePolicyConnections, type AgentPolicy, type AgentPolicySelection, type PolicyConnectionRoute, type TaskKind} from '../shared/agent-policy.js';
import {selectProviderModel, type ProviderModel} from '../shared/provider-model-catalog.js';

export type PolicyConnectionCatalog = {connectionId: string; models: readonly ProviderModel[]};
export type ResolveAgentPolicyOptions = {
  policy: AgentPolicy;
  originalConnections: readonly PolicyConnectionRoute[];
  text: string;
  taskKind?: TaskKind;
  catalogs: readonly PolicyConnectionCatalog[];
  explicitConnections?: readonly PolicyConnectionRoute[];
};
const fallbackWarning = '정책의 연결·모델·추론 수준을 현재 목록에서 모두 확인하지 못해 에이전트의 기존 연결 순서를 유지합니다. 실행할 때 각 연결을 다시 확인합니다.';

/** Select once from a captured policy and authenticated host catalogs. No I/O,
 * pricing assumptions or model substitutions; the caller persists the result
 * before dispatch and applies the existing no-replay-after-effects boundary.
 */
export function resolveAgentPolicy(options: ResolveAgentPolicyOptions): AgentPolicySelection {
  const policy = normalizeAgentPolicy(options.policy);
  const original = normalizePolicyConnections(options.originalConnections);
  const classification = classifyPolicyTask(policy, options.text, options.taskKind);
  const metadata = {...classification, policyId: policy.id, policyName: policy.name, policyUpdatedAt: policy.updatedAt};
  const allowed = new Set(original.map(route => route.connectionId));
  const validate = (routes: readonly PolicyConnectionRoute[]): PolicyConnectionRoute[] => {
    const selected = normalizePolicyConnections(routes).map(route => {
      if (!allowed.has(route.connectionId)) throw new Error('에이전트에 등록된 연결 안에서만 모델을 선택할 수 있습니다.');
      const catalogs = options.catalogs.filter(catalog => catalog.connectionId === route.connectionId);
      if (catalogs.length !== 1 || !catalogs[0]!.models.length) throw new Error('선택한 연결의 현재 모델 목록을 확인할 수 없습니다.');
      const catalog = catalogs[0]!;
      const selected = selectProviderModel({models: [...catalog.models], fetchedAt: '', source: 'host-supplied'}, route.model, route.effort);
      return {connectionId: route.connectionId, ...selected};
    });
    // Aliases can collapse onto one model/default effort. Do not silently drop
    // a priority or execute the same effective route twice.
    return normalizePolicyConnections(selected);
  };
  if (options.explicitConnections !== undefined) {
    return {...metadata, reason: `명시한 연결 순서 우선. ${classification.reason}`, connections: validate(options.explicitConnections)};
  }
  const rule = policy.rules.find(rule => rule.taskKind === classification.taskKind)!;
  try { return {...metadata, connections: validate(rule.connections)}; }
  catch { return {...metadata, connections: original, warning: fallbackWarning}; }
}
