import { normalizeApiProviderProfile, type ApiProviderProfile } from "../../../shared/api-provider-config.js";

type Json = Record<string, any>;
export interface ApiProviderMessage { readonly role: string; readonly content: string | readonly unknown[] }
export interface ApiProviderUsage { readonly inputTokens?: number; readonly outputTokens?: number; readonly cacheReadTokens?: number; readonly cacheWriteTokens?: number; readonly requestCount: number; readonly usageAvailable: boolean }
export type ApiProviderErrorCode = "authentication" | "permission" | "rate_limit" | "network" | "invalid_config" | "model_access" | "protocol" | "cancelled" | "tool" | "unsupported" | "timeout";
export class ApiProviderError extends Error {
  constructor(readonly code: ApiProviderErrorCode, message: string, readonly status?: number) { super(message); this.name = "ApiProviderError"; }
}
export type ApiProviderEvent =
  | { type: "text-delta"; delta: string }
  | { type: "tool-call"; toolCallId: string; toolName: string; args: unknown }
  | { type: "tool-result"; toolCallId: string; toolName: string; result: unknown }
  | { type: "usage"; usage: ApiProviderUsage }
  | { type: "completed"; model: string; responseId?: string };
export interface ApiProviderOptions {
  readonly profile: ApiProviderProfile;
  readonly apiKey: string;
  readonly messages: readonly ApiProviderMessage[];
  readonly system?: string;
  readonly tools?: readonly Json[];
  /** The application's permission/argument-validation bridge, never a model-controlled evaluator. */
  readonly executeTool?: (definition: Json, args: unknown, toolCallId: string, signal?: AbortSignal) => Promise<unknown>;
  readonly signal?: AbortSignal;
  readonly maxSteps?: number;
  readonly maxOutputTokens?: number;
  readonly timeoutMs?: number;
  readonly fetch?: typeof fetch;
}
function failure(code: ApiProviderErrorCode, message: string): never { throw new ApiProviderError(code, message); }
function record(value: unknown): Json { return value !== null && typeof value === "object" && !Array.isArray(value) ? value as Json : {}; }
function count(value: unknown): number | undefined { return typeof value === "number" && Number.isSafeInteger(value) && value >= 0 ? value : undefined; }
function cancelled(signal: AbortSignal): void { if (signal.aborted) failure(signal.reason?.name === "TimeoutError" ? "timeout" : "cancelled", signal.reason?.name === "TimeoutError" ? "The API request timed out." : "The API request was cancelled."); }
function toError(error: unknown, signal: AbortSignal): ApiProviderError {
  if (signal.aborted) return new ApiProviderError(signal.reason?.name === "TimeoutError" ? "timeout" : "cancelled", signal.reason?.name === "TimeoutError" ? "The API request timed out." : "The API request was cancelled.");
  return error instanceof ApiProviderError ? error : new ApiProviderError("network", "The API connection failed. Check the endpoint and network, then try again.");
}
async function pause(ms: number, signal: AbortSignal): Promise<void> {
  cancelled(signal);
  await new Promise<void>((resolve, reject) => {
    const onAbort = () => { clearTimeout(timer); reject(new ApiProviderError("cancelled", "The API request was cancelled.")); };
    const timer = setTimeout(() => { signal.removeEventListener("abort", onAbort); resolve(); }, ms);
    signal.addEventListener("abort", onAbort, { once: true });
  });
}
async function awaitTool(result: Promise<unknown>, signal: AbortSignal): Promise<unknown> {
  cancelled(signal);
  return await new Promise((resolve, reject) => {
    const onAbort = () => reject(new ApiProviderError("cancelled", "The API request was cancelled; an already-started tool may still finish."));
    signal.addEventListener("abort", onAbort, { once: true });
    void result.then(resolve, reject).finally(() => signal.removeEventListener("abort", onAbort));
  });
}
function httpError(status: number): ApiProviderError {
  if (status === 401) return new ApiProviderError("authentication", "The API key was rejected. Update this connection's key.", status);
  if (status === 403) return new ApiProviderError("permission", "This API key does not have permission for the request.", status);
  if (status === 404) return new ApiProviderError("model_access", "The model or API endpoint was not found. Check the model ID and protocol.", status);
  if (status === 429) return new ApiProviderError("rate_limit", "The API rate or usage limit was reached. Check your provider's quota and try later.", status);
  if (status >= 300 && status < 400) return new ApiProviderError("invalid_config", "The API endpoint redirected the request. Use its final HTTPS Base URL; credentials were not forwarded.", status);
  return new ApiProviderError(status >= 500 ? "network" : "protocol", status >= 500 ? "The API provider is temporarily unavailable." : "The API rejected the request. Check the model, protocol and supported capabilities.", status);
}

