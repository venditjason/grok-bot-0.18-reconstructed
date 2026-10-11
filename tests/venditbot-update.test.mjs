import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';
import {spawn} from 'node:child_process';
import {EventEmitter} from 'node:events';
import {existsSync, writeFileSync, unlinkSync} from 'node:fs';
import {chmod, cp, lstat, mkdir, mkdtemp, readFile, readdir, realpath, rename, rm, stat, symlink, link, writeFile} from 'node:fs/promises';
import path from 'node:path';
import {tmpdir} from 'node:os';
import test from 'node:test';
import {build} from 'esbuild';
const built = await build({stdin: {contents: "export * from './source/venditbot/local-updater.ts'; export * from './source/venditbot/updater-helper.ts'; export * from './source/venditbot/updater-files.ts';", resolveDir: process.cwd()}, bundle: true, platform: 'node', format: 'esm', write: false});
const {LocalUpdater, runPreparedUpdate, inspectArchive, parseManifest, newer, hashFile, copyPrivate, writePrivateJson, backupData, bundlePidsFromProcessList} = await import('data:text/javascript;base64,' + Buffer.from(built.outputFiles[0].text).toString('base64'));
const id = 'com.vendit.venditbot';
const digest = bytes => createHash('sha256').update(bytes).digest('hex');
async function privateDir(directory) {await mkdir(directory, {recursive: true, mode: 0o700}); await chmod(directory, 0o700);}
async function file(filename, contents, mode = 0o600) {await privateDir(path.dirname(filename)); await writeFile(filename, contents, {mode}); await chmod(filename, mode);}
function zip(entries) {
  const locals = [], central = []; let offset = 0;
  for (const entry of entries) {
    const name = Buffer.from(entry.name), data = Buffer.from(entry.data ?? 'fixture'), local = Buffer.alloc(30), header = Buffer.alloc(46);
    local.writeUInt32LE(0x04034b50); local.writeUInt16LE(20, 4); local.writeUInt16LE(0x800, 6); local.writeUInt32LE(data.length, 18); local.writeUInt32LE(data.length, 22); local.writeUInt16LE(name.length, 26);
    header.writeUInt32LE(0x02014b50); header.writeUInt16LE(3 * 256 + 20, 4); header.writeUInt16LE(20, 6); header.writeUInt16LE(0x800, 8); header.writeUInt32LE(data.length, 20); header.writeUInt32LE(data.length, 24); header.writeUInt16LE(name.length, 28); header.writeUInt32LE(((entry.mode ?? 0o100644) << 16) >>> 0, 38); header.writeUInt32LE(offset, 42);
    locals.push(local, name, data); central.push(header, name); offset += local.length + name.length + data.length;
  }
  const directory = Buffer.concat(central), end = Buffer.alloc(22); end.writeUInt32LE(0x06054b50); end.writeUInt16LE(entries.length, 8); end.writeUInt16LE(entries.length, 10); end.writeUInt32LE(directory.length, 12); end.writeUInt32LE(offset, 16);
  return Buffer.concat([...locals, directory, end]);
}
async function bundle(root, version) {
  await file(path.join(root, 'Contents/Info.plist'), JSON.stringify({CFBundleIdentifier: id, CFBundleShortVersionString: version, CFBundleVersion: version, CFBundleExecutable: 'VenditBot'}));
  await file(path.join(root, 'Contents/MacOS/VenditBot'), 'synthetic executable ' + version, 0o700);
  await file(path.join(root, 'Contents/Resources/app.bin'), 'synthetic app ' + version);
}
async function fixture(t, overrides = {}) {
  const root = await realpath(await mkdtemp(path.join(tmpdir(), 'venditbot-update-'))); await chmod(root, 0o700);
  const install = path.join(root, 'install'), appPath = path.join(install, '벤디트봇.app'), source = path.join(root, 'new', '벤디트봇.app'), userDataRoot = path.join(root, 'owned-data'), channelRoot = path.join(root, 'channel');
  await bundle(appPath, '1.0.0'); await bundle(source, '1.1.0'); await privateDir(userDataRoot);
  await file(path.join(userDataRoot, 'profiles/qa/conversations.json'), '{"syntheticConversation":true}');
  await file(path.join(userDataRoot, 'profiles/qa/providers/claude/synthetic-auth.json'), '{"syntheticOnly":true}');
  await file(path.join(userDataRoot, 'profiles/qa/cache/ignored.bin'), 'volatile'); await file(path.join(userDataRoot, 'logs/log.txt'), 'volatile');
  await symlink('synthetic-lock-owner', path.join(userDataRoot, 'profiles/qa/SingletonLock'));
  const archive = path.join(channelRoot, 'releases/1.1.0/VenditBot-macos-arm64.zip'); await file(archive, zip([{name: '벤디트봇.app/Contents/Info.plist'}]));
  const manifest = {schema: 1, version: '1.1.0', bundleId: id, archive: 'releases/1.1.0/VenditBot-macos-arm64.zip', sha256: digest(await readFile(archive)), validatedAt: '2026-10-11T00:00:00.000Z'};
  await file(path.join(channelRoot, 'latest.json'), JSON.stringify(manifest));
  const helperPath = path.join(appPath, 'Contents/Resources/updater-helper.cjs'); await file(helperPath, "process.send({type:'READY'}); setInterval(()=>{},1000); process.on('message', message=>{if(message.type==='CANCEL')process.exit(0);});");
  const commands = [], changes = []; const command = async (binary, args) => {
    commands.push({binary, args: [...args]});
    if (binary.endsWith('/plutil')) return JSON.parse(await readFile(args.at(-1), 'utf8'))[args[1]];
    if (binary.endsWith('/lipo')) return 'arm64';
    if (binary.endsWith('/ditto')) {await cp(source, path.join(args.at(-1), path.basename(source)), {recursive: true}); return '';}
    if (binary.endsWith('/codesign') || binary.endsWith('/open')) return '';
    throw new Error('unexpected OS command');
  };
  const options = {development: false, currentVersion: '1.0.0', channelRoot, userDataRoot, profileId: 'qa', appPath, executable: path.join(appPath, 'Contents/MacOS/VenditBot'), helperPath, command, bundleProcesses: async () => [], onChange: state => changes.push(state), ...overrides};
  const updater = new LocalUpdater(options); t.after(() => rm(root, {recursive: true, force: true}));
  const stage = async () => path.join(install, (await readdir(install)).find(name => name.startsWith('.venditbot-update-')));
  const readPlan = async () => {const stageRoot = await stage(); return {stageRoot, planPath: path.join(stageRoot, 'plan.json'), plan: JSON.parse(await readFile(path.join(stageRoot, 'plan.json'), 'utf8'))};};
  const prepare = async () => {const handle = await updater.prepare(); const value = await readPlan(); value.plan.parentPid = 424242; await writePrivateJson(value.planPath, value.plan); return {...value, handle};};
  return {root, install, appPath, source, userDataRoot, channelRoot, archive, manifest, updater, options, commands, changes, command, stage, readPlan, prepare};
}
function syntheticApplication() {
  return Object.assign(new EventEmitter(), {pid: 414141, exitCode: null, signalCode: null, kills: [], unreferenced: false, kill(signal) {this.kills.push(signal); this.signalCode = signal; queueMicrotask(() => this.emit('exit', null, signal)); return true;}, unref() {this.unreferenced = true;}});
}
const ports = f => ({command: f.command, parentAlive: () => false, actualParentPid: 424242, bundleProcesses: async () => [],
  spawnApplication: (binary, args, options) => {f.launch = {binary, args, options}; return f.application = syntheticApplication();},
  sleep: async () => {const {stageRoot} = await f.readPlan(); const request = path.join(stageRoot, 'startup-request.json'); if (existsSync(request)) await writePrivateJson(path.join(stageRoot, 'startup-ack.json'), JSON.parse(await readFile(request, 'utf8')));}
});
const installedVersion = async f => JSON.parse(await readFile(path.join(f.appPath, 'Contents/Info.plist'), 'utf8')).CFBundleVersion;

