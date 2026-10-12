import { build } from 'esbuild';
import { cp, mkdir, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { minifyVendorAsset, productionBuildOptions } from './lib/venditbot-build-options.mjs';
import {readRendererText,rendererInputPlugin,validateRendererAssets} from './lib/venditbot-renderer-assets.mjs';
const root = path.resolve(import.meta.dirname, '..');
const {version} = JSON.parse(await readFile(path.join(root, 'package.json'), 'utf8'));
if (typeof version !== 'string' || !/^\d+\.\d+\.\d+$/.test(version)) throw new Error('VenditBot requires a numeric three-part package version.');
const output = path.join(root, '.build', 'venditbot-app');
await rm(output, { recursive: true, force: true });
await mkdir(path.join(output, 'renderer'), { recursive: true });
const mainBuild = await build({ ...productionBuildOptions, entryPoints: [path.join(root, 'source/venditbot/main.ts')], outfile: path.join(output, 'main.cjs'), bundle: true, platform: 'node', format: 'cjs', target: 'node22', external: ['electron'], sourcemap: false, metafile: true });
await build({ ...productionBuildOptions, entryPoints: [path.join(root, 'source/venditbot/preload.ts')], outfile: path.join(output, 'preload.cjs'), bundle: true, platform: 'node', format: 'cjs', target: 'node22', external: ['electron'] });
await build({ ...productionBuildOptions, entryPoints: [path.join(root, 'source/venditbot/updater-helper.ts')], outfile: path.join(output, 'updater-helper.cjs'), bundle: true, platform: 'node', format: 'cjs', target: 'node22' });
await build({ ...productionBuildOptions, entryPoints: [path.join(root, 'frontend/venditbot/app.tsx')], outfile: path.join(output, 'renderer/app.js'), bundle: true, platform: 'browser', format: 'esm', target: 'chrome140', jsx: 'transform', jsxFactory: 'React.createElement', jsxFragment: 'React.Fragment', plugins:[rendererInputPlugin(path.join(root,'frontend/venditbot'))] });
for (const file of await readdir(path.join(root, 'frontend/venditbot'))) {
  const source = path.join(root, 'frontend/venditbot', file), destination = path.join(output, 'renderer', file);
  if (file === 'vds.js' || file.endsWith('.css')) await writeFile(destination, await minifyVendorAsset(await readRendererText(source), file));
  else if (['index.html', 'react.js'].includes(file)) await writeFile(destination, await readRendererText(source));
  else if (file === '_vendor') await cp(source, destination, { recursive: true });
}
await validateRendererAssets(path.join(output,'renderer'));
await cp(path.join(root, 'node_modules/@openai/codex-darwin-arm64/vendor/aarch64-apple-darwin'), path.join(output, 'runtimes/codex'), { recursive: true });
await mkdir(path.join(output, 'runtimes/claude'), { recursive: true });
await cp(path.join(root, 'node_modules/@anthropic-ai/claude-code-darwin-arm64/claude'), path.join(output, 'runtimes/claude/claude'));
await cp(path.join(root, 'node_modules/@anthropic-ai/claude-code-darwin-arm64/LICENSE.md'), path.join(output, 'runtimes/claude/LICENSE.md'));
await writeFile(path.join(output, 'package.json'), JSON.stringify({ name: 'venditbot', productName: '벤디트봇', version, main: 'main.cjs', private: true }, null, 2));
await writeFile(path.join(root, '.build', 'venditbot-bundle-inputs.json'), JSON.stringify(Object.keys(mainBuild.metafile.inputs), null, 2));
console.log(`VenditBot desktop built: ${output}`);
