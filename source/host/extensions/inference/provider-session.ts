import { join } from "node:path";
import { BasePromptBuilder, BasePromptExecutor } from "../../../packages/chat-inference/base.js";
import type { SandInferenceProvider } from "../../../shared/inference-router.js";
import { isApiProvider, type ApiProviderProfile } from "../../../shared/api-provider-config.js";
import { runClaudeTurn, runCodexTurn, type CodexTurnEvent, type ProviderMessage, type ProviderUsage } from "../../../shared/node/provider-auth-runtime.js";
import { getSandRootDir } from "../../host-paths.js";
import { SandSettingsStore } from "../../../shared/node/settings/sand-settings-store.js";
import { createApiProviderExecutor } from "./api-provider-session.js";
import type { PromptExecutor } from "./sand-labeling.js";

type Loose = Record<string, any>;
type RoutedProvider = Exclude<SandInferenceProvider, "cursor">;
type RoutedToolExecutor = (tool: Loose, args: unknown, toolCallId: string) => Promise<unknown>;
export interface RoutedProviderOptions {
  readonly model?: string;
  readonly effort?: string;
  readonly systemInstructions?: string;
  readonly mcpServerUrl?: string;
  readonly tools?: readonly Loose[];
  readonly executeTool?: RoutedToolExecutor;
  readonly onTextDelta?: (delta: string, accumulated: string) => void;
  readonly signal?: AbortSignal;
  readonly sessionId?: string;
  readonly apiProfile?: ApiProviderProfile;
  /** Supplied by main's secure credential store only; never ambient environment. */
  readonly apiKey?: string;
}
function recordRoutedUsage(provider: RoutedProvider, usage: ProviderUsage): void {
  new SandSettingsStore(join(getSandRootDir(), "settings.json")).recordInferenceUsage(provider, usage);
}
function response(text: string, id: string, modelId: string) {
  return { id, modelId, timestamp: new Date(), headers: {}, messages: [{ role: "assistant", content: [{ type: "text", text }] }] };
}
function officialExecutor(provider: "codex" | "claude-code", messages: readonly ProviderMessage[], invocationId: string, options: RoutedProviderOptions, onUsage?: (usage: ProviderUsage) => void) {
  const usage = Promise.withResolvers<{ promptTokens: number; completionTokens: number; totalTokens: number }>();
  const extendedUsage = Promise.withResolvers<ProviderUsage & { maxTokens: number }>();
  const resultResponse = Promise.withResolvers<ReturnType<typeof response>>();
  const metadata = Promise.withResolvers<Record<string, unknown>>();
  for (const value of [usage, extendedUsage, resultResponse, metadata]) void value.promise.catch(() => {});
  const fullStream = (async function* () {
    let done = false;
    try {
      const common = { messages, ...(options.model ? { model: options.model } : {}), ...(options.effort ? { effort: options.effort } : {}), ...(options.systemInstructions ? { systemInstructions: options.systemInstructions } : {}), ...(options.signal ? { signal: options.signal } : {}) };
      const stream: AsyncGenerator<CodexTurnEvent> = provider === "codex"
        ? runCodexTurn({ ...common, ...(options.tools ? { tools: options.tools } : {}), ...(options.executeTool ? { executeTool: options.executeTool } : {}) })
        : runClaudeTurn({ ...common, ...(options.sessionId ? { sessionId: options.sessionId } : {}) });
      for await (const event of stream) {
        if (event.type === "text-delta") { yield { type: "text-delta" as const, textDelta: event.delta }; continue; }
        done = true;
        const input = event.usage.inputTokens ?? 0, output = event.usage.outputTokens ?? 0;
        usage.resolve({ promptTokens: input, completionTokens: output, totalTokens: input + output });
        extendedUsage.resolve({ ...event.usage, maxTokens: 0 });
        metadata.resolve({ [provider]: { threadId: event.threadId, turnId: event.turnId, officialRuntime: true, usageAvailable: event.usage.inputTokens != null } });
        resultResponse.resolve(response(event.text, invocationId, options.model ?? provider));
        onUsage?.(event.usage);
      }
    } catch (error) { usage.reject(error); extendedUsage.reject(error); metadata.reject(error); resultResponse.reject(error); throw error; }
    finally {
      if (!done) { const error = new Error("Provider stream was interrupted before completion."); usage.reject(error); extendedUsage.reject(error); metadata.reject(error); resultResponse.reject(error); }
    }
  })();
  return { fullStream, response: resultResponse.promise, usage: usage.promise, extendedUsage: extendedUsage.promise, providerMetadata: metadata.promise, invocationId: Promise.resolve(invocationId) };
}
function executor(provider: RoutedProvider, messages: readonly ProviderMessage[], invocationId: string, options: RoutedProviderOptions) {
  const onUsage = (usage: ProviderUsage) => recordRoutedUsage(provider, usage);
  if (provider === "codex" || provider === "claude-code") return officialExecutor(provider, messages, invocationId, options, onUsage);
  if (!isApiProvider(provider) || options.apiProfile?.provider !== provider || !options.apiKey) throw new Error("Open a VenditBot API connection in the desktop app. Its selected profile and secure API key are required for this request.");
  return createApiProviderExecutor({ profile: options.apiProfile, apiKey: options.apiKey, messages, invocationId, onUsage, ...(options.tools ? { tools: options.tools } : {}), ...(options.executeTool ? { executeTool: options.executeTool } : {}), ...(options.signal ? { signal: options.signal } : {}) });
}
class ProviderPromptExecutor extends BasePromptExecutor<ProviderMessage> {
  constructor(readonly provider: RoutedProvider, initialMessages?: readonly ProviderMessage[]) { super(new BasePromptBuilder(initialMessages)); }
  stream(_ctx: unknown, invocationId = crypto.randomUUID(), definitions?: readonly Loose[]) {
    return executor(this.provider, this.getMessages(), invocationId, definitions ? { tools: definitions } : {});
  }
}
export function createProviderPromptSession(provider: RoutedProvider): { getModelId(): string; getExecutor(state?: unknown): PromptExecutor } {
  return { getModelId: () => provider, getExecutor: state => new ProviderPromptExecutor(provider, Array.isArray(state) ? state as ProviderMessage[] : undefined) };
}
export async function runRoutedProviderText(provider: RoutedProvider, messages: readonly ProviderMessage[], options: RoutedProviderOptions = {}): Promise<string> {
  const result = executor(provider, messages, crypto.randomUUID(), options);
  let text = "";
  for await (const event of result.fullStream) if (event.type === "text-delta") { text += event.textDelta; options.onTextDelta?.(event.textDelta, text); }
  await result.response; return text;
}
