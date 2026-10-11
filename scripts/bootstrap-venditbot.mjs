import { downloadArtifact } from '@electron/get';
import { access, mkdir, readFile, writeFile, rename, rm } from 'node:fs/promises';
import path from 'node:path';
import { promisify } from 'node:util';
import { execFile } from 'node:child_process';
const exec = promisify(execFile), root = path.resolve(import.meta.dirname, '..');
if (process.platform !== 'darwin' || process.arch !== 'arm64') throw new Error('벤디트봇은 현재 native macOS arm64 빌드를 지원합니다.');
const electron = path.join(root, 'node_modules/electron');
const {version} = JSON.parse(await readFile(path.join(electron, 'package.json'), 'utf8'));
const executable = 'Electron.app/Contents/MacOS/Electron';
const required = [executable, 'Electron.app/Contents/Frameworks/Electron Framework.framework/Versions/Current/Electron Framework', 'Electron.app/Contents/Info.plist'];
let ready = false;
try { ready = (await readFile(path.join(electron, 'dist/version'), 'utf8')).trim().replace(/^v/, '') === version; await Promise.all(required.map(file => access(path.join(electron, 'dist', file)))); } catch { ready = false; }
if (!ready) {
  const checksums = JSON.parse(await readFile(path.join(electron, 'checksums.json'), 'utf8'));
  const archive = await downloadArtifact({version, artifactName: 'electron', platform: 'darwin', arch: 'arm64', checksums, cacheRoot: path.join(root, '.cache/electron')});
  const temporary = path.join(root, '.build/electron-bootstrap'); await rm(temporary, {recursive: true, force: true}); await mkdir(temporary, {recursive: true});
  await exec('/usr/bin/ditto', ['-x', '-k', archive, temporary]);
  await Promise.all(required.map(file => access(path.join(temporary, file))));
  await rm(path.join(electron, 'dist'), {recursive: true, force: true}); await rename(temporary, path.join(electron, 'dist'));
  try { await rename(path.join(electron, 'dist/electron.d.ts'), path.join(electron, 'electron.d.ts')); } catch (error) { if (error.code !== 'ENOENT') throw error; }
}
await writeFile(path.join(electron, 'path.txt'), executable);
for (const file of ['@openai/codex-darwin-arm64/vendor/aarch64-apple-darwin/bin/codex', '@anthropic-ai/claude-code-darwin-arm64/claude']) await access(path.join(root, 'node_modules', file));
console.log(`Electron ${version} and dedicated Codex/Claude arm64 distributions are ready. No global app or credentials changed.`);
