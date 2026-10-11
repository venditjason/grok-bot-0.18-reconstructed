import { streamApiProvider, ApiProviderError, type ApiProviderOptions, type ApiProviderUsage } from "./api-provider-transport.js";

/** Adapter for the reconstructed host's prompt executor return contract. */
export function createApiProviderExecutor(options: ApiProviderOptions & { invocationId: string; onUsage?: (usage: ApiProviderUsage) => void }) {
  const usage = Promise.withResolvers<{ promptTokens: number; completionTokens: number; totalTokens: number }>();
  const extendedUsage = Promise.withResolvers<ApiProviderUsage & { maxTokens: number }>();
  const response = Promise.withResolvers<{ id: string; modelId: string; timestamp: Date; headers: Record<string, string>; messages: unknown[] }>();
  const providerMetadata = Promise.withResolvers<Record<string, unknown>>();
  // Callers commonly consume only fullStream. Rejected companion promises must not become unhandled rejections.
  for (const value of [usage, extendedUsage, response, providerMetadata]) void value.promise.catch(() => {});
  const fullStream = (async function* () {
    let text = "", finished = false, accounted = false;
    const messages: Array<{ role: string; content: Array<Record<string, unknown>> }> = [];
    const assistantPart = (part: Record<string, unknown>) => { let message = messages.at(-1); if (message?.role !== "assistant") { message = { role: "assistant", content: [] }; messages.push(message); } message.content.push(part); };
    let lastUsage: ApiProviderUsage = { requestCount: 0, usageAvailable: false };
    try {
      for await (const event of streamApiProvider(options)) {
        if (event.type === "text-delta") { text += event.delta; const last = messages.at(-1); const part = last?.role === "assistant" ? last.content.at(-1) : undefined; if (part?.type === "text") part.text = `${part.text}${event.delta}`; else assistantPart({ type: "text", text: event.delta }); yield { type: "text-delta" as const, textDelta: event.delta }; }
        else if (event.type === "tool-call") { assistantPart({ type: "tool-call", toolCallId: event.toolCallId, toolName: event.toolName, args: event.args }); yield { type: "tool-call" as const, toolCallId: event.toolCallId, toolName: event.toolName, args: event.args }; }
        else if (event.type === "tool-result") { const part = { type: "tool-result", toolCallId: event.toolCallId, toolName: event.toolName, result: event.result }; const last = messages.at(-1); if (last?.role === "tool") last.content.push(part); else messages.push({ role: "tool", content: [part] }); yield { type: "tool-result" as const, toolCallId: event.toolCallId, toolName: event.toolName, result: event.result }; }
        else if (event.type === "usage") lastUsage = event.usage;
        else {
          finished = true;
          const input = lastUsage.inputTokens ?? 0, output = lastUsage.outputTokens ?? 0;
          usage.resolve({ promptTokens: input, completionTokens: output, totalTokens: input + output });
          extendedUsage.resolve({ ...lastUsage, maxTokens: options.maxOutputTokens ?? 4096 });
          response.resolve({ id: options.invocationId, modelId: options.profile.model, timestamp: new Date(), headers: {}, messages });
          providerMetadata.resolve({ api: { profileId: options.profile.id, model: event.model, responseId: event.responseId, usageAvailable: lastUsage.usageAvailable } });
          accounted = true; options.onUsage?.(lastUsage);
        }
      }
    } catch (error) { usage.reject(error); extendedUsage.reject(error); response.reject(error); providerMetadata.reject(error); throw error; }
    finally {
      if (!accounted && lastUsage.requestCount) options.onUsage?.(lastUsage);
      if (!finished) { const error = new ApiProviderError("cancelled", "The API stream was interrupted."); usage.reject(error); extendedUsage.reject(error); response.reject(error); providerMetadata.reject(error); }
    }
  })();
  return { fullStream, response: response.promise, usage: usage.promise, extendedUsage: extendedUsage.promise, providerMetadata: providerMetadata.promise, invocationId: Promise.resolve(options.invocationId) };
}
