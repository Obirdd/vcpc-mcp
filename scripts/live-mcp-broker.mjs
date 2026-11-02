// Optional local development bridge. Production clients should use stdio directly.
import {Client} from '@modelcontextprotocol/client';
import {StdioClientTransport} from '@modelcontextprotocol/client/stdio';
import {randomUUID} from 'node:crypto';
import {appendFileSync, mkdirSync, writeFileSync} from 'node:fs';
import http from 'node:http';
import path from 'node:path';
import {fileURLToPath} from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const output = process.env.VCPC_RECORD_DIR;
if (!output || !path.isAbsolute(output)) throw Error('VCPC_RECORD_DIR must be absolute');
mkdirSync(output, {recursive:true, mode:0o700});
const client = new Client({name:'vcpc-live-mcp',version:'1.1.0'});
const transport = new StdioClientTransport({command:process.execPath,args:[path.join(root,'dist/server.js')],env:{...process.env},stderr:'inherit'});
let available = true, closing = false, session, server;
client.onclose = () => { available = false; session = undefined; if (!closing) server?.close(); };
client.onerror = e => { console.error('MCP transport error:', e.message); };
await client.connect(transport);
const listed = await client.listTools();
writeFileSync(path.join(output,'tools.json'),JSON.stringify(listed,null,2)+'\n',{mode:0o600});
// JSON Schema unions can declare fields in any branch. Explicit arguments are never removed.
const declares = (schema, key) => !!schema && (Object.hasOwn(schema.properties ?? {},key) || ['anyOf','oneOf','allOf'].some(k => (schema[k] ?? []).some(s => declares(s,key))));
const readBody = req => new Promise((resolve,reject) => { let data=''; req.on('data',c=>{data+=c;if(data.length>1048576) req.destroy();});req.on('end',()=>{try{resolve(data?JSON.parse(data):{});}catch(e){reject(e);}});req.on('error',reject); });
let tail = Promise.resolve();
const call = async request => {
 if (!available) throw Error('mcp_disconnected');
 const tool = listed.tools.find(t=>t.name===request.tool);
 if (!tool) throw Error('unknown_tool: '+String(request.tool));
 if (request.args !== undefined && (!request.args || typeof request.args !== 'object' || Array.isArray(request.args))) throw Error('args_must_be_object');
 const args = {...(request.args ?? {})};
 if (session && declares(tool.inputSchema,'session_id') && !Object.hasOwn(args,'session_id')) args.session_id=session;
 if (request.action && declares(tool.inputSchema,'action_id') && !Object.hasOwn(args,'action_id')) args.action_id=randomUUID();
 const started=Date.now();
 const result=await client.callTool({name:request.tool,arguments:args});
 if (request.tool==='vcpc_connect' && !result.isError && result.structuredContent?.session_id) session=result.structuredContent.session_id;
 if (['vcpc_disconnect','vcpc_disconnect_observer'].includes(request.tool) && !result.isError && args.session_id===session) session=undefined;
 const content=(result.content ?? []).map(item=>{
  if (item.type!=='image') return item;
  const bytes=Buffer.from(item.data,'base64');
  const filename=`image-${randomUUID()}.${item.mimeType==='image/png'?'png':'bin'}`;
  const file=path.join(output,filename);writeFileSync(file,bytes,{mode:0o600,flag:'wx'});
  const {data,...metadata}=item;return {...metadata,path:file,bytes:bytes.length};
 });
 const entry={at:new Date().toISOString(),tool:request.tool,arguments:args,duration_ms:Date.now()-started,...result,content};
 appendFileSync(path.join(output,'mcp-trace.jsonl'),JSON.stringify(entry)+'\n',{mode:0o600});
 return entry;
};
server=http.createServer(async(req,res)=>{
 res.setHeader('content-type','application/json; charset=utf-8');
 if(req.method==='GET' && req.url==='/health'){res.statusCode=available?200:503;res.end(JSON.stringify({ok:available,session,tools:listed.tools.map(t=>t.name)}));return;}
 if(req.method!=='POST'||req.url!=='/call'){res.statusCode=404;res.end(JSON.stringify({error:'not_found'}));return;}
 try {const request=await readBody(req);const pending=tail.then(()=>call(request));tail=pending.catch(()=>{});const result=await pending;res.statusCode=result.isError?422:200;res.end(JSON.stringify(result));}
 catch(e){res.statusCode=available?400:503;res.end(JSON.stringify({error:String(e)}));}
});
server.listen(0,'127.0.0.1',()=>{const {port}=server.address();writeFileSync(path.join(output,'broker.json'),JSON.stringify({pid:process.pid,port},null,2)+'\n',{mode:0o600});console.log(JSON.stringify({ready:true,port,tools:listed.tools.map(t=>t.name)}));});
const shutdown=async()=>{if(closing)return;closing=true;available=false;await new Promise(r=>server.close(r));await tail;await client.close();};
process.on('SIGTERM',()=>void shutdown().finally(()=>process.exit(0)));
process.on('SIGINT',()=>void shutdown().finally(()=>process.exit(0)));
