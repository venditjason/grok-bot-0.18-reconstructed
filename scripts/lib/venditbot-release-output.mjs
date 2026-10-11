import {constants} from 'node:fs';
import {copyFile, mkdir, rmdir} from 'node:fs/promises';

/** Production outputs are claimed exclusively, including concurrent packaging. */
export async function claimReleaseOutput(verifiedArchive, appOutput, archiveOutput) {
  await mkdir(appOutput, {recursive: false});
  try {await copyFile(verifiedArchive, archiveOutput, constants.COPYFILE_EXCL);}
  catch (error) {await rmdir(appOutput).catch(() => {}); throw error;}
}
