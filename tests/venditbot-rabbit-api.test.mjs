import assert from 'node:assert/strict';
import test from 'node:test';
import http from 'node:http';
import {once} from 'node:events';
import {build} from 'esbuild';

async function load(file, platform) {
  const result = await build({entryPoints: [file], bundle: true, platform, format: 'esm', write: false, metafile: true});
  assert.equal(Object.keys(result.metafile.inputs).some(path => path.includes('node_modules/')), false);
  if (platform === 'browser') assert.equal(result.outputFiles[0].text.includes('node:'), false);
  return import('data:text/javascript;base64,' + Buffer.from(result.outputFiles[0].text).toString('base64'));
}
const schema = await load('source/shared/rabbit-project-api.ts', 'browser');
const {RabbitProjectClient, RabbitProjectApiError} = await load('source/venditbot/rabbit-project-client.ts', 'node');
const project = '11111111-1111-4111-8111-111111111111', run = '22222222-2222-4222-8222-222222222222', other = '33333333-3333-4333-8333-333333333333';
const key = 'rabbit_' + 'a'.repeat(43), date = '2026-10-11T00:00:00.000Z';
const cursor = (id, tail) => Buffer.from(`${id}:${tail}`).toString('base64url');
const connection = (rest = {}) => ({id: other, name: '로컬 검사', baseUrl: 'https://rabbit.example', projectId: project, baseRef: 'main', workflowTemplate: 'feature_pr', maxParallelTasks: 2, timeoutSeconds: 600, enabledForAgents: false, createdAt: date, updatedAt: date, ...rest});
const input = (rest = {}) => ({objective: '작업 검증', acceptance_criteria: ['완료 조건'], ...rest});
const repository = (id = other, rest = {}) => ({id, provider: 'github', url: 'https://github.com/example/repository', default_branch: 'main', status: 'ready', ...rest});
const receipt = (origin = 'https://rabbit.example', rest = {}) => ({run_id: run, project_id: project, state: 'created', created_at: date, poll_url: `${origin}/v1/runs/${run}`, events_url: `${origin}/v1/runs/${run}/events`, ...rest});
const detail = (rest = {}) => ({id: run, run_id: run, project_id: project, state: 'running', objective: '작업 검증', block_reason: null, manifest_ready: true, created_at: date, run_revision: 1, event_cursor: cursor(run, 0), last_event_id: null, max_parallel_tasks: 2, timeout_seconds: 600, environment: 'development', ...rest});
const event = (sequence = 1, rest = {}) => ({id: other, project_id: project, run_id: run, type: 'run.started', sequence, data: {message: '시작'}, created_at: date, ...rest});
const response = (value, status = 200, headers = {}) => new Response(JSON.stringify(value), {status, headers: {'Content-Type': 'application/json', ...headers}});
const errorIs = (code, uncertain, status) => error => {
  assert.ok(error instanceof RabbitProjectApiError); assert.equal(error.code, code); assert.equal(error.uncertain, uncertain);
  if (status !== undefined) assert.equal(error.status, status);
  assert.equal(error.message.includes(key), false); return true;
};

test('browser-safe connection schema imports full endpoints, preserves canonical defaults and rejects insecure origins', () => {
  const imported = schema.importRabbitEndpoint(`https://rabbit.example/v1/projects/${project}/runs`);
  assert.deepEqual(imported, {baseUrl: 'https://rabbit.example', projectId: project});
  const result = schema.normalizeRabbitConnectionDraft({name: ' 예제 ', baseUrl: `https://rabbit.example/v1/projects/${project}/runs`});
  assert.deepEqual(result, {name: '예제', baseUrl: 'https://rabbit.example', projectId: project, baseRef: 'main', workflowTemplate: 'feature_pr', maxParallelTasks: 2, timeoutSeconds: 600, enabledForAgents: false});
  for (const url of ['http://rabbit.example', 'http://127.0.0.1:8000', 'https://user:pass@rabbit.example', 'https://rabbit.example?a=b', 'https://rabbit.example#f', 'https://rabbit.example/other', 'https://rabbit.example\\bad', 'https://rabbit.example\n/bad']) assert.throws(() => schema.importRabbitEndpoint(url));
  for (const host of ['localhost', '127.0.0.1', '[::1]']) assert.equal(schema.importRabbitEndpoint(`http://${host}:8000/v1`, {allowInsecureLoopback: true}).baseUrl, `http://${host}:8000`);
  assert.throws(() => schema.importRabbitEndpoint('http://10.1.2.3:8000', {allowInsecureLoopback: true}));
  assert.throws(() => schema.normalizeRabbitConnectionDraft({...connection(), baseUrl: `https://rabbit.example/v1/projects/${other}/runs`}));
});

