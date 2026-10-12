import assert from 'node:assert/strict';
import test from 'node:test';
import {build} from 'esbuild';
const built=await build({stdin:{contents:`export * from './source/shared/agent-policy.ts';export * from './source/venditbot/policy-efficiency.ts';`,resolveDir:process.cwd(),loader:'ts'},bundle:true,platform:'node',format:'esm',write:false});
const {EFFICIENCY_PRESETS,normalizePolicyEfficiency,policyEfficiencyPreset,boundPolicyHistory,efficiencyInstructions}=await import(`data:text/javascript;base64,${Buffer.from(built.outputFiles[0].text).toString('base64')}`);
const original=[{connectionId:'codex',model:'gpt-6-astra',effort:'high'},{connectionId:'claude-code',model:'claude-opus-5',effort:'high'}];
const model=(id,efforts=['low'],resolvedId)=>({id,label:id,isDefault:false,efforts,...(resolvedId?{resolvedId}:{})});
const catalogs=[{connectionId:'codex',models:[model('gpt-6-luna')]},{connectionId:'claude-code',models:[model('sonnet',['low','high'],'claude-sonnet-5-5')]}];
const efficiency={preset:'status_check',maxHistoryTurns:1,maxHistoryCharacters:4000};
const turn=(name)=>[{role:'user',content:`question ${name}`},{role:'assistant',content:`answer ${name}`}];
test('three efficiency presets use one catalog-backed low route and do not append high-model fallbacks',()=>{
 for(const preset of EFFICIENCY_PRESETS){const result=policyEfficiencyPreset(preset.id,original,catalogs);assert.deepEqual(result.connections,[{connectionId:'codex',model:'gpt-6-luna',effort:'low'}]);assert.deepEqual(result.efficiency,{preset:preset.id,maxHistoryTurns:preset.maxHistoryTurns,maxHistoryCharacters:preset.maxHistoryCharacters});assert.ok(result.keywords.length);}
 assert.deepEqual(policyEfficiencyPreset('settings_change',original,catalogs.slice(1)).connections,[{connectionId:'claude-code',model:'claude-sonnet-5-5',effort:'low'}]);
});
test('preset refuses unsupported effort, guessed alias, duplicate or foreign catalogs instead of returning expensive originals',()=>{
 for(const catalogs of [[],[{connectionId:'other',models:[model('gpt-6-luna')]}],[{connectionId:'codex',models:[model('gpt-6-luna',['high'])]}],[{connectionId:'claude-code',models:[model('sonnet')]}],[{connectionId:'codex',models:[model('gpt-6-luna')]},{connectionId:'codex',models:[model('gpt-6-luna')]}]])assert.throws(()=>policyEfficiencyPreset('status_check',original,catalogs),/자동 전환하지/);
 assert.throws(()=>policyEfficiencyPreset('invented',original,catalogs));
});
test('history budget retains newest whole turns and complete tool pairs without mutating full history',()=>{
 const tools=[{role:'user',content:'tool request'},{role:'assistant',content:[{type:'tool-call',toolCallId:'a',toolName:'read_file',args:{path:'x'}}]},{role:'tool',content:[{type:'tool-result',toolCallId:'a',toolName:'read_file',result:{text:'safe result'}}]},{role:'assistant',content:'tool answer'}];
 const history=[...turn('older'),...tools,{role:'user',content:'current '.repeat(2000)}],before=structuredClone(history);
 const result=boundPolicyHistory(history,efficiency);assert.deepEqual(result.messages,[...tools,history.at(-1)]);assert.equal(result.includedTurns,1);assert.equal(result.omittedTurns,1);assert.ok(result.historyCharacters<=4000);assert.deepEqual(history,before);
 result.messages[1].content[0].args.path='changed';assert.deepEqual(history,before);
});
test('oversized most-recent completed turn is omitted whole without selecting unrelated older history or clipping the current request',()=>{
 const history=[...turn('small'),...turn('x'.repeat(5000)),{role:'user',content:'current request'}];
 const result=boundPolicyHistory(history,{...efficiency,maxHistoryTurns:12,maxHistoryCharacters:1000});assert.deepEqual(result.messages,[history.at(-1)]);assert.equal(result.omittedTurns,2);assert.equal(result.historyCharacters,0);
 assert.deepEqual(boundPolicyHistory([...turn('old'),history.at(-1)],{...efficiency,maxHistoryTurns:0}).messages,[history.at(-1)]);
});
test('serialized history character boundary counts escaped content and never splits a turn',()=>{
 const history=[...turn('\\"'.repeat(150)),{role:'user',content:'current'}],size=JSON.stringify(history.slice(0,-1)).length;assert.ok(size>=1000);
 assert.equal(boundPolicyHistory(history,{...efficiency,maxHistoryCharacters:size}).includedTurns,1);
 assert.equal(boundPolicyHistory(history,{...efficiency,maxHistoryCharacters:size-1}).includedTurns,0);
});
test('efficiency validation rejects malformed bounds and guidance does not claim provider caps or erase approvals',()=>{
 for(const update of [{preset:'other'},{maxHistoryTurns:-1},{maxHistoryTurns:13},{maxHistoryTurns:1.5},{maxHistoryTurns:'1'},{maxHistoryCharacters:999},{maxHistoryCharacters:50001},{maxHistoryCharacters:NaN}])assert.throws(()=>normalizePolicyEfficiency({...efficiency,...update}));
 assert.throws(()=>boundPolicyHistory([{role:'assistant',content:'orphan'},{role:'user',content:'current'}],efficiency));
 assert.throws(()=>boundPolicyHistory([{role:'user',content:'unfinished'},{role:'tool',content:[]},{role:'user',content:'current'}],efficiency));
 for(const preset of EFFICIENCY_PRESETS){const text=efficiencyInstructions({...efficiency,preset:preset.id},2);assert.match(text,/전체 기록은 앱에 보존/);assert.match(text,/도구 승인/);assert.match(text,/전체 토큰 또는 비용 한도가 아닙니다/);}
});
