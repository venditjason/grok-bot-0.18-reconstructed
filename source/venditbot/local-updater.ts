import {constants, access, lstat, rm} from './updater-physical-fs.js';
import {dirname, join} from 'node:path';
import {randomUUID} from 'node:crypto';
import {spawn, type ChildProcess} from 'node:child_process';
import {absolute, backupData, bundleDigest, bundleProcessIds, canonical, copyPrivate, hashFile, inspectArchive, inside, newer, owned, parseManifest, privateDirectory, readPrivateJson, readUpdatePlan, runCommand, validateBundle, versionParts, writePrivateJson, type ByteProgressCallback, type BundleProcessProbe, type CommandRunner, type UpdateManifest, type UpdatePlan} from './updater-files.js';

export type UpdateStage = 'checking' | 'verifying-current' | 'verifying-archive' | 'copying-archive' | 'extracting' | 'verifying-package' | 'backing-up' | 'preparing-restart' | 'awaiting-quit';
export type UpdateProgress = {stage: UpdateStage; percent?: number; completedBytes?: number; totalBytes?: number; startedAt: string; updatedAt: string};
export type UpdateState = {phase: 'development' | 'idle' | 'available' | 'installing' | 'error'; currentVersion: string; version?: string; error?: string; progress?: UpdateProgress};
export type PreparedUpdate = {launch(parentPid: number): Promise<void>; cancel(): Promise<void>};
export interface LocalUpdaterOptions {
  development: boolean; currentVersion: string; channelRoot: string; userDataRoot: string; profileId: string; appPath: string; executable: string; helperPath: string;
  onChange?: (state: UpdateState) => void;
  /** Internal dependency ports for synthetic bundle tests; never renderer input. */
  command?: CommandRunner; spawnHelper?: typeof spawn; helperReadyMs?: number; parentWaitMs?: number; startupWaitMs?: number; bundleProcesses?: BundleProcessProbe;
}
const safeMessage = (error: unknown): string => error instanceof Error && /^[가-힣A-Za-z0-9 ()·./:_-]+[.!?]?$/.test(error.message) ? error.message.slice(0, 400) : '로컬 업데이트 준비에 실패했습니다. 원래 앱과 데이터는 유지됩니다.';