test('config validation does not coerce null, malformed UUIDs, limits or capability flags', () => {
  for (const patch of [{repositoryId: 'not-uuid'}, {projectId: null}, {baseRef: null}, {workflowTemplate: null}, {maxParallelTasks: null}, {timeoutSeconds: null}, {enabledForAgents: null}, {allowInsecureLoopback: 'yes'}, {maxParallelTasks: 5}, {timeoutSeconds: 59}, {timeoutSeconds: 14401}, {name: '\n'}]) assert.throws(() => schema.normalizeRabbitConnection({...connection(), ...patch}));
  for (const candidate of [null, 'rabbit_' + 'a'.repeat(42), 'Bearer ' + key, key + '\n', key + 'b']) assert.equal(schema.isRabbitProjectApiKey(candidate), false);
  assert.equal(schema.validateRabbitProjectApiKey(key), key);
  for (const preferForProjectTasks of [true, null, 'true']) assert.throws(() => schema.normalizeRabbitConnection({...connection(), preferForProjectTasks}));
  assert.equal(schema.normalizeRabbitConnection({...connection(), enabledForAgents: true, preferForProjectTasks: true}).preferForProjectTasks, true);
  assert.equal(schema.normalizeRabbitConnection({...connection(), enabledForAgents: true, preferForProjectTasks: false}).preferForProjectTasks, undefined);
});

test('run input matches project API defaults and preserves explicit repository UUID spelling', () => {
  const repository_id = other.toUpperCase().replace('3', 'A');
  const canonical = schema.normalizeRabbitRunInput(input({repository_id, objective: ' 작업 ', acceptance_criteria: [' 조건 ']}), connection());
  assert.deepEqual(canonical, {objective: '작업', acceptance_criteria: ['조건'], repository_id, base_ref: 'main', workflow_template: 'feature_pr', attachments: [], constraints: {environment: 'development', max_parallel_tasks: 2, timeout_seconds: 600, api_cost_limit_usd: 0}});
  const original = structuredClone(canonical); canonical.acceptance_criteria.push('second'); assert.equal(original.acceptance_criteria.length, 1);
});

test('run schema blocks owner-only options, attachments, invalid refs and null defaults before dispatch', () => {
  for (const patch of [{lane_id: other}, {model_id: 'model'}, {reasoning_effort: 'low'}, {attachments: [{artifact_id: other}]}, {attachments: null}, {repository_id: null}, {base_ref: null}, {base_ref: '../secret'}, {base_ref: '-flag'}, {workflow_template: null}, {acceptance_criteria: []}, {acceptance_criteria: Array(1)}, {constraints: null}, {constraints: {max_parallel_tasks: null}}, {constraints: {timeout_seconds: null}}, {constraints: {environment: 'production'}}, {constraints: {api_cost_limit_usd: 1}}, {constraints: {model: 'm'}}]) assert.throws(() => schema.normalizeRabbitRunInput(input(patch), connection()));
  assert.throws(() => schema.normalizeRabbitRunInput(input({objective: '한'.repeat(20000), acceptance_criteria: ['한'.repeat(2000)]}), connection()), /64KiB/);
  assert.throws(() => schema.normalizeRabbitRunInput(input({objective: 'x'.repeat(20001)}), connection()));
});

