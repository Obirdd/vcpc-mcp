import type {McpServer} from '@modelcontextprotocol/server';
import type {Page} from 'playwright';
import {z} from 'zod/v4';
export function registerScreenshot(server:McpServer,get:()=>{id:string;page:Page;read:()=>Promise<unknown>}|undefined){
 server.registerTool('vcpc_screenshot',{description:'Return the current rendered viewport as a native MCP PNG image; no hidden DOM content or full-page capture. Use at milestones, not every card.',inputSchema:z.object({session_id:z.string().min(1)}).strict(),annotations:{readOnlyHint:true}},async({session_id})=>{
  const current=get();if(!current||current.id!==session_id)return {isError:true,content:[{type:'text' as const,text:'invalid_session'}]};
  try{const observation=await current.read();const png=await current.page.screenshot({type:'png',fullPage:false,animations:'disabled'});await current.read();return {content:[{type:'text' as const,text:JSON.stringify({observation,note:'Image and observation are sequential; game may advance between captures.'})},{type:'image' as const,mimeType:'image/png',data:png.toString('base64')}]};}
  catch{return {isError:true,content:[{type:'text' as const,text:'screenshot_unavailable: preserve current page and observe again'}]};}
 });
}
