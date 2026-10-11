import path from 'node:path';
import { existsSync } from 'node:fs';
import { assertNativeDesktopEnvironment, assertDevelopmentDataRoot } from './lib/native-desktop-environment.mjs';
import { capture, run } from './lib/process.mjs';

assertNativeDesktopEnvironment();
assertDevelopmentDataRoot();
const bundle = path.resolve(import.meta.dirname, '../dist/벤디트봇 개발.app');
if (!existsSync(bundle)) throw new Error('Build the isolated development bundle first with npm run package:dev.');
const identity = await capture('/usr/bin/plutil', ['-extract', 'CFBundleIdentifier', 'raw', '-o', '-', path.join(bundle, 'Contents/Info.plist')]);
if (identity !== 'com.vendit.venditbot.development') throw new Error('Refusing to launch a production bundle for development.');
await run(path.join(bundle, 'Contents/MacOS/VenditBot Development'), [], {env: {...process.env, VENDITBOT_DEVELOPMENT: '1'}});
