import assert from "node:assert/strict";
import { createServer } from "node:http";
import { mkdtemp, readFile, rm, stat, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { build } from "esbuild";

async function moduleAt(file) {
  const result = await build({ entryPoints: [new URL(`../${file}`, import.meta.url).pathname], bundle: true, platform: "node", format: "esm", target: "node22", write: false });
  return import(`data:text/javascript;base64,${Buffer.from(result.outputFiles[0].text).toString("base64")}`);
}
const api = await moduleAt("source/host/extensions/inference/api-provider-transport.ts");
const config = await moduleAt("source/shared/api-provider-config.ts");
const settingsModule = await moduleAt("source/shared/node/settings/sand-settings-store.ts");
const adapter = await moduleAt("source/host/extensions/inference/api-provider-session.ts");
const localStore = await moduleAt("source/venditbot/local-store.ts");
const profile = (protocol = "chat-completions", extra = {}) => config.normalizeApiProviderProfile({ schemaVersion: 1, id: "test", name: "Test", provider: protocol === "anthropic-messages" ? "anthropic" : "openai-compatible", authMethod: "api-key", model: "fixture-model", baseUrl: protocol === "anthropic-messages" ? "https://api.anthropic.com/v1" : "https://example.invalid/v1", protocol, capabilities: { tools: true }, ...extra });
const wire = (...events) => events.map(event => `data: ${typeof event === "string" ? event : JSON.stringify(event)}\n\n`).join("");
const streamResponse = (...events) => new Response(wire(...events), { headers: { "content-type": "text/event-stream" } });
const done = (text = "OK", usage = { prompt_tokens: 2, completion_tokens: 1 }) => streamResponse({ id: "chat-fixture", choices: [{ delta: { content: text }, finish_reason: null }] }, { choices: [{ delta: {}, finish_reason: "stop" }], usage }, "[DONE]");
async function collect(options) { const events = []; for await (const event of api.streamApiProvider({ profile: profile(), apiKey: "fixture-secret", messages: [{ role: "user", content: "Hello" }], ...options })) events.push(event); return events; }
const tool = { name: "lookup", inputSchema: { type: "object", properties: { q: { type: "string" } }, required: ["q"] } };

test("profiles permit only explicit protocols, endpoint-safe keys and local HTTP opt-in", () => {
  for (const baseUrl of ["http://example.com/v1", "https://user:password@example.com", "https://example.com/v1?key=secret", "https://example.com/#secret", "file:///tmp/api", "http://127.0.0.1/v1"]) assert.throws(() => profile("responses", { baseUrl }));
  assert.equal(profile("responses", { baseUrl: "http://127.0.0.1:5000/v1", allowInsecureLoopback: true }).baseUrl, "http://127.0.0.1:5000/v1");
  assert.throws(() => profile("responses", { provider: "openai", baseUrl: "https://evil.invalid/v1" }));
  assert.throws(() => profile("responses", { provider: "anthropic" }));
  assert.throws(() => profile("responses", { model: "" }));
  const normalized = profile("responses", { apiKey: "must-not-persist", headers: { Authorization: "must-not-persist" } });
  assert.doesNotMatch(JSON.stringify(normalized), /must-not-persist/);
});

test("UUID profile keys round-trip through encrypted storage without identity collisions", async () => {
  const folder = await mkdtemp(path.join(tmpdir(), "venditbot-api-secret-test-"));
  try {
    const selected = profile("responses", { id: "b6e0b868-1918-4b4e-852e-e385069df115" });
    const reference = config.apiProfileSecretKey(selected);
    assert.match(reference, /^[A-Z0-9_]+$/);
    assert.notEqual(config.apiProfileSecretKey({ ...selected, id: "a-b" }), config.apiProfileSecretKey({ ...selected, id: "a_b" }));
    const store = new localStore.EncryptedSecretStore(folder, { isAsyncEncryptionAvailable: async () => true, encryptStringAsync: async value => Buffer.from(`encrypted:${value}`), decryptStringAsync: async bytes => ({result: bytes.toString().slice(10), shouldReEncrypt: false}) });
    await store.write(reference, "fixture-key");
    assert.equal(store.has(reference), true);
    assert.equal(await store.read(reference), "fixture-key");
    store.remove(reference);
    assert.equal(store.has(reference), false);
  } finally { await rm(folder, { recursive: true, force: true }); }
});

test("credential references bind normalized endpoint, protocol, provider and profile ID", () => {
  const selected = profile("responses", { baseUrl: "https://example.invalid/v1" });
  const reference = config.apiProfileSecretKey(selected);
  const variants = [
    { ...selected, baseUrl: "https://different.invalid/v1" },
    { ...selected, baseUrl: "https://example.invalid/v2" },
    { ...selected, protocol: "chat-completions" },
    { ...selected, id: "different-id" },
    profile("responses", { provider: "openai", baseUrl: "https://api.openai.com/v1" }),
  ];
  for (const variant of variants) assert.notEqual(reference, config.apiProfileSecretKey(variant));
  const official = profile("responses", { provider: "openai", baseUrl: "https://api.openai.com/v1" });
  assert.notEqual(config.apiProfileSecretKey(official), config.apiProfileSecretKey({ ...official, provider: "openai-compatible" }));
  assert.equal(reference, config.apiProfileSecretKey({ ...selected, baseUrl: "https://EXAMPLE.invalid:443/v1/" }));
  assert.equal(reference, config.apiProfileSecretKey({ ...selected, model: "another-fixture-model", name: "Renamed", capabilities: { tools: false, images: false, structuredOutput: false } }));
  const hex = reference.slice("VENDITBOT_API_V2_".length);
  const tuple = String.fromCharCode(...hex.match(/.{4}/g).map(part => Number.parseInt(part, 16)));
  assert.deepEqual(JSON.parse(tuple), [selected.provider, selected.baseUrl, selected.protocol, selected.id]);
  assert.throws(() => config.apiProfileSecretKey({ ...selected, baseUrl: "https://user:key@example.invalid/v1" }));
});

test("settings sanitize secrets, retain selected models, and extend all provider usage records", async () => {
  const folder = await mkdtemp(path.join(tmpdir(), "venditbot-api-test-"));
  try {
    const file = path.join(folder, "settings.json"), store = new settingsModule.SandSettingsStore(file);
    store.setApiProviderProfiles([{ ...profile(), apiKey: "do-not-save" }]);
    store.setActiveApiProfileId("test");
    assert.equal(store.getActiveApiProfile().model, "fixture-model");
    assert.equal(store.getInferenceProvider(), "openai-compatible");
    assert.doesNotMatch(await readFile(file, "utf8"), /do-not-save|apiKey/);
    store.recordInferenceUsage("anthropic", { inputTokens: 3, outputTokens: 5, requestCount: 2, usageAvailable: false });
    assert.equal(store.getInferenceRouterUsage().providers.anthropic.requests, 2);
    assert.equal(store.getInferenceRouterUsage().providers.anthropic.unknownUsageRequests, 2);
    assert.equal(store.getInferenceRouterUsage().providers.openai.requests, 0);
  } finally { await rm(folder, { recursive: true, force: true }); }
});

test("desktop settings preserve corrupt originals and refuse symlink targets", async () => {
  const folder = await mkdtemp(path.join(tmpdir(), "venditbot-settings-test-"));
  try {
    const file = path.join(folder, "settings.json"), store = new settingsModule.SandSettingsStore(file, { failOnCorrupt: true });
    await writeFile(file, '{corrupt');
    assert.throws(() => store.setApiProviderProfiles([profile()]));
    assert.equal(await readFile(file, "utf8"), '{corrupt');
    await writeFile(file, JSON.stringify({ version: 1, apiProviderProfiles: [profile(), profile()] }));
    assert.throws(() => store.getApiProviderProfiles());
    await rm(file);
    const target = path.join(folder, 'unrelated.txt'); await writeFile(target, 'untouched'); await symlink(target, file);
    assert.throws(() => store.persist(settingsModule.emptySettings()));
    assert.equal(await readFile(target, 'utf8'), 'untouched');
    await rm(file); store.setApiProviderProfiles([profile()]);
    assert.equal((await stat(file)).mode & 0o777, 0o600);
  } finally { await rm(folder, { recursive: true, force: true }); }
});

test("chat streaming preserves roles and tool results, routes the selected model and fixed no-redirect policy", async () => {
  let requests = 0, executions = 0;
  const events = await collect({ tools: [tool], executeTool: async (definition, args, id) => { executions++; assert.equal(id, "call_1"); assert.deepEqual(args, { q: "item" }); return { found: true }; }, fetch: async (url, init) => {
    requests++; const body = JSON.parse(init.body);
    assert.equal(body.model, "fixture-model"); assert.equal(init.redirect, "manual");
    assert.equal(new Headers(init.headers).get("authorization"), "Bearer fixture-secret");
    if (requests === 1) return streamResponse({ choices: [{ delta: { tool_calls: [{ index: 0, id: "call_1", function: { name: "lookup", arguments: '{"q":' } }] }, finish_reason: null }] }, { choices: [{ delta: { tool_calls: [{ index: 0, function: { arguments: '"item"}' } }] }, finish_reason: "tool_calls" }], usage: { prompt_tokens: 4, completion_tokens: 3 } }, "[DONE]");
    assert.equal(body.messages[0].role, "user");
    assert.equal(body.messages[1].role, "assistant"); assert.equal(body.messages[1].tool_calls[0].id, "call_1");
    assert.deepEqual(body.messages[2], { role: "tool", tool_call_id: "call_1", content: '{"found":true}' });
    return done("Found", { prompt_tokens: 5, completion_tokens: 2 });
  } });
  assert.equal(executions, 1); assert.equal(requests, 2);
  assert.deepEqual(events.find(event => event.type === "usage").usage, { inputTokens: 9, outputTokens: 5, requestCount: 2, usageAvailable: true });
  assert.equal(events.at(-1).type, "completed");
});

test("Responses sends tool outputs with matching call IDs and keeps same-provider output items", async () => {
  let requests = 0;
  const events = await collect({ profile: profile("responses"), tools: [tool], executeTool: async () => "found", fetch: async (_url, init) => {
    requests++; const body = JSON.parse(init.body);
    assert.equal(body.store, false);
    if (requests === 1) return streamResponse({ type: "response.completed", response: { id: "r1", status: "completed", output: [{ type: "function_call", id: "fc1", call_id: "c1", name: "lookup", arguments: '{"q":"item"}' }], usage: { input_tokens: 2, output_tokens: 3 } } });
    assert.deepEqual(body.input.at(-1), { type: "function_call_output", call_id: "c1", output: "found" });
    return streamResponse({ type: "response.output_text.delta", delta: "OK" }, { type: "response.completed", response: { id: "r2", status: "completed", output: [], usage: { input_tokens: 4, output_tokens: 1 } } });
  } });
  assert.equal(events.at(-1).responseId, "r2");
});

test("Anthropic Messages streams text, tools, and cumulative output usage", async () => {
  let requests = 0;
  const events = await collect({ profile: profile("anthropic-messages"), tools: [tool], executeTool: async () => "value", fetch: async (url, init) => {
    requests++; const body = JSON.parse(init.body);
    assert.equal(url, "https://api.anthropic.com/v1/messages");
    assert.equal(new Headers(init.headers).get("x-api-key"), "fixture-secret");
    assert.equal(new Headers(init.headers).has("authorization"), false);
    if (requests === 1) return streamResponse({ type: "message_start", message: { id: "m1", usage: { input_tokens: 3, output_tokens: 1 } } }, { type: "content_block_start", index: 0, content_block: { type: "tool_use", id: "t1", name: "lookup", input: {} } }, { type: "content_block_delta", index: 0, delta: { type: "input_json_delta", partial_json: '{"q":"item"}' } }, { type: "message_delta", delta: { stop_reason: "tool_use" }, usage: { output_tokens: 4 } }, { type: "message_stop" });
    assert.equal(body.messages.at(-1).content[0].tool_use_id, "t1");
    return streamResponse({ type: "message_start", message: { id: "m2", usage: { input_tokens: 2, output_tokens: 1 } } }, { type: "content_block_delta", index: 0, delta: { type: "text_delta", text: "OK" } }, { type: "message_delta", delta: { stop_reason: "end_turn" }, usage: { output_tokens: 3 } }, { type: "message_stop" });
  } });
  assert.equal(events.find(event => event.type === "usage").usage.outputTokens, 7);
});

test("truncated streams keep partial text, reject completion and do not execute incomplete tools", async () => {
  const events = []; let executed = false;
  await assert.rejects(async () => { for await (const event of api.streamApiProvider({ profile: profile(), apiKey: "secret", messages: [], tools: [tool], executeTool: async () => { executed = true; }, fetch: async () => streamResponse({ choices: [{ delta: { content: "partial", tool_calls: [{ index: 0, id: "call", function: { name: "lookup", arguments: "{}" } }] }, finish_reason: null }] }) })) events.push(event); }, error => error.code === "protocol");
  assert.equal(events[0].delta, "partial"); assert.equal(executed, false); assert.equal(events.some(event => event.type === "completed"), false);
});

test("401, 403, redirect and provider error bodies never leak secrets or retry", async () => {
  for (const [status, code] of [[401, "authentication"], [403, "permission"], [302, "invalid_config"]]) {
    let requests = 0;
    await assert.rejects(() => collect({ fetch: async () => { requests++; return new Response("Bearer fixture-secret malicious remote error", { status, headers: { location: "https://other.invalid" } }); } }), error => { assert.equal(error.code, code); assert.doesNotMatch(error.message, /fixture-secret|malicious|other.invalid/); return true; });
    assert.equal(requests, 1);
  }
});

test("429 retries are bounded and successful retries account requests", async () => {
  let requests = 0;
  const events = await collect({ fetch: async () => ++requests === 1 ? new Response("secret", { status: 429 }) : done() });
  assert.equal(requests, 2); assert.equal(events.find(event => event.type === "usage").usage.requestCount, 2);
  requests = 0;
  await assert.rejects(() => collect({ fetch: async () => { requests++; return new Response("secret", { status: 429 }); } }), error => error.code === "rate_limit");
  assert.equal(requests, 3);
});

test("cancellation interrupts a hanging stream promptly", async () => {
  const controller = new AbortController(); let cancelled = false;
  const pending = collect({ signal: controller.signal, fetch: async () => new Response(new ReadableStream({ cancel() { cancelled = true; } }), { headers: { "content-type": "text/event-stream" } }) });
  setTimeout(() => controller.abort(), 10);
  await assert.rejects(() => pending, error => error.code === "cancelled");
  assert.equal(cancelled, true);
});

test("text-only profile sends no tools, and missing usage stays unknown", async () => {
  const events = await collect({ profile: profile("chat-completions", { capabilities: {} }), tools: [tool], fetch: async (_url, init) => { assert.equal(JSON.parse(init.body).tools, undefined); return done("OK", null); } });
  const usage = events.find(event => event.type === "usage").usage;
  assert.equal(usage.usageAvailable, false); assert.equal(usage.inputTokens, undefined);
});

test("tool calls are deduplicated during a turn and never retried after a broken continuation", async () => {
  let requests = 0, executions = 0;
  await assert.rejects(() => collect({ tools: [tool], executeTool: async () => { executions++; return "result"; }, fetch: async () => {
    requests++;
    if (requests <= 2) return streamResponse({ choices: [{ delta: { tool_calls: [{ index: 0, id: "same-call", function: { name: "lookup", arguments: "{}" } }] }, finish_reason: "tool_calls" }] }, "[DONE]");
    return streamResponse({ choices: [{ delta: { content: "interrupted" }, finish_reason: null }] });
  } }), error => error.code === "protocol");
  assert.equal(executions, 1); assert.equal(requests, 3);
});

test("executor settles usage and response only after verified completion", async () => {
  const result = adapter.createApiProviderExecutor({ profile: profile(), apiKey: "secret", messages: [], invocationId: "fixture", fetch: async () => done() });
  const events = []; for await (const event of result.fullStream) events.push(event);
  assert.equal(events[0].textDelta, "OK"); assert.equal((await result.response).modelId, "fixture-model");
  assert.equal((await result.extendedUsage).inputTokens, 2);
  const broken = adapter.createApiProviderExecutor({ profile: profile(), apiKey: "secret", messages: [], invocationId: "broken", fetch: async () => streamResponse({ choices: [{ delta: { content: "partial" }, finish_reason: null }] }) });
  await assert.rejects(async () => { for await (const _ of broken.fullStream) {} });
  await assert.rejects(broken.response); await assert.rejects(broken.extendedUsage);
});


test("real loopback HTTP stream supports split UTF-8 and never follows credential redirects", async () => {
  let unexpected = 0, observed = [];
  const server = createServer(async (request, response) => {
    observed.push(request.headers.authorization);
    if (request.url === "/redirect/chat/completions") { response.writeHead(307, { location: "/stolen" }); response.end(); return; }
    if (request.url === "/stolen") { unexpected++; response.end(); return; }
    response.writeHead(200, { "content-type": "text/event-stream" });
    const bytes = Buffer.from(wire({ choices: [{ delta: { content: "안녕" }, finish_reason: null }] }, { choices: [{ delta: {}, finish_reason: "stop" }], usage: { prompt_tokens: 1, completion_tokens: 1 } }, "[DONE]"));
    for (let i = 0; i < bytes.length; i += 3) response.write(bytes.subarray(i, i + 3));
    response.end();
  });
  await new Promise(resolve => server.listen(0, "127.0.0.1", resolve));
  try {
    const baseUrl = `http://127.0.0.1:${server.address().port}`;
    const events = await collect({ profile: profile("chat-completions", { baseUrl, allowInsecureLoopback: true }) });
    assert.equal(events.filter(event => event.type === "text-delta").map(event => event.delta).join(""), "안녕");
    await assert.rejects(() => collect({ profile: profile("chat-completions", { baseUrl: `${baseUrl}/redirect`, allowInsecureLoopback: true }) }), error => error.code === "invalid_config");
    assert.equal(unexpected, 0); assert.deepEqual(observed, ["Bearer fixture-secret", "Bearer fixture-secret"]);
  } finally { await new Promise(resolve => server.close(resolve)); }
});

test("cancellation while awaiting a tool does not restart or wait indefinitely for the tool", async () => {
  const controller = new AbortController(); let calls = 0;
  const pending = collect({ signal: controller.signal, tools: [tool], executeTool: async () => { calls++; setTimeout(() => controller.abort(), 10); await new Promise(() => {}); }, fetch: async () => streamResponse({ choices: [{ delta: { tool_calls: [{ index: 0, id: "call", function: { name: "lookup", arguments: "{}" } }] }, finish_reason: "tool_calls" }] }, "[DONE]") });
  await assert.rejects(() => pending, error => error.code === "cancelled");
  assert.equal(calls, 1);
});

test("connection validation requires real text and reports usage without persisting readiness", async () => {
  const result = await api.validateApiProviderConnection({ profile: profile(), apiKey: "fixture", fetch: async (_url, init) => { const body = JSON.parse(init.body); assert.equal(body.max_tokens, 128); return done(); } });
  assert.equal(result.ok, true); assert.equal(result.model, "fixture-model");
  await assert.rejects(() => api.validateApiProviderConnection({ profile: profile(), apiKey: "fixture", fetch: async () => done("") }), error => error.code === "protocol");
});