test('local manifest schema, numeric versions and development mode are explicit', async t => {
  assert.equal(newer('1.10.0', '1.9.9'), true); assert.equal(newer('1.0.0', '1.0.0'), false);
  for (const version of ['01.0.0', '1.0', '1.0.0-beta', '1.0.0.1', '1.0.-1']) assert.throws(() => newer(version, '0.1.0'));
  const f = await fixture(t); assert.equal((await f.updater.check()).phase, 'available');
  for (const extra of [{archive: '../bad.zip'}, {bundleId: 'com.other'}, {schema: 2}, {sha256: 'bad'}, {extra: true}, {validatedAt: 'bad'}]) assert.throws(() => parseManifest({...f.manifest, ...extra}));
  const dev = new LocalUpdater({...f.options, development: true, channelRoot: '/missing'}); assert.equal((await dev.check()).phase, 'development'); await assert.rejects(dev.prepare(), /개발/);
  await writePrivateJson(path.join(f.channelRoot, 'latest.json'), {...f.manifest, version: '1.0.0', archive: 'releases/1.0.0/VenditBot-macos-arm64.zip'}); assert.equal((await f.updater.check()).phase, 'idle');
});

test('channel/archive ownership and symlinks are rejected; bad hash never mutates the app or profile', async t => {
  const f = await fixture(t); await chmod(path.join(f.channelRoot, 'latest.json'), 0o644); assert.equal((await f.updater.check()).phase, 'error'); await chmod(path.join(f.channelRoot, 'latest.json'), 0o600);
  const bytes = await readFile(f.archive); await rm(f.archive); const elsewhere = path.join(f.root, 'external.zip'); await file(elsewhere, bytes); await symlink(elsewhere, f.archive); assert.equal((await f.updater.check()).phase, 'error');
  await rm(f.archive); await file(f.archive, Buffer.concat([bytes, Buffer.from('corruption')])); await assert.rejects(f.updater.prepare(), /SHA256/);
  assert.equal(await installedVersion(f), '1.0.0'); assert.equal(await readFile(path.join(f.userDataRoot, 'profiles/qa/conversations.json'), 'utf8'), '{"syntheticConversation":true}');
});

