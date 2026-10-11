import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';
import {execFile} from 'node:child_process';
import {createRequire} from 'node:module';
import {chmod, mkdir, mkdtemp, readFile, realpath, rm, writeFile} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import path from 'node:path';
import test from 'node:test';
import {createPackage} from '@electron/asar';
import {build} from 'esbuild';

const require = createRequire(import.meta.url);
const compiled = await build({stdin: {contents: "export {hashFile,bundleDigest,backupData} from './source/venditbot/updater-files.ts'; export {lstat} from './source/venditbot/updater-physical-fs.ts';", resolveDir: process.cwd()}, bundle: true, platform: 'node', format: 'cjs', write: false});

async function fixture(t) {
  const root = await realpath(await mkdtemp(path.join(tmpdir(), 'venditbot-physical-fs-'))); await chmod(root, 0o700);
  t.after(() => rm(root, {recursive: true, force: true}));
  const source = path.join(root, 'source'), bundle = path.join(root, 'synthetic.app'), resources = path.join(bundle, 'Contents/Resources'), archive = path.join(resources, 'app.asar'), data = path.join(root, 'data');
  await mkdir(source, {mode: 0o700}); await mkdir(resources, {recursive: true, mode: 0o700}); await mkdir(data, {mode: 0o700});
  await writeFile(path.join(source, 'main.js'), 'module.exports = "synthetic archive";', {mode: 0o600});
  await createPackage(source, archive); await chmod(archive, 0o600);
  const archiveBytes = await readFile(archive), digest = createHash('sha256').update(archiveBytes).digest('hex');
  await writeFile(path.join(data, 'evidence.asar'), archiveBytes, {mode: 0o600});
  const runtime = path.join(root, 'updater.cjs'); await writeFile(runtime, compiled.outputFiles[0].text, {mode: 0o600});
  return {root, bundle, archive, data, digest, runtime, updater: require(runtime)};
}

test('plain Node updater hashes and backs up ASAR as physical archive bytes', async t => {
  const f = await fixture(t); assert.equal(await f.updater.hashFile(f.archive), f.digest); assert.equal((await f.updater.lstat(f.archive)).isFile(), true);
  const backup = path.join(f.root, 'backup'); await f.updater.backupData(f.data, backup);
  const manifest = JSON.parse(await readFile(path.join(backup, '.venditbot-backup.json')));
  assert.deepEqual(manifest.files.map(item => item.path), ['evidence.asar']); assert.equal(manifest.files[0].sha256, f.digest);
});

test('packaged Electron Node mode uses original-fs without changing global ASAR behavior', {skip: process.env.VENDITBOT_ELECTRON_FS_QA !== '1'}, async t => {
  const f = await fixture(t), expectedBundleDigest = await f.updater.bundleDigest(f.bundle);
  const harness = path.join(f.root, 'probe.cjs');
  await writeFile(harness, `const assert=require('node:assert/strict');const fs=require('node:fs/promises');const updater=require(${JSON.stringify(f.runtime)});(async()=>{const noAsar=process.noAsar;const archive=${JSON.stringify(f.archive)};assert.equal((await fs.lstat(archive)).isDirectory(),true);assert.equal((await updater.lstat(archive)).isFile(),true);assert.equal(await updater.hashFile(archive),${JSON.stringify(f.digest)});assert.equal(await updater.bundleDigest(${JSON.stringify(f.bundle)}),${JSON.stringify(expectedBundleDigest)});const backup=${JSON.stringify(path.join(f.root, 'electron-backup'))};await updater.backupData(${JSON.stringify(f.data)},backup);const m=JSON.parse(await fs.readFile(require('node:path').join(backup,'.venditbot-backup.json'),'utf8'));assert.deepEqual(m.files.map(x=>x.path),['evidence.asar']);assert.equal(m.files[0].sha256,${JSON.stringify(f.digest)});assert.equal(process.noAsar,noAsar);assert.equal((await fs.lstat(archive)).isDirectory(),true);console.log(JSON.stringify({electron:process.versions.electron,virtualAsarPreserved:true,archiveHashMatches:true,bundleDigestMatches:true,opaqueBackup:true}));})().catch(e=>{console.error(e.message);process.exitCode=1;});`, {mode: 0o600});
  const output = await new Promise((resolve, reject) => execFile(require('electron'), [harness], {timeout: 15000, maxBuffer: 65536, encoding: 'utf8', env: {PATH: '/usr/bin:/bin', HOME: process.env.HOME ?? '', LANG: 'en_US.UTF-8', ELECTRON_RUN_AS_NODE: '1'}}, (error, stdout, stderr) => error ? reject(new Error(`Electron physical fs probe failed: ${stderr}`)) : resolve(stdout.trim())));
  const result = JSON.parse(output); assert.equal(result.archiveHashMatches, true); assert.equal(result.bundleDigestMatches, true); assert.equal(result.virtualAsarPreserved, true); assert.equal(result.opaqueBackup, true);
});