/** SSE reader accepts CRLF and split UTF-8, and never treats EOF as successful completion. */
async function* sse(response: Response, signal: AbortSignal): AsyncGenerator<string> {
  if (!response.body) failure("protocol", "The API returned an empty response body.");
  if (!response.headers.get("content-type")?.toLowerCase().includes("text/event-stream")) failure("protocol", "The API did not return a server-sent event stream.");
  const reader = response.body.getReader(), decoder = new TextDecoder();
  let buffer = "", data: string[] = [], frameSize = 0;
  const abortRead = () => { void reader.cancel().catch(() => {}); };
  signal.addEventListener("abort", abortRead, { once: true });
  try {
    while (true) {
      cancelled(signal);
      const chunk = await reader.read();
      cancelled(signal);
      buffer += chunk.done ? decoder.decode() : decoder.decode(chunk.value, { stream: true });
      if (buffer.length > 4_194_304) failure("protocol", "The API stream exceeded its event size limit.");
      let end: number;
      while ((end = buffer.indexOf("\n")) !== -1) {
        const line = buffer.slice(0, end).replace(/\r$/, ""); buffer = buffer.slice(end + 1);
        if (line === "") { if (data.length) yield data.join("\n"); data = []; frameSize = 0; }
        else if (line.startsWith("data:")) { const part = line.slice(5).replace(/^ /, ""); data.push(part); frameSize += part.length; if (frameSize > 4_194_304) failure("protocol", "The API stream exceeded its event size limit."); }
      }
      if (chunk.done) break;
    }
    // Unfinished frames are deliberately discarded; each parser requires a terminal event.
  } finally { signal.removeEventListener("abort", abortRead); await reader.cancel().catch(() => {}); reader.releaseLock(); }
}
function parseEvent(data: string): Json {
  try { const parsed = JSON.parse(data); if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) throw new Error(); return parsed; }
  catch { failure("protocol", "The API returned malformed streaming JSON."); }
}
function imageUrl(part: Json): string {
  const raw = part.image ?? part.image_url?.url ?? part.url;
  const value = raw instanceof URL ? raw.href : typeof raw === "string" ? raw : raw instanceof Uint8Array ? `data:${part.mimeType || "image/png"};base64,${Buffer.from(raw).toString("base64")}` : "";
  if (/^data:image\/(png|jpeg|webp|gif);base64,[a-z\d+/=]+$/i.test(value)) return value;
  try { const url = new URL(value); if (url.protocol === "https:" && !url.username && !url.password) return url.href; } catch {}
  failure("unsupported", "Images must be HTTPS URLs or supported base64 image data.");
}
function textResult(value: unknown): string { try { return typeof value === "string" ? value : JSON.stringify(value) ?? "null"; } catch { failure("tool", "The tool result could not be serialized."); } }
function contentParts(message: ApiProviderMessage): Json[] {
  return typeof message.content === "string" ? [{ type: "text", text: message.content }] : message.content.map(part => record(part));
}
function convertMessages(messages: readonly ApiProviderMessage[], profile: ApiProviderProfile): { system: string; messages: Json[] } {
  const converted: Json[] = [], system: string[] = [];
  for (const message of messages) {
    if (!["system", "developer", "user", "assistant", "tool"].includes(message.role)) failure("unsupported", "The conversation contains an unsupported message role.");
    const parts = contentParts(message), content: Json[] = [], calls: Json[] = [];
    for (const part of parts) {
      if (part.type === "text" && typeof part.text === "string") content.push({ type: "text", text: part.text });
      else if (part.type === "image" || part.type === "image_url") {
        if (!profile.capabilities.images) failure("unsupported", "Image support is disabled for this model connection.");
        content.push({ type: "image", url: imageUrl(part) });
      } else if (part.type === "tool-call") calls.push({ id: part.toolCallId, name: part.toolName, args: part.args });
      else if (part.type === "tool-result") {
        if (typeof part.toolCallId !== "string") failure("protocol", "The conversation contains an invalid tool result.");
        if (profile.protocol === "responses") converted.push({ type: "function_call_output", call_id: part.toolCallId, output: textResult(part.result) });
        else if (profile.protocol === "anthropic-messages") converted.push({ role: "user", content: [{ type: "tool_result", tool_use_id: part.toolCallId, content: textResult(part.result) }] });
        else converted.push({ role: "tool", tool_call_id: part.toolCallId, content: textResult(part.result) });
      } else if (part.type === "reasoning" || part.type === "redacted-reasoning") { /* private provider state is never forwarded */ }
      else failure("unsupported", "This connection cannot send one of the conversation attachments.");
    }
    if (message.role === "system" || message.role === "developer") { system.push(content.map(part => part.text ?? "").join("\n")); continue; }
    if (profile.protocol === "responses") {
      if (content.length) converted.push({ role: message.role, content: content.map(part => part.type === "text" ? { type: message.role === "assistant" ? "output_text" : "input_text", text: part.text } : { type: "input_image", image_url: part.url }) });
      for (const call of calls) converted.push({ type: "function_call", call_id: call.id, name: call.name, arguments: textResult(call.args) });
    } else if (profile.protocol === "anthropic-messages") {
      const blocks = content.map(part => {
        if (part.type === "text") return part;
        const match = /^data:([^;]+);base64,(.+)$/.exec(part.url);
        return { type: "image", source: match ? { type: "base64", media_type: match[1], data: match[2] } : { type: "url", url: part.url } };
      });
      blocks.push(...calls.map(call => ({ type: "tool_use", id: call.id, name: call.name, input: call.args })));
      if (blocks.length) converted.push({ role: message.role, content: blocks });
    } else if (content.length || calls.length) converted.push({ role: message.role, content: content.length ? content.map(part => part.type === "text" ? part : { type: "image_url", image_url: { url: part.url } }) : null, ...(calls.length ? { tool_calls: calls.map(call => ({ id: call.id, type: "function", function: { name: call.name, arguments: textResult(call.args) } })) } : {}) });
  }
  return { system: system.join("\n\n"), messages: converted };
}
interface Call { id: string; name: string; arguments: string }
interface Step { calls: Call[]; output: Json[]; text: string; usage: Omit<ApiProviderUsage, "requestCount">; responseId?: string }
function usageFrom(raw: Json, protocol: ApiProviderProfile["protocol"]): Omit<ApiProviderUsage, "requestCount"> {
  const input = count(protocol === "chat-completions" ? raw.prompt_tokens : raw.input_tokens), output = count(protocol === "chat-completions" ? raw.completion_tokens : raw.output_tokens);
  const read = count(raw.cache_read_input_tokens ?? raw.input_tokens_details?.cached_tokens ?? raw.prompt_tokens_details?.cached_tokens), write = count(raw.cache_creation_input_tokens);
  return { ...(input === undefined ? {} : { inputTokens: input }), ...(output === undefined ? {} : { outputTokens: output }), ...(read === undefined ? {} : { cacheReadTokens: read }), ...(write === undefined ? {} : { cacheWriteTokens: write }), usageAvailable: input !== undefined && output !== undefined };
}
async function* readStep(response: Response, protocol: ApiProviderProfile["protocol"], signal: AbortSignal): AsyncGenerator<ApiProviderEvent, Step> {
  let text = "", finished = false, finishReason: string | undefined, responseId: string | undefined;
  let rawUsage: Json = {}, output: Json[] = [];
  const calls = new Map<number, Call>();
  for await (const data of sse(response, signal)) {
    if (data === "[DONE]") { if (protocol === "chat-completions" && finishReason) finished = true; break; }
    const event = parseEvent(data);
    if (event.error || event.type === "error" || event.type === "response.failed") failure("protocol", "The API reported a streaming failure. The partial response has been preserved.");
    let delta: unknown;
    if (protocol === "chat-completions") {
      responseId = typeof event.id === "string" ? event.id : responseId;
      if (event.usage) rawUsage = { ...rawUsage, ...record(event.usage) };
      const choice = event.choices?.[0]; delta = choice?.delta?.content;
      if (choice?.finish_reason) { finishReason = choice.finish_reason; if (!["stop", "tool_calls"].includes(finishReason!)) failure("protocol", "The API response did not complete normally (limit, filter or provider error)."); }
      for (const call of choice?.delta?.tool_calls ?? []) {
        if (!Number.isInteger(call.index) || call.index < 0) failure("protocol", "The API returned an invalid tool call index.");
        const current = calls.get(call.index) ?? { id: "", name: "", arguments: "" };
        if (typeof call.id === "string") current.id = call.id;
        if (typeof call.function?.name === "string") current.name += call.function.name;
        if (typeof call.function?.arguments === "string") current.arguments += call.function.arguments;
        calls.set(call.index, current);
      }
    } else if (protocol === "anthropic-messages") {
      if (event.type === "message_start") { responseId = event.message?.id; rawUsage = record(event.message?.usage); }
      if (event.type === "content_block_start") {
        if (event.content_block?.type === "tool_use") calls.set(event.index, { id: event.content_block.id, name: event.content_block.name, arguments: "" });
        if (event.content_block?.type === "text") delta = event.content_block.text;
      }
      if (event.type === "content_block_delta") {
        if (event.delta?.type === "text_delta") delta = event.delta.text;
        if (event.delta?.type === "input_json_delta") { const call = calls.get(event.index); if (!call) failure("protocol", "The API returned arguments without a tool call."); call.arguments += event.delta.partial_json ?? ""; }
      }
      if (event.type === "message_delta") { rawUsage = { ...rawUsage, ...record(event.usage) }; finishReason = event.delta?.stop_reason; }
      if (event.type === "message_stop") { if (!["end_turn", "tool_use", "stop_sequence"].includes(finishReason ?? "")) failure("protocol", "The API response did not complete normally (limit or provider error)."); finished = true; break; }
    } else {
      if (event.type === "response.output_text.delta") delta = event.delta;
      if (event.type === "response.output_item.done" && event.item) output.push(event.item);
      if (event.type === "response.incomplete") failure("protocol", "The API returned an incomplete response.");
      if (event.type === "response.completed") {
        if (event.response?.status !== "completed") failure("protocol", "The API response was not completed.");
        rawUsage = record(event.response.usage); responseId = event.response.id;
        if (Array.isArray(event.response.output)) output = event.response.output;
        for (const item of output) if (item.type === "function_call") calls.set(calls.size, { id: item.call_id, name: item.name, arguments: item.arguments });
        finished = true; break;
      }
    }
    if (typeof delta === "string" && delta) { text += delta; if (text.length > 16_777_216) failure("protocol", "The API response exceeded the output size limit."); yield { type: "text-delta", delta }; }
    if (calls.size > 128 || [...calls.values()].some(call => call.arguments.length > 1_048_576)) failure("protocol", "The API tool calls exceeded the size limit.");
  }
  if (!finished) failure("protocol", "The API stream ended before completion. The partial response has been preserved; tools were not replayed.");
  const selected = [...calls.values()];
  if (selected.length && protocol === "chat-completions" && finishReason !== "tool_calls") failure("protocol", "The API returned unfinished tool calls.");
  if (selected.length && protocol === "anthropic-messages" && finishReason !== "tool_use") failure("protocol", "The API returned unfinished tool calls.");
  return { calls: selected, output, text, usage: usageFrom(rawUsage, protocol), ...(responseId === undefined ? {} : { responseId }) };
}

