import { createHash } from 'node:crypto';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import vm from 'node:vm';
import { performance } from 'node:perf_hooks';
import { transform } from 'esbuild';
import { minifyVendorAsset, productionBuildOptions } from './lib/venditbot-build-options.mjs';
import { assertNativeDesktopEnvironment } from './lib/native-desktop-environment.mjs';

assertNativeDesktopEnvironment();

// A frozen, pre-change app bundle isolates asset/build changes from concurrent
// UI work. This launches a hidden, credential-free fixture, never the live app.
const root = path.resolve(import.meta.dirname, '..');
const directory = path.resolve(process.argv[2] ?? path.join(root, '../performance-vendor'));
const repetitions = Number(process.env.VENDITBOT_BENCH_REPETITIONS ?? 6);
if (!Number.isInteger(repetitions) || repetitions < 2 || repetitions > 20) throw new Error('Benchmark repetitions must be 2–20.');
const read = name => readFile(path.join(directory, name), 'utf8');
const source = {
  'react.js': await read('react-development-original.js'), 'vds.js': await read('vds-source.js'),
  'app.js': await read('app-baseline.js'), 'main.cjs': await read('main-baseline.cjs'),
  'preload.cjs': await read('preload-baseline.cjs'), 'style.css': await read('style-baseline.css'), 'vds.css': await read('vds-baseline.css'),
};
const optimized = { 'react.js': await readFile(path.join(root, 'frontend/venditbot/react.js'), 'utf8') };
for (const [file, text] of Object.entries(source)) {
  if (file === 'react.js') continue;
  optimized[file] = file === 'vds.js' || file.endsWith('.css') ? await minifyVendorAsset(text, file)
    : (await transform(text, { ...productionBuildOptions, loader: 'js', format: file.endsWith('.cjs') ? 'cjs' : 'esm', target: file.endsWith('.cjs') ? 'node22' : 'chrome140' })).code;
}
const median = values => { const sorted = [...values].sort((a, b) => a - b), middle = Math.floor(sorted.length / 2); return sorted.length % 2 ? sorted[middle] : (sorted[middle - 1] + sorted[middle]) / 2; };
const runId = new Date().toISOString().replace(/[:.]/g, '-');
const sha256 = text => createHash('sha256').update(text).digest('hex');
const assets = Object.keys(source).map(file => ({ file, beforeBytes: Buffer.byteLength(source[file]), afterBytes: Buffer.byteLength(optimized[file]), beforeSha256: sha256(source[file]), afterSha256: sha256(optimized[file]) }));
const parse = {};
for (const [label, files] of Object.entries({ baseline: source, optimized })) {
  parse[label] = {};
  for (const [file, text] of Object.entries(files)) {
    if (file.endsWith('.css')) continue;
    const times = [];
    for (let i = 0; i < 45; i++) {
      const input = `${text}\n// Unique parse iteration ${label}-${file}-${i}`;
      const start = performance.now();
      if (file === 'app.js') {
        if (!vm.SourceTextModule) throw new Error('Run with node --experimental-vm-modules for actual ESM parsing.');
        new vm.SourceTextModule(input, { identifier: `${label}-${file}-${i}` });
      } else new vm.Script(input, { filename: `${label}-${file}-${i}` });
      if (i >= 5) times.push(performance.now() - start);
    }
    parse[label][file] = { medianMs: median(times), minMs: Math.min(...times), maxMs: Math.max(...times), measuredIterations: times.length };
  }
}