test('response projection pins project/run/origin and strips server account snapshots', () => {
  const result = schema.normalizeRabbitRunDetail(detail({org_id: other, goal: 'ignored', route_set_snapshot: {secret: key}, policy_snapshot: {ignored: true}}), {projectId: project, runId: run});
  assert.equal(result.org_id, undefined); assert.equal(result.route_set_snapshot, undefined); assert.equal(result.goal, undefined);
  for (const patch of [{project_id: other}, {run_id: other}, {id: other}, {event_cursor: cursor(other, 0)}]) assert.throws(() => schema.normalizeRabbitRunDetail(detail(patch), {projectId: project, runId: run}));
  for (const patch of [{project_id: other}, {poll_url: 'https://evil.example/path'}, {events_url: `https://rabbit.example/v1/runs/${other}/events`}, {poll_url: `https://rabbit.example/v1/runs/${run}?token=x`}]) assert.throws(() => schema.normalizeRabbitRunReceipt(receipt(undefined, patch), connection()));
});

test('events project only bounded status text and proven PR result fields', () => {
  const result = {status: 'pr_opened', base_sha: 'a'.repeat(40), summary: {exit_code: 0, output_bytes: 5, output_sha256: 'b'.repeat(64), tests: 'unverified', log: key}, branch: 'rabbit/run/feature', pr_url: 'https://github.com/example/repository/pull/23', pr_number: 23, head_sha: 'c'.repeat(40), raw_logs: key};
  const page = schema.normalizeRabbitEventPage({items: [event(1, {type: 'task.execution.pr_opened', data: {message: '검토할 PR', task_id: other, result, token: key}})], next_cursor: cursor(run, 1), has_more: false, run_revision: 2}, {projectId: project, runId: run});
  assert.equal(page.items[0].data.result.pr_number, 23); assert.equal(JSON.stringify(page).includes(key), false);
  assert.throws(() => schema.normalizeRabbitEventPage({...page, next_cursor: cursor(other, 1)}, {projectId: project, runId: run}));
  assert.throws(() => schema.normalizeRabbitEventPage({...page, next_cursor: cursor(run, 2)}, {projectId: project, runId: run}));
  assert.throws(() => schema.normalizeRabbitEventPage({...page, items: [page.items[0], page.items[0]]}, {projectId: project, runId: run}));
  const arbitrary = schema.normalizeRabbitEventPage({items: [event(1, {data: {reason: {nested: true}, result: {arbitrary: key}}})], next_cursor: cursor(run, 1), has_more: false, run_revision: 1}, {projectId: project, runId: run});
  assert.deepEqual(arbitrary.items[0].data, {});
});

test('read-only connection test pages in UUID order and sends only project key authentication', async () => {
  const seen = [], first = '33333333-3333-4333-8333-333333333333', second = '44444444-4444-4444-8444-444444444444';
  const client = new RabbitProjectClient({fetch: async (url, options) => {
    seen.push({url: String(url), options});
    return response(seen.length === 1 ? {items: [repository(first)], next_cursor: cursor(project, first), has_more: true} : {items: [repository(second)], next_cursor: null, has_more: false});
  }});
  const result = await client.testRabbitConnection(connection(), key);
  assert.equal(result.pages, 2); assert.deepEqual(result.repositories.map(item => item.id), [first, second]);
  for (const item of seen) {assert.equal(item.options.method, 'GET'); assert.equal(item.options.headers['X-Project-API-Key'], key); assert.equal(item.options.headers.Authorization, undefined); assert.equal(item.options.headers.Cookie, undefined); assert.equal(item.options.credentials, 'omit'); assert.equal(item.options.redirect, 'manual'); assert.equal(new URL(item.url).pathname, `/v1/projects/${project}/repositories`);}
  assert.equal(new URL(seen[1].url).searchParams.get('cursor'), cursor(project, first));
});

test('repository duplicate pages, cross-project cursors and malformed boundaries fail closed', async () => {
  for (const mode of ['duplicate', 'cross-project', 'no-progress']) {
    let calls = 0; const client = new RabbitProjectClient({fetch: async () => {calls++; return response({items: mode === 'no-progress' ? [] : [repository()], next_cursor: cursor(mode === 'cross-project' ? other : project, other), has_more: true});}});
    await assert.rejects(client.testRabbitConnection(connection(), key), errorIs('invalid_response', false)); assert.ok(calls <= 2);
  }
});

