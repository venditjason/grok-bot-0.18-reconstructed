import {spawn, type ChildProcess} from 'node:child_process';

// This child has no application/profile access. Reparenting ends its authority:
// a reused PID can never become its parent after the original parent exits.
export const QUIT_WATCHDOG_SOURCE = `
const parent = Number(process.argv[1]), wait = Number(process.argv[2]);
if (!Number.isSafeInteger(parent) || parent <= 1 || process.ppid !== parent || !Number.isInteger(wait) || wait < 100 || wait > 10000) process.exit(2);
setTimeout(() => {
  if (process.ppid === parent) { try { process.kill(parent, 'SIGKILL'); } catch {} }
  process.exit(0);
}, wait);
`;

/** Only call from will-quit, after data flush, owned-provider drain and window closure. */
export function startQuitWatchdog(options: {executable: string; parentPid: number; graceMs?: number; spawnChild?: typeof spawn; onError?: (error: Error) => void}): ChildProcess {
  if (options.parentPid !== process.pid) throw new Error('종료 확인은 현재 앱 프로세스에만 사용할 수 있습니다.');
  const grace = options.graceMs ?? 5000;
  if (!Number.isInteger(grace) || grace < 100 || grace > 10000) throw new Error('종료 확인 시간이 올바르지 않습니다.');
  const child = (options.spawnChild ?? spawn)(options.executable, ['-e', QUIT_WATCHDOG_SOURCE, String(options.parentPid), String(grace)], {
    detached: true, stdio: 'ignore', env: {PATH: '/usr/bin:/bin', ELECTRON_RUN_AS_NODE: '1'},
  });
  child.on('error', error => options.onError?.(error)); child.unref(); return child;
}
