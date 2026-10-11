import assert from 'node:assert/strict';
import test from 'node:test';
import { chmod, mkdtemp, readFile, rm, stat, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { compareVersions, fileSha256, publishLocalRelease } from '../scripts/lib/local-release-channel.mjs';
import { assertNativeDesktopEnvironment, assertDevelopmentDataRoot } from '../scripts/lib/native-desktop-environment.mjs';
import {claimReleaseOutput} from '../scripts/lib/venditbot-release-output.mjs';

async function fixture(t) {
  const root = await mkdtemp(path.join(tmpdir(), 'venditbot-release-test-')); t.after(() => rm(root, {recursive: true, force: true}));
  const archivePath = path.join(root, 'archive.zip'), verificationPath = path.join(root, 'verification.json'), qaReportPath = path.join(root, 'qa.json'), channelRoot = path.join(root, 'channel');
  await writeFile(archivePath, 'test archive bytes, not a runnable application');
  const sha256 = await fileSha256(archivePath);
  const verification = {version: '0.2.0', bundleId: 'com.vendit.venditbot', architecture: 'arm64', archiveSignatureVerified: true, archiveSha256: sha256};
  const qa = {schema: 1, version: '0.2.0', archiveSha256: sha256, status: 'passed', automated: {passed: 123, failed: 0}, native: {status: 'passed'}, update: {status: 'passed'}};
  await writeFile(verificationPath, JSON.stringify(verification)); await writeFile(qaReportPath, JSON.stringify(qa));
  return {root, archivePath, verificationPath, qaReportPath, channelRoot, verification, qa};
}
test('local channel publishes exact accepted bytes privately and is idempotent', async t => {
  const f = await fixture(t), published = await publishLocalRelease(f);
  assert.equal(published.version, '0.2.0'); assert.equal(published.sha256, await fileSha256(f.archivePath));
  const manifest = path.join(f.channelRoot, 'latest.json'), archive = path.join(f.channelRoot, published.archive);
  assert.equal((await stat(manifest)).mode & 0o777, 0o600); assert.equal((await stat(archive)).mode & 0o777, 0o600);
  assert.equal(await fileSha256(archive), published.sha256);
  assert.equal((await publishLocalRelease(f)).sha256, published.sha256);
});
test('failed or mismatched QA and modified archives cannot appear as an update', async t => {
  const f = await fixture(t);
  for (const mutate of [q => {q.status = 'pending';}, q => {q.automated.failed = 1;}, q => {q.native.status = 'pending';}, q => {q.update.status = 'pending';}, q => {q.archiveSha256 = '0'.repeat(64);}]) {
    const qa = structuredClone(f.qa); mutate(qa); await writeFile(f.qaReportPath, JSON.stringify(qa)); await assert.rejects(publishLocalRelease(f), /QA/);
  }
  await writeFile(f.qaReportPath, JSON.stringify(f.qa)); await writeFile(f.archivePath, 'changed');
  await assert.rejects(publishLocalRelease(f), /verified production/);
});
test('release channel rejects symlinks, public directories and downgrade without replacing latest', async t => {
  const f = await fixture(t), first = await publishLocalRelease(f), latest = await readFile(path.join(f.channelRoot, 'latest.json'));
  f.verification.version = f.qa.version = '0.1.0'; await writeFile(f.verificationPath, JSON.stringify(f.verification)); await writeFile(f.qaReportPath, JSON.stringify(f.qa));
  await assert.rejects(publishLocalRelease(f), /downgrade/); assert.deepEqual(await readFile(path.join(f.channelRoot, 'latest.json')), latest);
  const link = path.join(f.root, 'linked-channel'); await symlink(f.channelRoot, link); await assert.rejects(publishLocalRelease({...f, channelRoot: link}), /symlink/);
  await chmod(f.channelRoot, 0o755); await assert.rejects(publishLocalRelease(f), /private/); await chmod(f.channelRoot, 0o700);
  assert.equal(first.version, '0.2.0');
});
test('version comparison is numeric and native GUI guard stops sandbox AppKit crashes', () => {
  assert.equal(compareVersions('0.10.0', '0.2.0'), 1); assert.equal(compareVersions('1.0.0', '1.0.0'), 0);
  for (const bad of ['01.2.0', '../0.2.0', '1.2', '1.2.3-alpha', '9999999999999999999.0.0']) assert.throws(() => compareVersions(bad, '0.2.0'));
  if (process.platform === 'darwin') assert.throws(() => assertNativeDesktopEnvironment({CODEX_SANDBOX: 'seatbelt'}), /AppKit/);
  assert.doesNotThrow(() => assertNativeDesktopEnvironment({CODEX_SANDBOX_NETWORK_DISABLED: '1'}));
  for (const directory of ['/Users/qa/Library/Application Support/VenditBot', '/Users/qa/Library/Application Support/VenditBot/profiles/default', '/Users/qa/Library/Application Support/venditbot', '/Users/qa/Library/Application Support/VenditBot/else/..']) assert.throws(() => assertDevelopmentDataRoot({VENDITBOT_USER_DATA_DIR: directory}, '/Users/qa'), /production/);
  assert.doesNotThrow(() => assertDevelopmentDataRoot({VENDITBOT_USER_DATA_DIR: '/private/tmp/venditbot-qa'}, '/Users/qa'));
});
test('concurrent packagers claim production output once without replacing an existing app or ZIP', async t => {
  const f = await fixture(t), app = path.join(f.root, 'new.app'), archive = path.join(f.root, 'release.zip');
  const results = await Promise.allSettled([claimReleaseOutput(f.archivePath, app, archive), claimReleaseOutput(f.archivePath, app, archive)]);
  assert.equal(results.filter(result => result.status === 'fulfilled').length, 1);
  await writeFile(path.join(app, 'existing-work-canary'), 'keep');
  await assert.rejects(claimReleaseOutput(f.archivePath, app, archive));
  assert.equal(await readFile(path.join(app, 'existing-work-canary'), 'utf8'), 'keep');
  await writeFile(archive, 'keep this already published ZIP');
  await assert.rejects(claimReleaseOutput(f.archivePath, path.join(f.root, 'another.app'), archive));
  assert.equal(await readFile(archive, 'utf8'), 'keep this already published ZIP');
});
