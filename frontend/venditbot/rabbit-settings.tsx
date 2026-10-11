/** @jsxRuntime classic */
/** @jsx React.createElement */
/** @jsxFrag React.Fragment */
import type * as ReactTypes from 'react';
import { importRabbitEndpoint, normalizeRabbitConnectionDraft, normalizeRabbitRunInput, validateRabbitProjectApiKey, type RabbitConnectionTest } from '../../source/shared/rabbit-project-api';
import { blankRabbitEdit, rabbitEditFor, rabbitPreset, rabbitRunLabel, type RabbitEditDraft, type RabbitProfile, type RabbitRunRecord, type RabbitWorkDraft } from './rabbit-ui-state';
import { clearMatchingDraft } from './draft-storage';
const React: typeof ReactTypes = window.React;
const { Button, TextInput, TextArea, Checkbox, Badge } = window.VDS;
const panel = 'rabbit-panel bg-background-base-elevate border border-solid border-line-outline-stroke rounded-xl';
const selectClass = 'select-control bg-background-base-normal text-glyph-gray-body border border-solid border-line-outline-stroke';
type Records<T> = Record<string, T>;
type SetRecords<T> = ReactTypes.Dispatch<ReactTypes.SetStateAction<Records<T>>>;
export type RabbitSettingsProps = {
  connections: RabbitProfile[]; runs: RabbitRunRecord[]; edits: Records<RabbitEditDraft>; onEdits: SetRecords<RabbitEditDraft>; work: Records<RabbitWorkDraft>; onWork: SetRecords<RabbitWorkDraft>;
  editKey: string; onEditKey(key: string): void; active: boolean;
  invoke(method: string, args?: unknown): Promise<any>;
  onConnections(connections: RabbitProfile[]): void; onRun(run: RabbitRunRecord): void;
  onFlushWork(): boolean;
  onGuard(value: { keyDirty: boolean; pending: boolean }): void;
};
/** Mounted while hidden so a navigation never discards an unsaved password or in-flight request. */
export function RabbitSettings(props: RabbitSettingsProps) {
  const { connections, runs, edits, onEdits, work, onWork, editKey, onEditKey, invoke, onConnections, onRun } = props;
  const [keys, setKeys] = React.useState<Records<string>>({});
  const [errors, setErrors] = React.useState<Records<string>>({});
  const [busy, setBusy] = React.useState<Records<boolean>>({});
  const [tests, setTests] = React.useState<Records<{ baseUrl: string; projectId: string; updatedAt: string; result: RabbitConnectionTest }>>({});
  const [deleteId, setDeleteId] = React.useState('');
  const [exported, setExported] = React.useState<Records<boolean>>({});
  const [historyLimit, setHistoryLimit] = React.useState(50);
  const locks = React.useRef(new Set<string>());
  const current = React.useRef(props); current.current = props;
  const keyRef = React.useRef(keys); keyRef.current = keys;
  const selected = connections.find(item => item.id === editKey);
  const record = edits[editKey] ?? (selected ? rabbitEditFor(selected) : blankRabbitEdit());
  const changeKeys = (transform: (keys: Records<string>) => Records<string>) => { const next = transform(keyRef.current); keyRef.current = next; setKeys(next); current.current.onGuard({ keyDirty: Object.values(next).some(Boolean), pending: locks.current.size > 0 }); };
  const guard = () => current.current.onGuard({ keyDirty: Object.values(keyRef.current).some(Boolean), pending: locks.current.size > 0 });
  const tested = (target: { id?: string; baseUrl: string; projectId: string }) => { const cached = target.id ? tests[target.id] : undefined; const live = current.current.connections.find(item => item.id === target.id); return cached?.baseUrl === target.baseUrl && cached.projectId === target.projectId && cached.updatedAt === live?.updatedAt ? cached.result : undefined; };
  const error = (key: string, text = '') => setErrors(previous => ({ ...previous, [key]: text }));
  const perform = async (key: string, action: () => Promise<void>) => {
    if (locks.current.has(key)) return;
    locks.current.add(key); guard(); setBusy(previous => ({ ...previous, [key]: true })); error(key);
    try { await action(); } catch (failure) { error(key, failure instanceof Error ? failure.message : '요청을 처리하지 못했습니다.'); }
    finally { locks.current.delete(key); guard(); setBusy(previous => ({ ...previous, [key]: false })); }
  };
  const change = (next: RabbitEditDraft) => { error(`save:${editKey}`); onEdits(previous => ({ ...previous, [editKey]: next })); };
  const endpoint = (text: string) => {
    let draft = record.draft;
    try { const parsed = importRabbitEndpoint(text, { allowInsecureLoopback: !!draft.allowInsecureLoopback }); draft = { ...draft, baseUrl: parsed.baseUrl, projectId: parsed.projectId ?? draft.projectId, ...(parsed.baseUrl !== draft.baseUrl || (parsed.projectId && parsed.projectId !== draft.projectId) ? { repositoryId: undefined } : {}) }; } catch {}
    change({ ...record, endpoint: text, draft });
  };
  const choose = (id: string) => { setDeleteId(''); onEditKey(id); };
  const save = () => void perform(`save:${editKey}`, async () => {
    const submitted = record, target = editKey, typedKey = keyRef.current[target] ?? '';
    const parsed = importRabbitEndpoint(submitted.endpoint, { allowInsecureLoopback: !!submitted.draft.allowInsecureLoopback });
    const normalized = normalizeRabbitConnectionDraft({ ...submitted.draft, baseUrl: parsed.baseUrl, projectId: parsed.projectId ?? submitted.draft.projectId });
    if (typedKey) validateRabbitProjectApiKey(typedKey);
    if (!selected?.hasKey && !typedKey) throw new Error('Rabbit 프로젝트 API 키를 입력하세요.');
    const result = await invoke('saveRabbitConnection', { connection: { ...normalized, ...(submitted.draft.id ? { id: submitted.draft.id } : {}) }, ...(typedKey ? { apiKey: typedKey } : {}), ...(submitted.expectedUpdatedAt ? { expectedUpdatedAt: submitted.expectedUpdatedAt } : {}) });
    const next: RabbitProfile[] = result.rabbitConnections ?? [];
    onConnections(next);
    changeKeys(previous => previous[target] === typedKey ? { ...previous, [target]: '' } : previous);
    onEdits(previous => clearMatchingDraft(previous, target, submitted));
    const saved = next.find(item => submitted.draft.id ? item.id === submitted.draft.id : !connections.some(old => old.id === item.id));
    if (saved) {
      onEdits(previous => {
        const newer = previous[target]; if (!newer) return previous;
        const copy = { ...previous }; delete copy[target]; copy[saved.id] = { ...newer, draft: { ...newer.draft, id: saved.id }, expectedUpdatedAt: saved.updatedAt }; return copy;
      });
      if (target !== saved.id) changeKeys(previous => { const copy = { ...previous }; if (copy[target]) copy[saved.id] = copy[target]; delete copy[target]; return copy; });
      if (current.current.editKey === target) onEditKey(saved.id);
    }
  });
  const test = (profile: RabbitProfile) => void perform(`test:${profile.id}`, async () => { const result: RabbitConnectionTest = await invoke('testRabbitConnection', { id: profile.id }); const latest = current.current.connections.find(item => item.id === profile.id); if (latest?.baseUrl === profile.baseUrl && latest.projectId === profile.projectId && latest.updatedAt === profile.updatedAt && result.projectId === profile.projectId) setTests(previous => ({ ...previous, [profile.id]: { baseUrl: profile.baseUrl, projectId: profile.projectId, updatedAt: profile.updatedAt, result } })); });
  const remove = (profile: RabbitProfile) => void perform(`delete:${profile.id}`, async () => {
    const result = await invoke('deleteRabbitConnection', { id: profile.id, expectedUpdatedAt: profile.updatedAt }); onConnections(result.rabbitConnections ?? []); setDeleteId('');
    changeKeys(previous => { const next = { ...previous }; delete next[profile.id]; return next; });
    if (current.current.editKey === profile.id) onEditKey('new');
  });
  const submit = (profile: RabbitProfile) => void perform(`start:${profile.id}`, async () => {
    const submitted = work[profile.id] ?? { objective: '', criteria: '' };
    const request = submitted.pending ?? { requestId: crypto.randomUUID(), input: normalizeRabbitRunInput({ objective: submitted.objective, acceptance_criteria: submitted.criteria.split('\n').map(value => value.trim()).filter(Boolean) }, profile) };
    onWork(previous => ({ ...previous, [profile.id]: { ...(previous[profile.id] ?? submitted), pending: request } }));
    if (!current.current.onFlushWork()) throw new Error('접수 요청 초안을 저장하지 못했습니다. 저장을 복구한 뒤 다시 시도하세요.');
    const result: RabbitRunRecord = await invoke('startRabbitRun', { connectionId: profile.id, input: request.input, requestId: request.requestId }); onRun(result);
    onWork(previous => {
      const latest = previous[profile.id]; if (latest?.pending?.requestId !== request.requestId) return previous;
      const next = { ...previous };
      if (latest.objective.trim() === request.input.objective && JSON.stringify(latest.criteria.split('\n').map(value => value.trim()).filter(Boolean)) === JSON.stringify(request.input.acceptance_criteria) && result.phase !== 'rejected') delete next[profile.id];
      else { const { pending: ignored, ...retained } = latest; next[profile.id] = retained; }
      return next;
    });
  });
  const exportRun = (run: RabbitRunRecord) => void perform(`export:${run.id}`, async () => { const result = await invoke('exportRabbitRun', { id: run.id }); if (result.saved) setExported(previous => ({ ...previous, [run.id]: true })); });
  const runAction = (run: RabbitRunRecord, retry: boolean) => void perform(`run:${run.id}`, async () => onRun(await invoke(retry ? 'retryRabbitRun' : 'refreshRabbitRun', { id: run.id })));
  const conflict = record.draft.id && (!selected || selected.updatedAt !== record.expectedUpdatedAt);
  return <section className="rabbit-settings" aria-label="프로젝트 레인 API(Rabbit)">
    <div className="section-heading"><div><h2 className="typo-h2/b text-glyph-gray-heading">프로젝트 레인 API(Rabbit)</h2><p className="typo-b3/r text-glyph-gray-description">Rabbit 프로젝트에 개발 작업을 접수하고 진행 상황을 조회합니다. 대화용 AI 모델 연결과 별도로 관리합니다.</p></div><Button kind="common" hierarchy="secondary" size="small" onPress={() => choose('new')}>Rabbit 연결 추가</Button></div>
    <p className="typo-l1/r text-glyph-gray-caption">프로젝트 키로 접수·상태·이벤트·저장소를 조회합니다. 모델·추론 강도·레인 선택과 원격 취소는 Rabbit 소유자 화면에서 관리하세요.</p>
    {connections.map(profile => <section className={panel} key={profile.id}><div className="card-heading"><div><h3 className="typo-h3/b text-glyph-gray-heading">{profile.name}</h3><p className="typo-l2/r text-glyph-gray-caption">{profile.baseUrl} · {profile.projectId}</p></div><Badge kind={profile.hasKey ? 'common' : 'warning'}>{(tested(profile) || profile.verified) ? '조회 확인됨' : profile.hasKey ? '키 저장됨' : '키 필요'}</Badge></div><div className="rabbit-actions"><Button kind="vendit" hierarchy="secondary" size="small" disabled={!profile.hasKey || !!busy[`test:${profile.id}`]} loading={!!busy[`test:${profile.id}`]} onPress={() => test(profile)}>Rabbit 연결 검사 · GET</Button><Button kind="common" hierarchy="ghost" size="small" onPress={() => choose(profile.id)}>Rabbit 연결 수정</Button><Button kind="common" hierarchy="ghost" size="small" onPress={() => void perform(`open:${profile.id}`, () => invoke('openRabbitProject', { connectionId: profile.id }))}>Rabbit 화면 열기</Button><Button kind="common" hierarchy="ghost" size="small" onPress={() => setDeleteId(profile.id)}>Rabbit 연결 삭제</Button></div>
      {tested(profile) && <p className="typo-l1/r text-glyph-gray-description" role="status">GET 검사 완료 · 저장소 {tested(profile)!.repositories.length}개. 작업을 생성하지 않았습니다. 저장소 조회 성공이 실행 준비를 보장하지는 않습니다.</p>}
      {['test', 'delete', 'open'].map(action => errors[`${action}:${profile.id}`] && <p key={action} role="alert" className="typo-l1/r text-glyph-danger-body">{errors[`${action}:${profile.id}`]}</p>)}
      {deleteId === profile.id && <div className="delete-confirm"><span className="typo-l1/r text-glyph-danger-body">연결과 저장한 키를 삭제합니다. 기존 원격 작업은 취소되지 않습니다.</span><Button kind="destructive" size="small" disabled={!!busy[`delete:${profile.id}`]} onPress={() => remove(profile)}>Rabbit 연결 삭제 확인</Button><Button kind="common" hierarchy="ghost" size="small" onPress={() => setDeleteId('')}>취소</Button></div>}
      <details className="rabbit-work-form"><summary className="typo-b3/sb text-glyph-gray-heading">이 프로젝트에 작업 요청</summary><TextArea aria-label={`${profile.name} 작업 목표`} value={work[profile.id]?.objective ?? ''} maxLength={20000} rows={3} placeholder="해결할 작업 목표" onChange={(event: ReactTypes.ChangeEvent<HTMLTextAreaElement>) => onWork(previous => ({ ...previous, [profile.id]: { ...(previous[profile.id] ?? { criteria: '' }), objective: event.target.value } }))} /><TextArea aria-label={`${profile.name} 완료 기준`} value={work[profile.id]?.criteria ?? ''} maxLength={61000} rows={3} placeholder="완료 기준을 한 줄에 하나씩 입력하세요" onChange={(event: ReactTypes.ChangeEvent<HTMLTextAreaElement>) => onWork(previous => ({ ...previous, [profile.id]: { ...(previous[profile.id] ?? { objective: '' }), criteria: event.target.value } }))} /><p className="typo-l1/r text-glyph-gray-caption">{profile.workflowTemplate} · {profile.baseRef} · 병렬 {profile.maxParallelTasks} · 제한 {profile.timeoutSeconds}초. 전송 전 작업 규칙에 따른 승인을 요청합니다.</p>{work[profile.id]?.pending && <p role="status" className="typo-l1/r text-glyph-warning-body">이전 접수 응답을 확인하지 못했습니다. 다시 확인하면 저장된 원래 목표·완료 기준과 같은 요청 ID를 사용합니다. 새로 입력한 내용은 초안에 남습니다.</p>}{errors[`start:${profile.id}`] && <p role="alert" className="typo-l1/r text-glyph-danger-body">{errors[`start:${profile.id}`]}</p>}<Button kind="vendit" size="medium" disabled={!profile.hasKey || !!busy[`start:${profile.id}`] || (!work[profile.id]?.pending && (!work[profile.id]?.objective.trim() || !work[profile.id]?.criteria.trim()))} loading={!!busy[`start:${profile.id}`]} onPress={() => submit(profile)}>{work[profile.id]?.pending ? '이전 접수 확인 다시 시도' : 'Rabbit 작업 접수'}</Button></details>
    </section>)}
    <section className={panel} aria-label="Rabbit 연결 설정"><div className="card-heading"><h3 className="typo-h3/b text-glyph-gray-heading">{record.draft.id ? 'Rabbit 연결 편집' : '새 Rabbit 연결'}</h3><Button kind="common" hierarchy="ghost" size="small" onPress={() => endpoint(rabbitPreset)}>예시 프로젝트 주소</Button></div>{conflict && <div role="alert" className="typo-l1/r text-glyph-warning-body">연결이 변경되거나 삭제되었습니다. 초안은 유지됩니다.{selected && <Button kind="common" hierarchy="ghost" size="small" onPress={() => onEdits(previous => { const next = { ...previous }; delete next[editKey]; return next; })}>최신 Rabbit 연결 다시 불러오기</Button>}</div>}
      <TextInput label="Rabbit 연결 이름" value={record.draft.name} maxLength={80} onChange={(event: ReactTypes.ChangeEvent<HTMLInputElement>) => change({ ...record, draft: { ...record.draft, name: event.target.value } })} />
      <TextInput label="Rabbit 프로젝트 POST 주소" value={record.endpoint} maxLength={4096} placeholder={rabbitPreset} onChange={(event: ReactTypes.ChangeEvent<HTMLInputElement>) => endpoint(event.target.value)} desc="전체 /v1/projects/프로젝트ID/runs 주소를 붙여 넣으면 서버 주소와 프로젝트 ID를 추출합니다." />
      <div className="form-grid"><TextInput label="Rabbit 서버 주소" value={record.draft.baseUrl} readOnly /><TextInput label="Rabbit 프로젝트 ID" value={record.draft.projectId} onChange={(event: ReactTypes.ChangeEvent<HTMLInputElement>) => change({ ...record, draft: { ...record.draft, projectId: event.target.value, repositoryId: undefined }, endpoint: record.draft.baseUrl })} />
      <TextInput label="Rabbit 프로젝트 API 키" type="password" autoComplete="off" spellCheck={false} value={keys[editKey] ?? ''} maxLength={8192} placeholder={selected?.hasKey ? '변경할 때만 새 키 입력' : 'rabbit_로 시작하는 전체 키'} onChange={(event: ReactTypes.ChangeEvent<HTMLInputElement>) => changeKeys(previous => ({ ...previous, [editKey]: event.target.value }))} desc="키는 초안에 저장하지 않습니다. 마스킹된 값 대신 전체 키를 입력하세요." />
      <label className="form-field typo-l1/m text-glyph-gray-description">저장소<select aria-label="Rabbit 저장소" className={selectClass} value={record.draft.repositoryId ?? ''} onChange={event => change({ ...record, draft: { ...record.draft, repositoryId: event.target.value || undefined } })}><option value="">프로젝트 기본 저장소</option>{tested(record.draft)?.repositories.map(repository => <option key={repository.id} value={repository.id}>{repository.url} · {repository.status}</option>)}{record.draft.repositoryId && !tested(record.draft)?.repositories.some(item => item.id === record.draft.repositoryId) && <option value={record.draft.repositoryId}>{record.draft.repositoryId} · 저장된 선택</option>}</select><span>연결을 저장한 뒤 GET 검사로 목록을 불러오세요.</span></label>
      <TextInput label="Rabbit 기준 브랜치" value={record.draft.baseRef} maxLength={240} onChange={(event: ReactTypes.ChangeEvent<HTMLInputElement>) => change({ ...record, draft: { ...record.draft, baseRef: event.target.value } })} />
      <label className="form-field typo-l1/m text-glyph-gray-description">작업 템플릿<select aria-label="Rabbit 작업 템플릿" className={selectClass} value={record.draft.workflowTemplate} onChange={event => change({ ...record, draft: { ...record.draft, workflowTemplate: event.target.value as typeof record.draft.workflowTemplate } })}><option value="feature_pr">feature_pr · 기능 PR</option><option value="bugfix_pr">bugfix_pr · 수정 PR</option><option value="review_only">review_only · 검토</option></select></label>
      <label className="form-field typo-l1/m text-glyph-gray-description">최대 병렬 작업<select aria-label="Rabbit 최대 병렬 작업" className={selectClass} value={record.draft.maxParallelTasks} onChange={event => change({ ...record, draft: { ...record.draft, maxParallelTasks: Number(event.target.value) as 1 | 2 | 3 | 4 } })}>{[1, 2, 3, 4].map(value => <option key={value} value={value}>{value}</option>)}</select></label>
      <TextInput label="Rabbit 제한 시간(초)" type="number" min={60} max={14400} value={String(record.draft.timeoutSeconds)} onChange={(event: ReactTypes.ChangeEvent<HTMLInputElement>) => change({ ...record, draft: { ...record.draft, timeoutSeconds: Math.max(0, Math.min(14400, Math.trunc(Number(event.target.value) || 0))) } })} />
      <TextInput label="Rabbit API 비용 한도(USD)" value="0" readOnly desc="현재 프로젝트 API 계약의 고정값입니다. 전체 서비스 이용이 무료라는 의미는 아닙니다." /></div>
      <label className="check-label typo-b3/r text-glyph-gray-body"><Checkbox kind="square" aria-label="에이전트의 Rabbit 프로젝트 사용 허용" checked={record.draft.enabledForAgents} onCheckedChange={(checked: boolean) => change({ ...record, draft: { ...record.draft, enabledForAgents: checked, ...(!checked ? { preferForProjectTasks: false } : {}) } })} />에이전트가 이 프로젝트에 작업 요청 가능 · 작업 규칙 적용</label>
      <label className="check-label typo-b3/r text-glyph-gray-body"><Checkbox kind="square" aria-label="등록 프로젝트 작업은 Rabbit API 최우선" checked={record.draft.preferForProjectTasks === true} disabled={!record.draft.enabledForAgents} onCheckedChange={(checked: boolean) => change({ ...record, draft: { ...record.draft, preferForProjectTasks: checked } })} />자동 설정 · 등록 프로젝트 작업은 Rabbit API 최우선</label><p className="typo-l1/r text-glyph-gray-caption">연결 이름·프로젝트 ID·프로젝트 주소를 명시한 작업에 적용합니다. GET 검사 만료·재시작 후에도 우선 설정은 유지되며 다시 검사해야 합니다. 일반 대화는 기존 AI를 사용합니다. 원격 접수 결과가 불명확하면 로컬에서 중복 실행하지 않습니다.</p>
      {errors[`save:${editKey}`] && <p role="alert" className="typo-l1/r text-glyph-danger-body">{errors[`save:${editKey}`]}</p>}<div className="rabbit-actions"><Button kind="common" hierarchy="ghost" size="medium" onPress={() => { changeKeys(previous => ({ ...previous, [editKey]: '' })); onEdits(previous => { const next = { ...previous }; delete next[editKey]; return next; }); error(`save:${editKey}`); }}>Rabbit 입력 초기화</Button><Button kind="vendit" size="medium" disabled={!!busy[`save:${editKey}`] || !!conflict} loading={!!busy[`save:${editKey}`]} onPress={save}>Rabbit 연결 저장</Button></div>
    </section>
    <section className="rabbit-history"><h3 className="typo-h3/b text-glyph-gray-heading">Rabbit 작업 기록</h3><p className="typo-l1/r text-glyph-gray-description">202는 요청 접수입니다. 실제 완료 여부는 상태 조회로 확인합니다. 이 화면을 닫아도 원격 작업은 계속되며, 취소는 Rabbit 소유자 화면에서 진행하세요.</p>{runs.length ? runs.slice(0, historyLimit).map(run => <section key={run.id} className={panel}><div className="card-heading"><h4 className="typo-b3/sb text-glyph-gray-heading">{run.connectionSnapshot.name} · {run.request.objective}</h4><Badge kind={run.phase === 'unknown' || run.phase === 'rejected' ? 'warning' : 'common'}>{rabbitRunLabel(run)}</Badge></div><p className="typo-l2/r text-glyph-gray-caption">{new Date(run.createdAt).toLocaleString()} · 전송 {run.attempts}회{run.receipt ? ` · Run ${run.receipt.run_id}` : ''}</p>{run.error && <p className="typo-l1/r text-glyph-danger-body">{run.error}</p>}{errors[`run:${run.id}`] && <p role="alert" className="typo-l1/r text-glyph-danger-body">{errors[`run:${run.id}`]}</p>}<div className="rabbit-actions"><Button kind="common" hierarchy="ghost" size="small" disabled={!!busy[`export:${run.id}`]} onPress={() => exportRun(run)}>접수 기록 내보내기</Button>{run.receipt && <Button kind="common" hierarchy="secondary" size="small" disabled={!!busy[`run:${run.id}`]} onPress={() => runAction(run, false)}>상태·이벤트 조회</Button>}{run.phase === 'unknown' && <Button kind="vendit" hierarchy="secondary" size="small" disabled={!!busy[`run:${run.id}`]} onPress={() => runAction(run, true)}>같은 요청으로 접수 재시도</Button>}</div>{errors[`export:${run.id}`] && <p role="alert" className="typo-l1/r text-glyph-danger-body">{errors[`export:${run.id}`]}</p>}{exported[run.id] && <p role="status" className="typo-l1/r text-glyph-gray-description">접수 기록을 JSON 파일로 보관했습니다.</p>}{run.detail && <details><summary className="typo-l1/r text-glyph-gray-description">실행 상태</summary><pre className="draft-recovery-text typo-l2/r">{JSON.stringify(run.detail, null, 2)}</pre></details>}{run.events && <details><summary className="typo-l1/r text-glyph-gray-description">작업 이벤트 · 최근 100개</summary><pre className="draft-recovery-text typo-l2/r">{JSON.stringify(run.events, null, 2)}</pre>{run.events.has_more && <p className="typo-l1/r text-glyph-gray-description">이후 이벤트가 더 있습니다. 상태·이벤트 조회를 다시 누르면 다음 내용을 가져옵니다.</p>}</details>}<details><summary className="typo-l1/r text-glyph-gray-description">접수한 목표와 완료 기준</summary><pre className="draft-recovery-text typo-l2/r">{JSON.stringify(run.request, null, 2)}</pre></details></section>) : <p className="typo-b3/r text-glyph-gray-caption">접수한 작업이 없습니다.</p>}{runs.length > historyLimit && <Button kind="common" hierarchy="secondary" size="medium" onPress={() => setHistoryLimit(previous => previous + 50)}>Rabbit 이전 기록 더 보기 ({runs.length - historyLimit})</Button>}</section>
  </section>;
}
