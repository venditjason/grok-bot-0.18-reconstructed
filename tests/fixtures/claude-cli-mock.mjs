#!/usr/bin/env node
import {existsSync,writeFileSync,unlinkSync} from 'node:fs';
import path from 'node:path';
import {createInterface} from 'node:readline';
const marker=path.join(process.env.CLAUDE_CONFIG_DIR,'mock-login');
if(process.argv[2]==='auth') {
 if(process.argv[3]==='status') {const loggedIn=existsSync(marker);const report=()=>{console.log(JSON.stringify({loggedIn,authMethod:loggedIn?'claude.ai':'none',configDirectory:process.env.CLAUDE_CONFIG_DIR}));process.exit(loggedIn?0:1)};const delay=path.join(process.env.CLAUDE_CONFIG_DIR,'delay-next-status');if(existsSync(delay)){unlinkSync(delay);writeFileSync(path.join(process.env.CLAUDE_CONFIG_DIR,'delayed-status-started'),JSON.stringify(loggedIn));setTimeout(report,600)}else report();}
 if(process.argv[3]==='login') {setTimeout(()=>{writeFileSync(marker,'synthetic');process.exit(0)},30);}
 if(process.argv[3]==='logout') {const finish=()=>{if(existsSync(marker))unlinkSync(marker);process.exit(0)};if(existsSync(path.join(process.env.CLAUDE_CONFIG_DIR,'delay-logout'))){writeFileSync(path.join(process.env.CLAUDE_CONFIG_DIR,'logout-started'),'synthetic');setTimeout(finish,400)}else finish();}
} else if(process.argv.includes('--input-format')) {
 createInterface({input:process.stdin}).on('line',line=>{const message=JSON.parse(line);if(message.type!=='control_request'||message.request.subtype!=='initialize')process.exit(4);console.log(JSON.stringify({type:'control_response',response:{subtype:'success',request_id:message.request_id,response:{models:[{value:'default',resolvedModel:'mock-claude-model',displayName:'Default (recommended)',description:'Mock Claude',supportsEffort:true,supportedEffortLevels:['low','high']},{value:'mock-fast',resolvedModel:'mock-fast-1',displayName:'Fast',supportsEffort:false},{value:'mock-disabled',resolvedModel:'mock-disabled-1',displayName:'Unavailable',description:'Disabled by provider policy',disabled:true,supportsEffort:true,supportedEffortLevels:['high']}]}}}));});
} else {
 let input='';process.stdin.setEncoding('utf8');process.stdin.on('data',chunk=>input+=chunk);
 const send=msg=>process.stdout.write(JSON.stringify(msg)+'\n');
 process.stdin.on('end',()=>{
  writeFileSync(path.join(process.env.CLAUDE_CONFIG_DIR,'last-inference-input.json'),JSON.stringify({input,args:process.argv.slice(2)}));
  const resuming=process.argv.includes('--resume');
  if(input==='effort-contract'&&(process.argv[process.argv.indexOf('--model')+1]!=='mock-claude-model'||process.argv[process.argv.indexOf('--effort')+1]!=='high'||!process.argv[process.argv.indexOf('--system-prompt')+1].includes('OWNED_AGENT_INSTRUCTIONS'))) {send({type:'result',subtype:'error_during_execution',is_error:true});return;}
  if(resuming && (!process.argv.includes('--fork-session') || process.argv[process.argv.indexOf('--resume')+1]!=='owned-claude-session')) {send({type:'result',subtype:'error_during_execution',session_id:'incorrect-fork'});return;}
  if(input==='mcp-contract') {
   const config=JSON.parse(process.argv[process.argv.indexOf('--mcp-config')+1]);
   const checks=[config.mcpServers.venditbot.type==='http',config.mcpServers.venditbot.headers.Authorization==='Bearer ${VENDITBOT_MCP_TOKEN}',process.env.VENDITBOT_MCP_TOKEN?.length>=32,!process.argv.join(' ').includes(process.env.VENDITBOT_MCP_TOKEN),process.argv[process.argv.indexOf('--tools')+1]==='',process.argv[process.argv.indexOf('--allowedTools')+1]==='mcp__venditbot__*',process.env.ENABLE_CLAUDEAI_MCP_SERVERS==='false'];
   if(checks.some(value=>!value)){send({type:'result',subtype:'error_during_execution',session_id:'owned-claude-session'});return;}
  }
  if(input==='malformed'){process.stdout.write('not json\n');return;}
  send({type:'stream_event',event:{type:'content_block_delta',delta:{type:'text_delta',text:'Claude '}}});
  if(input==='hang'){setInterval(()=>{},1000);return;}
  if(input==='truncated')return;
  send({type:'stream_event',event:{type:'content_block_delta',delta:{type:'text_delta',text:'OK'}}});
  send({type:'result',subtype:input==='fail'?'error_during_execution':'success',is_error:input==='fail'||input==='auth-failure-success-subtype',session_id:resuming?'owned-claude-session-fork':'owned-claude-session',result:'Claude OK',usage:{input_tokens:4,output_tokens:2}});
 });
}
