import type * as ReactTypes from 'react';
import { CHAT_ATTACHMENT_LIMITS, validChatAttachments, type ChatAttachment } from '../../source/shared/chat-attachments';
import { useLocalDraft } from './draft-storage';
const React: typeof ReactTypes = window.React;
const { Button } = window.VDS;
export function attachmentDrafts(value: unknown): Record<string, ChatAttachment[]> | undefined {
  if (!value || typeof value !== 'object' || Array.isArray(value) || Object.keys(value).length > 1000) return;
  const result: Record<string, ChatAttachment[]> = {};
  for (const [key, files] of Object.entries(value)) {
    if (!/^(agent:|session:|team:|chat:|new-chat:|new-chat$)/.test(key) || key.length > 240 || !validChatAttachments(files)) return;
    result[key] = files;
  }
  return result;
}
export function AttachmentList({ files, onRemove }: { files?: ChatAttachment[]; onRemove?(id: string): void }) {
  if (!files?.length) return null;
  return <ul className="chat-attachments" aria-label="첨부 파일">{files.map(file => <li key={file.id} className="chat-attachment"><span aria-hidden="true">{file.kind === 'image' ? '▧' : '▤'}</span><span className="attachment-name" title={file.name}>{file.name}</span><span className="typo-l2/r text-glyph-gray-caption">{Math.max(1, Math.ceil(file.bytes / 1024))} KB</span>{onRemove && <Button kind="common" hierarchy="ghost" size="xsmall" aria-label={`${file.name} 첨부 제거`} onPress={() => onRemove(file.id)}>×</Button>}</li>)}</ul>;
}
export function useChatAttachments(key: string, invoke: (method: string, args?: unknown) => Promise<any>) {
  const [drafts, setDrafts, storage] = useLocalDraft<Record<string, ChatAttachment[]>>('chat-attachments', {}, attachmentDrafts);
  const [busy, setBusy] = React.useState(false), [errors, setErrors] = React.useState<Record<string, string>>({});
  const pending = React.useRef<{key: string} | undefined>(undefined);
  const receive = async (read: () => Promise<ChatAttachment[]>) => {
    if (pending.current) return;
    const operation = {key}; pending.current = operation; setBusy(true); setErrors(previous => ({ ...previous, [key]: '' }));
    try {
      const files = await read();
      if (!validChatAttachments(files)) throw new Error('첨부 파일 응답을 확인할 수 없습니다.');
      if (!files.length) return;
      setDrafts(previous => {
        const current = previous[operation.key] ?? [];
        const merged = [...current, ...files.filter(file => !current.some(item => item.id === file.id))];
        if (!validChatAttachments(merged)) throw new Error('첨부는 최대 5개, 합계 12 MB까지 가능합니다.');
        return { ...previous, [operation.key]: merged };
      });
    } catch (cause) { setErrors(previous => ({ ...previous, [operation.key]: cause instanceof Error ? cause.message : '첨부 파일을 준비하지 못했습니다.' })); }
    finally { pending.current = undefined; setBusy(false); }
  };
  const choose = () => void receive(() => invoke('selectChatAttachments'));
  const drop = (files: File[]) => void receive(async () => {
    if (files.length > CHAT_ATTACHMENT_LIMITS.count || files.reduce((sum, file) => sum + file.size, 0) > CHAT_ATTACHMENT_LIMITS.totalBytes) throw new Error('첨부는 최대 5개, 합계 12 MB까지 가능합니다.');
    const payload = [];
    for (const file of files) payload.push({ name: file.name, bytes: new Uint8Array(await file.arrayBuffer()) });
    return invoke('stageChatAttachments', { files: payload });
  });
  const remove = (id: string) => setDrafts(previous => ({ ...previous, [key]: (previous[key] ?? []).filter(file => file.id !== id) }));
  const clear = (keys: string[], ids: string[]) => setDrafts(previous => { const next = { ...previous }; for (const item of keys) next[item] = (next[item] ?? []).filter(file => !ids.includes(file.id)); return next; });
  const promote = (from: string, to: string) => {
    if (from === to) return;
    setDrafts(previous => {
      const moving = previous[from] ?? [], existing = previous[to] ?? [];
      const merged = [...existing, ...moving.filter(file => !existing.some(item => item.id === file.id))];
      if (!validChatAttachments(merged)) throw new Error('대화 첨부 초안을 합칠 수 없습니다. 기존 초안은 보관했습니다.');
      return { ...previous, [from]: [], [to]: merged };
    });
    // Only redirect the picker already in flight; later new chats keep their own key.
    if (pending.current?.key === from) pending.current.key = to;
    setErrors(previous => ({ ...previous, [from]: '', [to]: previous[from] || previous[to] || '' }));
  };
  return { drafts, files: drafts[key] ?? [], busy, error: errors[key] ?? '', storage, choose, drop, remove, clear, promote };
}
