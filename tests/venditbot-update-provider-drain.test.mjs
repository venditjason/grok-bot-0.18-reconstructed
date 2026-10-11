import assert from 'node:assert/strict';
import {mkdtemp, readFile, realpath, rm, writeFile} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import path from 'node:path';
import test from 'node:test';
import {build} from 'esbuild';
const compiled = await build({stdin: {contents: "export {ProviderAuthRuntime} from './source/shared/node/provider-auth-runtime.ts'; export {CodexAppServer} from './source/shared/node/codex-app-server.ts'; export {resolveVenditBotPaths} from './source/shared/node/venditbot-paths.ts';", resolveDir: process.cwd()}, bundle: true, platform: 'node', format: 'esm', write: false});
const {ProviderAuthRuntime, CodexAppServer, resolveVenditBotPaths} = await import('data:text/javascript;base64,' + Buffer.from(compiled.outputFiles[0].text).toString('base64'));
async function fixture(t, mode = 'codex') {
  const root = await realpath(await mkdtemp(path.join(tmpdir(), 'venditbot-update-drain-'))), paths = resolveVenditBotPaths({homeDir: root, env: {}}), marker = path.join(root, 'child-flushed'), script = path.join(root, 'child.mjs'); let server;
  await writeFile(script, `#!${process.execPath}\nimport {createInterface} from 'node:readline';import {writeFileSync} from 'node:fs';setInterval(()=>{},1000);process.on('SIGTERM',()=>{${mode === 'ignore' ? '' : `setTimeout(()=>{writeFileSync(${JSON.stringify(marker)},'synthetic flush complete');process.exit(0);},180);`}});createInterface({input:process.stdin}).on('line',line=>{const m=JSON.parse(line);if(m.type==='control_request')console.log(JSON.stringify({type:'control_response',response:{subtype:'success',request_id:m.request_id,response:{models:[]}}}));else if(m.id)${mode === 'pending' ? 'setTimeout(()=>{' : ''}console.log(JSON.stringify({id:m.id,result:m.method==='account/read'?{account:null}:{}}))${mode === 'pending' ? '},180)' : ''};});`, {mode: 0o700});
  const runtime = new ProviderAuthRuntime({paths, codexExecutable: process.execPath, claudeExecutable: script, claudeLoginPolicy: {mode: 'personal-local'}, createCodexServer: options => (server = new CodexAppServer({...options, executable: process.execPath, args: [script]}))});
  t.after(async () => {await runtime.shutdownForUpdate().catch(() => runtime.shutdown()); await rm(root, {recursive: true, force: true});});
  return {runtime, marker, server: () => server};
}
test('update shutdown awaits a retired Codex process final flush without logout', async t => {
  const f = await fixture(t); await f.runtime.status('codex'); f.server().close(); await f.runtime.shutdownForUpdate(); assert.equal(await readFile(f.marker, 'utf8'), 'synthetic flush complete');
});
test('update shutdown also drains Claude catalog subprocesses that resolved before actual exit', async t => {
  const f = await fixture(t, 'claude'); await f.runtime.listModels('claude-code'); await f.runtime.shutdownForUpdate(); assert.equal(await readFile(f.marker, 'utf8'), 'synthetic flush complete');
});
test('update shutdown refuses pending provider work and can drain it after completion', async t => {
  const f = await fixture(t, 'pending'), pending = f.runtime.status('codex'); await assert.rejects(f.runtime.shutdownForUpdate(), /진행 중/); await pending; await f.runtime.shutdownForUpdate(); assert.equal(await readFile(f.marker, 'utf8'), 'synthetic flush complete');
});
test('an owned Codex process ignoring graceful stop is killed before update preparation proceeds', async t => {
  const f = await fixture(t, 'ignore'); await f.runtime.status('codex'); const started = Date.now(); await f.runtime.shutdownForUpdate(); assert.ok(Date.now() - started >= 900); await assert.rejects(readFile(f.marker), {code: 'ENOENT'});
});