test('prepare creates verified private durable-data backup and staging; cancellation only removes staging', async t => {
  const f = await fixture(t), {handle, plan, stageRoot} = await f.prepare(); assert.equal(f.updater.state().phase, 'installing');
  const backup = JSON.parse(await readFile(path.join(plan.dataBackup, '.venditbot-backup.json'), 'utf8')); assert.equal(backup.files.length, 2);
  for (const entry of backup.files) {const target = path.join(plan.dataBackup, entry.path); assert.equal((await stat(target)).mode & 0o777, 0o600); assert.equal(await hashFile(target), entry.sha256); assert.deepEqual(await readFile(target), await readFile(path.join(f.userDataRoot, entry.path)));}
  assert.equal((await stat(plan.dataBackup)).mode & 0o777, 0o700); assert.ok(f.commands.some(call => call.binary.endsWith('/codesign'))); assert.ok(f.commands.every(call => !call.binary.includes('sh')));
  await handle.cancel(); await assert.rejects(lstat(stageRoot), {code: 'ENOENT'}); assert.equal(f.updater.state().phase, 'available'); assert.equal(await installedVersion(f), '1.0.0'); assert.ok(await stat(plan.dataBackup));
});

test('durable profile symlinks and hardlinks fail closed before replacement', async t => {
  for (const kind of ['symlink', 'hardlink']) {
    const f = await fixture(t), target = path.join(f.userDataRoot, 'profiles/qa/conversations.json'), other = path.join(f.root, 'outside.json'); await file(other, 'outside'); await rm(target); await (kind === 'symlink' ? symlink(other, target) : link(other, target));
    await assert.rejects(f.updater.prepare()); assert.equal(await installedVersion(f), '1.0.0'); assert.equal(await readFile(other, 'utf8'), 'outside');
  }
});

test('ZIP preflight blocks traversal, special files, external links, duplicate entries and corrupt local headers', async t => {
  const f = await fixture(t), target = path.join(f.root, 'attack.zip');
  for (const entries of [[{name: '../out'}], [{name: '/absolute.app/file'}], [{name: 'ok.app/../out'}], [{name: 'ok.app/fifo', mode: 0o010600}], [{name: 'ok.app/link', mode: 0o120777, data: '../../outside'}], [{name: 'ok.app/file'}, {name: 'ok.app/file'}]]) {await file(target, zip(entries)); await assert.rejects(inspectArchive(target));}
  await file(target, zip([{name: 'ok.app/Contents/link', mode: 0o120777, data: '../Resources'}, {name: 'ok.app/Resources/file'}])); assert.equal(await inspectArchive(target), 'ok.app');
  const corrupt = zip([{name: 'ok.app/file'}]); corrupt.writeUInt32LE(0, 0); await file(target, corrupt); await assert.rejects(inspectArchive(target));
});

test('wrong bundle identity, version, architecture and signature fail preparation', async t => {
  for (const mode of ['identity', 'version', 'architecture', 'signature']) {
    const f = await fixture(t); const updater = new LocalUpdater({...f.options, command: async (binary, args) => {
      if (binary.endsWith('/plutil') && args.at(-1).includes('extracted') && args[1] === (mode === 'identity' ? 'CFBundleIdentifier' : 'CFBundleVersion') && ['identity', 'version'].includes(mode)) return 'wrong';
      if (binary.endsWith('/lipo') && mode === 'architecture') return 'x86_64';
      if (binary.endsWith('/codesign') && mode === 'signature') throw new Error('rejected fixture signature'); return f.command(binary, args);
    }});
    await assert.rejects(updater.prepare()); assert.equal(await installedVersion(f), '1.0.0');
  }
});

test('launch waits for real child READY IPC, passes a clean Node-mode environment, and cancels while parent lives', async t => {
  const f = await fixture(t); let launch;
  const updater = new LocalUpdater({...f.options, spawnHelper: (binary, args, options) => {launch = {binary, args, options}; return spawn(process.execPath, args, options);}});
  const handle = await updater.prepare(); t.after(() => handle.cancel()); await handle.launch(process.pid);
  assert.equal(launch.binary, f.options.executable); assert.equal(launch.options.env.ELECTRON_RUN_AS_NODE, '1'); assert.equal(launch.options.env.VENDITBOT_UPDATE_HELPER, '1'); assert.equal(launch.options.detached, true);
  assert.equal(Object.keys(launch.options.env).some(key => /CODEX|CLAUDE|ANTHROPIC|OPENAI|NODE_OPTIONS/.test(key)), false); assert.equal(await installedVersion(f), '1.0.0');
  await handle.cancel(); assert.equal(updater.state().phase, 'available');
});

test('helper timeout and cancellation never rename while the parent remains alive', async t => {
  for (const cancel of [false, true]) {
    const f = await fixture(t), {planPath} = await f.prepare(); let now = 0, ready = 0, moves = 0;
    await assert.rejects(runPreparedUpdate(planPath, {...ports(f), parentAlive: () => true, ready: () => ready++, now: () => now, sleep: async () => {now += 10000;}, cancelled: () => cancel, rename: async () => {moves++;}}));
    assert.equal(ready, 1); assert.equal(moves, 0); assert.equal(await installedVersion(f), '1.0.0');
  }
});

