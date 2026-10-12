import {EFFICIENCY_PRESETS, normalizePolicyConnections, normalizePolicyEfficiency, type PolicyConnectionRoute, type PolicyEfficiency} from '../shared/agent-policy.js';
import type {PolicyConnectionCatalog} from './agent-policy-resolver.js';

// These are preference candidates, never a price ranking or an entitlement claim.
const lightweightCandidates = ['gpt-6-luna', 'claude-sonnet-5-5'] as const;

export function policyEfficiencyPreset(presetId: unknown, original: readonly PolicyConnectionRoute[], catalogs: readonly PolicyConnectionCatalog[]) {
  const preset = EFFICIENCY_PRESETS.find(item => item.id === presetId);
  if (!preset) throw new Error('절약 작업 종류를 확인하세요.');
  const connectionIds = [...new Set(normalizePolicyConnections(original).map(route => route.connectionId))];
  for (const modelId of lightweightCandidates) for (const connectionId of connectionIds) {
    const matches = catalogs.filter(catalog => catalog.connectionId === connectionId);
    if (matches.length !== 1) continue;
    const model = matches[0]!.models.find(item => (item.resolvedId ?? item.id) === modelId && item.efforts.includes('low'));
    if (!model) continue;
    return {keywords: [...preset.keywords], connections: [{connectionId, model: model.resolvedId ?? model.id, effort: 'low'}],
      efficiency: normalizePolicyEfficiency({preset: preset.id, maxHistoryTurns: preset.maxHistoryTurns, maxHistoryCharacters: preset.maxHistoryCharacters})};
  }
  throw new Error('선택한 연결의 현재 목록에서 절약 후보 모델과 low 추론 수준을 확인하지 못했습니다. 로그인·모델 목록을 확인하거나 사용할 모델을 직접 설정하세요. 기존 모델로 자동 전환하지 않았습니다.');
}

type HistoryMessage = {role: 'user' | 'assistant' | 'tool'; content: string | unknown[]};
/** Select a suffix of whole completed turns. Never slices a request, tool pair or saved transcript. */
export function boundPolicyHistory(history: readonly HistoryMessage[], rawEfficiency: PolicyEfficiency) {
  const efficiency = normalizePolicyEfficiency(rawEfficiency), current = history.at(-1);
  if (!current || current.role !== 'user' || typeof current.content !== 'string') throw new Error('절약 문맥은 현재 사용자 요청으로 끝나야 합니다.');
  const groups: HistoryMessage[][] = [];
  for (const message of history.slice(0, -1)) {
    if (message.role === 'user') groups.push([]);
    if (!groups.length) throw new Error('이전 대화의 완성된 작업 단위를 확인할 수 없습니다.');
    groups.at(-1)!.push(message);
  }
  if (groups.some(group => group.at(-1)?.role !== 'assistant' || typeof group.at(-1)?.content !== 'string')) throw new Error('완료되지 않은 이전 대화는 절약 문맥으로 보내지 않습니다.');
  const selected: HistoryMessage[][] = [];
  for (let index = groups.length - 1; index >= 0 && selected.length < efficiency.maxHistoryTurns; index--) {
    const next = [groups[index]!, ...selected];
    if (JSON.stringify(next.flat()).length > efficiency.maxHistoryCharacters) break;
    selected.unshift(groups[index]!);
  }
  const previous = selected.flat();
  return {messages: structuredClone([...previous, current]), includedTurns: selected.length, omittedTurns: groups.length - selected.length,
    historyCharacters: previous.length ? JSON.stringify(previous).length : 0};
}

export function efficiencyInstructions(efficiency: PolicyEfficiency, omittedTurns: number): string {
  normalizePolicyEfficiency(efficiency);
  const output = {
    status_check: '상태 확인: 확인한 사실, 이상 여부, 필요한 다음 행동만 간결하게 보고하세요. 불필요한 배경 설명은 생략하세요.',
    periodic_report: '정기 보고서: 핵심 결과, 근거, 미해결 항목과 다음 행동을 짧게 정리하세요. 반복 설명을 줄이세요.',
    settings_change: '설정 변경: 요청된 변경과 확인 결과를 간결하게 보고하세요. 필요한 기존 승인 절차를 그대로 따르세요.',
  }[efficiency.preset];
  return `절약 정책: ${output}\n이전 완료 대화 ${omittedTurns}회가 이번 전송에서 생략되었습니다. 전체 기록은 앱에 보존됩니다. 생략된 내용을 추측하거나 과거 도구 작업을 반복하지 마세요. 필요한 맥락이 없으면 현재 요청에 필요한 정보를 확인하세요. 역할·보안 규칙과 도구 승인은 그대로 적용됩니다. 이 설정은 이전 대화 전송량과 응답 스타일의 선호이며 전체 토큰 또는 비용 한도가 아닙니다.`;
}
