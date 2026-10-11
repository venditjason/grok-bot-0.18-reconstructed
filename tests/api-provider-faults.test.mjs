import assert from 'node:assert/strict';
import {createServer} from 'node:http';
import test from 'node:test';
import {build} from 'esbuild';

const built = await build({entryPoints: ['source/host/extensions/inference/api-provider-transport.ts'], bundle: true, platform: 'node', format: 'esm', write: false});
const {streamApiProvider} = await import('data:text/javascript;base64,' + Buffer.from(built.outputFiles[0].text).toString('base64'));
const tool = {name: 'write_fixture', inputSchema: {type: 'object', properties: {value: {type: 'string'}}}};
const wire = (...events) => events.map(event => `data: ${typeof event === 'string' ? event : JSON.stringify(event)}\n\n`).join('');
const chatCall = (id = 'call1', args = '{"value":"one"}', index = 0) => ({index, id, function: {name: tool.name, arguments: args}});
const chatTools = calls => wire({choices: [{delta: {tool_calls: calls}, finish_reason: 'tool_calls'}]}, '[DONE]');
const deferred = () => {let resolve; const promise = new Promise(yes => {resolve = yes;}); return {promise, resolve};};

async function server(t, handler) {
  const requests = [], sockets = new Set(); let closedResponses = 0;
  const http = createServer(async (request, response) => {
    response.on('close', () => closedResponses++);
    try {
      let body = ''; for await (const chunk of request) body += chunk;
      requests.push({url: request.url, body: JSON.parse(body)});
      await handler(request, response, requests.length);
    } catch {response.destroy();}
  });
  http.on('connection', socket => {sockets.add(socket); socket.on('close', () => sockets.delete(socket));});
  await new Promise((resolve, reject) => {http.once('error', reject); http.listen(0, '127.0.0.1', resolve);});
  t.after(async () => {for (const socket of sockets) socket.destroy(); await new Promise(resolve => http.close(resolve));});
  const baseUrl = `http://127.0.0.1:${http.address().port}`;
  const options = (protocol = 'chat-completions') => ({profile: {schemaVersion: 1, id: 'fault-fixture', name: 'Fault fixture', provider: protocol === 'anthropic-messages' ? 'anthropic' : 'openai-compatible', authMethod: 'api-key', model: 'fixture', baseUrl: protocol === 'anthropic-messages' ? 'https://api.anthropic.com/v1' : baseUrl, allowInsecureLoopback: true, protocol, capabilities: {tools: true}}, apiKey: 'synthetic-not-a-credential', messages: [{role: 'user', content: 'synthetic request'}], timeoutMs: 2000,
    // Anthropic has a fixed production URL. This explicit test-only fetch port
    // redirects transport to our loopback fixture, never to an external host.
    ...(protocol === 'anthropic-messages' ? {fetch: (url, init) => {assert.equal(url, 'https://api.anthropic.com/v1/messages'); return fetch(baseUrl + '/messages', init);}} : {})});
  return {options, requests, closed: () => closedResponses};
}
async function observe(options, onEvent = () => {}) {
  const events = []; let error;
  try {for await (const event of streamApiProvider(options)) {events.push(event); await onEvent(event);}} catch (failure) {error = failure;}
  return {events, error};
}
const partial = protocol => protocol === 'responses' ? {type: 'response.output_text.delta', delta: 'partial'} : protocol === 'anthropic-messages' ? {type: 'content_block_delta', index: 0, delta: {type: 'text_delta', text: 'partial'}} : {choices: [{delta: {content: 'partial'}, finish_reason: null}]};
const sse = response => {response.writeHead(200, {'content-type': 'text/event-stream'}); response.flushHeaders();};
function failed(result, code) {assert.equal(result.error?.code, code); assert.equal(result.events.some(event => event.type === 'completed'), false); assert.equal(result.events.filter(event => event.type === 'usage').length, 1);}

test('real connection resets preserve partial text without a replay in all three protocols', async t => {
  for (const protocol of ['chat-completions', 'responses', 'anthropic-messages']) {
    const received = deferred(), fixture = await server(t, async (_request, response) => {sse(response); response.write(wire(partial(protocol))); await received.promise; response.destroy();});
    const result = await observe(fixture.options(protocol), event => {if (event.type === 'text-delta') received.resolve();});
    failed(result, 'network'); assert.equal(result.events[0].delta, 'partial'); assert.equal(fixture.requests.length, 1);
  }
});

test('clean EOF without each protocol terminal event is never accepted as completion', async t => {
  for (const protocol of ['chat-completions', 'responses', 'anthropic-messages']) {
    const fixture = await server(t, (_request, response) => {sse(response); response.end(wire(partial(protocol)));});
    const result = await observe(fixture.options(protocol)); failed(result, 'protocol'); assert.equal(result.events[0].delta, 'partial'); assert.equal(fixture.requests.length, 1);
  }
});

test('unfinished network tool frames have no side effects even when the arguments are complete', async t => {
  const fixture = await server(t, (_request, response) => {sse(response); response.end(wire({choices: [{delta: {tool_calls: [chatCall()]}, finish_reason: 'tool_calls'}]}));});
  let executions = 0; const result = await observe({...fixture.options(), tools: [tool], executeTool: async () => {executions++;}});
  failed(result, 'protocol'); assert.equal(executions, 0); assert.equal(fixture.requests.length, 1);
});

