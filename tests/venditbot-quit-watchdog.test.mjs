import assert from 'node:assert/strict';
import {spawn} from 'node:child_process';
import {EventEmitter} from 'node:events';
import vm from 'node:vm';
import test from 'node:test';
import {build} from 'esbuild';

const built=await build({entryPoints:['source/venditbot/quit-watchdog.ts'],bundle:true,platform:'node',format:'esm',write:false});
const entry='data:text/javascript;base64,'+Buffer.from(built.outputFiles[0].text).toString('base64');
const {QUIT_WATCHDOG_SOURCE,startQuitWatchdog}=await import(entry);

test('quit watchdog requires its current parent at both start and deadline, preventing reused-PID termination',()=>{
  const run=(initial,after)=>{
    let timer; const kills=[], exits=[];
    const process={argv:['node','4242','5000'],ppid:initial,kill:(...args)=>kills.push(args),exit:code=>{exits.push(code);throw new Error('exit');}};
    try {vm.runInNewContext(QUIT_WATCHDOG_SOURCE,{process,setTimeout:fn=>{timer=fn;}});} catch(error){assert.equal(error.message,'exit');}
    process.ppid=after; if(timer)try{timer();}catch(error){assert.equal(error.message,'exit');}
    return {kills,exits};
  };
  assert.deepEqual(run(4242,4242),{kills:[[4242,'SIGKILL']],exits:[0]});
  assert.deepEqual(run(4242,1),{kills:[],exits:[0]});
  assert.deepEqual(run(9999,4242),{kills:[],exits:[2]});
});

test('quit watchdog spawns only a bounded own-parent Node child with no auth or profile environment',()=>{
  let observed;const child=Object.assign(new EventEmitter(),{unref(){this.unreferenced=true;}});
  startQuitWatchdog({executable:'/synthetic/VenditBot',parentPid:process.pid,spawnChild:(...args)=>{observed=args;return child;}});
  assert.equal(observed[0],'/synthetic/VenditBot');assert.deepEqual(observed[1].slice(-2),[String(process.pid),'5000']);
  assert.deepEqual(observed[2],{detached:true,stdio:'ignore',env:{PATH:'/usr/bin:/bin',ELECTRON_RUN_AS_NODE:'1'}});assert.equal(child.unreferenced,true);
  assert.throws(()=>startQuitWatchdog({executable:'/synthetic/VenditBot',parentPid:process.pid+1}),/현재 앱/);
  assert.throws(()=>startQuitWatchdog({executable:'/synthetic/VenditBot',parentPid:process.pid,graceMs:0}),/시간/);
});

test('real Node watchdog ends only its deliberately stalled disposable parent after the bound',async t=>{
  const parent=spawn(process.execPath,['--input-type=module','-e',`import {startQuitWatchdog} from ${JSON.stringify(entry)};startQuitWatchdog({executable:process.execPath,parentPid:process.pid,graceMs:200});setInterval(()=>{},1000);`],{stdio:'ignore'});
  t.after(()=>{if(parent.exitCode==null&&parent.signalCode==null)parent.kill('SIGKILL');});
  const started=Date.now();const result=await new Promise((resolve,reject)=>{const timer=setTimeout(()=>reject(new Error('watchdog timeout')),5000);parent.once('error',reject);parent.once('exit',(code,signal)=>{clearTimeout(timer);resolve({code,signal});});});
  assert.deepEqual(result,{code:null,signal:'SIGKILL'});assert.ok(Date.now()-started>=180);
});