test('helper replaces only the app after parent exit, retains old bundle and relaunches the same custom profile', async t => {
  const f = await fixture(t), {planPath, plan} = await f.prepare(); let live = true, ready = false;
  const defaults = ports(f);
  await runPreparedUpdate(planPath, {...defaults, parentAlive: () => live, ready: () => {ready = true;}, sleep: async () => {assert.equal(ready, true); if (live) {assert.equal(await installedVersion(f), '1.0.0'); live = false;} else await defaults.sleep();}});
  assert.equal(await installedVersion(f), '1.1.0'); assert.equal(JSON.parse(await readFile(path.join(plan.backupApp, 'Contents/Info.plist'))).CFBundleVersion, '1.0.0');
  assert.equal(f.launch.binary, f.options.executable); assert.deepEqual(f.launch.args, []); assert.equal(f.launch.options.env.VENDITBOT_USER_DATA_DIR, f.userDataRoot); assert.equal(f.launch.options.env.VENDITBOT_PROFILE_ID, 'qa'); assert.equal(f.launch.options.env.VENDITBOT_UPDATE_PLAN, planPath); assert.equal(f.launch.options.env.VENDITBOT_UPDATE_ID, plan.id); assert.equal(f.launch.options.env.ELECTRON_RUN_AS_NODE, undefined); assert.equal(f.application.unreferenced, true); assert.deepEqual(f.application.kills, []); assert.equal(f.commands.some(call => call.binary === '/usr/bin/open'), false);
  assert.equal(await readFile(path.join(f.userDataRoot, 'profiles/qa/providers/claude/synthetic-auth.json'), 'utf8'), '{"syntheticOnly":true}'); assert.equal(JSON.parse(await readFile(path.join(plan.stageRoot, 'status.json'))).phase, 'completed');
});

test('failed replacement, installed signature and launch roll back only the bundle', async t => {
  for (const mode of ['rename', 'signature', 'launch']) {
    const f = await fixture(t), {planPath, plan} = await f.prepare(); const defaults = ports(f);
    await assert.rejects(runPreparedUpdate(planPath, {...defaults, spawnApplication: (...args) => {if (mode === 'launch') throw new Error('fixture spawn failure'); return defaults.spawnApplication(...args);}, rename: async (source, target) => {if (mode === 'rename' && source === plan.stagedApp) throw new Error('fixture rename failure'); return rename(source, target);}, command: async (binary, args) => {
      if (mode === 'signature' && binary.endsWith('/codesign') && args.at(-1) === f.appPath && await installedVersion(f) === '1.1.0') throw new Error('fixture installed signature failure');
      return f.command(binary, args);
    }}));
    assert.equal(await installedVersion(f), '1.0.0'); assert.equal(JSON.parse(await readFile(path.join(plan.stageRoot, 'status.json'))).phase, 'rolled-back');
    const opened = f.commands.find(call => call.binary === '/usr/bin/open'); assert.deepEqual(opened.args, ['-n', '--env', `VENDITBOT_USER_DATA_DIR=${f.userDataRoot}`, '--env', 'VENDITBOT_PROFILE_ID=qa', f.appPath]); assert.equal(opened.args.includes('-F'), false);
    assert.equal(await readFile(path.join(f.userDataRoot, 'profiles/qa/conversations.json'), 'utf8'), '{"syntheticConversation":true}');
  }
});

test('helper rejects altered archive/bundle, wrong parent and unsafe plan paths before READY', async t => {
  for (const mode of ['archive', 'bundle', 'parent', 'path']) {
    const f = await fixture(t), {planPath, plan} = await f.prepare(); let ready = false;
    if (mode === 'archive') await writeFile(plan.archive, 'corrupt');
    if (mode === 'bundle') await writeFile(path.join(plan.stagedApp, 'Contents/Resources/app.bin'), 'corrupt');
    if (mode === 'path') await writePrivateJson(planPath, {...plan, targetApp: '/'});
    await assert.rejects(runPreparedUpdate(planPath, {...ports(f), ...(mode === 'parent' ? {actualParentPid: 42} : {}), ready: () => {ready = true;}}));
    assert.equal(ready, false); assert.equal(await installedVersion(f), '1.0.0');
  }
});

