import {constants, lstatSync, openSync, closeSync, fstatSync, readSync, realpathSync, type Stats} from 'node:fs';
import {join, dirname, resolve} from 'node:path';
import {atomicWriteJson} from './local-store.js';
import {DEFAULT_ACTION_RULES, normalizeActionRules, type ActionRules} from '../shared/action-rules.js';

const maxBytes = 4 * 1024 * 1024;
const safeError = '작업 규칙 저장 경로가 안전하지 않거나 파일이 변경되었습니다. 원본을 보존했습니다.';
function privateEntry(stat: Stats, directory = false): void {
  if (stat.isSymbolicLink() || (directory ? !stat.isDirectory() : !stat.isFile() || stat.nlink !== 1 || stat.size > maxBytes) || (stat.mode & 0o077) !== 0 || (process.getuid && stat.uid !== process.getuid())) throw new Error(safeError);
}
function privateRoot(root: string): void {
  privateEntry(lstatSync(root), true);
  for (let path = resolve(root);;) {
    const stat = lstatSync(path);
    if (stat.isSymbolicLink() && !(process.platform === 'darwin' && ['/tmp', '/var', '/etc'].includes(path) && realpathSync(path) === `/private${path}`)) throw new Error(safeError);
    const parent = dirname(path); if (parent === path) break; path = parent;
  }
}
function readRules(file: string): ActionRules | undefined {
  let before: Stats;
  try {before = lstatSync(file);} catch (error) {if ((error as NodeJS.ErrnoException).code === 'ENOENT') return; throw error;}
  privateEntry(before);
  const fd = openSync(file, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
  try {
    const opened = fstatSync(fd); privateEntry(opened);
    if (before.dev !== opened.dev || before.ino !== opened.ino) throw new Error(safeError);
    const bytes = Buffer.alloc(Math.min(opened.size + 1, maxBytes + 1)); let length = 0;
    while (length < bytes.length) {const count = readSync(fd, bytes, length, bytes.length - length, length); if (count === 0) break; length += count;}
    const after = fstatSync(fd), current = lstatSync(file); privateEntry(after); privateEntry(current);
    if (length > maxBytes || length !== opened.size || opened.size !== after.size || opened.mtimeMs !== after.mtimeMs || opened.ctimeMs !== after.ctimeMs || current.dev !== after.dev || current.ino !== after.ino) throw new Error(safeError);
    return normalizeActionRules(JSON.parse(new TextDecoder('utf-8', {fatal: true}).decode(bytes.subarray(0, length))));
  } finally {closeSync(fd);}
}

/** No file is created for defaults. Saved changes require the exact visible
 * revision, and a failed or conflicting write never replaces a prior policy. */
export class ActionRulesStore {
  private readonly file: string;
  private current: ActionRules;
  private persisted: boolean;
  constructor(private readonly root: string) {
    privateRoot(root);
    this.file = join(root, 'action-rules.json');
    const saved = readRules(this.file); this.persisted = saved !== undefined; this.current = saved ?? normalizeActionRules(DEFAULT_ACTION_RULES);
  }
  get(): ActionRules {return structuredClone(this.current);}
  save(input: unknown, expectedUpdatedAt: string): ActionRules {
    if (expectedUpdatedAt !== this.current.updatedAt) throw new Error('작업 규칙이 변경되었습니다. 최신 규칙을 다시 불러온 뒤 저장하세요.');
    privateRoot(this.root);
    const disk = readRules(this.file);
    if ((disk !== undefined) !== this.persisted || JSON.stringify(disk ?? normalizeActionRules(DEFAULT_ACTION_RULES)) !== JSON.stringify(this.current)) {
      if (disk) {this.current = disk; this.persisted = true;}
      throw new Error('저장된 작업 규칙이 다른 곳에서 변경되었습니다. 최신 규칙을 다시 불러온 뒤 저장하세요.');
    }
    if (!input || typeof input !== 'object' || Array.isArray(input)) throw new Error('작업 규칙 형식을 확인하세요.');
    const updatedAt = new Date(Math.max(Date.now(), Date.parse(this.current.updatedAt) + 1)).toISOString();
    const next = normalizeActionRules({...input, updatedAt});
    if (Buffer.byteLength(JSON.stringify(next, null, 2)) > maxBytes) throw new Error('작업 규칙 저장 한도 4MiB를 초과했습니다. 기존 규칙은 보존했습니다.');
    atomicWriteJson(this.file, next); this.current = next; this.persisted = true; return this.get();
  }
}
