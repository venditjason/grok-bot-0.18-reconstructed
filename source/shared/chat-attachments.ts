export type ChatAttachment = {id:string;name:string;kind:'image'|'text';mimeType:string;bytes:number;sha256:string};
export const CHAT_ATTACHMENT_LIMITS = {count:5,totalBytes:12*1024*1024,imageBytes:4*1024*1024,textBytes:256*1024} as const;
export function validChatAttachment(value:unknown):value is ChatAttachment {
  if(!value||typeof value!=='object'||Array.isArray(value))return false;const a=value as ChatAttachment;
  return /^[a-f0-9-]{36}$/.test(a.id)&&typeof a.name==='string'&&a.name.length>0&&a.name.length<=180&&!/[\x00-\x1f/\\]/.test(a.name)&&['image','text'].includes(a.kind)&&typeof a.mimeType==='string'&&/^[a-z0-9.+-]+\/[a-z0-9.+-]+$/.test(a.mimeType)&&Number.isSafeInteger(a.bytes)&&a.bytes>0&&a.bytes<=(a.kind==='image'?CHAT_ATTACHMENT_LIMITS.imageBytes:CHAT_ATTACHMENT_LIMITS.textBytes)&&/^[a-f0-9]{64}$/.test(a.sha256);
}
export function validChatAttachments(value:unknown):value is ChatAttachment[]{return Array.isArray(value)&&value.length<=CHAT_ATTACHMENT_LIMITS.count&&value.every(validChatAttachment)&&new Set(value.map(a=>a.id)).size===value.length&&value.reduce((n,a)=>n+a.bytes,0)<=CHAT_ATTACHMENT_LIMITS.totalBytes;}