test('renderer-state drafts are durable, its exact Chromium locks are ephemeral, and backup rechecks the complete snapshot', async t => {
  const f = await fixture(t), renderer = path.join(f.userDataRoot, 'profiles/qa/renderer-state');
  await file(path.join(renderer, 'Local Storage/leveldb/000003.log'), 'synthetic draft'); await file(path.join(renderer, 'Code Cache/ignored'), 'cache'); await symlink('synthetic-cookie', path.join(renderer, 'SingletonCookie'));
  const {plan, handle} = await f.prepare(); assert.equal(await readFile(path.join(plan.dataBackup, 'profiles/qa/renderer-state/Local Storage/leveldb/000003.log'), 'utf8'), 'synthetic draft'); await handle.cancel();
  for (const mutation of ['edit', 'add', 'delete']) {
    const root = path.join(f.root, mutation), source = path.join(root, 'source'), destination = path.join(root, 'snapshot'); await file(path.join(source, 'a.json'), 'before'); await file(path.join(source, 'z.bin'), Buffer.alloc(32 * 1024 * 1024));
    let changed = false;
    const timer = setInterval(() => {if (changed || !existsSync(path.join(destination, 'z.bin'))) return; changed = true; if (mutation === 'delete') unlinkSync(path.join(source, 'a.json')); else writeFileSync(path.join(source, mutation === 'add' ? 'added.json' : 'a.json'), 'after', {mode: 0o600});}, 1);
    try {await assert.rejects(backupData(source, destination), /백업 중 변경/); assert.equal(changed, true); assert.equal(existsSync(path.join(destination, '.venditbot-backup.json')), false);} finally {clearInterval(timer);}
  }
});

test('a failed helper stop retains the lock and a later cancellation really retries cleanup', async t => {
  const f = await fixture(t); const child = Object.assign(new EventEmitter(), {pid: 919191, exitCode: null, signalCode: null, send(_value, callback) {callback?.();}, kill() {return false;}, unref() {}, channel: {unref() {}}});
  const updater = new LocalUpdater({...f.options, spawnHelper: () => {queueMicrotask(() => child.emit('message', {type: 'READY'})); return child;}});
  const handle = await updater.prepare(); await handle.launch(process.pid); const stage = await f.stage();
  await assert.rejects(handle.cancel(), /종료를 확인/); assert.equal(updater.state().phase, 'installing'); assert.ok(await stat(stage));
  child.exitCode = 1; await handle.cancel(); assert.equal(updater.state().phase, 'available'); await assert.rejects(stat(stage), {code: 'ENOENT'});
});

test('a diagnostic status write failure after startup ACK never moves the now-live app', async t => {
  const f = await fixture(t), {planPath, plan} = await f.prepare(); let moves = 0; const defaults = ports(f);
  await runPreparedUpdate(planPath, {...defaults, rename: async (...args) => {moves++; return rename(...args);}, sleep: async () => {
    await defaults.sleep(); const status = path.join(plan.stageRoot, 'status.json'); await rm(status); await mkdir(status);
  }});
  assert.equal(moves, 2); assert.equal(await installedVersion(f), '1.1.0'); assert.ok(await stat(plan.backupApp)); assert.deepEqual(f.application.kills, []);
});

test('startup timeout, early exit and mismatched ACK stop only the owned new app before restoring the old bundle', async t => {
  for (const mode of ['timeout', 'exit', 'ack']) {
    const f = await fixture(t), {planPath, plan} = await f.prepare(); let now = 0; const defaults = ports(f);
    await assert.rejects(runPreparedUpdate(planPath, {...defaults, now: () => now, sleep: async () => {
      now += 10000;
      if (mode === 'exit') {f.application.exitCode = 19; f.application.emit('exit', 19);}
      if (mode === 'ack') {const request = JSON.parse(await readFile(path.join(plan.stageRoot, 'startup-request.json'))); await writePrivateJson(path.join(plan.stageRoot, 'startup-ack.json'), {...request, pid: request.pid + 1});}
    }, rename: async (...args) => {if (args[0] === f.appPath && args[1].endsWith('failed-update.app')) assert.ok(f.application.exitCode != null || f.application.signalCode != null); return rename(...args);}}));
    assert.equal(await installedVersion(f), '1.0.0'); assert.equal(JSON.parse(await readFile(path.join(plan.stageRoot, 'status.json'))).phase, 'rolled-back');
    assert.deepEqual(f.application.kills, mode === 'exit' ? [] : ['SIGTERM']);
  }
});

test('a new app that cannot be stopped blocks rollback and leaves both bundles in place', async t => {
  const f = await fixture(t), {planPath, plan} = await f.prepare(); let now = 0; const child = syntheticApplication(); child.kill = signal => {child.kills.push(signal); return false;};
  await assert.rejects(runPreparedUpdate(planPath, {...ports(f), spawnApplication: () => child, now: () => now, sleep: async () => {now += 10000;}, stopWaitMs: 20}), /종료를 확인/);
  assert.equal(await installedVersion(f), '1.1.0'); assert.ok(await stat(plan.backupApp)); assert.equal(existsSync(path.join(plan.stageRoot, 'failed-update.app')), false); assert.equal(JSON.parse(await readFile(path.join(plan.stageRoot, 'status.json'))).phase, 'rollback-blocked'); assert.equal(f.commands.some(call => call.binary === '/usr/bin/open'), false);
});

