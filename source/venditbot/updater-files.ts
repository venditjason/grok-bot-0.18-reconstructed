import {constants, lstat, mkdir, open, readdir, readlink, realpath, rename, rm, writeFile} from './updater-physical-fs.js';
import {createHash, randomUUID} from 'node:crypto';
import {basename, dirname, isAbsolute, join, relative, resolve, sep} from 'node:path';
import {execFile} from 'node:child_process';
import {inflateRawSync} from 'node:zlib';

export const UPDATE_BUNDLE_ID = 'com.vendit.venditbot';
export type UpdateManifest = {schema: 1; version: string; bundleId: typeof UPDATE_BUNDLE_ID; archive: string; sha256: string; validatedAt: string};
export type UpdatePlan = {schema: 1; id: string; stageRoot: string; targetApp: string; stagedApp: string; backupApp: string; dataRoot: string; profileId: string; dataBackup: string; archive: string; archiveSha256: string; bundleSha256: string; currentVersion: string; version: string; targetDevice: number; targetInode: number; parentPid: number; waitMs: number; startupWaitMs: number; createdAt: string};
export type ByteProgress = {completedBytes: number; totalBytes: number};
export type ByteProgressCallback = (progress: ByteProgress) => void;
// Observation must never interrupt file verification or cleanup. No paths or contents.
function reportBytes(callback: ByteProgressCallback | undefined, completedBytes: number, totalBytes: number): void {try {callback?.({completedBytes, totalBytes});} catch {}}
export type CommandRunner = (file: string, args: readonly string[]) => Promise<string>;
export type BundleProcessProbe = (app: string, scope: 'main' | 'all') => Promise<number[]>;
const UID = process.getuid?.();
const MAX_ARCHIVE = 4 * 1024 ** 3;
export function inside(parent: string, child: string): boolean {const name = relative(parent, child); return name !== '' && !name.startsWith('..' + sep) && name !== '..' && !isAbsolute(name);}
export function absolute(path: string): string {if (typeof path !== 'string' || !isAbsolute(path) || path.includes('\0') || resolve(path) !== path || path === dirname(path)) throw new Error('업데이트 경로가 올바르지 않습니다.'); return path;}
export async function canonical(path: string): Promise<void> {absolute(path); if (await realpath(path) !== path) throw new Error('업데이트 경로에 심볼릭 링크가 있습니다.');}
export async function owned(path: string, kind: 'file' | 'directory', privateMode = false) {
  const stat = await lstat(path);
  if (stat.isSymbolicLink() || (kind === 'file' ? !stat.isFile() || stat.nlink !== 1 : !stat.isDirectory()) || (UID != null && stat.uid !== UID) || (stat.mode & (privateMode ? 0o077 : 0o022)) !== 0) throw new Error('업데이트 파일의 소유자 또는 접근 권한이 안전하지 않습니다.');
  return stat;
}
export async function privateDirectory(path: string, create = false): Promise<void> {if (create) await mkdir(path, {mode: 0o700}); await canonical(path); await owned(path, 'directory', true);}
export async function writePrivateJson(path: string, data: unknown): Promise<void> {
  const temporary = path + '.' + randomUUID() + '.tmp';
  try {await writeFile(temporary, JSON.stringify(data, null, 2), {mode: 0o600, flag: 'wx'}); await rename(temporary, path);} finally {await rm(temporary, {force: true});}
}
export async function readPrivateJson(path: string, limit = 64 * 1024): Promise<unknown> {
  await canonical(path); const stat = await owned(path, 'file', true); if (stat.size > limit) throw new Error('업데이트 정보 크기 제한을 초과했습니다.');
  const fd = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW);
  try {const current = await fd.stat(); if (current.ino !== stat.ino || current.dev !== stat.dev) throw new Error('업데이트 파일이 변경되었습니다.'); return JSON.parse(await fd.readFile('utf8'));} finally {await fd.close();}
}
export function versionParts(version: string): number[] {
  if (typeof version !== 'string' || !/^(0|[1-9]\d{0,7})\.(0|[1-9]\d{0,7})\.(0|[1-9]\d{0,7})$/.test(version)) throw new Error('숫자 세 자리 형식의 앱 버전이 필요합니다.'); return version.split('.').map(Number);
}
export function newer(version: string, current: string): boolean {const a = versionParts(version), b = versionParts(current); for (let i = 0; i < 3; i++) if (a[i] !== b[i]) return a[i]! > b[i]!; return false;}
export function parseManifest(value: unknown): UpdateManifest {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('업데이트 정보 형식이 올바르지 않습니다.');
  const m = value as Record<string, unknown>; const keys = ['schema', 'version', 'bundleId', 'archive', 'sha256', 'validatedAt'];
  if (Object.keys(m).length !== keys.length || Object.keys(m).some(key => !keys.includes(key)) || m.schema !== 1 || m.bundleId !== UPDATE_BUNDLE_ID || typeof m.version !== 'string') throw new Error('지원하지 않는 업데이트 정보입니다.');
  versionParts(m.version);
  if (m.archive !== `releases/${m.version}/VenditBot-macos-arm64.zip` || typeof m.sha256 !== 'string' || !/^[a-f0-9]{64}$/.test(m.sha256) || typeof m.validatedAt !== 'string' || !/^\d{4}-\d{2}-\d{2}T/.test(m.validatedAt) || !Number.isFinite(Date.parse(m.validatedAt))) throw new Error('업데이트 파일 위치 또는 검증 정보가 올바르지 않습니다.');
  return m as UpdateManifest;
}
export async function readUpdatePlan(path: string): Promise<UpdatePlan> {
  const raw = await readPrivateJson(path); if (!raw || typeof raw !== 'object' || Array.isArray(raw)) throw new Error('업데이트 계획이 올바르지 않습니다.');
  const plan = raw as UpdatePlan;
  if (plan.schema !== 1 || typeof plan.id !== 'string' || !/^[a-f0-9-]{36}$/.test(plan.id) || typeof plan.profileId !== 'string' || !/^[a-zA-Z0-9][a-zA-Z0-9_-]{0,63}$/.test(plan.profileId) || !Number.isSafeInteger(plan.parentPid) || plan.parentPid <= 1 || !Number.isFinite(plan.waitMs) || plan.waitMs < 100 || plan.waitMs > 60_000 || !Number.isFinite(plan.startupWaitMs) || plan.startupWaitMs < 100 || plan.startupWaitMs > 60_000 || !newer(plan.version, plan.currentVersion) || !/^[a-f0-9]{64}$/.test(plan.archiveSha256) || !/^[a-f0-9]{64}$/.test(plan.bundleSha256)) throw new Error('업데이트 계획 값이 올바르지 않습니다.');
  for (const value of [plan.stageRoot, plan.targetApp, plan.stagedApp, plan.backupApp, plan.dataRoot, plan.dataBackup, plan.archive]) absolute(value);
  if (path !== join(plan.stageRoot, 'plan.json') || basename(plan.stageRoot) !== '.venditbot-update-' + plan.id || dirname(plan.stageRoot) !== dirname(plan.targetApp) || !plan.targetApp.endsWith('.app') || !inside(join(plan.stageRoot, 'extracted'), plan.stagedApp) || !plan.stagedApp.endsWith('.app') || plan.backupApp !== plan.targetApp + `.previous-${plan.currentVersion}-${plan.id}` || plan.archive !== join(plan.stageRoot, 'release.zip') || plan.dataRoot === plan.targetApp || inside(plan.targetApp, plan.dataRoot) || inside(plan.dataRoot, plan.targetApp) || inside(plan.stageRoot, plan.dataRoot)) throw new Error('업데이트 계획의 경로가 안전하지 않습니다.');
  await privateDirectory(plan.stageRoot); await privateDirectory(plan.dataBackup); await privateDirectory(plan.dataRoot);
  const backup = await readPrivateJson(join(plan.dataBackup, '.venditbot-backup.json'), 32 * 1024 * 1024) as {schema?: number; files?: unknown[]};
  if (backup.schema !== 1 || !Array.isArray(backup.files)) throw new Error('검증된 프로필 백업이 없습니다.');
  return plan;
}
export async function hashFile(path: string, privateMode = false, max = MAX_ARCHIVE, onProgress?: ByteProgressCallback): Promise<string> {
  const before = await owned(path, 'file', privateMode); if (before.size > max) throw new Error('업데이트 파일 크기 제한을 초과했습니다.');
  const fd = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW);
  try {
    const stat = await fd.stat(); if (stat.ino !== before.ino || stat.dev !== before.dev) throw new Error('업데이트 파일이 변경되었습니다.');
    const hash = createHash('sha256'); let completed = 0; reportBytes(onProgress, 0, stat.size);
    for await (const chunk of fd.createReadStream({autoClose: false})) {hash.update(chunk); completed += (chunk as Buffer).length; if (completed < stat.size) reportBytes(onProgress, completed, stat.size);}
    const after = await fd.stat(); if (stat.size !== after.size || stat.mtimeMs !== after.mtimeMs || completed !== stat.size) throw new Error('업데이트 파일이 변경되었습니다.');
    reportBytes(onProgress, completed, stat.size); return hash.digest('hex');
  } finally {await fd.close();}
}
export async function copyPrivate(source: string, target: string, onProgress?: ByteProgressCallback): Promise<string> {
  const initial = await owned(source, 'file'), src = await open(source, constants.O_RDONLY | constants.O_NOFOLLOW);
  let dest;
  try {
    const stat = await src.stat(); if (stat.ino !== initial.ino || stat.dev !== initial.dev) throw new Error('백업 원본이 변경되었습니다.');
    dest = await open(target, 'wx', 0o600); const hash = createHash('sha256'); let position = 0; const totalBytes = stat.size * 2; reportBytes(onProgress, 0, totalBytes);
    for await (const chunk of src.createReadStream({autoClose: false})) {const bytes = chunk as Buffer; hash.update(bytes); let offset = 0; while (offset < bytes.length) {const written = await dest.write(bytes, offset, bytes.length - offset, position); if (written.bytesWritten === 0) throw new Error('백업 파일 쓰기가 진행되지 않았습니다.'); offset += written.bytesWritten; position += written.bytesWritten;} reportBytes(onProgress, position, totalBytes);}
    await dest.sync(); const after = await src.stat(); if (stat.size !== after.size || stat.mtimeMs !== after.mtimeMs || position !== stat.size) throw new Error('백업 중 원본이 변경되었습니다.');
    await dest.close(); dest = undefined; const digest = hash.digest('hex');
    if (await hashFile(target, true, 8 * 1024 ** 3, progress => {const completed = stat.size + progress.completedBytes; if (completed < totalBytes) reportBytes(onProgress, completed, totalBytes);}) !== digest) throw new Error('백업 파일의 해시 검증에 실패했습니다.');
    reportBytes(onProgress, totalBytes, totalBytes); return digest;
  } finally {await src.close(); await dest?.close();}
}
export const runCommand: CommandRunner = (file, args) => new Promise((resolveResult, reject) => {
  execFile(file, [...args], {timeout: 180_000, maxBuffer: 2 * 1024 * 1024, encoding: 'utf8', env: {PATH: '/usr/bin:/bin:/usr/sbin:/sbin', HOME: process.env.HOME ?? '', LANG: 'en_US.UTF-8'}}, (error, stdout) => error ? reject(new Error('업데이트 시스템 검증 명령에 실패했습니다.')) : resolveResult(stdout.trim()));
});
/** ps comm contains executable paths only, never user/provider argv or prompts. */
export function bundlePidsFromProcessList(output: string, app: string, scope: 'main' | 'all'): number[] {
  const prefix = app.normalize('NFC') + '/Contents/', mainPrefix = prefix + 'MacOS/';
  return output.split('\n').flatMap(line => {const match = /^\s*(\d+)\s+(.+?)\s*$/.exec(line); if (!match) return []; const executable = match[2]!.normalize('NFC'), pid = Number(match[1]); return Number.isSafeInteger(pid) && pid > 1 && (scope === 'all' ? executable.startsWith(prefix) : executable.startsWith(mainPrefix) && !executable.slice(mainPrefix.length).includes('/')) ? [pid] : [];});
}
export const bundleProcessIds: BundleProcessProbe = (app, scope) => new Promise((resolvePids, reject) => {
  const args = ['-ww', ...(UID == null ? ['-a'] : ['-U', String(UID)]), '-o', 'pid=,comm='];
  execFile('/bin/ps', args, {timeout: 5000, maxBuffer: 4 * 1024 * 1024, encoding: 'utf8', env: {PATH: '/usr/bin:/bin'}}, (error, stdout) => error ? reject(new Error('실행 중인 앱 프로세스를 확인하지 못했습니다.')) : resolvePids(bundlePidsFromProcessList(stdout, app, scope)));
});
export async function validateBundle(app: string, version: string, command = runCommand): Promise<void> {
  await canonical(app); await owned(app, 'directory'); if (!app.endsWith('.app')) throw new Error('앱 번들 경로가 아닙니다.');
  const plist = join(app, 'Contents', 'Info.plist'); await canonical(plist); await owned(plist, 'file');
  const field = (key: string) => command('/usr/bin/plutil', ['-extract', key, 'raw', '-o', '-', plist]);
  if (await field('CFBundleIdentifier') !== UPDATE_BUNDLE_ID || await field('CFBundleShortVersionString') !== version || await field('CFBundleVersion') !== version) throw new Error('업데이트 앱의 식별자 또는 버전이 일치하지 않습니다.');
  const binary = await field('CFBundleExecutable'); if (!/^[A-Za-z0-9_-]{1,100}$/.test(binary)) throw new Error('업데이트 실행 파일 이름이 올바르지 않습니다.');
  const executable = join(app, 'Contents', 'MacOS', binary); await canonical(executable); await owned(executable, 'file');
  if (await command('/usr/bin/lipo', ['-archs', executable]) !== 'arm64') throw new Error('이 업데이트는 Apple Silicon arm64 앱이 아닙니다.');
  await command('/usr/bin/codesign', ['--verify', '--deep', '--strict', app]);
}
/** Hash real files and internal bundle symlinks without following link trees. */
export async function bundleDigest(app: string): Promise<string> {
  await canonical(app); const hash = createHash('sha256'); let count = 0, bytes = 0;
  async function walk(directory: string): Promise<void> {
    for (const name of (await readdir(directory)).sort()) {
      if (++count > 100_000) throw new Error('업데이트 파일 개수 제한을 초과했습니다.');
      const file = join(directory, name), stat = await lstat(file), key = relative(app, file);
      if (stat.isSymbolicLink()) {
        if (UID != null && stat.uid !== UID) throw new Error('앱 링크 소유자가 올바르지 않습니다.');
        const target = await realpath(file); if (!inside(app, target)) throw new Error('앱 외부를 가리키는 링크입니다.'); hash.update(JSON.stringify([key, 'link', await readlink(file)]));
      } else if (stat.isDirectory()) {await owned(file, 'directory'); hash.update(JSON.stringify([key, 'directory', stat.mode & 0o777])); await walk(file);}
      else {await owned(file, 'file'); bytes += stat.size; if (bytes > 8 * 1024 ** 3) throw new Error('압축 해제 크기 제한을 초과했습니다.'); hash.update(JSON.stringify([key, stat.mode & 0o777, await hashFile(file)]));}
    }
  }
  await walk(app); return hash.digest('hex');
}
const ephemeral = new Set(['cache', 'Cache', 'Code Cache', 'GPUCache', 'DawnGraphiteCache', 'DawnWebGPUCache', 'ShaderCache', 'GrShaderCache', 'logs', 'Logs', 'Crashpad', 'Crash Reports', 'BrowserMetrics']);
const singleton = new Set(['SingletonLock', 'SingletonCookie', 'SingletonSocket', 'DevToolsActivePort']);
export async function backupData(dataRoot: string, destination: string, onProgress?: ByteProgressCallback): Promise<void> {
  await canonical(dataRoot); await owned(dataRoot, 'directory', true); await privateDirectory(destination, true);
  const files: {path: string; sha256: string; bytes: number; mode: number}[] = [], directories: string[] = []; let bytes = 0;
  const skipLock = (name: string, key: string) => singleton.has(name) && /^profiles[/\\][^/\\]+[/\\](?:renderer-state[/\\])?[^/\\]+$/.test(key);
  // Determine the real durable byte count before reporting a percentage. This
  // inventory is checked again while copying and after final source hashing.
  const measured = new Map<string, {bytes: number; mode: number; ino: number; dev: number; mtimeMs: number}>();
  const measuredDirectories: string[] = []; let measuredBytes = 0;
  async function measure(source: string): Promise<void> {
    for (const name of (await readdir(source)).sort()) {
      const file = join(source, name), stat = await lstat(file), key = relative(dataRoot, file);
      if (skipLock(name, key)) continue;
      if (stat.isSymbolicLink()) throw new Error('프로필에 심볼릭 링크가 있어 안전하게 백업할 수 없습니다.');
      if (stat.isDirectory()) {await owned(file, 'directory'); if (ephemeral.has(name)) continue; measuredDirectories.push(key); await measure(file);}
      else {
        if (key === '.venditbot-backup.json') throw new Error('프로필에 예약된 백업 파일 이름이 있습니다.');
        await owned(file, 'file'); measuredBytes += stat.size;
        if (measuredBytes > 8 * 1024 ** 3 || measured.size >= 100_000) throw new Error('프로필 백업 한도를 초과했습니다.');
        measured.set(key, {bytes: stat.size, mode: stat.mode & 0o777, ino: stat.ino, dev: stat.dev, mtimeMs: stat.mtimeMs});
      }
    }
  }
  await measure(dataRoot); const totalBytes = measuredBytes * 3; let copiedBytes = 0, verifiedBytes = 0;
  reportBytes(onProgress, 0, totalBytes);
  async function walk(source: string, target: string): Promise<void> {
    for (const name of (await readdir(source)).sort()) {
      const file = join(source, name), stat = await lstat(file), key = relative(dataRoot, file);
      // Chromium owns these live process locks; they contain no durable state.
      if (skipLock(name, key)) continue;
      if (stat.isSymbolicLink()) throw new Error('프로필에 심볼릭 링크가 있어 안전하게 백업할 수 없습니다.');
      if (stat.isDirectory()) {await owned(file, 'directory'); if (ephemeral.has(name)) continue; directories.push(key); await privateDirectory(join(target, name), true); await walk(file, join(target, name));}
      else {
        if (key === '.venditbot-backup.json') throw new Error('프로필에 예약된 백업 파일 이름이 있습니다.');
        await owned(file, 'file'); bytes += stat.size; if (bytes > 8 * 1024 ** 3 || files.length >= 100_000) throw new Error('프로필 백업 한도를 초과했습니다.');
        const expected = measured.get(key);
        if (!expected || expected.bytes !== stat.size || expected.mode !== (stat.mode & 0o777) || expected.ino !== stat.ino || expected.dev !== stat.dev || expected.mtimeMs !== stat.mtimeMs) throw new Error('프로필이 백업 중 변경되었습니다. 잠시 후 업데이트를 다시 시도하세요.');
        const sha256 = await copyPrivate(file, join(target, name), progress => reportBytes(onProgress, copiedBytes + progress.completedBytes, totalBytes));
        files.push({path: key, sha256, bytes: stat.size, mode: stat.mode & 0o777}); copiedBytes += stat.size * 2;
      }
    }
  }
  await walk(dataRoot, destination);
  if (files.length !== measured.size || bytes !== measuredBytes || JSON.stringify(directories) !== JSON.stringify(measuredDirectories)) throw new Error('프로필이 백업 중 변경되었습니다. 잠시 후 업데이트를 다시 시도하세요.');
  // The host freezes edits and flushes Chromium before this call. Re-enumerate
  // every durable source entry as well: file-local checks alone miss late writes
  // to an earlier LevelDB file or files added/deleted during the first walk.
  const verifiedFiles: typeof files = [], verifiedDirectories: string[] = [];
  async function verify(source: string): Promise<void> {
    for (const name of (await readdir(source)).sort()) {
      const file = join(source, name), stat = await lstat(file), key = relative(dataRoot, file);
      if (skipLock(name, key)) continue;
      if (stat.isSymbolicLink()) throw new Error('프로필 백업 중 링크가 추가되었습니다.');
      if (stat.isDirectory()) {await owned(file, 'directory'); if (ephemeral.has(name)) continue; verifiedDirectories.push(key); await verify(file);}
      else {
        await owned(file, 'file'); const expected = measured.get(key); if (!expected || stat.size !== expected.bytes) throw new Error('프로필이 백업 중 변경되었습니다. 잠시 후 업데이트를 다시 시도하세요.');
        const sha256 = await hashFile(file, false, 8 * 1024 ** 3, progress => {const completed = copiedBytes + verifiedBytes + progress.completedBytes; if (completed < totalBytes) reportBytes(onProgress, completed, totalBytes);});
        verifiedFiles.push({path: key, sha256, bytes: stat.size, mode: stat.mode & 0o777}); verifiedBytes += stat.size;
      }
    }
  }
  await verify(dataRoot);
  if (JSON.stringify(verifiedFiles) !== JSON.stringify(files) || JSON.stringify(verifiedDirectories) !== JSON.stringify(directories)) throw new Error('프로필이 백업 중 변경되었습니다. 잠시 후 업데이트를 다시 시도하세요.');
  await writePrivateJson(join(destination, '.venditbot-backup.json'), {schema: 1, createdAt: new Date().toISOString(), files, directories});
  reportBytes(onProgress, totalBytes, totalBytes);
}

