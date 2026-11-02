import {instructions,registerKnowledge} from './knowledge.js';
import {registerScreenshot} from './screenshots.js';
import {McpServer} from '@modelcontextprotocol/server';
import {serveStdio} from '@modelcontextprotocol/server/stdio';
import {z} from 'zod/v4';
import {randomUUID} from 'node:crypto';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {mkdirSync,existsSync} from 'node:fs';
import {ExistingBrowser} from './existing-browser.js';
import {PageDriver} from './actions/page-driver.js';
import {ExistingController,requestExistingRevocation} from './actions/existing-controller.js';
import {readExistingPolicy} from './actions/existing-registry.js';
import type {Tool as AllTool,View} from './actions/controller.js';
type Tool=Exclude<AllTool,'vcpc_end_contest'|'vcpc_register_team'|'vcpc_confirm_initial_rating'|'vcpc_select_problem'|'vcpc_return_lobby'|'vcpc_open_training'|'vcpc_draw_training'|'vcpc_draw_training_ten'|'vcpc_collect_training'>;
import {Observation} from './model.js';

// One control domain per installation: aliases and MCP inputs cannot select another directory.
const stateDir=path.resolve(path.dirname(fileURLToPath(import.meta.url)),'..','data','existing-user');
const policyFile=process.env.VCPC_TASK_POLICY_FILE;
const key=z.string().min(1).max(128);
let browser:ExistingBrowser|undefined;
let connecting:Promise<ExistingBrowser>|undefined;
let binding=false,controlChanging=false;
let active:{id:string;binding:string;driver:PageDriver;control?:ExistingController}|undefined;
const getBrowser=async()=>{if(browser)return browser;connecting??=ExistingBrowser.connect();try{return browser=await connecting;}finally{connecting=undefined;}};
const ok=(data:object)=>({content:[{type:'text' as const,text:JSON.stringify(data)}],structuredContent:data});
const fail=(code:string,message:string)=>({isError:true,content:[{type:'text' as const,text:JSON.stringify({code,message})}]});
const errorCode=(e:unknown)=>e instanceof Error?e.message.split(':')[0]:'operation_failed';
const read=async()=>{
 if(!active || !browser)throw Error('invalid_session');
 const current=active;const owner=browser;owner.assertBound(current.binding);
 const raw=await current.driver.observe();owner.assertBound(current.binding);
 if(active!==current || browser!==owner)throw Error('binding_invalid');
 const allowed=(raw.allowed_actions as string[]).filter(a=>['vcpc_observe','vcpc_wait_for_change','vcpc_get_result'].includes(a)||!!current.control?.can(a as Tool));
 return Observation.parse({schema_version:'vcpc-mcp.v1',session_id:current.id,run_id:current.control?.runId??null,snapshot_id:randomUUID(),observed_at:new Date().toISOString(),...raw,allowed_actions:allowed,uncertainties:[...(raw.uncertainties as string[]),'存档的永久身份与接管前历史未知']});
};
const serverFactory=()=>{
 const server=new McpServer({name:'vcpc-existing',version:'0.5.2-alpha.2'},{instructions});
 registerKnowledge(server,()=>active?.control?.ledger);
 registerScreenshot(server,()=>active?{id:active.id,page:active.driver.page,read}:undefined);
 server.registerTool('vcpc_list_targets',{description:'只列已经打开的 VCPC 页面；标识仅在本连接有效。',inputSchema:z.object({}).strict(),annotations:{readOnlyHint:true}},async()=>{try{const b=await getBrowser();return ok({targets:b.listTargets(),browser_version:b.version});}catch{return fail('browser_disconnected','无法连接 Chrome。启用 chrome://inspect/#remote-debugging 并在 Chrome 允许连接，然后重试。');}});
 server.registerTool('vcpc_connect',{description:'显式选择 target_id，只读绑定，不导航。',inputSchema:z.object({target_id:key}).strict(),annotations:{readOnlyHint:true}},async({target_id})=>{
  if(active||binding)return fail('already_connected','请先断开当前绑定。');binding=true;
  try{const b=await getBrowser();const bound=b.bind(target_id);const driver=new PageDriver(bound.page,12000,async(tool)=>{if(tool==='vcpc_end_contest'||tool==='vcpc_register_team'||tool==='vcpc_confirm_initial_rating'||tool==='vcpc_select_problem'||tool==='vcpc_return_lobby'||tool==='vcpc_open_training'||tool==='vcpc_draw_training'||tool==='vcpc_draw_training_ten'||tool==='vcpc_collect_training')throw Error('action_not_authorized');const current=active;const owner=browser;if(!current?.control||!owner)throw Error('control_revoked');current.control.assertWritable(tool);if(tool==='vcpc_start_contest'){const previous=await owner.continuity(current.binding);current.control.verifyContinuity(previous);const next=await owner.continuity(current.binding,true,true);current.control.setNewRunContinuity(next);}else{const continuity=await owner.continuity(current.binding);current.control.verifyContinuity(continuity);}if(await current.driver.page.evaluate(()=>document.hidden))throw Error('page_not_visible');current.control.assertWritable(tool);},true);active={id:randomUUID(),binding:bound.binding_id,driver};const observation=await read();return ok({session_id:active.id,binding_id:bound.binding_id,mode:'existing-user',control:'read_only',browser_version:b.version,observation});}
  catch(e){active=undefined;const b=browser;browser=undefined;await b?.close().catch(()=>{});return fail(errorCode(e),'绑定或观察失败；连接已断开，未操作页面。');}finally{binding=false;}
 });
 server.registerTool('vcpc_observe',{description:'观察绑定页面，不导航。',inputSchema:z.object({session_id:key}).strict(),outputSchema:Observation,annotations:{readOnlyHint:true}},async({session_id})=>{if(!active||active.id!==session_id)return fail('invalid_session','请重新连接。');try{return ok(await read());}catch{return fail('binding_invalid','页面关闭、导航、重载或连接失效；请断开并重新选择。');}});
 server.registerTool('vcpc_get_result',{description:'只读最终结算。',inputSchema:z.object({session_id:key}).strict(),outputSchema:Observation,annotations:{readOnlyHint:true}},async({session_id})=>{if(!active||active.id!==session_id)return fail('invalid_session','请重新连接。');try{const o=await read();return o.phase==='final'?ok(o):fail('invalid_phase','当前不是结算页。');}catch{return fail('binding_invalid','绑定已失效。');}});
 server.registerTool('vcpc_take_control',{description:'按启动时指定的本地策略取得单写资格；不会点击页面。',inputSchema:z.object({session_id:key}).strict()},async({session_id})=>{
  if(!active||!browser||active.id!==session_id)return fail('invalid_session','请先绑定目标。');if(active.control||controlChanging)return fail('already_controlled','控制权已持有或正在切换。');
  if(!policyFile||!path.isAbsolute(policyFile))return fail('policy_required','需在本机启动配置指定绝对路径 VCPC_TASK_POLICY_FILE；工具参数不能授予权限。');
  controlChanging=true;const current=active;const b=browser;
  try{const policy=readExistingPolicy(policyFile);const continuity=await b.continuity(current.binding,true);if(active!==current||browser!==b)throw Error('binding_invalid');const ctrl=new ExistingController(stateDir,policy,current.driver,()=>{if(active!==current||browser!==b)throw Error('binding_invalid');b.assertBound(current.binding);},continuity);current.control=ctrl;return ok({status:'controlled',control_id:ctrl.controlId,policy:{task_id:policy.task_id,max_attached:policy.max_attached,max_starts:policy.max_starts,expires_at:policy.expires_at},observation:await read()});}
  catch(e){if(current.control){await current.control.release().catch(()=>{});current.control=undefined;}return fail(errorCode(e),'无法安全取得控制权；保留页面和日志。');}finally{controlChanging=false;}
 });
 server.registerTool('vcpc_attach_contest',{description:'登记当前已运行比赛，历史未知；不点击、不伪造开赛。',inputSchema:z.object({session_id:key}).strict()},async({session_id})=>{
  if(!active?.control||!browser||active.id!==session_id)return fail('control_required','请先取得控制权。');
  try{const current=active;const continuity=await browser.continuity(current.binding);const run=await current.control!.attach(continuity);return ok({status:'attached',run_id:run.run_id,origin:run.origin,attached_at:run.attached_at,history:'unknown',observation:await read()});}catch(e){return fail(errorCode(e),'接管登记失败；未执行游戏动作。');}
 });
 const common={session_id:key,action_id:key};const schemas={
  vcpc_enter_stage:z.object({...common}).strict(),vcpc_select_strategy:z.object({...common,strategy:z.string().min(1).max(100)}).strict(),vcpc_start_contest:z.object({...common}).strict(),
  vcpc_control_contest:z.object({...common,operation:z.enum(['pause','resume','speed']),speed:z.union([z.literal(1),z.literal(2),z.literal(4)]).optional()}).strict(),
  vcpc_choose_event:z.object({...common,decision_id:key,option_id:key}).strict(),vcpc_continue_event:z.object({...common,decision_id:key}).strict(),vcpc_reveal_judgement:z.object({...common,decision_id:key}).strict(),vcpc_collect_judgement:z.object({...common,decision_id:key}).strict(),vcpc_claim_review_reward:z.object({...common}).strict()};
 for(const [name,schema] of Object.entries(schemas))server.registerTool(name,{description:'执行策略允许的游戏动作；使用 action_id 去重。',inputSchema:schema,annotations:{readOnlyHint:false,destructiveHint:true,openWorldHint:true}},async(input:unknown)=>{
  const {session_id,action_id,...args}=input as Record<string,unknown>;
  if(!active?.control||session_id!==active.id)return fail('control_required','请先取得控制权。');
  if(name==='vcpc_control_contest' && ((args.operation==='speed'&&args.speed===undefined)||(args.operation!=='speed'&&args.speed!==undefined)))return fail('invalid_argument','speed 只在 operation=speed 时必填。');
  try{const result=await active.control.execute(name as Tool,String(action_id),args);if(!['confirmed','confirmed_replay'].includes(result.status))return fail(result.status,result.message??'动作未确认；请观察或检查日志。');return ok(result);}catch(e){return fail(errorCode(e),'动作处理失败；检查日志并停止写入。');}
 });
 server.registerTool('vcpc_wait_for_change',{description:'限时观察变化；不暂停比赛。',inputSchema:z.object({session_id:key,timeout_ms:z.number().int().min(1000).max(30000)}).strict(),annotations:{readOnlyHint:true}},async({session_id,timeout_ms},ctx)=>{
  if(!active||session_id!==active.id)return fail('invalid_session','请重新连接。');
  try{const current=active;const result=await current.driver.waitForChange(timeout_ms,ctx.mcpReq.signal);const observation=await read();return ok({status:result.status,observation});}catch{return fail('binding_invalid','等待已取消或页面不可用；游戏不会自动暂停。');}
 });
 server.registerTool('vcpc_release_control',{description:'停止新写入，等待在途动作确认并释放控制；不暂停游戏。',inputSchema:z.object({session_id:key}).strict()},async({session_id})=>{
  if(!active?.control||active.id!==session_id)return fail('control_required','没有当前控制权。');if(controlChanging)return fail('control_busy','控制权正在切换。');controlChanging=true;
  try{const c=active.control;const result=await c.release();if(active?.control===c)active.control=undefined;return ok({...result,game_pause_changed:false,game_state:'unknown'});}catch(e){return fail(errorCode(e),'释放未确认，保留锁和日志，不得重试写入。');}finally{controlChanging=false;}
 });
 server.registerTool('vcpc_revoke_control',{description:'请求收回控制；不删除锁，已发送点击须等待结果。',inputSchema:z.object({}).strict()},async()=>{try{mkdirSync(stateDir,{recursive:true,mode:0o700});if(!existsSync(path.join(stateDir,'controller.lock')))return ok({status:'no_controller',game_pause_changed:false,game_state:'unknown'});try{requestExistingRevocation(stateDir);}catch(e){if((e as NodeJS.ErrnoException).code!=='EEXIST')throw e;}return ok({status:'revocation_requested',game_pause_changed:false,game_state:'unknown'});}catch(e){return fail(errorCode(e),'收回请求未确认。');}});
 server.registerTool('vcpc_disconnect_observer',{description:'只断开没有控制权的只读会话；不关闭浏览器或暂停游戏。',inputSchema:z.object({session_id:key}).strict(),annotations:{readOnlyHint:true,destructiveHint:false}},async({session_id})=>{
  if(!active||active.id!==session_id)return fail('invalid_session','请使用当前 session_id。');
  if(active.control||controlChanging)return fail('control_active','先通过控制权释放入口安全释放。');
  active=undefined;const b=browser;browser=undefined;try{await b?.close();return ok({status:'disconnected',game_pause_changed:false,game_state:'unknown'});}catch{return fail('disconnect_failed','只读连接关闭未确认。');}
 });
 server.registerTool('vcpc_disconnect',{description:'释放控制后断开借用连接；不关闭页面或暂停游戏。',inputSchema:z.object({session_id:key}).strict()},async({session_id})=>{if(!active||active.id!==session_id)return fail('invalid_session','请使用当前 session_id。');if(controlChanging)return fail('control_busy','控制权正在切换。');controlChanging=true;try{const c=active.control;const outcome=await c?.release();active=undefined;const b=browser;browser=undefined;await b?.close();return ok({status:outcome?.status==='outcome_unknown'?'outcome_unknown':'disconnected',game_pause_changed:false,game_state:'unknown'});}catch{return fail('disconnect_failed','断开或在途结果未确认；检查日志。');}finally{controlChanging=false;}});
 return server;
};
serveStdio(serverFactory,{onerror:()=>console.error('mcp: transport error')});
let closing=false;async function shutdown(){if(closing)return;closing=true;const c=active?.control;await c?.release().catch(()=>{});active=undefined;const b=browser??await connecting?.catch(()=>undefined);browser=undefined;await b?.close().catch(()=>{});}
process.stdin.on('end',()=>{void shutdown();});process.on('SIGTERM',()=>{void shutdown().finally(()=>process.exit(0));});process.on('SIGINT',()=>{void shutdown().finally(()=>process.exit(0));});
