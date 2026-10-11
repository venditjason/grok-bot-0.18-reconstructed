/** Public, secret-free provider configuration shared by renderer and host. */
export const API_PROVIDERS = ["openai", "anthropic", "openrouter", "openai-compatible"] as const;
export type ApiProvider = typeof API_PROVIDERS[number];
export type ApiProtocol = "responses" | "chat-completions" | "anthropic-messages";
export interface ApiProviderProfile {
  readonly schemaVersion: 1;
  readonly id: string;
  readonly name: string;
  readonly provider: ApiProvider;
  readonly authMethod: "api-key";
  readonly model: string;
  readonly baseUrl: string;
  readonly protocol: ApiProtocol;
  readonly allowInsecureLoopback: boolean;
  readonly capabilities: { readonly tools: boolean; readonly images: boolean; readonly structuredOutput: boolean };
}
export const API_DEFAULT_BASE_URLS = { openai: "https://api.openai.com/v1", anthropic: "https://api.anthropic.com/v1", openrouter: "https://openrouter.ai/api/v1" } as const;
export function isApiProvider(value: unknown): value is ApiProvider { return typeof value === "string" && (API_PROVIDERS as readonly string[]).includes(value); }
export function apiProfileSecretKey(profile: ApiProviderProfile): string {
  const normalized = normalizeApiProviderProfile(profile);
  // Bind a credential to the destination and wire protocol as well as its
  // profile. A failed config commit cannot expose a replacement endpoint's key
  // to the old endpoint. JSON tuple + fixed-width UTF-16 hex is collision-free,
  // portable, and restricted to the encrypted store's A-Z/0-9/_ alphabet.
  const binding = JSON.stringify([normalized.provider, normalized.baseUrl, normalized.protocol, normalized.id]);
  let encoded = "";
  for (let index = 0; index < binding.length; index++) encoded += binding.charCodeAt(index).toString(16).padStart(4, "0");
  return `VENDITBOT_API_V2_${encoded.toUpperCase()}`;
}
export function normalizeApiProviderProfile(value: unknown): ApiProviderProfile {
  if (typeof value !== "object" || value === null || Array.isArray(value)) throw new Error("API profile is required.");
  const raw = value as Record<string, unknown>;
  if (raw.schemaVersion !== 1 || !isApiProvider(raw.provider) || raw.authMethod !== "api-key") throw new Error("Unsupported API profile or authentication method.");
  if (typeof raw.id !== "string" || !/^[a-z0-9][a-z0-9_-]{0,63}$/.test(raw.id)) throw new Error("API profile ID must use lowercase letters, digits, underscores or hyphens.");
  const name = typeof raw.name === "string" ? raw.name.trim() : "";
  const model = typeof raw.model === "string" ? raw.model.trim() : "";
  if (!name || name.length > 100 || /[\r\n\0]/.test(name)) throw new Error("A connection name of at most 100 characters is required.");
  if (!model || model.length > 200 || /[\s\0]/.test(model)) throw new Error("Enter the exact model ID supplied by your API provider.");
  const protocol = raw.protocol;
  if (protocol !== "responses" && protocol !== "chat-completions" && protocol !== "anthropic-messages") throw new Error("Select the API protocol explicitly.");
  if (raw.provider === "anthropic" ? protocol !== "anthropic-messages" : protocol === "anthropic-messages") throw new Error("Anthropic uses the Messages protocol.");
  if (raw.provider === "openrouter" && protocol !== "chat-completions") throw new Error("OpenRouter profiles currently use Chat Completions.");
  let url: URL;
  try { url = new URL(typeof raw.baseUrl === "string" && raw.baseUrl.trim() ? raw.baseUrl.trim() : raw.provider === "openai-compatible" ? "" : API_DEFAULT_BASE_URLS[raw.provider]); }
  catch { throw new Error("Enter a valid API Base URL."); }
  if (url.username || url.password || url.search || url.hash) throw new Error("API Base URL cannot contain credentials, query parameters or a fragment.");
  const loopback = url.hostname === "localhost" || url.hostname === "127.0.0.1" || url.hostname === "[::1]";
  const allowInsecureLoopback = raw.allowInsecureLoopback === true;
  if (url.protocol !== "https:" && !(url.protocol === "http:" && loopback && allowInsecureLoopback && raw.provider === "openai-compatible")) throw new Error("HTTPS is required; HTTP is permitted only for an explicitly enabled loopback server.");
  const baseUrl = url.href.replace(/\/+$/, "");
  if (raw.provider !== "openai-compatible" && baseUrl !== API_DEFAULT_BASE_URLS[raw.provider]) throw new Error("Official provider endpoints are fixed. Create a separate compatible API profile for another endpoint.");
  const capabilities = raw.capabilities as Record<string, unknown> | undefined;
  // A manual model ID does not establish tool/image support. Enable only by explicit configuration.
  return { schemaVersion: 1, id: raw.id, name, provider: raw.provider, authMethod: "api-key", model, baseUrl, protocol, allowInsecureLoopback, capabilities: { tools: capabilities?.tools === true, images: capabilities?.images === true, structuredOutput: false } };
}

/** Configured capability claims; actual model access is established only by a request. */
export function getApiProviderCapabilities(profile: ApiProviderProfile) {
  return { textStreaming: true, toolCalling: profile.capabilities.tools, images: profile.capabilities.images, structuredOutput: false, usage: "provider-reported" as const };
}
