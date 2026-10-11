import { transform } from 'esbuild';

// No property mangling: IPC payload keys and vendor exports are public contracts.
export const productionBuildOptions = Object.freeze({ minify: true, treeShaking: true, legalComments: 'inline' });

export async function minifyVendorAsset(source, filename) {
  const loader = filename.endsWith('.css') ? 'css' : 'js';
  // Deliberately omit format/globalName: VDS is a classic script and its global
  // binding must remain visible to the following application module.
  return (await transform(source, { ...productionBuildOptions, loader, target: 'chrome140', sourcefile: filename })).code;
}
