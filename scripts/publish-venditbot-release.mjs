import path from 'node:path';
import { homedir } from 'node:os';
import { publishLocalRelease } from './lib/local-release-channel.mjs';

const args = process.argv.slice(2), values = {};
for (let index = 0; index < args.length; index += 2) {
  const name = args[index], value = args[index + 1];
  if (!['--archive', '--verification', '--qa-report', '--channel'].includes(name) || !value || value.startsWith('--') || values[name]) throw new Error('Use --archive ZIP --verification JSON --qa-report JSON [--channel DIRECTORY].');
  values[name] = path.resolve(value);
}
for (const name of ['--archive', '--verification', '--qa-report']) if (!values[name]) throw new Error(`${name} is required. Publication never bypasses QA.`);
const manifest = await publishLocalRelease({archivePath: values['--archive'], verificationPath: values['--verification'], qaReportPath: values['--qa-report'], channelRoot: values['--channel'] ?? path.join(homedir(), 'Library/Application Support/VenditBot Updates')});
console.log(`Validated VenditBot ${manifest.version} published to the local update channel. The running app and all profiles were left untouched.`);
