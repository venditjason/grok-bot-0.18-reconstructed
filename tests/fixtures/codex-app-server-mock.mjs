import { createInterface } from 'node:readline';
import { appendFileSync, existsSync, writeFileSync, unlinkSync } from 'node:fs';
import path from 'node:path';
const marker = path.join(process.env.CODEX_HOME, 'synthetic-keyring-fixture');
let authenticated = process.env.MOCK_KEYRING === '1' && existsSync(marker);
let turn = 0;
const mode = process.env.MOCK_MODE;
const send = message => process.stdout.write(JSON.stringify(message) + '\n');
const notify = (method, params) => send({ method, params });
const complete = (threadId, turnId, status = 'completed') => {
  notify('thread/tokenUsage/updated', { threadId, turnId, tokenUsage: { total: { inputTokens: 5, outputTokens: 2, cachedInputTokens: 1 }, last: { inputTokens: 1, outputTokens: 1 } } });
  notify('turn/completed', { threadId, turn: { id: turnId, status } });
};
let toolReplies = 0;
createInterface({ input: process.stdin }).on('line', line => {
  const msg = JSON.parse(line);
  if (process.env.MOCK_LOG) appendFileSync(process.env.MOCK_LOG, line + '\n');
  if (!msg.method) { if (++toolReplies === 2) complete('thread-1', 'turn-1'); return; }
  const ok = result => send({ id: msg.id, result });
  switch (msg.method) {
    case 'initialize': ok({ userAgent: 'mock' }); break;
    case 'initialized': break;
    case 'model/list': {
      const model = { id:'mock-codex-model',model:'mock-codex-model',displayName:'Mock Codex',description:'Official protocol test model',isDefault:true,hidden:false,supportedReasoningEfforts:[{reasoningEffort:'low'},{reasoningEffort:'high'}],defaultReasoningEffort:'low' };
      if (mode === 'catalog-pages' && !msg.params.cursor) ok({data:[model],nextCursor:'page-2'});
      else if (mode === 'catalog-pages') ok({data:[{...model,id:'second',model:'second',isDefault:false,supportedReasoningEfforts:[],defaultReasoningEffort:null},{...model,id:'hidden',model:'hidden',hidden:true}],nextCursor:null});
      else ok({data:[model],nextCursor:null});
      break;
    }
    case 'account/read': {
      const read = () => ok({ account: authenticated ? { type: 'chatgpt', email: 'user@example.invalid', planType: 'plus' } : null });
      if (mode === 'slow-status') setTimeout(read, 150); else read(); break;
    }
    case 'account/login/start':
      if (mode === 'slow-start') { setTimeout(() => ok({ type: 'chatgpt', loginId: 'owned-login', authUrl: 'https://auth.openai.com/authorize?state=slow' }), 2000); break; }
      if (mode === 'keyring-denied') { send({ id: msg.id, error: { code: -32603, message: 'failed to write keyring SECRET_SENTINEL' } }); break; }
      if (mode === 'port-conflict') { send({ id: msg.id, error: { code: -32000, message: 'port occupied SECRET_SENTINEL' } }); break; }
      ok({ type: 'chatgpt', loginId: 'owned-login', authUrl: mode === 'evil-url' ? 'https://evil.invalid/oauth' : 'https://auth.openai.com/authorize?state=owned-state' });
      notify('account/login/completed', { loginId: 'forged-login', success: true });
      if (mode !== 'pending' && mode !== 'evil-url') setTimeout(() => { authenticated = true; if (process.env.MOCK_KEYRING === '1') writeFileSync(marker, 'synthetic authenticated marker'); notify('account/login/completed', { loginId: 'owned-login', success: true }); }, 30);
      break;
    case 'account/login/cancel': ok({}); break;
    case 'account/logout': authenticated = false; if (existsSync(marker)) unlinkSync(marker); if (mode === 'slow-logout') setTimeout(() => ok({}), 100); else ok({}); break;
    case 'thread/start': if (mode === 'slow-thread') setTimeout(() => ok({ thread: { id: 'thread-1' } }), 2000); else ok({ thread: { id: mode === 'thread-empty' ? '' : mode === 'thread-long' ? 't'.repeat(257) : mode === 'thread-nul' ? 't\0' : mode === 'steer-boundary' ? 't'.repeat(256) : 'thread-1' } }); break;
    case 'thread/inject_items': ok({}); break;
    case 'thread/unsubscribe': ok({}); break;
    case 'turn/start': {
      const threadId = msg.params.threadId, turnId = mode === 'turn-nul' ? 'u\0' : mode === 'turn-long' ? 'u'.repeat(257) : mode === 'turn-empty' ? '' : mode === 'steer-boundary' ? 'u'.repeat(256) : `turn-${++turn}`;
      if (mode === 'start-lost-ack') break;
      if (mode === 'terminal-before-ack') {complete(threadId,turnId); ok({turn:{id:turnId,status:'inProgress'}}); break;}
      ok({ turn: { id: turnId, status: mode === 'steer-unconfirmed' ? 'unknown' : 'inProgress' } });
      if (mode === 'terminal-error') {notify('error',{threadId,turnId,willRetry:false,error:{message:'SECRET_SENTINEL',additionalDetails:'SECRET_SENTINEL',codexErrorInfo:'serverOverloaded'}}); break;}
      if (mode === 'retry-success') {notify('error',{threadId,turnId,willRetry:true,error:{message:'SECRET_SENTINEL',codexErrorInfo:'serverOverloaded'}}); setTimeout(()=>{notify('item/agentMessage/delta',{threadId,turnId,delta:'2'});complete(threadId,turnId);},30); break;}
      if (mode === 'failed-info') {notify('turn/completed',{threadId,turn:{id:turnId,status:'failed',error:{message:'SECRET_SENTINEL',codexErrorInfo:{httpConnectionFailed:{httpStatusCode:503}}}}});break;}
      if (mode === 'terminal-paused') {notify('item/agentMessage/delta',{threadId,turnId,delta:'partial'});setTimeout(()=>complete(threadId,turnId),80);break;}

      notify('item/agentMessage/delta', { threadId: 'another-thread', turnId, delta: 'MUST_NOT_APPEAR' });
      if (mode === 'crash') { process.exit(3); break; }
      notify('item/agentMessage/delta', { threadId, turnId, delta: 'Hello ' });
      if (mode === 'hanging' || mode === 'stuck-interrupt' || mode.startsWith('steer')) break;
      if (mode.startsWith('web-')) {
        const item={type:'webSearch',id:'web-1',query:'weather Seoul',action:{type:'search',query:'weather Seoul',queries:null},results:[{url:'https://www.met.no/'}]};
        notify('item/started',{threadId,turnId,item});
        if(mode==='web-hang')break;
        notify('item/completed',{threadId,turnId,item});complete(threadId,turnId);break;
      }
      if (mode === 'tools') {
        const params = { threadId, turnId, callId: 'call-1', tool: 'safe_tool', arguments: { value: 4 }, namespace: null };
        send({ id: 900, method: 'item/tool/call', params }); send({ id: 901, method: 'item/tool/call', params });
      } else {
        const bytes = Buffer.from(JSON.stringify({ method: 'item/agentMessage/delta', params: { threadId, turnId, delta: '세계' } }) + '\n');
        process.stdout.write(bytes.subarray(0, bytes.length - 7));
        setTimeout(() => { process.stdout.write(bytes.subarray(bytes.length - 7)); complete(threadId, turnId, mode === 'failed' ? 'failed' : 'completed'); }, 5);
      }
      break;
    }
    case 'turn/steer':
      if (mode === 'steer-lost') break;
      if (mode === 'steer-terminal') {complete(msg.params.threadId,msg.params.expectedTurnId);break;}
      if (mode === 'steer-error') {send({id:msg.id,error:{code:-32603,message:'SECRET_SENTINEL'}});break;}
      if (mode === 'steer-mismatch') {ok({turnId:'wrong-turn'});break;}
      ok({turnId:msg.params.expectedTurnId}); break;
    case 'turn/interrupt': if (mode === 'stuck-interrupt') break; ok({}); complete(msg.params.threadId, msg.params.turnId, 'interrupted'); break;
    default: send({ id: msg.id, error: { code: -32601, message: 'unsupported' } });
  }
});