test('startup ACK is bound to the private plan, version, profile, own PID and helper parent', async t => {
  const saved = [process.env.VENDITBOT_UPDATE_PLAN, process.env.VENDITBOT_UPDATE_ID];
  t.after(() => {for (const [key, value] of [['VENDITBOT_UPDATE_PLAN', saved[0]], ['VENDITBOT_UPDATE_ID', saved[1]]]) {if (value == null) delete process.env[key]; else process.env[key] = value;}});
  delete process.env.VENDITBOT_UPDATE_PLAN; delete process.env.VENDITBOT_UPDATE_ID;
  const f = await fixture(t); await f.updater.acknowledgeStartup();
  const {planPath, plan} = await f.prepare(); await rm(f.appPath, {recursive: true}); await cp(plan.stagedApp, f.appPath, {recursive: true});
  const expected = {schema: 1, id: plan.id, version: plan.version, pid: process.pid, helperPid: process.ppid};
  const updated = new LocalUpdater({...f.options, currentVersion: plan.version});
  for (const wrong of [{pid: process.pid + 1}, {helperPid: process.ppid + 1}, {id: 'wrong'}, {version: '9.9.9'}]) {
    process.env.VENDITBOT_UPDATE_PLAN = planPath; process.env.VENDITBOT_UPDATE_ID = plan.id;
    await writePrivateJson(path.join(plan.stageRoot, 'startup-request.json'), {...expected, ...wrong}); await assert.rejects(updated.acknowledgeStartup(), /일치하지/); assert.equal(existsSync(path.join(plan.stageRoot, 'startup-ack.json')), false);
  }
  await writePrivateJson(path.join(plan.stageRoot, 'startup-request.json'), expected);
  await assert.rejects(new LocalUpdater({...f.options, currentVersion: plan.version, profileId: 'other'}).acknowledgeStartup(), /프로필/);
  process.env.VENDITBOT_UPDATE_ID = 'wrong'; await assert.rejects(updated.acknowledgeStartup(), /프로필/); process.env.VENDITBOT_UPDATE_ID = plan.id;
  await updated.acknowledgeStartup(); assert.deepEqual(JSON.parse(await readFile(path.join(plan.stageRoot, 'startup-ack.json'))), expected); assert.equal(process.env.VENDITBOT_UPDATE_PLAN, undefined); assert.equal(process.env.VENDITBOT_UPDATE_ID, undefined);
});

test('bundle process matching is exact, Unicode-normalized and distinguishes main from descendants', () => {
  const app = '/private/fixture/벤디트봇.app';
  const output = [`11 ${app.normalize('NFD')}/Contents/MacOS/VenditBot`, `12 ${app}/Contents/Frameworks/Electron Helper.app/Contents/MacOS/Electron Helper`, `13 ${app}/Contents/Resources/runtimes/codex`, `14 /other/벤디트봇.app/Contents/MacOS/VenditBot`, `15 ${app}.previous/Contents/MacOS/VenditBot`, 'not process data'].join('\n');
  assert.deepEqual(bundlePidsFromProcessList(output, app, 'main'), [11]); assert.deepEqual(bundlePidsFromProcessList(output, app, 'all'), [11, 12, 13]);
});

test('other profile main processes block preparation and READY without affecting those processes', async t => {
  const f = await fixture(t); await assert.rejects(new LocalUpdater({...f.options, bundleProcesses: async () => [process.pid, 717171]}).prepare(), /다른 프로필/); assert.equal(await installedVersion(f), '1.0.0');
  const {planPath} = await f.prepare(); let ready = false, moves = 0;
  await assert.rejects(runPreparedUpdate(planPath, {...ports(f), bundleProcesses: async () => [424242, process.pid, 717171], ready: () => {ready = true;}, rename: async () => {moves++;}}), /다른 프로필/);
  assert.equal(ready, false); assert.equal(moves, 0); assert.equal(await installedVersion(f), '1.0.0');
});

test('remaining bundle processes and a process appearing just before rename block replacement', async t => {
  for (const mode of ['remaining', 'race']) {
    const f = await fixture(t), {planPath} = await f.prepare(); let calls = 0, now = 0, moves = 0;
    await assert.rejects(runPreparedUpdate(planPath, {...ports(f), bundleProcesses: async (_app, scope) => scope === 'main' ? [424242] : (++calls > (mode === 'race' ? 1 : 0) ? [727272] : []), now: () => now, sleep: async () => {now += 1000;}, rename: async () => {moves++;}}));
    assert.equal(moves, 0); assert.equal(await installedVersion(f), '1.0.0');
  }
});

test('short-lived Chromium descendants drain before a healthy replacement', async t => {
  const f = await fixture(t), {planPath} = await f.prepare(); let probes = 0, sleeps = 0; const defaults = ports(f);
  await runPreparedUpdate(planPath, {...defaults, bundleProcesses: async (_app, scope) => scope === 'main' ? [424242, process.pid] : (++probes < 3 ? [737373] : []), sleep: async () => {sleeps++; await defaults.sleep();}});
  assert.ok(sleeps >= 3); assert.equal(await installedVersion(f), '1.1.0'); assert.deepEqual(f.application.kills, []);
});

