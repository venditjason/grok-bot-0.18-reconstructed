import { createHash, randomUUID } from 'node:crypto';
import { createReadStream } from 'node:fs';
import { chmod, copyFile, lstat, mkdir, readFile, realpath, rename, rmdir, unlink, writeFile } from 'node:fs/promises';
import path from 'node:path';

const VERSION = /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/;
const HASH = /^[a-f0-9]{64}$/;
const BUNDLE_ID = 'com.vendit.venditbot';
export function compareVersions(left, right) {
  if (![left, right].every(v => typeof v === 'string' && VERSION.test(v) && v.split('.').every(n => Number.isSafeInteger(Number(n))))) throw new Error('Invalid release version.');
  for (let i = 0; i < 3; i++) { const difference = Number(left.split('.')[i]) - Number(right.split('.')[i]); if (difference) return Math.sign(difference); }
  return 0;
}
export async function fileSha256(file) {
  const hash = createHash('sha256'); for await (const chunk of createReadStream(file)) hash.update(chunk); return hash.digest('hex');
}
async function regularFile(file) {
  const entry = await lstat(file);
  if (!entry.isFile() || entry.isSymbolicLink() || entry.nlink !== 1) throw new Error('A regular non-linked release file is required.');
  return entry;
}
async function noSymlinkAncestors(directory) {
  for (let candidate = path.resolve(directory); ; candidate = path.dirname(candidate)) {
    try {
      if ((await lstat(candidate)).isSymbolicLink()) {
        const systemAlias = process.platform === 'darwin' && ['/tmp', '/var', '/etc'].includes(candidate) && await realpath(candidate) === `/private${candidate}`;
        if (!systemAlias) throw new Error('Release channel cannot have symlink ancestors.');
      }
    } catch (error) { if (error.code !== 'ENOENT') throw error; }
    if (path.dirname(candidate) === candidate) break;
  }
}
async function privateDirectory(directory) {
  await noSymlinkAncestors(directory); await mkdir(directory, {recursive: true, mode: 0o700});
  const entry = await lstat(directory);
  if (!entry.isDirectory() || entry.isSymbolicLink() || (process.getuid && entry.uid !== process.getuid()) || (entry.mode & 0o077)) throw new Error('Release directories must be private and owned by the current user.');
}
async function optionalJson(file) {
  try { await regularFile(file); return JSON.parse(await readFile(file, 'utf8')); }
  catch (error) { if (error.code === 'ENOENT') return undefined; throw error; }
}

/** Publish only the exact archive accepted by both packaging and final QA. */
export async function publishLocalRelease({archivePath, verificationPath, qaReportPath, channelRoot}) {
  archivePath = path.resolve(archivePath); channelRoot = path.resolve(channelRoot);
  await regularFile(archivePath); await regularFile(verificationPath); await regularFile(qaReportPath);
  const verification = JSON.parse(await readFile(verificationPath, 'utf8'));
  const qa = JSON.parse(await readFile(qaReportPath, 'utf8'));
  const version = verification.version; compareVersions(version, '0.0.0');
  const hash = await fileSha256(archivePath);
  if (!HASH.test(hash) || verification.bundleId !== BUNDLE_ID || verification.archiveSignatureVerified !== true || verification.architecture !== 'arm64' || verification.archiveSha256 !== hash) throw new Error('Archive does not match the verified production package.');
  if (qa.schema !== 1 || qa.version !== version || qa.archiveSha256 !== hash || qa.status !== 'passed' || qa.automated?.failed !== 0 || !(qa.automated?.passed > 0) || qa.native?.status !== 'passed' || qa.update?.status !== 'passed') throw new Error('The exact release archive needs completed automated, native, and update QA.');
  await privateDirectory(channelRoot);
  const lock = path.join(channelRoot, '.publish-lock');
  await mkdir(lock, {mode: 0o700});
  try {
    const previous = await optionalJson(path.join(channelRoot, 'latest.json'));
    if (previous && compareVersions(version, previous.version) < 0) throw new Error('Publishing an older release would downgrade the local channel.');
    const releases = path.join(channelRoot, 'releases'), release = path.join(releases, version);
    await privateDirectory(releases); await privateDirectory(release);
    const archive = `releases/${version}/VenditBot-macos-arm64.zip`, destination = path.join(channelRoot, archive);
    try {
      await regularFile(destination);
      if (await fileSha256(destination) !== hash) throw new Error('A different immutable archive already occupies this release version.');
      if ((await lstat(destination)).mode & 0o077) throw new Error('Published archive must be private.');
    } catch (error) {
      if (error.code !== 'ENOENT') throw error;
      const temporary = path.join(release, `.archive-${randomUUID()}.tmp`);
      try {
        await copyFile(archivePath, temporary, 1); await chmod(temporary, 0o600);
        if (await fileSha256(temporary) !== hash) throw new Error('Release archive changed during publication.');
        await rename(temporary, destination);
      } finally { await unlink(temporary).catch(error => { if (error.code !== 'ENOENT') throw error; }); }
    }
    const manifest = {schema: 1, version, bundleId: BUNDLE_ID, archive, sha256: hash, validatedAt: new Date().toISOString()};
    const temporary = path.join(channelRoot, `.latest-${randomUUID()}.tmp`);
    try { await writeFile(temporary, `${JSON.stringify(manifest, null, 2)}\n`, {flag: 'wx', mode: 0o600}); await rename(temporary, path.join(channelRoot, 'latest.json')); }
    finally { await unlink(temporary).catch(error => { if (error.code !== 'ENOENT') throw error; }); }
    return manifest;
  } finally { await rmdir(lock); }
}
