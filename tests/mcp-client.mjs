import {Client} from '@modelcontextprotocol/client';
import {StdioClientTransport} from '@modelcontextprotocol/client/stdio';
import assert from 'node:assert/strict';
import {fileURLToPath} from 'node:url';
const server=fileURLToPath(new URL('../dist/server.js',import.meta.url));
const client=new Client({name:'vcpc-stage2-verifier',version:'1.0.0'});
const transport=new StdioClientTransport({command:process.execPath,args:[server],stderr:'inherit'});
try {
 await client.connect(transport);
 const tools=await client.listTools(); assert.ok(['vcpc_connect','vcpc_observe'].every(n=>tools.tools.some(x=>x.name===n))); 
 const c=await client.callTool({name:'vcpc_connect',arguments:{}}); assert.equal(c.isError,undefined); const data=c.structuredContent; assert.ok(data?.session_id); assert.equal(data.observation.identity.team_name,'MCP阶段三测试-1030');
 const o=await client.callTool({name:'vcpc_observe',arguments:{session_id:data.session_id}}); assert.equal(o.isError,undefined); assert.equal(o.structuredContent?.session_id,data.session_id);
 const bad=await client.callTool({name:'vcpc_observe',arguments:{session_id:'wrong'}}); assert.equal(bad.isError,true);
 console.log(JSON.stringify({tools:tools.tools.map(x=>x.name),connect:c.structuredContent,observe:o.structuredContent,invalid_session:bad.content},null,2));
} finally {await client.close();}