test('real header and body stalls time out once and close the underlying request', async t => {
  for (const phase of ['headers', 'body']) {
    const fixture = await server(t, (_request, response) => {if (phase === 'body') sse(response);});
    const started = Date.now(), result = await observe({...fixture.options(), timeoutMs: 100});
    failed(result, 'timeout'); assert.ok(Date.now() - started < 1500); assert.equal(fixture.requests.length, 1);
    for (let i = 0; i < 30 && !fixture.closed(); i++) await new Promise(resolve => setTimeout(resolve, 10));
    assert.equal(fixture.closed(), 1);
  }
});

test('cancellation during Retry-After makes no second HTTP request', async t => {
  const controller = new AbortController(), sent = deferred();
  const fixture = await server(t, (_request, response) => {response.writeHead(429, {'retry-after': '5'}); response.end('synthetic quota error'); sent.resolve();});
  const pending = observe({...fixture.options(), signal: controller.signal}); await sent.promise; await new Promise(resolve => setTimeout(resolve, 20)); controller.abort();
  failed(await pending, 'cancelled'); assert.equal(fixture.requests.length, 1);
});

test('network failure after a completed tool step never repeats the tool or continuation request', async t => {
  const fixture = await server(t, (_request, response, count) => {if (count === 1) {sse(response); response.end(chatTools([chatCall()]));} else response.destroy();});
  let executions = 0; const result = await observe({...fixture.options(), tools: [tool], executeTool: async () => {executions++; return 'committed';}});
  failed(result, 'network'); assert.equal(executions, 1); assert.equal(fixture.requests.length, 2); assert.equal(result.events.filter(event => event.type === 'tool-result').length, 1);
});

test('consumer return after visible text immediately closes a real unfinished HTTP stream', async t => {
  const fixture = await server(t, (_request, response) => {sse(response); response.write(wire(partial('chat-completions')));});
  for await (const event of streamApiProvider(fixture.options())) {assert.equal(event.type, 'text-delta'); break;}
  for (let i = 0; i < 30 && !fixture.closed(); i++) await new Promise(resolve => setTimeout(resolve, 10));
  assert.equal(fixture.closed(), 1); assert.equal(fixture.requests.length, 1);
});

test('cancellation at the exposed tool-call event must prevent its execution', async t => {
  const fixture = await server(t, (_request, response) => {sse(response); response.end(chatTools([chatCall()]));});
  const controller = new AbortController(); let executions = 0;
  const result = await observe({...fixture.options(), signal: controller.signal, tools: [tool], executeTool: async () => {executions++; return 'committed';}}, event => {if (event.type === 'tool-call') controller.abort();});
  failed(result, 'cancelled'); assert.equal(executions, 0); assert.equal(fixture.requests.length, 1);
});

test('conflicting repeated tool IDs reject the whole received batch before any execution', async t => {
  const fixture = await server(t, (_request, response) => {sse(response); response.end(chatTools([chatCall(), chatCall('call1', '{"value":"different"}', 1)]));});
  let executions = 0; const result = await observe({...fixture.options(), tools: [tool], executeTool: async () => {executions++; return 'committed';}});
  failed(result, 'tool'); assert.equal(executions, 0); assert.equal(fixture.requests.length, 1);
});

test('a later batch with an earlier committed ID conflict does not execute its preceding new call', async t => {
  const fixture = await server(t, (_request, response, count) => {sse(response); response.end(chatTools(count === 1 ? [chatCall()] : [chatCall('new-call'), chatCall('call1', '{"value":"changed"}', 1)]));});
  const executions = []; const result = await observe({...fixture.options(), tools: [tool], executeTool: async (_definition, _args, id) => {executions.push(id); return 'committed';}});
  failed(result, 'tool'); assert.deepEqual(executions, ['call1']); assert.equal(fixture.requests.length, 2);
});

test('timeout during an already-started tool settles promptly and a late tool result cannot restart inference', async t => {
  const fixture = await server(t, (_request, response) => {sse(response); response.end(chatTools([chatCall()]));});
  const gate = deferred(); let executions = 0;
  const result = await observe({...fixture.options(), timeoutMs: 100, tools: [tool], executeTool: async () => {executions++; return gate.promise;}});
  failed(result, 'timeout'); assert.equal(executions, 1); assert.equal(result.events.some(event => event.type === 'tool-result'), false);
  gate.resolve('late result'); await new Promise(resolve => setTimeout(resolve, 20)); assert.equal(fixture.requests.length, 1);
});

test('a terminal event completes and closes a server connection even if the server never sends EOF', async t => {
  for (const protocol of ['chat-completions', 'responses', 'anthropic-messages']) {
    const fixture = await server(t, (_request, response) => {
      sse(response); response.write(wire(partial(protocol)));
      response.write(protocol === 'responses' ? wire({type: 'response.completed', response: {id: 'r1', status: 'completed', output: []}}) : protocol === 'anthropic-messages' ? wire({type: 'message_delta', delta: {stop_reason: 'end_turn'}}, {type: 'message_stop'}) : wire({choices: [{delta: {}, finish_reason: 'stop'}]}, '[DONE]'));
    });
    const result = await observe(fixture.options(protocol)); assert.equal(result.error, undefined); assert.equal(result.events.at(-1).type, 'completed');
    for (let i = 0; i < 30 && !fixture.closed(); i++) await new Promise(resolve => setTimeout(resolve, 10));
    assert.equal(fixture.closed(), 1); assert.equal(fixture.requests.length, 1);
  }
});