/** Check ZIP paths before ditto sees them. ZIP64/encryption/special files fail closed. */
export async function inspectArchive(archive: string): Promise<string> {
  const stat = await owned(archive, 'file', true); if (stat.size < 22 || stat.size > MAX_ARCHIVE) throw new Error('업데이트 ZIP 크기가 올바르지 않습니다.');
  const fd = await open(archive, constants.O_RDONLY | constants.O_NOFOLLOW);
  const read = async (offset: number, length: number) => {const bytes = Buffer.alloc(length); const {bytesRead} = await fd.read(bytes, 0, length, offset); if (bytesRead !== length) throw new Error('업데이트 ZIP이 잘렸습니다.'); return bytes;};
  try {
    const tail = await read(Math.max(0, stat.size - 65557), Math.min(stat.size, 65557)); let end = tail.length - 22;
    while (end >= 0 && (tail.readUInt32LE(end) !== 0x06054b50 || end + 22 + tail.readUInt16LE(end + 20) !== tail.length)) end--;
    if (end < 0) throw new Error('업데이트 ZIP 디렉터리가 없습니다.');
    const entries = tail.readUInt16LE(end + 10), size = tail.readUInt32LE(end + 12), offset = tail.readUInt32LE(end + 16);
    if (tail.readUInt16LE(end + 4) || tail.readUInt16LE(end + 6) || entries !== tail.readUInt16LE(end + 8) || entries === 65535 || size > 32 * 1024 * 1024 || offset + size > stat.size) throw new Error('지원하지 않는 ZIP 형식입니다.');
    const central = await read(offset, size), decoder = new TextDecoder('utf-8', {fatal: true}); let position = 0, top = '', unpacked = 0; const seen = new Set<string>();
    for (let index = 0; index < entries; index++) {
      if (position + 46 > central.length || central.readUInt32LE(position) !== 0x02014b50) throw new Error('업데이트 ZIP 항목이 손상되었습니다.');
      const flags = central.readUInt16LE(position + 8), compression = central.readUInt16LE(position + 10), compressed = central.readUInt32LE(position + 20), length = central.readUInt32LE(position + 24), nameLength = central.readUInt16LE(position + 28), extraLength = central.readUInt16LE(position + 30), commentLength = central.readUInt16LE(position + 32), mode = central.readUInt32LE(position + 38) >>> 16, localOffset = central.readUInt32LE(position + 42);
      if (flags & 1 || ![0, 8].includes(compression) || position + 46 + nameLength + extraLength + commentLength > central.length || (unpacked += length) > 8 * 1024 ** 3) throw new Error('지원하지 않거나 너무 큰 ZIP 항목입니다.');
      const rawName = central.subarray(position + 46, position + 46 + nameLength), name = decoder.decode(rawName), segments = name.replace(/\/$/, '').split('/');
      if (!name || name.includes('\\') || /[\0\r\n]/.test(name) || segments.some(segment => !segment || segment === '.' || segment === '..') || !segments[0]!.endsWith('.app')) throw new Error('ZIP 파일이 앱 경로를 벗어납니다.');
      top ||= segments[0]!; if (segments[0] !== top || seen.has(name)) throw new Error('ZIP에 중복 또는 여러 앱이 포함되어 있습니다.'); seen.add(name);
      const kind = mode & 0o170000; if (![0, 0o040000, 0o100000, 0o120000].includes(kind)) throw new Error('ZIP 특수 파일은 허용하지 않습니다.');
      const local = await read(localOffset, 30); if (local.readUInt32LE(0) !== 0x04034b50 || local.readUInt16LE(26) !== nameLength || !(await read(localOffset + 30, nameLength)).equals(rawName)) throw new Error('ZIP 로컬 항목이 일치하지 않습니다.');
      const dataOffset = localOffset + 30 + nameLength + local.readUInt16LE(28); if (dataOffset + compressed > offset) throw new Error('ZIP 데이터 위치가 올바르지 않습니다.');
      if (kind === 0o120000) {
        if (length > 4096 || compressed > 8192) throw new Error('ZIP 링크 크기가 올바르지 않습니다.');
        const data = await read(dataOffset, compressed), target = decoder.decode(compression === 0 ? data : inflateRawSync(data, {maxOutputLength: 4096}));
        const virtualRoot = join('/venditbot-zip-root', top), link = join('/venditbot-zip-root', name);
        if (!target || isAbsolute(target) || target.includes('\\') || target.includes('\0') || !inside(virtualRoot, resolve(dirname(link), target))) throw new Error('ZIP 링크가 앱 외부를 가리킵니다.');
      }
      position += 46 + nameLength + extraLength + commentLength;
    }
    if (!top || position !== central.length) throw new Error('업데이트 ZIP 디렉터리가 올바르지 않습니다.'); return top;
  } finally {await fd.close();}
}
