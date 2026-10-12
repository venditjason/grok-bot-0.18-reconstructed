/** @jsxRuntime classic */
/** @jsx React.createElement */
/** @jsxFrag React.Fragment */
import type * as ReactTypes from 'react';
import type { DevelopmentBinding } from '../../source/shared/development-routing';
import type { RabbitProfile } from './rabbit-ui-state';
const React: typeof ReactTypes = window.React;
const { Button } = window.VDS;

export function DevelopmentRoutingPicker({ value, inherited, connections = [], scope, disabled, onChange, onManage }: {
  value?: DevelopmentBinding; inherited?: DevelopmentBinding; connections?: RabbitProfile[]; scope: 'team' | 'agent'; disabled?: boolean;
  onChange(value: DevelopmentBinding | undefined): void; onManage?(): void;
}) {
  const effective = value ?? (scope === 'team' ? inherited : undefined);
  const selected = connections.find(connection => connection.id === effective?.connectionId);
  const unavailable = !!effective && (!selected || !selected.enabledForAgents || !selected.hasKey);
  return <section className="agent-automation bg-background-base-subtle rounded-lg" style={{ padding: 16 }} aria-label={scope === 'team' ? '팀 개발 실행 설정' : '대표·PM 개발 실행 설정'}>
    <label className="form-field typo-l1/m text-glyph-gray-description">개발을 맡길 Rabbit 프로젝트
      <select aria-label={scope === 'team' ? '팀 Rabbit 프로젝트' : '에이전트 Rabbit 기본 프로젝트'} className="select-control bg-background-base-normal text-glyph-gray-body border border-solid border-line-outline-stroke" value={value?.connectionId ?? ''} disabled={disabled} onChange={event => onChange(event.target.value ? { mode: 'rabbit', connectionId: event.target.value } : undefined)}>
        <option value="">{scope === 'team' ? '대표의 기본 설정 사용' : '지정 안 함 · 기존 실행 방식 유지'}</option>
        {connections.map(connection => <option key={connection.id} value={connection.id} disabled={!connection.enabledForAgents || !connection.hasKey}>{connection.name} · {connection.projectId}{!connection.enabledForAgents ? ' · 에이전트 사용 허용 필요' : !connection.hasKey ? ' · 키 저장 필요' : ''}</option>)}
        {value && !connections.some(connection => connection.id === value.connectionId) && <option value={value.connectionId}>삭제되거나 사용할 수 없는 연결 · 다시 선택하세요</option>}
      </select>
    </label>
    {effective ? <><p className="typo-l1/r text-glyph-gray-description">대표·PM은 지정한 AI 모델로 기획·검토·보고합니다. 실제 개발과 테스트는 {selected?.name ?? '지정된 Rabbit 프로젝트'}의 레인에 맡깁니다. 로컬 파일 변경이나 다른 프로젝트로 자동 전환하지 않습니다.</p>{selected && <p className="typo-l2/r text-glyph-gray-caption">{scope === 'team' && !value ? '대표 기본값 · ' : ''}{selected.baseUrl} · {selected.projectId}</p>}</> : <p className="typo-l1/r text-glyph-gray-description">Rabbit 프로젝트를 선택하면 대표의 AI 모델과 개발 실행 위치를 따로 관리할 수 있습니다. 같은 대표가 여러 팀에 속해도 팀별 지정이 우선합니다.</p>}
    {unavailable && <p role="alert" className="typo-l1/r text-glyph-warning-body">지정된 연결을 사용할 수 없습니다. 연결을 확인할 때까지 해당 프로젝트 개발은 차단되며 로컬 개발로 전환하지 않습니다.</p>}
    <p className="typo-l2/r text-glyph-gray-caption">새 작업부터 적용됩니다. 진행 중인 작업과 접수 기록의 프로젝트는 바뀌지 않습니다. API 키는 설정의 기존 연결에서만 관리합니다.</p>
    {onManage && <Button kind="common" hierarchy="ghost" size="small" disabled={disabled} onPress={onManage}>Rabbit 연결 관리</Button>}
  </section>;
}