/** Consumes only a private local publisher channel. No download or remote code. */
export class LocalUpdater {
  private value: UpdateState;
  private busy = false;
  private progressEpoch = 0;
  constructor(private readonly options: LocalUpdaterOptions) {
    versionParts(options.currentVersion); if (typeof options.profileId !== 'string' || !/^[a-zA-Z0-9][a-zA-Z0-9_-]{0,63}$/.test(options.profileId)) throw new Error('업데이트 프로필 ID가 올바르지 않습니다.'); this.value = {phase: options.development ? 'development' : 'idle', currentVersion: options.currentVersion};
  }
  state(): UpdateState {return {...this.value, ...(this.value.progress ? {progress: {...this.value.progress}} : {})};}
  /** Called after loadFile succeeds, before the newly installed window is shown. */
  async acknowledgeStartup(): Promise<void> {
    const path = process.env.VENDITBOT_UPDATE_PLAN, id = process.env.VENDITBOT_UPDATE_ID;
    if (path == null && id == null) return;
    if (this.options.development || !path || !id) throw new Error('업데이트 시작 확인 정보가 올바르지 않습니다.');
    const plan = await readUpdatePlan(path);
    if (id !== plan.id || plan.targetApp !== this.options.appPath || plan.dataRoot !== this.options.userDataRoot || plan.profileId !== this.options.profileId || plan.version !== this.options.currentVersion || !inside(plan.targetApp, this.options.executable)) throw new Error('업데이트 시작 앱 또는 프로필이 일치하지 않습니다.');
    await canonical(plan.targetApp); await validateBundle(plan.targetApp, plan.version, this.options.command ?? runCommand);
    const requestPath = join(plan.stageRoot, 'startup-request.json'); let request: Record<string, unknown> | undefined;
    for (let attempt = 0; attempt < 40; attempt++) {
      try {request = await readPrivateJson(requestPath) as Record<string, unknown>; break;} catch (error) {if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error; await new Promise(resolve => setTimeout(resolve, 50));}
    }
    if (!request || request.schema !== 1 || request.id !== id || request.version !== plan.version || request.pid !== process.pid || request.helperPid !== process.ppid) throw new Error('업데이트 시작 프로세스가 일치하지 않습니다.');
    await writePrivateJson(join(plan.stageRoot, 'startup-ack.json'), {schema: 1, id, version: plan.version, pid: process.pid, helperPid: process.ppid});
    delete process.env.VENDITBOT_UPDATE_PLAN; delete process.env.VENDITBOT_UPDATE_ID;
  }
  private publish(value: Omit<UpdateState, 'currentVersion'>): void {
    if (!value.progress) this.progressEpoch++;
    this.value = {...value, currentVersion: this.options.currentVersion}; try {this.options.onChange?.(this.state());} catch {}
  }
  private startProgress(stage: UpdateStage, phase: UpdateState['phase'] = 'installing', version = this.value.version): ByteProgressCallback {
    const epoch = ++this.progressEpoch, startedAt = new Date().toISOString(); let lastAt = 0, lastBytes: number | undefined, lastTotal: number | undefined;
    this.publish({phase, ...(version ? {version} : {}), progress: {stage, startedAt, updatedAt: startedAt}});
    return ({completedBytes, totalBytes}) => {
      if (epoch !== this.progressEpoch || !Number.isSafeInteger(completedBytes) || !Number.isSafeInteger(totalBytes) || completedBytes < 0 || totalBytes < completedBytes) return;
      if (lastBytes === completedBytes && lastTotal === totalBytes) return;
      const now = Date.now(); if (lastBytes !== undefined && completedBytes !== totalBytes && now - lastAt < 150) return;
      lastAt = now; lastBytes = completedBytes; lastTotal = totalBytes;
      this.publish({phase, ...(version ? {version} : {}), progress: {stage, startedAt, updatedAt: new Date(now).toISOString(), completedBytes, totalBytes,
        ...(totalBytes > 0 ? {percent: Math.floor(completedBytes / totalBytes * 100)} : {})}});
    };
  }
  private async published(): Promise<UpdateManifest | undefined> {
    const root = absolute(this.options.channelRoot);
    try {await privateDirectory(root);} catch (error) {if ((error as NodeJS.ErrnoException).code === 'ENOENT') return; throw error;}
    let raw; try {raw = await readPrivateJson(join(root, 'latest.json'));} catch (error) {if ((error as NodeJS.ErrnoException).code === 'ENOENT') return; throw error;}
    const manifest = parseManifest(raw); if (!newer(manifest.version, this.options.currentVersion)) return;
    await privateDirectory(join(root, 'releases')); await privateDirectory(join(root, 'releases', manifest.version));
    const archive = join(root, manifest.archive); await canonical(archive); await owned(archive, 'file', true); return manifest;
  }
  async check(): Promise<UpdateState> {
    if (this.options.development) return this.state();
    if (this.busy || this.value.phase === 'installing') throw new Error('업데이트 작업이 진행 중입니다.');
    this.busy = true; this.startProgress('checking', this.value.phase === 'available' ? 'available' : 'idle');
    try {const manifest = await this.published(); this.publish(manifest ? {phase: 'available', version: manifest.version} : {phase: 'idle'});}
    catch (error) {this.publish({phase: 'error', error: safeMessage(error)});}
    finally {this.busy = false;} return this.state();
  }
  async prepare(): Promise<PreparedUpdate> {
    if (this.options.development) throw new Error('개발 앱은 로컬 업데이트 대상이 아닙니다.');
    if (this.busy || this.value.phase === 'installing') throw new Error('업데이트 작업이 진행 중입니다.');
    this.busy = true; let stageRoot: string | undefined;
    this.startProgress('checking');
    try {
      const manifest = await this.published(); if (!manifest) throw new Error('검증할 새 로컬 업데이트가 없습니다.');
      this.startProgress('verifying-current', 'installing', manifest.version);
      const {appPath, userDataRoot, channelRoot, helperPath, executable} = this.options;
      for (const path of [appPath, userDataRoot, channelRoot, helperPath, executable]) {absolute(path); await canonical(path);}
      if (!appPath.endsWith('.app') || !inside(appPath, executable) || [userDataRoot, channelRoot].some(path => path === appPath || inside(appPath, path) || inside(path, appPath)) || userDataRoot === channelRoot || inside(userDataRoot, channelRoot) || inside(channelRoot, userDataRoot)) throw new Error('앱과 데이터의 업데이트 경로가 안전하게 분리되어 있지 않습니다.');
      await owned(helperPath, 'file'); await owned(executable, 'file'); await privateDirectory(userDataRoot); await access(dirname(appPath), constants.W_OK);
      if ((await (this.options.bundleProcesses ?? bundleProcessIds)(appPath, 'main')).some(pid => pid !== process.pid)) throw new Error('다른 프로필의 같은 앱이 실행 중입니다. 종료한 뒤 업데이트하세요.');
      const command = this.options.command ?? runCommand; await validateBundle(appPath, this.options.currentVersion, command);
      const targetStat = await lstat(appPath), sourceArchive = join(channelRoot, manifest.archive);
      const hashing = this.startProgress('verifying-archive');
      if (await hashFile(sourceArchive, true, undefined, hashing) !== manifest.sha256) throw new Error('업데이트 압축 파일의 SHA256이 일치하지 않습니다.');
      const id = randomUUID(); stageRoot = join(dirname(appPath), '.venditbot-update-' + id); await privateDirectory(stageRoot, true);
      const archive = join(stageRoot, 'release.zip'); const copying = this.startProgress('copying-archive');
      if (await copyPrivate(sourceArchive, archive, copying) !== manifest.sha256) throw new Error('복사한 업데이트 압축 파일의 SHA256이 일치하지 않습니다.');
      this.startProgress('extracting');
      const bundleName = await inspectArchive(archive), extracted = join(stageRoot, 'extracted'); await privateDirectory(extracted, true);
      await command('/usr/bin/ditto', ['-x', '-k', archive, extracted]);
      this.startProgress('verifying-package');
      const stagedApp = join(extracted, bundleName); await validateBundle(stagedApp, manifest.version, command); const bundleSha256 = await bundleDigest(stagedApp);
      const backups = join(channelRoot, 'backups'); try {await privateDirectory(backups);} catch (error) {if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error; await privateDirectory(backups, true);}
      const dataBackup = join(backups, id); await backupData(userDataRoot, dataBackup, this.startProgress('backing-up'));
      this.startProgress('preparing-restart');
      const helper = join(stageRoot, 'updater-helper.cjs'); await copyPrivate(helperPath, helper);
      const plan: UpdatePlan = {schema: 1, id, stageRoot, targetApp: appPath, stagedApp, backupApp: appPath + `.previous-${this.options.currentVersion}-${id}`, dataRoot: userDataRoot, profileId: this.options.profileId, dataBackup, archive, archiveSha256: manifest.sha256, bundleSha256, currentVersion: this.options.currentVersion, version: manifest.version, targetDevice: targetStat.dev, targetInode: targetStat.ino, parentPid: 0, waitMs: Math.max(100, Math.min(60_000, this.options.parentWaitMs ?? 30_000)), startupWaitMs: Math.max(100, Math.min(60_000, this.options.startupWaitMs ?? 20_000)), createdAt: new Date().toISOString()};
      const planPath = join(stageRoot, 'plan.json'); await writePrivateJson(planPath, plan);
      let child: ChildProcess | undefined, cancelled = false, cancelling: Promise<void> | undefined, launched = false, ready = false;
      const stage = stageRoot;
      const cancel = (): Promise<void> => {
        if (cancelled) return Promise.resolve(); if (cancelling) return cancelling;
        cancelling = (async () => {
          if (child && child.pid != null && child.exitCode == null && child.signalCode == null) {
            await new Promise<void>((resolveExit, reject) => {
              const exited = () => {clearTimeout(timer); clearTimeout(hard); resolveExit();};
              const hard = setTimeout(() => child?.kill('SIGKILL'), 1000);
              const timer = setTimeout(() => {clearTimeout(hard); child!.off('exit', exited); reject(new Error('업데이트 도우미 종료를 확인하지 못했습니다.'));}, 4000);
              child!.once('exit', exited); child!.send?.({type: 'CANCEL'}, () => {}); child!.kill('SIGTERM');
            });
          }
          await rm(stage, {recursive: true, force: true}); cancelled = true; this.publish({phase: 'available', version: manifest.version});
        })().finally(() => {cancelling = undefined;});
        return cancelling;
      };
      return {cancel, launch: async parentPid => {
        if (cancelled || cancelling || launched || parentPid !== process.pid) throw new Error('업데이트 도우미 실행 상태가 올바르지 않습니다.');
        launched = true; plan.parentPid = parentPid; await writePrivateJson(planPath, plan);
        try {
          child = (this.options.spawnHelper ?? spawn)(executable, [helper, planPath], {cwd: stage, detached: true, stdio: ['ignore', 'ignore', 'ignore', 'ipc'], env: {PATH: '/usr/bin:/bin:/usr/sbin:/sbin', HOME: process.env.HOME ?? '', LANG: 'en_US.UTF-8', ELECTRON_RUN_AS_NODE: '1', VENDITBOT_UPDATE_HELPER: '1'}});
          await new Promise<void>((resolveReady, reject) => {
            const timer = setTimeout(() => finish(new Error('업데이트 도우미 준비 시간이 초과되었습니다.')), this.options.helperReadyMs ?? 30_000);
            const message = (value: unknown) => {if (value && typeof value === 'object' && (value as {type?: string}).type === 'READY') {ready = true; finish();} else if (value && typeof value === 'object' && (value as {type?: string}).type === 'ERROR') finish(new Error('업데이트 도우미 검증에 실패했습니다.'));};
            const exit = () => finish(new Error('업데이트 도우미가 준비 전에 종료되었습니다.'));
            const finish = (error?: Error) => {clearTimeout(timer); child!.off('message', message); child!.off('exit', exit); child!.off('error', exit); error ? reject(error) : resolveReady();};
            child!.on('message', message); child!.once('exit', exit); child!.once('error', exit);
          });
          if (cancelled || !ready) throw new Error('업데이트가 취소되었습니다.'); child.unref(); child.channel?.unref();
          this.startProgress('awaiting-quit');
        } catch (error) {await cancel(); this.publish({phase: 'error', version: manifest.version, error: safeMessage(error)}); throw error;}
      }};
    } catch (error) {
      if (stageRoot) await rm(stageRoot, {recursive: true, force: true}); this.publish({phase: 'error', error: safeMessage(error)}); throw error;
    } finally {this.busy = false;}
  }
}
