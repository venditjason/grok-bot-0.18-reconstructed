import * as nodeFs from 'node:fs';
import {createRequire} from 'node:module';

// An update verifies and moves archive bytes, never Electron's virtual ASAR
// contents. Electron's patched fs reports synthetic stats for those contents.
// Keep ordinary application fs/require behavior intact; do not set noAsar.
// https://www.electronjs.org/docs/latest/tutorial/asar-archives
const physicalFs: typeof nodeFs = process.versions.electron
  ? createRequire(process.execPath)('original-fs') as typeof nodeFs
  : nodeFs;

export const {constants} = physicalFs;
export const {access, lstat, mkdir, open, readdir, readlink, realpath, rename, rm, writeFile} = physicalFs.promises;
