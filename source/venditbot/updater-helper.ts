import {lstat, rename} from './updater-physical-fs.js';
import {join} from 'node:path';
import {spawn, type ChildProcess} from 'node:child_process';
import {setTimeout as delay} from 'node:timers/promises';
import {bundleDigest, bundleProcessIds, canonical, hashFile, owned, readPrivateJson, readUpdatePlan, runCommand, validateBundle, writePrivateJson, type BundleProcessProbe, type CommandRunner} from './updater-files.js';

export interface UpdateHelperPorts {
  command?: CommandRunner; parentAlive?: (pid: number) => boolean; actualParentPid?: number; rename?: typeof rename;
  now?: () => number; sleep?: (ms: number) => Promise<void>; ready?: () => void; cancelled?: () => boolean;
  spawnApplication?: typeof spawn; stopWaitMs?: number;
  bundleProcesses?: BundleProcessProbe;
}
function alive(pid: number): boolean {try {process.kill(pid, 0); return true;} catch (error) {return (error as NodeJS.ErrnoException).code !== 'ESRCH';}}
async function stopApplication(child: ChildProcess, timeoutMs = 4000): Promise<void> {
  if (child.pid == null || child.exitCode != null || child.signalCode != null) return;
  await new Promise<void>((resolveExit, reject) => {
    const done = () => {clearTimeout(timer); clearTimeout(hard); child.off('exit', done); resolveExit();};
    const hard = setTimeout(() => child.kill('SIGKILL'), Math.min(1000, timeoutMs / 2));
    const timer = setTimeout(() => {clearTimeout(hard); child.off('exit', done); reject(new Error('새 앱의 종료를 확인하지 못했습니다.'));}, timeoutMs);
    child.once('exit', done); child.kill('SIGTERM');
  });
}
/** Parent must exit normally after READY; no bundle rename is allowed earlier. */
export async function runPreparedUpdate(planPath: string, ports: UpdateHelperPorts = {}): Promise<void> {
  const plan = await readUpdatePlan(planPath), command = ports.command ?? runCommand, move = ports.rename ?? rename, isAlive = ports.parentAlive ?? alive, now = ports.now ?? Date.now;
  const processes = ports.bundleProcesses ?? bundleProcessIds;
  const relaunch = () => command('/usr/bin/open', ['-n', '--env', `VENDITBOT_USER_DATA_DIR=${plan.dataRoot}`, '--env', `VENDITBOT_PROFILE_ID=${plan.profileId}`, plan.targetApp]);
  const statusPath = join(plan.stageRoot, 'status.json'); let movedOld = false, movedNew = false, application: ChildProcess | undefined;
  const status = (phase: string, error?: string) => writePrivateJson(statusPath, {schema: 1, phase, version: plan.version, updatedAt: new Date().toISOString(), ...(error ? {error} : {})});
  const drainBundle = async () => {
    const deadline = now() + 3000;
    while ((await processes(plan.targetApp, 'all')).some(pid => pid !== process.pid)) {
      if (now() >= deadline) throw new Error('앱 번들을 사용하는 프로세스가 남아 있습니다.');
      await (ports.sleep ?? delay)(100);
    }
  };
  try {
    if (plan.parentPid !== (ports.actualParentPid ?? process.ppid)) throw new Error('업데이트 부모 프로세스가 일치하지 않습니다.');
    if ((await processes(plan.targetApp, 'main')).some(pid => pid !== plan.parentPid && pid !== process.pid)) throw new Error('다른 프로필의 같은 앱이 실행 중입니다.');
    await canonical(plan.targetApp); const current = await owned(plan.targetApp, 'directory');
    if (current.dev !== plan.targetDevice || current.ino !== plan.targetInode || (await lstat(plan.stageRoot)).dev !== current.dev) throw new Error('설치 대상 앱이 변경되었습니다.');
    try {await lstat(plan.backupApp); throw new Error('기존 앱 백업 경로가 이미 있습니다.');} catch (error) {if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;}
    if (await hashFile(plan.archive, true) !== plan.archiveSha256 || await bundleDigest(plan.stagedApp) !== plan.bundleSha256) throw new Error('업데이트 파일이 준비 후 변경되었습니다.');
    await validateBundle(plan.stagedApp, plan.version, command); await validateBundle(plan.targetApp, plan.currentVersion, command);
    await status('ready'); ports.ready?.();
    const deadline = now() + plan.waitMs;
    while (isAlive(plan.parentPid)) {
      if (ports.cancelled?.()) throw new Error('업데이트가 취소되었습니다.');
      if (now() >= deadline) throw new Error('기존 앱 종료를 기다리는 시간이 초과되었습니다.');
      await (ports.sleep ?? delay)(100);
    }
    if (ports.cancelled?.()) throw new Error('업데이트가 취소되었습니다.');
    await drainBundle();
    if (ports.cancelled?.()) throw new Error('업데이트가 취소되었습니다.');
    // Recheck after the wait; READY is not permission to swap changing files.
    const previous = await owned(plan.targetApp, 'directory');
    if (previous.dev !== plan.targetDevice || previous.ino !== plan.targetInode || await bundleDigest(plan.stagedApp) !== plan.bundleSha256) throw new Error('업데이트 대기 중 앱이 변경되었습니다.');
    await status('installing');
    if ((await processes(plan.targetApp, 'all')).some(pid => pid !== process.pid)) throw new Error('교체 직전에 같은 앱 프로세스가 시작되어 업데이트를 중단했습니다.');
    await move(plan.targetApp, plan.backupApp); movedOld = true;
    await move(plan.stagedApp, plan.targetApp); movedNew = true;
    await validateBundle(plan.targetApp, plan.version, command);
    const executable = await command('/usr/bin/plutil', ['-extract', 'CFBundleExecutable', 'raw', '-o', '-', join(plan.targetApp, 'Contents', 'Info.plist')]);
    if (!/^[A-Za-z0-9_-]{1,100}$/.test(executable)) throw new Error('새 앱 실행 파일 이름이 올바르지 않습니다.');
    await status('awaiting-startup'); let launchFailed = false;
    application = (ports.spawnApplication ?? spawn)(join(plan.targetApp, 'Contents', 'MacOS', executable), [], {detached: true, cwd: plan.targetApp, stdio: 'ignore', env: {PATH: '/usr/bin:/bin:/usr/sbin:/sbin', HOME: process.env.HOME ?? '', LANG: 'en_US.UTF-8', VENDITBOT_USER_DATA_DIR: plan.dataRoot, VENDITBOT_PROFILE_ID: plan.profileId, VENDITBOT_UPDATE_PLAN: planPath, VENDITBOT_UPDATE_ID: plan.id}});
    application.once('error', () => {launchFailed = true;});
    if (application.pid == null) throw new Error('새 앱을 실행할 수 없습니다.');
    const expected = {schema: 1, id: plan.id, version: plan.version, pid: application.pid, helperPid: process.pid};
    await writePrivateJson(join(plan.stageRoot, 'startup-request.json'), expected);
    const startupDeadline = now() + plan.startupWaitMs;
    for (;;) {
      if (launchFailed || application.exitCode != null || application.signalCode != null) throw new Error('새 앱이 시작 확인 전에 종료되었습니다.');
      if (ports.cancelled?.() || now() >= startupDeadline) throw new Error('새 앱의 시작 확인 시간이 초과되었습니다.');
      let ack: unknown; try {ack = await readPrivateJson(join(plan.stageRoot, 'startup-ack.json'));} catch (error) {if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;}
      if (ack != null) {
        if (!ack || typeof ack !== 'object' || Object.entries(expected).some(([key, value]) => (ack as Record<string, unknown>)[key] !== value)) throw new Error('새 앱 시작 확인이 일치하지 않습니다.');
        break;
      }
      await (ports.sleep ?? delay)(100);
    }
    application.unref();
    // Acknowledged apps may already be writing data. Journal failure is never
    // permission to move a live bundle or start a second application instance.
    await status('completed').catch(() => {});
  } catch (error) {
    if (application) {
      try {await stopApplication(application, ports.stopWaitMs ?? 4000);}
      catch {await status('rollback-blocked', '새 앱이 실행 중이어서 번들을 옮기지 않았습니다. 기존 앱 백업은 보관되어 있습니다.').catch(() => {}); throw new Error('새 앱 종료를 확인하지 못해 앱 복구를 중단했습니다.');}
    }
    if (movedOld) {
      // Chromium children can outlive their main process. A different profile
      // may also start during recovery. Never rename a bundle still in use.
      try {
        await drainBundle();
        if ((await processes(plan.targetApp, 'all')).some(pid => pid !== process.pid)) throw new Error('복구 직전에 같은 앱 프로세스가 시작되었습니다.');
      } catch {
        await status('rollback-blocked', '앱 번들을 사용하는 프로세스가 있어 복구를 중단했습니다. 기존 앱 백업은 보관되어 있습니다.').catch(() => {});
        throw new Error('실행 중인 앱 프로세스 때문에 앱 복구를 중단했습니다.');
      }
      try {if (movedNew) await move(plan.targetApp, join(plan.stageRoot, 'failed-update.app')); await move(plan.backupApp, plan.targetApp);}
      catch {await status('rollback-error', '앱 복구를 완료하지 못했습니다. 기존 앱 백업은 보관되어 있습니다.').catch(() => {}); throw new Error('업데이트 앱 복구를 완료하지 못했습니다.');}
      await status('rolled-back', '업데이트에 실패해 기존 앱으로 복구했습니다.').catch(() => {}); await relaunch();
    } else await status('error', '업데이트를 중단했습니다. 기존 앱과 프로필은 변경하지 않았습니다.').catch(() => {});
    throw error;
  }
}

if (process.env.VENDITBOT_UPDATE_HELPER === '1') {
  let cancelled = false; process.on('message', message => {if (message && typeof message === 'object' && (message as {type?: string}).type === 'CANCEL') cancelled = true;});
  const path = process.argv[2];
  void (async () => {
    try {if (!path) throw new Error('업데이트 계획이 없습니다.'); await runPreparedUpdate(path, {ready: () => process.send?.({type: 'READY'}), cancelled: () => cancelled}); process.exit(0);}
    catch {if (process.send && process.connected) process.send({type: 'ERROR'}, () => process.exit(1)); else process.exit(1);}
  })();
}
