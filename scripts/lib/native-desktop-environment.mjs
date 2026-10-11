import path from 'node:path';
import {homedir} from 'node:os';
import {PRODUCT_IDENTITY} from '../../source/shared/product-identity.ts';

/** AppKit registration is denied by the Codex seatbelt execution sandbox. */
export function assertNativeDesktopEnvironment(env = process.env) {
  if (process.platform === 'darwin' && env.CODEX_SANDBOX === 'seatbelt') {
    throw new Error('macOS native GUI verification needs an approved unsandboxed desktop launch. Do not run Electron inside the Codex execution sandbox: AppKit will abort before the app starts. Use the packaged development app with a separate QA data directory.');
  }
}
export function assertDevelopmentDataRoot(env = process.env, home = homedir()) {
  const configured = env.VENDITBOT_USER_DATA_DIR?.trim(); if (!configured) return;
  if (!path.isAbsolute(configured)) throw new Error('Development QA data directory must be absolute.');
  const root = path.resolve(home, 'Library', 'Application Support', PRODUCT_IDENTITY.englishName).normalize('NFC').toLowerCase();
  const selected = path.resolve(configured).normalize('NFC').toLowerCase();
  if (selected === root || selected.startsWith(root + path.sep)) throw new Error('Development launch cannot inherit the production data directory. Choose a separate QA directory.');
}