/** API keys are ephemeral inputs from main's secure store. No environment or global credential fallback. */
export async function* streamApiProvider(options: ApiProviderOptions): AsyncGenerator<ApiProviderEvent> {
  let profile: ApiProviderProfile;
  try { profile = normalizeApiProviderProfile(options.profile); } catch { failure("invalid_config", "The API connection configuration is invalid. Review its endpoint, protocol and model ID."); }
  if (!options.apiKey?.trim() || /[\r\n]/.test(options.apiKey)) failure("authentication", "Save an API key for this connection first.");
  const localAbort = new AbortController();
  const timer = setTimeout(() => localAbort.abort(new DOMException("Timed out", "TimeoutError")), Math.min(Math.max(options.timeoutMs ?? 120_000, 100), 600_000));
  const signal = options.signal ? AbortSignal.any([options.signal, localAbort.signal]) : localAbort.signal;
  let requestCount = 0, usageAvailable = true;
  const totals: Record<string, number> = {};
  const toolResults = new Map<string, { fingerprint: string; result: unknown }>();
  try {
    cancelled(signal);
    const converted = convertMessages(options.messages, profile);
    const history = converted.messages;
    const system = [options.system, converted.system].filter(Boolean).join("\n\n");
    const tools = profile.capabilities.tools ? (options.tools ?? []) : [];
    const names = new Set<string>();
    for (const definition of tools) {
      if (typeof definition.name !== "string" || !/^[a-zA-Z0-9_-]{1,128}$/.test(definition.name) || names.has(definition.name) || typeof (definition.inputSchema ?? definition.parameters) !== "object") failure("tool", "The tool definitions are invalid or have duplicate names.");
      names.add(definition.name);
    }
    const toolSchema = tools.map(definition => {
      const fields = { name: definition.name, ...(typeof definition.description === "string" ? { description: definition.description } : {}) };
      const parameters = definition.inputSchema ?? definition.parameters;
      return profile.protocol === "anthropic-messages" ? { ...fields, input_schema: parameters } : profile.protocol === "responses" ? { type: "function", ...fields, parameters, strict: false } : { type: "function", function: { ...fields, parameters } };
    });
    const maxSteps = Math.min(Math.max(options.maxSteps ?? 8, 1), 16);
    const maxOutputTokens = Math.min(Math.max(options.maxOutputTokens ?? 4096, 1), 32768);
    for (let stepIndex = 0; stepIndex < maxSteps; stepIndex++) {
      cancelled(signal);
      const endpoint = `${profile.baseUrl}/${profile.protocol === "responses" ? "responses" : profile.protocol === "anthropic-messages" ? "messages" : "chat/completions"}`;
      const body: Json = { model: profile.model, stream: true, ...(toolSchema.length ? { tools: toolSchema } : {}) };
      if (profile.protocol === "responses") Object.assign(body, { input: history, store: false, max_output_tokens: maxOutputTokens, ...(system ? { instructions: system } : {}) });
      else if (profile.protocol === "anthropic-messages") Object.assign(body, { messages: history, max_tokens: maxOutputTokens, ...(system ? { system } : {}) });
      else Object.assign(body, { messages: [...(system ? [{ role: "system", content: system }] : []), ...history], ...(profile.provider === "openai" ? { max_completion_tokens: maxOutputTokens } : { max_tokens: maxOutputTokens }), stream_options: { include_usage: true }, ...(profile.provider === "openrouter" ? { provider: { allow_fallbacks: false, require_parameters: true } } : {}) });
      const headers: Record<string, string> = { "content-type": "application/json", accept: "text/event-stream" };
      if (profile.provider === "anthropic") { headers["x-api-key"] = options.apiKey; headers["anthropic-version"] = "2023-06-01"; }
      else headers.authorization = `Bearer ${options.apiKey}`;
      let response: Response | undefined;
      for (let attempt = 0; attempt < 3; attempt++) {
        cancelled(signal); requestCount++;
        response = await (options.fetch ?? fetch)(endpoint, { method: "POST", headers, body: JSON.stringify(body), signal, redirect: "manual" });
        if (response.ok) break;
        await response.body?.cancel().catch(() => {});
        if ((response.status === 429 || response.status >= 500) && attempt < 2) {
          const retryAfter = Number(response.headers.get("retry-after"));
          await pause(Number.isFinite(retryAfter) && retryAfter > 0 ? Math.min(retryAfter * 1000, 5000) : 250 * 2 ** attempt, signal);
          continue;
        }
        throw httpError(response.status);
      }
      if (!response) failure("network", "The API did not respond.");
      const reader = readStep(response, profile.protocol, signal);
      let step: Step;
      try { while (true) { const next = await reader.next(); if (next.done) { step = next.value; break; } yield next.value; } }
      finally { await reader.return(undefined as never); }
      usageAvailable &&= step.usage.usageAvailable;
      for (const key of ["inputTokens", "outputTokens", "cacheReadTokens", "cacheWriteTokens"] as const) { const amount = step.usage[key]; if (amount !== undefined) totals[key] = (totals[key] ?? 0) + amount; }
      if (!step.calls.length) {
        yield { type: "usage", usage: { ...totals, requestCount, usageAvailable } };
        yield { type: "completed", model: profile.model, ...(step.responseId === undefined ? {} : { responseId: step.responseId }) };
        return;
      }
      if (!profile.capabilities.tools) failure("unsupported", "The model requested a tool but tool support is disabled for this connection.");
      // Validate the entire batch before invoking any external work.
      const batchFingerprints = new Map<string, string>();
      const batch = step.calls.map(call => {
        if (typeof call.id !== "string" || !call.id || typeof call.name !== "string") failure("protocol", "The API returned an invalid tool identity.");
        const definition = tools.find(tool => tool.name === call.name);
        if (!definition) failure("tool", "The API requested a tool that was not offered.");
        let args: unknown;
        try { args = JSON.parse(call.arguments || "{}"); } catch { failure("tool", "The API returned invalid tool argument JSON. No tool was executed for this batch."); }
        if (args === null || typeof args !== "object" || Array.isArray(args)) failure("tool", "Tool arguments must be a JSON object.");
        const fingerprint = `${call.name}:${textResult(args)}`;
        const previous = toolResults.get(call.id)?.fingerprint ?? batchFingerprints.get(call.id);
        if (previous !== undefined && previous !== fingerprint) failure("tool", "The API reused a tool call ID with different arguments. No tool was executed for this batch.");
        batchFingerprints.set(call.id, fingerprint);
        return { call, args, definition, fingerprint };
      });
      if (profile.protocol === "responses") history.push(...step.output);
      else if (profile.protocol === "anthropic-messages") history.push({ role: "assistant", content: [...(step.text ? [{ type: "text", text: step.text }] : []), ...batch.map(({ call, args }) => ({ type: "tool_use", id: call.id, name: call.name, input: args }))] });
      else history.push({ role: "assistant", content: step.text || null, tool_calls: batch.map(({ call }) => ({ id: call.id, type: "function", function: { name: call.name, arguments: call.arguments || "{}" } })) });
      for (const { call, args, definition, fingerprint } of batch) {
        cancelled(signal);
        const cached = toolResults.get(call.id);
        yield { type: "tool-call", toolCallId: call.id, toolName: call.name, args };
        // The consumer can cancel while this generator is paused at the event.
        // Check before invoking the callback, not after evaluating its Promise.
        cancelled(signal);
        if (!options.executeTool) failure("unsupported", "This execution context has no authorized tool executor.");
        let result: unknown;
        if (cached) result = cached.result;
        else {
          try { result = await awaitTool(options.executeTool(definition, args, call.id, signal), signal); }
          catch { failure("tool", "The tool execution failed. It was not retried automatically."); }
          toolResults.set(call.id, { fingerprint, result });
        }
        cancelled(signal);
        yield { type: "tool-result", toolCallId: call.id, toolName: call.name, result };
        const output = textResult(result);
        if (profile.protocol === "responses") history.push({ type: "function_call_output", call_id: call.id, output });
        else if (profile.protocol === "anthropic-messages") history.push({ role: "user", content: [{ type: "tool_result", tool_use_id: call.id, content: output }] });
        else history.push({ role: "tool", tool_call_id: call.id, content: output });
      }
    }
    failure("tool", "The tool step limit was reached. Start another turn to continue; no tool was replayed.");
  } catch (error) {
    if (requestCount) yield { type: "usage", usage: { ...totals, requestCount, usageAvailable: false } };
    throw toError(error, signal);
  } finally { clearTimeout(timer); localAbort.abort(); }
}

/** Explicit user-triggered connection test; makes a small billable model request. */
export async function validateApiProviderConnection(options: Pick<ApiProviderOptions, "profile" | "apiKey" | "signal" | "fetch">): Promise<{ ok: true; model: string; usage: ApiProviderUsage }> {
  let usage: ApiProviderUsage = { requestCount: 0, usageAvailable: false }, completed = false, text = "";
  for await (const event of streamApiProvider({ ...options, messages: [{ role: "user", content: "Reply with OK." }], maxOutputTokens: 128, maxSteps: 1, timeoutMs: 30_000 })) {
    if (event.type === "usage") usage = event.usage;
    if (event.type === "text-delta") text += event.delta;
    if (event.type === "completed") completed = true;
  }
  if (!completed || !text.trim()) failure("protocol", "The API returned no text during the connection test. Check model access and output limits.");
  return { ok: true, model: options.profile.model, usage };
}
