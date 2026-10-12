import type * as ReactTypes from 'react';
import type {ChatTurn} from '../../source/shared/chat-turns';
import {AttachmentList} from './chat-attachments';
const React: typeof ReactTypes = window.React;
const {Button} = window.VDS;
const labels = {queued: '답변 대기', running: '답변 중', paused: '보류', completed: '완료', failed: '실패', cancelled: '취소됨'};
export function ChatTurnList({turns, storageError, busy, onCancel, onRetry, onResume}: {
  turns: ChatTurn[]; storageError?: string; busy: boolean; onCancel(id: string): void; onRetry(id: string): void; onResume(): void;
}) {
  const pending = turns.filter(turn => turn.status !== 'completed' && turn.status !== 'running');
  if (!pending.length && !storageError) return null;
  return <section className="chat-turns" aria-label="보낸 메시지 대기열">
    <div className="chat-turn-heading"><span className="typo-l1/m">보낸 메시지 · 순서대로 답변</span>{pending.some(turn => turn.status === 'paused') && <Button kind="common" hierarchy="secondary" size="xsmall" disabled={busy} onPress={onResume}>다음 메시지 계속</Button>}</div>
    {storageError && <p role="alert">대기열 저장에 실패해 다음 실행을 보류했습니다. {storageError}</p>}
    <ol>{pending.map(turn => <li key={turn.id}>
      <div className="chat-turn-heading"><span className="typo-l2/r">{labels[turn.status]}</span><div>{(turn.status === 'failed' || turn.status === 'cancelled') && <Button kind="common" hierarchy="ghost" size="xsmall" disabled={busy} onPress={() => onRetry(turn.id)}>다시 시도</Button>}{turn.status !== 'cancelled' && <Button kind="common" hierarchy="ghost" size="xsmall" disabled={busy} onPress={() => onCancel(turn.id)}>취소</Button>}</div></div>
      <p className="chat-turn-text">{turn.text}</p><AttachmentList files={turn.attachments}/>{turn.error && <p className="typo-l2/r text-glyph-gray-caption">{turn.error}</p>}
    </li>)}</ol>
  </section>;
}

export type SendReceipts = Record<string, {id: string; content: string}>;
export function validSendReceipts(value: unknown): SendReceipts | undefined {
  if (!value || typeof value !== 'object' || Array.isArray(value) || Object.keys(value).length > 1000) return;
  if (Object.entries(value).every(([key, item]) => key.length <= 100 && item && typeof item === 'object' && typeof item.id === 'string' && /^[0-9a-f-]{36}$/i.test(item.id) && typeof item.content === 'string' && item.content.length <= 110000)) return value as SendReceipts;
}
