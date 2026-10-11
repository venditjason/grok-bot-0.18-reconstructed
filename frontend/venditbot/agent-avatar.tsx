/** @jsxRuntime classic */
/** @jsx React.createElement */
/** @jsxFrag React.Fragment */
import type * as ReactTypes from 'react';
import type { AvatarJob } from './avatar-jobs';
const React: typeof ReactTypes = window.React;
const { Button, TextArea } = window.VDS;
export type AgentAvatarAsset = { id: string; dataUrl: string; kind: 'illustration' | 'image'; createdAt: string };
/** Stable local portrait while a saved image is loading, missing, or not yet assigned. */
export function defaultAvatarDataUrl(seed: string): string {
  let hash = 2166136261;
  for (const char of seed || 'venditbot') hash = Math.imul(hash ^ char.codePointAt(0)!, 16777619) >>> 0;
  const backgrounds = ['#E8E3FA', '#DCECEF', '#F7E4DB', '#E4EBD6', '#F5E2EC', '#DDE7F5'];
  const skin = ['#F1C7A6', '#DCA683', '#A96F51', '#E6B697', '#81513F'][(hash >>> 5) % 5];
  const hair = ['#293042', '#544238', '#262322', '#75513D', '#B99062'][(hash >>> 9) % 5];
  const shirt = ['#7772AD', '#3D7E89', '#B77968', '#718455', '#985D7F', '#5278A6'][(hash >>> 14) % 6];
  const glasses = hash % 3 === 0 ? '<g fill="none" stroke="#3A3442" stroke-width="2"><rect x="28" y="39" width="17" height="12" rx="5"/><rect x="51" y="39" width="17" height="12" rx="5"/><path d="M45 44h6"/></g>' : '';
  const fringe = hash % 2 ? 'M24 41C21 11 73 9 73 41L62 31C46 38 38 26 24 41Z' : 'M24 41C22 9 70 7 73 41L63 37L58 25C43 38 34 31 24 41Z';
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="96" height="96" viewBox="0 0 96 96"><rect width="96" height="96" fill="${backgrounds[hash % 6]}"/><path d="M12 96V86C12 63 84 63 84 86V96" fill="${shirt}"/><rect x="41" y="58" width="14" height="20" rx="6" fill="${skin}"/><ellipse cx="48" cy="43" rx="24" ry="28" fill="${hair}"/><ellipse cx="48" cy="45" rx="21" ry="26" fill="${skin}"/><path d="${fringe}" fill="${hair}"/><g fill="#35313B"><circle cx="38" cy="45" r="2"/><circle cx="58" cy="45" r="2"/></g>${glasses}<path d="M42 57Q48 62 54 57" fill="none" stroke="#8C514B" stroke-width="2" stroke-linecap="round"/></svg>`;
  return `data:image/svg+xml,${encodeURIComponent(svg)}`;
}
export function AgentAvatar({ name, seed, url, size = 'small' }: { name: string; seed?: string; url?: string; size?: 'small' | 'medium' | 'large' }) {
  const [failed, setFailed] = React.useState(false);
  React.useEffect(() => setFailed(false), [url]);
  const fallback = React.useMemo(() => defaultAvatarDataUrl(seed ?? name), [seed, name]);
  return <span className={`agent-avatar agent-avatar-${size} bg-background-vendit-subtle text-glyph-vendit-heading typo-b2/sb`} aria-label={`${name || '에이전트'} 프로필 사진`}><img src={url && !failed ? url : fallback} alt={`${name || '에이전트'} 프로필 사진`} onError={url && !failed ? () => setFailed(true) : undefined} /></span>;
}
export function AgentAvatarEditor({ name, url, hasAvatar, prompt, connectionLabel, available, imageAvailable = false, mode = 'illustration', busy, phase, disabled, cancelling, error, onMode, onPrompt, onGenerate, onCancel, onRemove }: { name: string; url?: string; hasAvatar: boolean; prompt: string; connectionLabel: string; available: boolean; imageAvailable?: boolean; mode?: 'illustration' | 'image'; busy?: boolean; phase?: AvatarJob['phase']; disabled?: boolean; cancelling?: boolean; error?: string; onMode?(mode: 'illustration' | 'image'): void; onPrompt(text: string): void; onGenerate(): void; onCancel(): void; onRemove(): void }) {
  const imageMode = imageAvailable && mode === 'image', label = imageMode ? '이미지' : '일러스트';
  return <section className="avatar-editor" aria-label={`AI 프로필 ${label}`}>
    <div className="avatar-preview-row"><AgentAvatar name={name} url={url} size="large" /><div><h3 className="typo-b3/sb text-glyph-gray-heading">AI 프로필 {label}</h3><p className="typo-l1/r text-glyph-gray-caption">원하는 모습을 설명하면 1순위 AI가 {label}를 만듭니다. 미리 본 뒤 에이전트 저장으로 적용하세요.</p>{hasAvatar && <Button kind="common" hierarchy="ghost" size="xsmall" disabled={disabled || busy} onPress={onRemove}>프로필 사진 해제</Button>}</div></div>
    {imageAvailable && <label className="form-field typo-l1/m text-glyph-gray-description">생성 방식<select aria-label="프로필 이미지 생성 방식" className="select-control bg-background-base-normal text-glyph-gray-body border border-solid border-line-outline-stroke typo-b3/r" value={mode} disabled={!available || disabled || busy} onChange={event => onMode?.(event.target.value as 'illustration' | 'image')}><option value="image">AI 이미지 · Codex · 추천</option><option value="illustration">일러스트 · 텍스트 모델</option></select></label>}
    <p className="typo-l1/r text-glyph-gray-description">생성 연결 · {connectionLabel || '아래에서 1순위 AI 연결과 모델을 선택하세요.'}</p>
    <p className="typo-l2/r text-glyph-gray-caption">{imageMode ? 'Codex의 이미지 생성 도구로 프로필 이미지를 만듭니다. 계정과 모델의 지원 여부는 생성 시 확인합니다.' : 'Codex·Claude·API의 텍스트 모델로 만드는 프로필 일러스트입니다.'}</p>
    {!available && <p className="typo-l1/r text-glyph-gray-description">1순위 연결에 로그인하거나 API 연결을 저장한 뒤 사용할 모델을 선택하세요.</p>}
    <label className="form-field typo-l1/m text-glyph-gray-description">{label} 프롬프트<TextArea aria-label={`프로필 ${label} 프롬프트`} value={prompt} rows={3} maxLength={4000} placeholder="예: 차분한 파란 배경, 둥근 안경을 쓴 친근한 로봇의 프로필" onChange={(event: ReactTypes.ChangeEvent<HTMLTextAreaElement>) => onPrompt(event.target.value)} /></label>
    {busy && <p className="typo-l1/r text-glyph-vendit-heading" role="status">{phase === 'queued' ? '이 에이전트의 프로필 생성이 대기 중입니다.' : phase === 'validating' ? '이 에이전트의 생성 연결을 확인하고 있습니다.' : '이 에이전트의 프로필을 생성하고 있습니다.'} 다른 에이전트의 사진도 예약할 수 있습니다.</p>}
    {error && <p className="typo-b3/r text-glyph-danger-body" role="alert">{error}</p>}
    <div className="avatar-generation-actions"><span className="typo-l2/r text-glyph-gray-caption">선택한 연결의 모델 이용 한도와 API 요금이 적용됩니다.</span>{busy ? <Button kind="destructive" hierarchy="secondary" size="medium" disabled={cancelling} loading={cancelling} onPress={onCancel}>{label} 생성 취소</Button> : <Button kind="vendit" hierarchy="secondary" size="medium" disabled={disabled || !prompt.trim() || !available} onPress={onGenerate}>{hasAvatar ? `${label} 다시 생성` : `${label} 생성`}</Button>}</div>
  </section>;
}
