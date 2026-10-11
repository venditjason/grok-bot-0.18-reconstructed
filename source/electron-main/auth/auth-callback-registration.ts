import { PRODUCT_IDENTITY } from "../../shared/product-identity.js";

export const SAND_AUTH_REDIRECT_TARGET = PRODUCT_IDENTITY.scheme;
export const SAND_AUTH_PROTOCOL_SCHEME = PRODUCT_IDENTITY.scheme;

export interface AuthProtocolApp {
  setAsDefaultProtocolClient?(protocol: string, path?: string, args?: readonly string[]): boolean;
}
export interface AuthCallbackRegistration {
  readonly redirectTarget: string;
  readonly protocolScheme: string;
  readonly registered: boolean;
  readonly skipped: boolean;
}

// A parent shell or old Grok configuration must never cause VenditBot to claim sand/grokbot.
export function resolveAuthRedirectTarget(_env: NodeJS.ProcessEnv = process.env): string { return PRODUCT_IDENTITY.scheme; }
export function resolveAuthProtocolScheme(_env: NodeJS.ProcessEnv = process.env): string { return PRODUCT_IDENTITY.scheme; }
export function registerAuthCallbackProtocol(options: {
  readonly app: AuthProtocolApp;
  readonly isPackaged: boolean;
  readonly isLabBuild: boolean;
  readonly env?: NodeJS.ProcessEnv;
}): AuthCallbackRegistration {
  const identity = { redirectTarget: PRODUCT_IDENTITY.scheme, protocolScheme: PRODUCT_IDENTITY.scheme };
  if (!options.isPackaged || options.isLabBuild || options.app.setAsDefaultProtocolClient == null) return { ...identity, registered: false, skipped: true };
  return { ...identity, registered: options.app.setAsDefaultProtocolClient(PRODUCT_IDENTITY.scheme), skipped: false };
}