test('submission returns a receipt, uses a durable idempotency header and performs exactly one request', async () => {
  let calls = 0; const client = new RabbitProjectClient({fetch: async (url, options) => {
    calls++; assert.equal(String(url), `https://rabbit.example/v1/projects/${project}/runs`); assert.equal(options.method, 'POST'); assert.equal(options.headers['Idempotency-Key'], other);
    const body = JSON.parse(options.body); assert.equal(body.constraints.environment, 'development'); assert.equal(body.constraints.api_cost_limit_usd, 0); assert.equal(body.model_id, undefined); return response(receipt(), 202);
  }});
  const result = await client.submitRabbitRun(connection(), key, input(), other); assert.equal(result.state, 'created'); assert.equal(result.run_id, run); assert.equal(calls, 1);
  for (const bad of ['short', 'header\nvalue', 'x'.repeat(129)]) await assert.rejects(client.submitRabbitRun(connection(), key, input(), bad), errorIs('invalid_request', false));
  assert.equal(calls, 1);
});

test('POST classifications distinguish definite HTTP rejection from uncertain receipt/network outcomes without echoing server errors', async () => {
  for (const [status, expected, uncertain] of [[401, 'invalid_api_key', false], [403, 'invalid_api_key', false], [409, 'invalid_api_key', false], [422, 'invalid_api_key', false], [500, 'invalid_api_key', true], [503, 'invalid_api_key', true]]) {
    let calls = 0; const client = new RabbitProjectClient({fetch: async () => {calls++; return response({error: {code: 'invalid_api_key', message: key, details: {key}}}, status);}});
    await assert.rejects(client.submitRabbitRun(connection(), key, input(), other), errorIs(expected, uncertain, status)); assert.equal(calls, 1);
  }
  const unknown = new RabbitProjectClient({fetch: async () => response({error: {code: key, message: key}}, 400)});
  await assert.rejects(unknown.submitRabbitRun(connection(), key, input(), other), errorIs('http_error', false, 400));
  const network = new RabbitProjectClient({fetch: async () => {throw new Error(key);}});
  await assert.rejects(network.submitRabbitRun(connection(), key, input(), other), errorIs('network_error', true));
  await assert.rejects(network.getRabbitRun(connection(), key, run), errorIs('network_error', false));
  for (const [code, status] of [['internal_error', 500], ['validation_error', 422], ['repository_scope_mismatch', 422], ['request_too_large', 413]]) {
    const client = new RabbitProjectClient({fetch: async () => response({error: {code, message: key, details: {key}, request_id: key}}, status)});
    await assert.rejects(client.submitRabbitRun(connection(), key, input(), other), errorIs(code, status === 500, status));
  }
});

test('schema failures retain safe diagnostic IDs and the original request without automatic retries', async () => {
  const requests = [], diagnosticId = '78b4f1a2-94e6-44b0-acb0-321047919734';
  const client = new RabbitProjectClient({fetch: async (_url, options) => {
    requests.push({body: options.body, idempotencyKey: options.headers['Idempotency-Key']});
    return response({error: {code: 'database_schema_unavailable', request_id: diagnosticId, message: key, details: {secret: key}}}, 503);
  }});
  const verify = error => {errorIs('database_schema_unavailable', true, 503)(error); assert.equal(error.requestId, diagnosticId); assert.match(error.message, /데이터베이스 복구/); assert.ok(error.message.includes(diagnosticId)); return true;};
  await assert.rejects(client.submitRabbitRun(connection(), key, input(), other), verify);
  assert.equal(requests.length, 1);
  await assert.rejects(client.submitRabbitRun(connection(), key, input(), other), verify);
  assert.equal(requests.length, 2); assert.deepEqual(requests[0], requests[1]);
  for (const request_id of [key, diagnosticId + '\n', 'https://evil.example/' + diagnosticId, {}, null, 'a'.repeat(1000)]) {
    const invalid = new RabbitProjectClient({fetch: async () => response({error: {code: 'internal_error', request_id, message: key}}, 500)});
    await assert.rejects(invalid.submitRabbitRun(connection(), key, input(), other), error => {errorIs('internal_error', true, 500)(error); assert.equal(error.requestId, undefined); assert.doesNotMatch(error.message, /진단 요청 ID/); return true;});
  }
});

