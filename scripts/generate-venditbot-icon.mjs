// Rebuild original local artwork only. Does not build, package or sign the application.
import { mkdir } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';

if (process.platform !== 'darwin') throw new Error('Icon generation requires macOS AppKit and iconutil. The committed SVG is portable.');
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const workspace = path.join(root, 'work', 'venditbot-icon');
const iconset = path.join(workspace, 'VenditBot.iconset');
const moduleCache = path.join(workspace, 'swift-module-cache');
await mkdir(moduleCache, { recursive: true });
function run(executable, args) {
  const result = spawnSync(executable, args, { cwd: root, stdio: 'inherit' });
  if (result.error) throw result.error;
  if (result.status !== 0) throw new Error(`${path.basename(executable)} failed (${result.status ?? result.signal}).`);
}
run('/usr/bin/swift', ['-module-cache-path', moduleCache, path.join(root, 'scripts', 'generate-venditbot-icon.swift'), iconset]);
run('/usr/bin/iconutil', ['-c', 'icns', '-o', path.join(root, 'resources', 'venditbot.icns'), iconset]);
console.log('Generated resources/venditbot.icns (16–1024 px, original VenditBot V artwork).');
