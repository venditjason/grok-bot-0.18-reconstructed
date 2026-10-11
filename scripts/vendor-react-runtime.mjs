import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

export const REACT_VERSION = '18.3.1';
// The official react-dom@18.3.1 production UMD reports this upstream build tag.
export const REACT_DOM_RUNTIME_VERSION = '18.3.1-next-f1338f8080-20240426';
export const LICENSE_SHA256 = '52412d7bc7ce4157ea628bbaacb8829e0a9cb3c58f57f99176126bc8cf2bfc85';
export const PACKAGES = [
  { name: 'react', file: 'react.production.min.js', integrity: 'sha512-wS+hAgJShR0KhEvPJArfuPVN1+Hz1t0Y6n5jLrGQbkb4urgPE/0Rve+1kMB1v/oWgHgm4WIcV+i7F2pTVj+2iQ==', sourceSha256: 'd949f1c3687aedadcedac85261865f29b17cd273997e7f6b2bfc53b2f9d4c4dd' },
  { name: 'react-dom', file: 'react-dom.production.min.js', integrity: 'sha512-5m4nQKp+rZRb09LNH59GM4BxTh9251/ylbKIbpe7TpGxfJ+9kv6BLkLBXIjjspbgbnIBNqlI23tRnTWT0snUIw==', sourceSha256: '35f4f974f4b2bcd44da73963347f8952e341f83909e4498227d4e26b98f66f0d' },
];
export const sha256 = value => createHash('sha256').update(value).digest('hex');
export function createBrowserRuntime(sources) {
  // Both VDS and the application must use this same React instance. Refuse a
  // partially installed or different runtime rather than silently mixing hooks.
  return `/* VenditBot: official React ${REACT_VERSION} production UMD assets. See resources/licenses/react-18.3.1-provenance.json. */\n;(function(){\nif(window.React||window.ReactDOM){if(!window.React||!window.ReactDOM||window.React.version!=="${REACT_VERSION}"||window.ReactDOM.version!=="${REACT_DOM_RUNTIME_VERSION}")throw new Error("VenditBot requires one React ${REACT_VERSION} runtime");return;}\n${sources[0]}\n;\n${sources[1]}\n})();\n`;
}

export async function vendorReactRuntime(tarballsDirectory, root = path.resolve(import.meta.dirname, '..')) {
  const sources = [];
  const packages = [];
  let license;
  for (const entry of PACKAGES) {
    const archive = path.join(tarballsDirectory, `${entry.name}-${REACT_VERSION}.tgz`);
    const bytes = await readFile(archive);
    if (`sha512-${createHash('sha512').update(bytes).digest('base64')}` !== entry.integrity) throw new Error(`Official ${entry.name} tarball integrity mismatch`);
    // Read only fixed members; never extract arbitrary archive paths.
    const source = execFileSync('/usr/bin/tar', ['-xOf', archive, `package/umd/${entry.file}`]);
    license = execFileSync('/usr/bin/tar', ['-xOf', archive, 'package/LICENSE']);
    if (sha256(source) !== entry.sourceSha256 || sha256(license) !== LICENSE_SHA256) throw new Error(`Official ${entry.name} source/license hash mismatch`);
    sources.push(source.toString('utf8'));
    packages.push({ ...entry, version: REACT_VERSION, tarball: `https://registry.npmjs.org/${entry.name}/-/${entry.name}-${REACT_VERSION}.tgz`, sourcePath: `package/umd/${entry.file}`, sourceBytes: source.length });
  }
  const bundle = createBrowserRuntime(sources);
  await writeFile(path.join(root, 'frontend/venditbot/react.js'), bundle);
  await writeFile(path.join(root, 'resources/licenses/react-18.3.1-LICENSE'), license);
  await writeFile(path.join(root, 'resources/licenses/react-18.3.1-provenance.json'), `${JSON.stringify({ version: REACT_VERSION, reportedRuntimeVersions: { react: REACT_VERSION, reactDOM: REACT_DOM_RUNTIME_VERSION }, packages, licenseSha256: LICENSE_SHA256, outputSha256: sha256(bundle), outputBytes: Buffer.byteLength(bundle), mode: 'official-production-umd', dependencyScope: 'VenditBot browser asset only; npm React dependencies unchanged', sourceDocumentation: ['https://legacy.reactjs.org/docs/cdn-links.html', 'https://legacy.reactjs.org/docs/optimizing-performance.html'], reproduction: 'node scripts/vendor-react-runtime.mjs <directory containing the two pinned official npm tarballs>' }, null, 2)}\n`);
  return { bytes: Buffer.byteLength(bundle), sha256: sha256(bundle) };
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  if (!process.argv[2]) throw new Error('Provide the directory containing verified official React 18.3.1 npm tarballs.');
  console.log(JSON.stringify(await vendorReactRuntime(path.resolve(process.argv[2]))));
}