test('admission pause and preserved-history errors explain recovery without retrying or trusting server text', async () => {
  for (const [code, status, message] of [['execution_admission_paused', 503, /같은 요청으로 재시도/], ['legacy_run_read_only', 409, /기존 작업의 완료나 취소를 뜻하지/], ['legacy_runtime_read_only', 409, /기존 작업의 완료나 취소를 뜻하지/]]) {
    let calls = 0;
    const client = new RabbitProjectClient({fetch: async () => {calls++; return response({error: {code, message: `unsafe ${key}`, details: {secret: key}}}, status);}});
    await assert.rejects(client.submitRabbitRun(connection(), key, input(), other), error => {
      errorIs(code, status === 503, status)(error); assert.match(error.message, message); assert.doesNotMatch(error.message, /unsafe/); return true;
    });
    assert.equal(calls, 1);
    await assert.rejects(client.getRabbitRun(connection(), key, run), errorIs(code, false, status));
    assert.equal(calls, 2);
  }
});

test('redirects and successful-but-invalid POST receipts remain uncertain and never follow untrusted URLs', async () => {
  for (const [reply, code] of [[new Response(null, {status: 307, headers: {Location: 'https://evil.example'}}), 'redirect_blocked'], [response(receipt(undefined, {poll_url: 'https://evil.example'}), 202), 'invalid_response'], [response(receipt(), 200), 'http_error']]) {
    let calls = 0; const client = new RabbitProjectClient({fetch: async () => {calls++; return reply;}});
    await assert.rejects(client.submitRabbitRun(connection(), key, input(), other), errorIs(code, true)); assert.equal(calls, 1);
  }
});

test('polling uses locally constructed scoped paths, JSON events and strips exact secret echoes', async () => {
  const seen = []; const client = new RabbitProjectClient({fetch: async (url, options) => {
    seen.push({url: new URL(url), options});
    return response(String(url).includes('/events?') ? {items: [event(2, {data: {message: `do not echo ${key}`}})], next_cursor: cursor(run, 2), has_more: false, run_revision: 2} : detail({objective: key}));
  }});
  assert.equal((await client.getRabbitRun(connection(), key, run)).objective, '[보안값 삭제]');
  const page = await client.getRabbitEvents(connection(), key, run, cursor(run, 1)); assert.equal(page.items[0].data.message.includes(key), false);
  assert.equal(seen[0].url.pathname, `/v1/runs/${run}`); assert.equal(seen[1].url.pathname, `/v1/runs/${run}/events`); assert.equal(seen[1].options.headers.Accept, 'application/json'); assert.equal(seen[1].options.headers['Last-Event-ID'], undefined);
  await assert.rejects(client.getRabbitEvents(connection(), key, run, cursor(other, 1)), errorIs('invalid_request', false)); assert.equal(seen.length, 2);
});

test('events reject repeated or skipped empty-page cursors instead of silently losing history', async () => {
  for (const body of [{items: [event(1)], next_cursor: cursor(run, 1), has_more: false, run_revision: 1}, {items: [], next_cursor: cursor(run, 7), has_more: false, run_revision: 1}]) {
    const client = new RabbitProjectClient({fetch: async () => response(body)});
    await assert.rejects(client.getRabbitEvents(connection(), key, run, cursor(run, 1)), errorIs('invalid_response', false));
  }
});

