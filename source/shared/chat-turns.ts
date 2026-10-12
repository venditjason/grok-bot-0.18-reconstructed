import {validChatAttachments, type ChatAttachment} from './chat-attachments.js';

export type ChatTurn = {id: string; sessionId: string; text: string; attachments: ChatAttachment[]; createdAt: string; status: 'queued' | 'running' | 'paused' | 'completed' | 'failed' | 'cancelled'; error?: string | undefined; continueAfter?: boolean};
export function validChatTurn(value: unknown): value is ChatTurn {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  const turn = value as ChatTurn;
  return /^[0-9a-f-]{36}$/i.test(turn.id) && typeof turn.sessionId === 'string' && !!turn.sessionId && turn.sessionId.length <= 100
    && typeof turn.text === 'string' && !!turn.text.trim() && turn.text.length <= 100000 && !turn.text.includes('\0')
    && validChatAttachments(turn.attachments) && Number.isFinite(Date.parse(turn.createdAt))
    && ['queued', 'running', 'paused', 'completed', 'failed', 'cancelled'].includes(turn.status)
    && (turn.continueAfter === undefined || typeof turn.continueAfter === 'boolean')
    && (turn.error === undefined || typeof turn.error === 'string' && turn.error.length <= 2000);
}