test('remaining descendants or a new profile at rollback time preserve the live bundle and previous backup', async t => {
  for (const mode of ['remaining', 'race']) {
    const f = await fixture(t), {planPath, plan} = await f.prepare(); let now = 0, rollbackProbes = 0; const defaults = ports(f);
    await assert.rejects(runPreparedUpdate(planPath, {...defaults, now: () => now, sleep: async () => {now += 1000;}, bundleProcesses: async (_app, scope) => {
      if (scope === 'main' || !f.application?.signalCode) return [];
      return ++rollbackProbes > (mode === 'race' ? 1 : 0) ? [747474] : [];
    }}), /복구를 중단/);
    assert.equal(await installedVersion(f), '1.1.0'); assert.ok(await stat(plan.backupApp)); assert.equal(existsSync(path.join(plan.stageRoot, 'failed-update.app')), false); assert.equal(JSON.parse(await readFile(path.join(plan.stageRoot, 'status.json'))).phase, 'rollback-blocked'); assert.deepEqual(f.application.kills, ['SIGTERM']);
  }
});

test('hash and verified copy report actual processed bytes without exposing paths or changing legacy return values', async t => {
  const f = await fixture(t), source = path.join(f.root, 'progress-source'), target = path.join(f.root, 'progress-copy');
  const bytes = Buffer.alloc(1024 * 1024 + 123, 0x53); await file(source, bytes);
  const hashProgress = [], copyProgress = [];
  assert.equal(await hashFile(source, true, bytes.length, progress => hashProgress.push(progress)), digest(bytes));
  assert.equal(await copyPrivate(source, target, progress => copyProgress.push(progress)), digest(bytes));
  for (const [updates, total] of [[hashProgress, bytes.length], [copyProgress, bytes.length * 2]]) {
    assert.equal(updates[0].completedBytes, 0); assert.equal(updates.at(-1).completedBytes, total);
    assert.ok(updates.length > 2); let previous = 0;
    for (const progress of updates) {assert.deepEqual(Object.keys(progress).sort(), ['completedBytes', 'totalBytes']); assert.equal(progress.totalBytes, total); assert.ok(progress.completedBytes >= previous && progress.completedBytes <= total); previous = progress.completedBytes;}
  }
  assert.deepEqual(await readFile(target), bytes); assert.equal((await stat(target)).mode & 0o777, 0o600);
  assert.equal(await hashFile(source, true, bytes.length, () => {throw new Error('observer only');}), digest(bytes));
  assert.equal(await copyPrivate(source, path.join(f.root, 'observer-copy'), () => {throw new Error('observer only');}), digest(bytes));
});

test('backup progress includes copy, backup verification and final source verification while excluding volatile files', async t => {
  const f = await fixture(t), source = path.join(f.root, 'progress-data'), destination = path.join(f.root, 'progress-backup');
  await file(path.join(source, 'profiles/qa/renderer-state/Local Storage/leveldb/0001.ldb'), Buffer.alloc(200_000, 0x41));
  await file(path.join(source, 'profiles/qa/record.json'), '{}'); await file(path.join(source, 'profiles/qa/empty'), '');
  await file(path.join(source, 'profiles/qa/cache/ignored'), Buffer.alloc(90_000)); await file(path.join(source, 'logs/ignored'), 'log');
  await symlink('ephemeral-lock', path.join(source, 'profiles/qa/renderer-state/SingletonLock'));
  const updates = []; await backupData(source, destination, progress => updates.push(progress));
  const expectedTotal = 3 * 200_002; assert.equal(updates[0].completedBytes, 0); assert.equal(updates.at(-1).completedBytes, expectedTotal);
  assert.ok(updates.every(progress => progress.totalBytes === expectedTotal));
  for (let i = 1; i < updates.length; i++) assert.ok(updates[i].completedBytes >= updates[i - 1].completedBytes);
  const manifest = JSON.parse(await readFile(path.join(destination, '.venditbot-backup.json'), 'utf8')); assert.equal(manifest.files.length, 3);
  for (const entry of manifest.files) {assert.equal(await hashFile(path.join(destination, entry.path)), entry.sha256); assert.equal(await hashFile(path.join(source, entry.path)), entry.sha256);}
  assert.equal(existsSync(path.join(destination, 'logs')), false);
});

test('source changes after backup byte inventory fail closed without a completed manifest or false final progress', async t => {
  const f = await fixture(t), source = path.join(f.root, 'mutating-progress-data'), destination = path.join(f.root, 'mutating-progress-backup');
  const item = path.join(source, 'record.json'); await file(item, '{}'); const updates = []; let changed = false;
  await assert.rejects(backupData(source, destination, progress => {updates.push(progress); if (!changed) {changed = true; writeFileSync(item, '{"changed":true}');}}), /백업 중 변경/);
  assert.equal(changed, true); assert.equal(existsSync(path.join(destination, '.venditbot-backup.json')), false);
  assert.ok(updates.every(progress => progress.completedBytes < progress.totalBytes));
});