test('bounded response reads reject declared/streamed overflow, non-JSON, corrupt UTF8 and truncated JSON', async () => {
  for (const reply of [new Response('{}', {headers: {'Content-Type': 'application/json', 'Content-Length': '1048577'}}), new Response(' '.repeat(1048577), {headers: {'Content-Type': 'application/json'}}), new Response('<html/>', {headers: {'Content-Type': 'text/html'}}), new Response(new Uint8Array([0xff]), {headers: {'Content-Type': 'application/json'}}), new Response('{', {headers: {'Content-Type': 'application/json'}})]) {
    const client = new RabbitProjectClient({fetch: async () => reply});
    await assert.rejects(client.getRabbitRun(connection(), key, run), errorIs('invalid_response', false));
  }
});

test('aborted-before-send performs no request; cancellation after POST dispatch is explicitly uncertain', async () => {
  const before = new AbortController(); before.abort(); let calls = 0;
  const client = new RabbitProjectClient({fetch: async () => {calls++; return new Promise(() => {});}});
  await assert.rejects(client.submitRabbitRun(connection(), key, input(), other, before.signal), errorIs('aborted', false)); assert.equal(calls, 0);
  const after = new AbortController(), pending = client.submitRabbitRun(connection(), key, input(), other, after.signal); after.abort();
  await assert.rejects(pending, errorIs('aborted', true)); assert.equal(calls, 1);
});

test('timeout bounds both a nonresponsive fetch and an unterminated body even if a transport ignores AbortSignal', async () => {
  for (const stage of ['fetch', 'body']) {
    const client = new RabbitProjectClient({timeoutMs: 35, fetch: async () => stage === 'fetch' ? new Promise(() => {}) : new Response(new ReadableStream({start(controller) {controller.enqueue(new TextEncoder().encode('{'));}}), {headers: {'Content-Type': 'application/json'}})});
    const start = Date.now(); await assert.rejects(client.submitRabbitRun(connection(), key, input(), other), errorIs('timeout', true)); assert.ok(Date.now() - start < 1000);
  }
});

async function withServer(handler, work) {
  const server = http.createServer(handler); server.listen(0, '127.0.0.1'); await once(server, 'listening');
  const origin = `http://127.0.0.1:${server.address().port}`;
  try {await work(connection({baseUrl: origin, allowInsecureLoopback: true}), origin);} finally {server.closeAllConnections(); await new Promise(resolve => server.close(resolve));}
}
test('real localhost transport enforces auth headers, no redirects and one POST across server faults', async () => {
  let mode = 'ok', calls = 0, redirected = 0;
  await withServer(async (request, reply) => {
    calls++; if (request.url === '/leak') {redirected++; reply.end('never'); return;}
    assert.equal(request.headers['x-project-api-key'], key); assert.equal(request.headers.authorization, undefined); assert.equal(request.headers.cookie, undefined);
    if (mode === 'drop') {request.socket.destroy(); return;}
    if (mode === 'redirect') {reply.writeHead(307, {Location: '/leak'}); reply.end(); return;}
    if (mode === 'partial') {reply.writeHead(202, {'Content-Type': 'application/json'}); reply.write('{'); return;}
    if (mode === 'error') {reply.writeHead(503, {'Content-Type': 'application/json'}); reply.end(JSON.stringify({error: {code: 'internal_error', message: key}})); return;}
    for await (const _ of request) {} reply.writeHead(202, {'Content-Type': 'application/json'}); reply.end(JSON.stringify(receipt(`http://${request.headers.host}`)));
  }, async config => {
    const client = new RabbitProjectClient({timeoutMs: 150}); assert.equal((await client.submitRabbitRun(config, key, input(), other)).run_id, run);
    for (const [nextMode, code] of [['drop', 'network_error'], ['redirect', 'redirect_blocked'], ['partial', 'timeout'], ['error', 'internal_error']]) {
      mode = nextMode; const start = calls; await assert.rejects(client.submitRabbitRun(config, key, input(), other), errorIs(code, true)); assert.equal(calls, start + 1);
    }
    assert.equal(redirected, 0);
  });
});

