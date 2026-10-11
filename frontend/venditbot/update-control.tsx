/** @jsxRuntime classic */
/** @jsx React.createElement */
/** @jsxFrag React.Fragment */
import type * as ReactTypes from 'react';
import type { UpdateProgress, UpdateStatus } from './ui-state';
const React: typeof ReactTypes = window.React;
const { Button, Badge } = window.VDS;

const stages: Record<UpdateProgress['stage'], { label: string; waiting: string }> = {
  checking: { label: '업데이트 정보 확인', waiting: '게시된 버전과 설치 조건을 확인하고 있습니다.' },
  'verifying-current': { label: '현재 앱 확인', waiting: '현재 앱의 식별 정보와 서명을 확인하고 있습니다.' },
  'verifying-archive': { label: '업데이트 파일 검증', waiting: '업데이트 파일의 해시를 읽고 검증하고 있습니다. 파일 크기에 따라 시간이 걸릴 수 있습니다.' },
  'copying-archive': { label: '업데이트 파일 복사·검증', waiting: '업데이트 파일을 준비 폴더에 복사하고 복사본을 검증하고 있습니다. 저장 장치의 속도에 따라 시간이 걸릴 수 있습니다.' },
  extracting: { label: '업데이트 파일 압축 해제', waiting: '새 앱의 파일을 압축 해제하고 있습니다. 파일 수에 따라 시간이 걸릴 수 있습니다.' },
  'verifying-package': { label: '새 앱 검증', waiting: '새 앱의 구조와 서명을 확인하고 있습니다. macOS 검증에 시간이 걸릴 수 있습니다.' },
  'backing-up': { label: '데이터 백업·검증', waiting: '대화·설정·이미지 데이터를 백업하고 원본과 백업본을 검증하고 있습니다. 대화·이미지 기록이 많으면 시간이 걸릴 수 있습니다.' },
  'preparing-restart': { label: '안전한 재시작 준비', waiting: '저장 상태와 실행 중인 프로세스의 종료를 확인하고 있습니다.' },
  'awaiting-quit': { label: '앱 종료와 교체 대기', waiting: '앱의 정상 종료를 기다리고 있습니다. 다른 벤디트봇 창이나 macOS 확인 창이 열려 있는지 확인해 주세요.' },
};
const finite = (value: unknown): value is number => typeof value === 'number' && Number.isFinite(value);
const duration = (milliseconds: number) => { const seconds = Math.floor(Math.max(0, milliseconds) / 1000); return seconds < 60 ? `${seconds}초` : `${Math.floor(seconds / 60)}분 ${seconds % 60}초`; };
const bytes = (value: number) => value < 1024 ? `${Math.floor(value)} B` : value < 1024 ** 2 ? `${(value / 1024).toFixed(1)} KiB` : value < 1024 ** 3 ? `${(value / 1024 ** 2).toFixed(1)} MiB` : `${(value / 1024 ** 3).toFixed(1)} GiB`;

export function updateProgressView(progress: UpdateProgress | undefined, now: number, observedAt: number) {
  const stage = progress && stages[progress.stage];
  const parsedStart = progress ? Date.parse(progress.startedAt) : NaN;
  const start = Number.isFinite(parsedStart) && parsedStart <= now ? parsedStart : observedAt;
  const parsedUpdate = progress ? Date.parse(progress.updatedAt) : NaN;
  const lastUpdate = Number.isFinite(parsedUpdate) && parsedUpdate >= start && parsedUpdate <= now ? parsedUpdate : start;
  const measuredBytes = progress && finite(progress.completedBytes) && progress.completedBytes >= 0 && finite(progress.totalBytes) && progress.totalBytes > 0 && progress.completedBytes <= progress.totalBytes ? { done: progress.completedBytes, total: progress.totalBytes } : undefined;
  const percent = progress && finite(progress.percent) && progress.percent >= 0 && progress.percent <= 100 ? progress.percent : measuredBytes ? 100 * measuredBytes.done / measuredBytes.total : undefined;
  return {
    label: stage?.label ?? '업데이트 설치 중',
    percent,
    percentLabel: percent === undefined ? undefined : `${Number(percent.toFixed(1))}%`,
    bytesLabel: measuredBytes ? `${bytes(measuredBytes.done)} / ${bytes(measuredBytes.total)}` : undefined,
    elapsed: duration(now - start),
    stale: now - lastUpdate >= 30_000,
    unchanged: duration(now - lastUpdate),
    waiting: stage?.waiting ?? '이 버전은 세부 진행 정보를 제공하지 않습니다. macOS 확인 창이나 다른 벤디트봇 창이 열려 있는지 확인해 주세요.',
  };
}

