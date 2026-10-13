import {validChatAttachments, type ChatAttachment} from './chat-attachments.js';

export type SteerDelivery = {mode: 'steer'; phase: 'intent' | 'accepted' | 'unknown'; attemptId: string; threadId: string; turnId: string; answerId: string};
export function validSteerDelivery(value: unknown): value is SteerDelivery {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  const v = value as SteerDelivery;
  return v.mode === 'steer' && ['intent','accepted','unknown'].includes(v.phase) && ['attemptId','threadId','turnId','answerId'].every(key => typeof v[key as keyof SteerDelivery] === 'string' && !!v[key as keyof SteerDelivery] && v[key as keyof SteerDelivery].length <= (key === 'threadId' || key === 'turnId' ? 256 : 200) && !v[key as keyof SteerDelivery].includes('\0'));
}
export type ChatTurn = {delivery?: SteerDelivery | undefined;id: string; sessionId: string; text: string; attachments: ChatAttachment[]; createdAt: string; status: 'queued' | 'running' | 'paused' | 'completed' | 'failed' | 'cancelled'; error?: string | undefined; continueAfter?: boolean};
export function validChatTurn(value: unknown): value is ChatTurn {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  const turn = value as ChatTurn;
  return /^[0-9a-f-]{36}$/i.test(turn.id) && typeof turn.sessionId === 'string' && !!turn.sessionId && turn.sessionId.length <= 100
    && typeof turn.text === 'string' && !!turn.text.trim() && turn.text.length <= 100000 && !turn.text.includes('\0')
    && (turn.delivery === undefined || validSteerDelivery(turn.delivery)) && validChatAttachments(turn.attachments) && Number.isFinite(Date.parse(turn.createdAt))
    && ['queued', 'running', 'paused', 'completed', 'failed', 'cancelled'].includes(turn.status)
    && (turn.continueAfter === undefined || typeof turn.continueAfter === 'boolean')
    && (turn.error === undefined || typeof turn.error === 'string' && turn.error.length <= 2000);
}