test('real localhost paginated GET shares a single deadline and in-flight abort closes a partial response', async () => {
  let count = 0, mode = 'pages';
  await withServer((request, reply) => {
    count++;
    if (mode === 'partial') {reply.writeHead(200, {'Content-Type': 'application/json'}); reply.write('{'); return;}
    const id = String(count).padStart(8, '0') + '-1111-4111-8111-111111111111';
    setTimeout(() => {if (!reply.destroyed) {reply.writeHead(200, {'Content-Type': 'application/json'}); reply.end(JSON.stringify({items: [repository(id)], next_cursor: cursor(project, id), has_more: true}));}}, 35);
  }, async config => {
    const client = new RabbitProjectClient({timeoutMs: 85}), start = Date.now();
    await assert.rejects(client.testRabbitConnection(config, key), errorIs('timeout', false)); assert.ok(count >= 2 && count <= 4); assert.ok(Date.now() - start < 500);
    mode = 'partial'; const controller = new AbortController(); const pending = client.getRabbitRun(config, key, run, controller.signal); setTimeout(() => controller.abort(), 25);
    await assert.rejects(pending, errorIs('aborted', false));
  });
});


test('collaboration receipts remain intermediate and final model reports stay bounded unverified data', () => {
  for (const status of ['plan_ready', 'artifact_saved', 'no_changes']) {
    const result = {status, base_sha: 'a'.repeat(40), summary: {exit_code: 0, output_bytes: 12, output_sha256: 'b'.repeat(64), tests: 'unverified', report: {text: 'Model report, not test proof.', truncated: false, authority: 'ignore'}}, raw_logs: key};
    const raw = {items: [event(1, {type: 'task.execution.' + status, data: {result}})], next_cursor: cursor(run, 1), has_more: false, run_revision: 2};
    const projected = schema.normalizeRabbitEventPage(raw, {projectId: project, runId: run}).items[0].data.result;
    assert.equal(projected.status, status); assert.equal(projected.summary.tests, 'unverified');
    assert.deepEqual(projected.summary.report, {text: 'Model report, not test proof.', truncated: false});
    assert.equal(projected.pr_url, undefined); assert.equal(JSON.stringify(projected).includes(key), false);
    for (const report of [{text: '한'.repeat(12000), truncated: false}, {text: 'x', truncated: 'false'}]) {
      result.summary.report = report;
      assert.throws(() => schema.normalizeRabbitEventPage(raw, {projectId: project, runId: run}));
    }
  }
});

test('native validation receipt is bounded and bound to exact published base/head while old results remain readable',()=>{
 const verification={version:1,status:'passed',verification_id:'verify-1',check_run_id:'check-1',review_id:'review-1',binding_sha256:'d'.repeat(64),candidate_sha256:'e'.repeat(64),repository_id:other,base_ref:'main',base_sha:'a'.repeat(40),head_sha:'c'.repeat(40),validation_policy_sha256:'f'.repeat(64),command_manifest_sha256:'0'.repeat(64),tests:true,diff_reviewed:true,process_exit_confirmed:true};
 const result={status:'pr_opened',base_sha:'a'.repeat(40),head_sha:'c'.repeat(40),summary:{exit_code:0,output_bytes:0,output_sha256:'b'.repeat(64),tests:'unverified'},branch:'rabbit/run/test',pr_url:'https://github.com/example/repository/pull/23',pr_number:23,verification};
 const parse=r=>schema.normalizeRabbitEventPage({items:[event(1,{type:'task.execution.pr_opened',data:{result:r}})],next_cursor:cursor(run,1),has_more:false,run_revision:2},{projectId:project,runId:run}).items[0].data.result;
 assert.deepEqual(parse({...result,verification:{...verification,raw_logs:key}}).verification,verification);
 const old={...result};delete old.verification;assert.equal(parse(old).verification,undefined);
 for(const patch of [{head_sha:'f'.repeat(40)},{base_sha:'f'.repeat(40)},{tests:false},{process_exit_confirmed:false},{review_id:''},{check_run_id:'a'.repeat(201)},{repository_id:'not-uuid'},{binding_sha256:'invalid'}])assert.throws(()=>parse({...result,verification:{...verification,...patch}}));
 assert.throws(()=>parse({...result,summary:{...result.summary,exit_code:1}}));
});
