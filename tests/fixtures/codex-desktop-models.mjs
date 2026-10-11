// Executed only by the desktop test's temporary bundled runtime fixture.
import {appendFileSync, readFileSync} from 'node:fs';
import {createInterface} from 'node:readline';
import path from 'node:path';
import {fileURLToPath} from 'node:url';

const catalogFile = path.join(path.dirname(fileURLToPath(import.meta.url)), 'models.json');
const log = path.join(process.env.CODEX_HOME, 'desktop-protocol.jsonl');
const send = message => process.stdout.write(`${JSON.stringify(message)}\n`);
let turn = 0;
createInterface({input: process.stdin}).on('line', line => {
  const message = JSON.parse(line); appendFileSync(log, `${line}\n`, {mode: 0o600});
  const reply = result => send({id: message.id, result});
  switch (message.method) {
    case 'initialize': reply({userAgent: 'desktop-model-test'}); break;
    case 'initialized': break;
    case 'account/read': reply({account: JSON.parse(readFileSync(catalogFile, 'utf8')).qaDisconnected ? null : {type: 'chatgpt', email: 'qa@example.invalid', planType: 'plus'}}); break;
    case 'account/login/start': reply({loginId: 'desktop-login', authUrl: 'https://auth.openai.com/qa-isolated-login'}); break;
    case 'account/login/cancel': reply({}); break;
    case 'model/list': reply(JSON.parse(readFileSync(catalogFile, 'utf8')).payload); break;
    case 'thread/start': reply({thread: {id: `desktop-thread-${turn + 1}`}}); break;
    case 'thread/inject_items': case 'thread/unsubscribe': case 'account/logout': reply({}); break;
    case 'turn/start': {
      const threadId = message.params.threadId, turnId = `desktop-turn-${++turn}`;
      reply({turn: {id: turnId, status: 'inProgress'}});
      setTimeout(() => {
        if (JSON.parse(readFileSync(catalogFile, 'utf8')).qaFailModels?.includes(message.params.model)) {
          send({method: 'turn/completed', params: {threadId, turn: {id: turnId, status: 'failed'}}}); return;
        }
        send({method: 'item/agentMessage/delta', params: {threadId, turnId, delta: '선택한 모델로 완료'}});
        send({method: 'turn/completed', params: {threadId, turn: {id: turnId, status: 'completed'}}});
      }, 5);
      break;
    }
    default: send({id: message.id, error: {code: -32601, message: 'Unexpected desktop QA request'}});
  }
});