test('update progress emits ordered stages, real per-stage byte totals, isolated snapshots and awaiting-quit only after READY', async t => {
  const f = await fixture(t); await f.updater.check();
  assert.equal(f.changes[0].progress.stage, 'checking'); assert.equal(f.updater.state().progress, undefined);
  const updater = new LocalUpdater({...f.options, spawnHelper: (binary, args, options) => spawn(process.execPath, args, options)});
  f.changes.length = 0; const handle = await updater.prepare(); t.after(() => handle.cancel());
  assert.equal(updater.state().progress.stage, 'preparing-restart'); assert.equal(updater.state().progress.percent, undefined);
  const detached = updater.state(); detached.progress.stage = 'checking'; assert.equal(updater.state().progress.stage, 'preparing-restart');
  await handle.launch(process.pid); assert.equal(updater.state().progress.stage, 'awaiting-quit');
  const expected = ['checking', 'verifying-current', 'verifying-archive', 'copying-archive', 'extracting', 'verifying-package', 'backing-up', 'preparing-restart', 'awaiting-quit'];
  const stages = f.changes.filter(change => change.progress).map(change => change.progress.stage).filter((stage, index, all) => index === 0 || stage !== all[index - 1]); assert.deepEqual(stages, expected);
  const {plan} = await f.readPlan(), backup = JSON.parse(await readFile(path.join(plan.dataBackup, '.venditbot-backup.json'), 'utf8'));
  const totals = {'verifying-archive': (await stat(f.archive)).size, 'copying-archive': 2 * (await stat(f.archive)).size, 'backing-up': 3 * backup.files.reduce((sum, entry) => sum + entry.bytes, 0)};
  for (const [stage, total] of Object.entries(totals)) {
    const updates = f.changes.filter(change => change.progress?.stage === stage).map(change => change.progress), measured = updates.filter(progress => progress.totalBytes !== undefined);
    assert.equal(measured[0].completedBytes, 0); assert.equal(measured.at(-1).completedBytes, total); assert.equal(measured.at(-1).percent, 100);
    assert.ok(updates.every(progress => progress.startedAt === updates[0].startedAt));
    for (const progress of measured) {assert.equal(progress.totalBytes, total); assert.equal(progress.percent, Math.floor(progress.completedBytes / total * 100)); assert.ok(Date.parse(progress.updatedAt) >= Date.parse(progress.startedAt));}
  }
  for (const change of f.changes) {assert.equal(change.phase, 'installing'); if (!(change.progress.stage in totals)) assert.equal(change.progress.percent, undefined); assert.equal(change.percent, undefined);}
  await handle.cancel(); assert.equal(updater.state().phase, 'available'); assert.equal(updater.state().progress, undefined);
});

test('unmeasurable OS commands publish their stage before waiting and do not invent a percentage', async t => {
  const f = await fixture(t); let reached, release; const entered = new Promise(resolve => {reached = resolve;}), gate = new Promise(resolve => {release = resolve;});
  const updater = new LocalUpdater({...f.options, command: async (binary, args) => {if (binary.endsWith('/codesign') && args.at(-1) === f.appPath) {reached(); await gate;} return f.command(binary, args);}});
  const preparing = updater.prepare(); await entered;
  assert.equal(updater.state().progress.stage, 'verifying-current'); assert.equal(updater.state().progress.percent, undefined);
  assert.equal(updater.state().progress.completedBytes, undefined); release(); const handle = await preparing; await handle.cancel();
});

test('failed verification clears progress and leaves the current app and source profile unchanged', async t => {
  const f = await fixture(t); const before = await readFile(path.join(f.userDataRoot, 'profiles/qa/conversations.json'));
  await file(f.archive, Buffer.concat([await readFile(f.archive), Buffer.from('corrupt')]));
  await assert.rejects(f.updater.prepare(), /SHA256/); assert.equal(f.updater.state().phase, 'error'); assert.equal(f.updater.state().progress, undefined);
  assert.equal(await installedVersion(f), '1.0.0'); assert.deepEqual(await readFile(path.join(f.userDataRoot, 'profiles/qa/conversations.json')), before);
});

test('byte updates are throttled per stage while initial and verified final totals are always delivered', async t => {
  const f = await fixture(t); const bytes = zip([{name: '벤디트봇.app/Contents/large-fixture', data: Buffer.alloc(8 * 1024 * 1024, 0x62)}]);
  await file(f.archive, bytes); await writePrivateJson(path.join(f.channelRoot, 'latest.json'), {...f.manifest, sha256: digest(bytes)});
  const updater = new LocalUpdater({...f.options, onChange: state => {
    f.changes.push(structuredClone(state));
    // A renderer/observer only receives a detached snapshot.
    if (state.progress) state.progress.stage = 'tampered';
  }});
  const handle = await updater.prepare();
  for (const stage of ['verifying-archive', 'copying-archive']) {
    const updates = f.changes.map(change => change.progress).filter(progress => progress?.stage === stage && progress.totalBytes !== undefined);
    assert.equal(updates[0].completedBytes, 0); assert.equal(updates.at(-1).percent, 100);
    const elapsed = Date.parse(updates.at(-1).updatedAt) - Date.parse(updates[0].updatedAt);
    assert.ok(updates.length <= 2 + Math.ceil(elapsed / 150), 'stream chunks must not each cause an IPC update');
  }
  assert.equal(updater.state().progress.stage, 'preparing-restart'); await handle.cancel();
});
