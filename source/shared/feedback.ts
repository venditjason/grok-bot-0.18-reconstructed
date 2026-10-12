export const SAND_FEEDBACK_MESSAGE_MAX_CHARS = 10_000; export const SAND_FEEDBACK_CONVERSATION_ID_MAX_CHARS = 512; export const SAND_FEEDBACK_ACCOUNT_SLOT_MAX_CHARS = 512; export const SAND_FEEDBACK_SENTRY_EVENT_ID_MAX_COUNT = 5; export const SAND_FEEDBACK_SENTRY_EVENT_ID_PATTERN = /^[0-9a-f]{32}$/;

/** Local report receipt; remote acceptance is never completion. */
export const FEEDBACK_REPOSITORY = 'venditjason/grok-bot-0.18-reconstructed' as const;
export type FeedbackInput = {requestId:string;kind:'bug'|'request';title:string;description:string};
export type FeedbackStatus = 'queued'|'running'|'validating'|'merged'|'failed'|'blocked'|'unknown';
export type FeedbackJob = {id:string;kind:'bug'|'request';title:string;description:string;status:FeedbackStatus;canResume?:boolean;route?:'rabbit'|'local';createdAt:string;updatedAt:string;revision:number;agentId?:string;sessionId?:string;message?:string;prUrl?:string;mergeSha?:string};
export type FeedbackSnapshot = {jobs:FeedbackJob[];agentId?:string;configured:boolean;configurationMessage?:string};
export type FeedbackAgent = {agentId:string;sessionId:string};
export type FeedbackBinding = {repository:typeof FEEDBACK_REPOSITORY;workspacePath?:string;baseBranch:string;allowLocalFallback:boolean;rabbitConnectionId?:string;rabbitRepositoryId?:string};
export type FeedbackMergeProof = {repository:typeof FEEDBACK_REPOSITORY;prUrl:string;headSha:string;mergeSha:string;checksPassed:true;merged:true};
export function feedbackInput(value:unknown):FeedbackInput {
 if(!value||typeof value!=='object'||Array.isArray(value))throw new Error('리포트 입력을 확인하세요.');
 const x=value as Record<string,unknown>;
 if(Object.keys(x).some(k=>!['requestId','kind','title','description'].includes(k))||typeof x.requestId!=='string'||!/^[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/i.test(x.requestId)||!['bug','request'].includes(String(x.kind)))throw new Error('리포트 요청 ID 또는 종류를 확인하세요.');
 for(const [name,max] of [['title',160],['description',12000]] as const)if(typeof x[name]!=='string'||!x[name].trim()||x[name].length>max||x[name].includes('\0'))throw new Error('리포트 제목과 내용을 확인하세요.');
 return {requestId:x.requestId.toLowerCase(),kind:x.kind as FeedbackInput['kind'],title:(x.title as string).trim(),description:(x.description as string).trim()};
}
