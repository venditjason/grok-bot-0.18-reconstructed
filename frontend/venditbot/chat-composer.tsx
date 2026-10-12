import type * as ReactTypes from 'react';
import { shouldSendOnEnter } from './ui-state';
const React: typeof ReactTypes = window.React;
const { Button } = window.VDS;

export function ChatComposer({ value, onChange, onSend, onCancel, label = '메시지', placeholder, focusRequest = 0, disabled, sending, canSend = !!value.trim(), maxLength = 100000, hint, cancelLabel = '응답 중단', onChooseAttachments, queueWhileRunning = false, children }: {
  value: string; onChange(text: string): void; onSend(): void; onCancel?(): void;
  label?: string; placeholder?: string; focusRequest?: number; disabled?: boolean; sending?: boolean;
  canSend?: boolean; maxLength?: number; hint?: string; cancelLabel?: string;
  onChooseAttachments?(): void; queueWhileRunning?: boolean; children?: ReactTypes.ReactNode;
}) {
  const input = React.useRef<HTMLTextAreaElement>(null);
  React.useEffect(() => {
    if (!window.requestAnimationFrame) { input.current?.focus({ preventScroll: true }); return; }
    const frame = window.requestAnimationFrame(() => input.current?.focus({ preventScroll: true }));
    return () => window.cancelAnimationFrame(frame);
  }, [focusRequest]);
  React.useEffect(() => {
    const field = input.current;
    if (!field) return;
    field.style.height = '0px';
    field.style.height = `${Math.min(160, Math.max(44, field.scrollHeight))}px`;
  }, [value]);
  return <div className="compact-composer">
    {children}
    <div className="composer-input-row">
      {onChooseAttachments && <Button className="composer-attach" kind="common" hierarchy="ghost" size="medium" aria-label="이미지 또는 파일 첨부" title="이미지 또는 파일 첨부" disabled={disabled} onPress={onChooseAttachments}>+</Button>}
      <textarea ref={input} aria-label={label} className="composer-input typo-b2/r text-glyph-gray-body" placeholder={placeholder} value={value} rows={1} maxLength={maxLength} disabled={disabled} onChange={event => onChange(event.target.value)} onKeyDown={event => {
        if (shouldSendOnEnter({ key: event.key, shiftKey: event.shiftKey, isComposing: event.nativeEvent.isComposing, keyCode: event.nativeEvent.keyCode })) {
          event.preventDefault();
          if (!disabled && !sending && canSend && (!onCancel || queueWhileRunning)) onSend();
        }
      }} />
      {onCancel && <Button className="composer-submit" kind="destructive" hierarchy="secondary" size="medium" onPress={onCancel}>{cancelLabel}</Button>}{(!onCancel || queueWhileRunning) && <Button className="composer-submit" kind="vendit" size="medium" disabled={disabled || sending || !canSend} loading={sending} onPress={onSend}>{onCancel && queueWhileRunning ? '대기열에 추가' : '입력'}</Button>}
    </div>
    {hint && <p className="composer-hint typo-l2/r text-glyph-gray-caption">{hint}</p>}
  </div>;
}