function InstallingProgress({ progress, preparing }: { progress?: UpdateProgress; preparing?: boolean }) {
  const [observedAt] = React.useState(Date.now);
  const [now, setNow] = React.useState(Date.now);
  React.useEffect(() => { const timer = window.setInterval(() => setNow(Date.now()), 1000); return () => window.clearInterval(timer); }, []);
  const view = updateProgressView(progress, Math.max(now, Date.now()), observedAt);
  const label = preparing ? '설치 준비 중' : view.label;
  const waiting = preparing ? '대화·설정의 저장 상태와 실행 중인 작업의 종료를 확인하고 있습니다. macOS 확인 창이 열려 있는지 확인해 주세요.' : view.waiting;
  return <div className="update-progress" aria-label="업데이트 진행">
    <p className="typo-b2/sb text-glyph-gray-heading" role="status" aria-live="polite" aria-atomic="true">{label}</p>
    <progress className="update-progress-bar" max={100} value={view.percent} aria-label={`${label} 단계 진행률`} aria-valuetext={view.percentLabel ? `현재 단계 ${view.percentLabel}` : '진행 중'} />
    <div className="update-progress-details typo-l2/r text-glyph-gray-description"><span>{view.percentLabel ? `현재 단계 ${view.percentLabel}` : '진행 중'}{view.bytesLabel ? ` · 처리량 ${view.bytesLabel}` : ''}</span><span>{progress ? '이 단계' : preparing ? '준비 시작 후' : '화면 표시 후'} {view.elapsed} 경과</span></div>
    <p className="typo-l2/r text-glyph-gray-caption">파일 준비를 마치면 앱이 다시 시작됩니다. 대화와 설정은 유지됩니다.</p>
    {view.stale && <p className="update-progress-wait typo-l2/r text-glyph-gray-description" role="status">30초 이상 새 진행 정보가 없습니다. {waiting} 완료되거나 오류가 표시될 때까지 기다려 주세요.</p>}
  </div>;
}

export function UpdateControl({ update, working, unsaved, busy, installRequested, blockedReason, onCheck, onInstall }: { update?: UpdateStatus; working?: boolean; unsaved?: boolean; busy?: boolean; installRequested?: boolean; blockedReason?: string; onCheck(): void; onInstall(): void }) {
  if (!update) return null;
  if (update.phase === 'development') return <div className="sidebar-update" aria-label="개발·검증용 앱"><Badge kind="warning">개발·검증용</Badge><span className="typo-l2/r text-glyph-gray-caption">정식 앱과 별도 프로필 · {update.currentVersion}</span></div>;
  const preparing = !!installRequested && update.phase !== 'installing' && update.phase !== 'error';
  const installing = update.phase === 'installing' || preparing, available = update.phase === 'available' && !!update.version;
  return <div className="sidebar-update" aria-label="앱 업데이트"><span className="typo-l2/r text-glyph-gray-caption">현재 {update.currentVersion}</span>
    {installing ? <><Button kind="common" hierarchy="secondary" size="medium" disabled loading>{preparing ? '설치 준비 중' : '업데이트 설치 중'}</Button><InstallingProgress progress={preparing ? undefined : update.progress} preparing={preparing} /></> : available ? <><Button kind="vendit" hierarchy="secondary" size="medium" disabled={busy || working || unsaved || !!blockedReason} onPress={onInstall}>{update.version} 업데이트</Button><p className="typo-l2/r text-glyph-gray-caption" role={working || unsaved || blockedReason ? 'status' : undefined}>{blockedReason ? blockedReason : working ? '작업 완료 후 업데이트' : unsaved ? '저장되지 않은 기록을 먼저 보관하세요.' : '저장된 대화와 설정을 유지하고 다시 시작합니다.'}</p></> : <Button kind="common" hierarchy="ghost" size="small" disabled={busy} loading={busy} onPress={onCheck}>{update.phase === 'error' ? '업데이트 다시 확인' : '업데이트 확인'}</Button>}
    {update.error && <p className="typo-l2/r text-glyph-danger-body" role="alert">{update.error}</p>}
  </div>;
}