const preload = `const {contextBridge}=require('electron');
const state={version:'0.1.0',profiles:[],sessions:[],agents:[],teams:[],teamRuns:[],activeRun:null,queue:{running:[],queued:[]}};
contextBridge.exposeInMainWorld('venditbot',{invoke:async method=>{if(method==='state')return state;if(method==='authStatus')return {};throw new Error('Unexpected fixture request: '+method);},onEvent:()=>()=>{}});`;
const main = `const {app,BrowserWindow}=require('electron');
const {execFileSync}=require('node:child_process'); const path=require('node:path');
const start=performance.now(); app.setPath('userData',path.join(__dirname,'user-data'));
app.whenReady().then(async()=>{
  const readyMs=performance.now()-start;
  const win=new BrowserWindow({show:false,width:1200,height:850,webPreferences:{preload:path.join(__dirname,'fixture-preload.cjs'),contextIsolation:true,nodeIntegration:false,sandbox:true,backgroundThrottling:false}});
  const errors=[];win.webContents.on('console-message',(_event,level,message)=>{if(level>=3)errors.push(message);});
  try {
    await win.loadFile(path.join(__dirname,'index.html'));
    const rendered=await win.webContents.executeJavaScript(\`new Promise((resolve,reject)=>{const deadline=Date.now()+5000;function probe(){const appText=document.querySelector('#app').innerText;if(appText.length>30)resolve({marks:window.__assetTimes,appText,react:React.version,reactDOM:ReactDOM.version});else if(Date.now()>deadline)reject(new Error('Fixture did not render'));else setTimeout(probe,5);}probe();})\`);
    console.log('VENDITBOT_PERF_LOADED '+JSON.stringify({readyMs,renderReadyMs:performance.now()-start,...rendered}));
    app.getAppMetrics();await new Promise(resolve=>setTimeout(resolve,1000));
    const metrics=app.getAppMetrics();
    const rows=execFileSync('/bin/ps',['-p',metrics.map(item=>item.pid).join(','),'-o','pid=,rss=,%cpu='],{encoding:'utf8'}).trim().split('\\n').map(line=>{const [pid,rssKiB,cpuPercent]=line.trim().split(/\\s+/).map(Number);return {pid,rssKiB,cpuPercent};});
    const interaction=await win.webContents.executeJavaScript(\`(async()=>{
      const element=document.createElement('div');element.id='vendor-probe';document.body.appendChild(element);
      let observed=''; function Probe(){const [count,setCount]=React.useState(0);const [text,setText]=React.useState('before');const [checked,setChecked]=React.useState(false);observed=count+':'+text+':'+checked;
        return React.createElement(VDS.VDSProvider,{preferScheme:'light'},React.createElement(React.Fragment,null,
          React.createElement(VDS.Button,{onPress:()=>setCount(value=>value+1)},'probe-count-'+count),
          React.createElement(VDS.TextInput,{label:'probe-input',value:text,onChange:event=>setText(event.target.value)}),
          React.createElement(VDS.Checkbox,{label:'probe-checkbox',checked,onCheckedChange:setChecked})));}
      const mounted=ReactDOM.createRoot(element);ReactDOM.flushSync(()=>mounted.render(React.createElement(Probe)));
      element.querySelector('button').click();
      const input=element.querySelector('input:not([type=checkbox])');Object.getOwnPropertyDescriptor(HTMLInputElement.prototype,'value').set.call(input,'after');input.dispatchEvent(new Event('input',{bubbles:true}));
      const checkbox=element.querySelector('[role=checkbox]')||element.querySelector('input[type=checkbox]');checkbox.click();
      await new Promise(resolve=>setTimeout(resolve,50));
      const result={observed,markup:element.innerText,exports:Object.keys(VDS).sort()};mounted.unmount();element.remove();return result;
    })()\`);
    console.log('VENDITBOT_PERF_DONE '+JSON.stringify({versions:process.versions,rows,totalRssKiB:rows.reduce((sum,item)=>sum+item.rssKiB,0),totalCpuPercent:metrics.reduce((sum,item)=>sum+item.cpu.percentCPUUsage,0),processCount:rows.length,interaction,errors}));
    if(interaction.observed!=='1:after:true')process.exitCode=1;
  }catch(error){console.error(error);process.exitCode=1;}
  win.destroy();app.exit(process.exitCode||0);
});`;
const fixtureIndex = (await read('index-baseline.html')).replace('<script src="react.js"></script><script src="vds.js"></script>', '<script src="mark-start.js"></script><script src="react.js"></script><script src="mark-react.js"></script><script src="vds.js"></script><script src="mark-vds.js"></script>');
async function runElectron(label, files, iteration) {
  const fixture = path.join(directory, `electron-${runId}-${label}-${iteration}`);
  await mkdir(path.join(fixture, 'home'), {recursive: true});
  for (const [file, text] of Object.entries(files)) await writeFile(path.join(fixture, file), text);
  for (const [file, text] of Object.entries({ 'fixture-main.cjs': main, 'fixture-preload.cjs': preload, 'index.html': fixtureIndex,
    'mark-start.js': 'window.__assetTimes={start:performance.now()};',
    'mark-react.js': 'window.__assetTimes.react=performance.now();',
    'mark-vds.js': 'window.__assetTimes.vds=performance.now();' })) await writeFile(path.join(fixture, file), text);
  const binary = path.join(root, 'node_modules/electron/dist/Electron.app/Contents/MacOS/Electron');
  return await new Promise((resolve, reject) => {
    const start = performance.now();
    const child = spawn(binary, [path.join(fixture, 'fixture-main.cjs')], { cwd: fixture, env: { PATH:'/usr/bin:/bin:/usr/sbin:/sbin', HOME:path.join(fixture,'home'), TMPDIR:'/tmp', LANG:'en_US.UTF-8' }, stdio:['ignore','pipe','pipe'] });
    const timer = setTimeout(() => { child.kill('SIGTERM'); reject(new Error('Isolated Electron benchmark timed out: '+JSON.stringify({buffered,stderr,loaded,result}))); }, 20000);
    let buffered='',stderr='',loaded,result;
    child.stdout.on('data', chunk => {buffered+=chunk;let newline;while((newline=buffered.indexOf('\n'))>=0){const line=buffered.slice(0,newline);buffered=buffered.slice(newline+1);if(line.startsWith('VENDITBOT_PERF_LOADED '))loaded={...JSON.parse(line.slice(22)),launchToRenderedMs:performance.now()-start};if(line.startsWith('VENDITBOT_PERF_DONE '))result=JSON.parse(line.slice(20));}});
    child.stderr.on('data', chunk => {stderr+=chunk;});
    child.on('error',error=>{clearTimeout(timer);reject(error);});
    child.on('close',code=>{clearTimeout(timer);if(code!==0||!loaded||!result)reject(new Error('Electron fixture failed: '+JSON.stringify({code,loaded,result,stderr})));else resolve({...loaded,...result});});
  });
}
const native = { baseline: [], optimized: [] };
if (!process.argv.includes('--skip-electron')) {
  for (let iteration=0;iteration<repetitions;iteration++) {
    // Alternate ordering to reduce filesystem-cache and background-load bias.
    for (const label of iteration%2 ? ['optimized','baseline'] : ['baseline','optimized']) {
      native[label].push(await runElectron(label,label==='baseline'?source:optimized,iteration));
      console.log(`${label} ${iteration+1}/${repetitions} finished`);
    }
  }
  const first = native.baseline[0];
  for (const [label, samples] of Object.entries(native)) for (const sample of samples) {
    assert.equal(sample.appText, first.appText, 'The production renderer must retain the same application content.');
    assert.deepEqual(sample.interaction.exports, first.interaction.exports, 'Minification must preserve every VDS export.');
    assert.equal(sample.interaction.observed, '1:after:true', 'VDS controlled inputs and hooks must share one React instance.');
    if (label === 'optimized') assert.deepEqual(sample.errors, [], 'The production renderer must have no console errors.');
  }
}
const summary = {};
for (const [label, samples] of Object.entries(native)) if (samples.length) summary[label]={ samples:samples.length,launchToRenderedMedianMs:median(samples.map(item=>item.launchToRenderedMs)),reactLoadMedianMs:median(samples.map(item=>item.marks.react-item.marks.start)),vdsLoadMedianMs:median(samples.map(item=>item.marks.vds-item.marks.react)),totalRssMedianMiB:median(samples.map(item=>item.totalRssKiB/1024)),totalCpuMedianPercent:median(samples.map(item=>item.totalCpuPercent)),processCounts:samples.map(item=>item.processCount)};
const report={generatedAt:new Date().toISOString(),scope:'Frozen pre-change application, hidden sandboxed Electron windows, fresh isolated empty user-data/HOME per launch, fixture IPC only, no providers/network/login. Startup includes app renderer and VDS initial mount; memory sampled after one second idle. Not a live-account end-to-end startup benchmark.',node:process.versions,assets,parse,native,summary};
await writeFile(path.join(directory,'asset-performance.json'),JSON.stringify(report,null,2)+'\n');
console.log(JSON.stringify({assets,summary},null,2));
