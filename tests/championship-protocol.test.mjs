import {test} from 'node:test';
import assert from 'node:assert/strict';
import {fileURLToPath} from 'node:url';
import {Client} from '@modelcontextprotocol/client';
import {StdioClientTransport} from '@modelcontextprotocol/client/stdio';
test('generic MCP clients discover championship reports, exact target verification and decision-window schemas without connecting a game',async()=>{
 const c=new Client({name:'championship-schema-test',version:'1'});
 try{await c.connect(new StdioClientTransport({command:process.execPath,args:[fileURLToPath(new URL('../dist/server.js',import.meta.url))],env:{...process.env,VCPC_BROWSER_MODE:'owned-test'},stderr:'pipe'}));
  const tools=(await c.listTools()).tools;const get=n=>tools.find(t=>t.name===n);
  for(const name of ['vcpc_get_run_report','vcpc_get_profile_stats']){assert.equal(get(name).annotations.readOnlyHint,true);const r=await c.callTool({name,arguments:{session_id:'invalid'}});assert.equal(r.isError,true);}
  assert.ok(get('vcpc_start_contest').inputSchema.properties.expected_stage);
  assert.ok(get('vcpc_get_run_report').inputSchema.properties.goal.properties.achievement.enum.includes('champion'));
  for(const field of ['stop_after_judgements','stop_at_elapsed_minutes','pause_at_checkpoint','pause_drain_limit','stop_on_failure_streak','stop_on_preparation_stall_minutes'])assert.ok(get('vcpc_advance').inputSchema.properties[field]);
  for(const field of ['cursor','limit','event_key'])assert.ok(get('vcpc_get_event_knowledge').inputSchema.properties[field]);
  assert.equal(get('vcpc_advance').inputSchema.properties.pause_drain_limit.maximum,5);
  assert.match(c.getInstructions(),/goal_verification\.verified/);
 }finally{await c.close();}
});
