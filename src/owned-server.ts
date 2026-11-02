import {McpServer} from '@modelcontextprotocol/server';
import {serveStdio} from '@modelcontextprotocol/server/stdio';
import {z} from 'zod/v4';
import {randomUUID} from 'node:crypto';
import path from 'node:path';
import {existsSync,readFileSync,writeFileSync} from 'node:fs';
import {instructions,registerKnowledge} from './knowledge.js';
import {registerScreenshot} from './screenshots.js';
import {advance,AdvanceOptions} from './advance.js';
import {PolicyStore,PolicyDefinition,PolicyRef} from './event-policy.js';
import {playLimits,resolveConfig} from './config.js';
import {Observation} from './model.js';
import {PersistentTestBrowser,type BrowserConnection} from './browser.js';
import {inspectRecovery,recoverSettledBrowser} from './recovery.js';
import {PageDriver} from './actions/page-driver.js';
import {ActionController,type ActionDriver,type Tool,type View} from './actions/controller.js';
import {Ledger} from './actions/ledger.js';
import {reviewNotOffered} from './actions/settlement.js';
import {startAndEnd} from './actions/start-and-end.js';
import {reconcileStart} from './reconcile-start.js';
import {reconcileEarlyEnd} from './reconcile-early-end.js';
import {runContext,runReport,profileReport,verifyGoal} from './run-report.js';
const {expectedTeam,dir,profile}=resolveConfig();
const earlyEndEnabled=process.env.VCPC_ALLOW_EARLY_END==='1'&&!!process.env.VCPC_PROFILE_ALIAS;
const registrationMarker=path.join(dir,'new-profile-registration.json');
const registrationEnabled=process.env.VCPC_ALLOW_REGISTRATION==='1' && !!process.env.VCPC_PROFILE_ALIAS;
const registrationAuthorized=()=>registrationEnabled && existsSync(registrationMarker) && readFileSync(registrationMarker,'utf8')===JSON.stringify({profile,expectedTeam});
// Phase-five acceptance ceiling includes the existing phase-three contest.
const {maxContests:contestLimit,trainingTp:trainingTpBudget}=playLimits();
let writeTail:Promise<unknown>=Promise.resolve();
function serial<T>(operation:()=>Promise<T>):Promise<T>{const p=writeTail.then(operation);writeTail=p.catch(()=>{});return p;}
const ConnectOutput=z.object({session_id:z.string(),observation:Observation}).strict();
const ActionOutput=z.object({status:z.string(),before:Observation.optional(),after:Observation.optional(),message:z.string().optional(),run_id:z.string().optional()}).strict();
const WaitOutput=z.object({status:z.string(),observation:Observation}).strict();
const key=z.string().min(1).max(128);const common={session_id:key,action_id:key};
let active:{id:string,connection:BrowserConnection,driver:PageDriver,controller:ActionController,ledger:Ledger,read:()=>Promise<Observation>}|undefined;
let connecting=false;
const ok=(data:object)=>({content:[{type:'text' as const,text:JSON.stringify(data)}],structuredContent:data});
const fail=(code:string,message:string,detail?:{before?:unknown;after?:unknown;[key:string]:unknown})=>({isError:true,content:[{type:'text' as const,text:JSON.stringify({code,message,...detail,current_visible_state:detail?.after??detail?.before??null,evidence_location:path.join(dir,'actions.jsonl'),next_step:({stale_decision:'重新观察并使用当前决策标识',blocked_by_dialog:'先观察并处理当前遮挡弹窗',invalid_phase:'重新观察并选择当前状态允许的操作',identity_mismatch:'停止写入并核对专用测试队伍',browser_disconnected:'保留页面和日志；检查连接，不刷新',timeout:'等待超时并不表示游戏暂停；重新观察',outcome_unknown:'停止写入；检查动作日志与页面，不重放',unknown_state:'保留页面并只读诊断',invalid_session:'重新连接并使用当前会话句柄',target_mismatch:'停止写入并检查用户是否切离指定站点',cancelled:'等待已取消，比赛未自动暂停；重新观察',controller_locked:'确认其他控制器已退出；不要盲目删除锁',browser_recovery_required:'核对进程、档案、最后确认状态及未决动作；赛中不自动恢复',run_continuity_unknown:'页面可能已重载或缺少连续性证据；保留档案和日志，只读检查，赛中不要重新启动',browser_metadata_invalid:'保留元数据，核对档案与进程；不要删除锁或覆盖文件',previous_recovery_incomplete:'恢复中断；保留标记、浏览器和元数据，人工核验后再处理'} as Record<string,string>)[code]??'检查当前页面、动作日志和服务状态'})}]});
const policies=new PolicyStore(dir);
const serverFactory=()=>{
 const server=new McpServer({name:'vcpc',version:'0.5.2-alpha.2'},{instructions});
 registerKnowledge(server,path.join(dir,'actions.jsonl'));
 registerScreenshot(server,()=>active?{id:active.id,page:active.driver.page,read:active.read}:undefined);
 server.registerTool('vcpc_save_event_policy',{description:'Save an immutable, profile-scoped event policy version. Saving does not authorize or enable automatic choices.',inputSchema:PolicyDefinition,annotations:{readOnlyHint:false}},async input=>serial(async()=>{try{return ok(policies.save(input));}catch(e){return fail('policy_save_failed',e instanceof Error?e.message:'policy save failed');}}));
 server.registerTool('vcpc_list_event_policies',{description:'List profile-scoped policy versions and disabled status. None are automatically active.',inputSchema:z.object({}).strict(),annotations:{readOnlyHint:true}},async()=>{try{return ok({policies:policies.list()});}catch(e){return fail('policy_read_failed',e instanceof Error?e.message:'policy read failed');}});
 server.registerTool('vcpc_get_event_policy',{description:'Read one exact profile-scoped policy version.',inputSchema:PolicyRef,annotations:{readOnlyHint:true}},async input=>{try{return ok(policies.get(input));}catch(e){return fail('policy_read_failed',e instanceof Error?e.message:'policy read failed');}});
 server.registerTool('vcpc_disable_event_policy',{description:'Permanently disable one immutable policy version; use a new version to change or restore rules.',inputSchema:PolicyRef,annotations:{readOnlyHint:false}},async input=>serial(async()=>{try{return ok(policies.disable(input));}catch(e){return fail('policy_disable_failed',e instanceof Error?e.message:'policy disable failed');}}));

 const connectOwned=async(recover:boolean,registrationOnly=false)=>{
  if(active||connecting)return fail('already_connected','使用现有 session_id');connecting=true;let connection:BrowserConnection|undefined;let ledger:Ledger|undefined;
  try{const newProfile=!existsSync(profile) && !existsSync(path.join(dir,'browser.json'));ledger=new Ledger(dir);connection=recover?await recoverSettledBrowser({dir,profile,expectedTeam},ledger,registrationOnly):await new PersistentTestBrowser().connect();const id=randomUUID();let driver:PageDriver;driver=new PageDriver(connection.page,12000,async(tool)=>{const pending=ledger!.entries.filter(e=>e.kind==='begin').at(-1);if(pending?.tool!==tool||pending.document_token!==await driver.documentToken())throw Error('document_changed_before_click');if(['vcpc_end_contest','vcpc_start_contest','vcpc_select_problem','vcpc_control_contest','vcpc_choose_event','vcpc_continue_event','vcpc_reveal_judgement','vcpc_collect_judgement','vcpc_claim_review_reward'].includes(tool)||(['vcpc_enter_stage','vcpc_return_lobby'].includes(tool)&&(pending.before as View|undefined)?.phase==='final')){const start=ledger!.entries.filter(e=>e.kind==='begin'&&e.tool==='vcpc_start_contest').at(-1);if(!start?.document_token || start.document_token!==await driver.documentToken())throw Error('run_continuity_unknown_before_click');}},false,earlyEndEnabled);let controller:ActionController;
   const prior=ledger.entries.filter(e=>e.kind==='begin'&&e.document_token&&((e.before as View|undefined)?.identity.team_name===expectedTeam)).at(-1);if(prior?.document_token===await driver.documentToken())driver.rememberTeam(expectedTeam,prior.document_token);
   const read=async()=>{const raw=await driver.observe();const allowed=(raw.allowed_actions as string[]).filter(a=>!(a==='vcpc_end_contest'&&!earlyEndEnabled) && !(a==='vcpc_register_team' && (!registrationAuthorized() || ledger!.entries.length>0)) && !((a==='vcpc_start_contest'||a==='vcpc_enter_stage')&&ledger!.startAttempts()>=contestLimit) && !((a==='vcpc_enter_stage'||a==='vcpc_return_lobby') && raw.phase==='final' && !String((raw.final as {reward?:string}|null)?.reward??'').includes('已领取') && !reviewNotOffered(raw)) && !(a==='vcpc_claim_review_reward'&&(!ledger!.starts()||!String((raw.final as {reward?:string}|null)?.reward??'').includes('+1 TP'))) && !(['vcpc_draw_training','vcpc_draw_training_ten'].includes(a) && controller.trainingSpent()+(a==='vcpc_draw_training_ten'?10:1)>trainingTpBudget) && !(ledger!.unresolved()&&!['vcpc_observe','vcpc_wait_for_change','vcpc_get_result'].includes(a)));
    if(!ledger!.unresolved()&&ledger!.starts()&&['contest_running','contest_paused','judge_pending','judge_revealed','event_choice','event_result'].includes(raw.phase))allowed.push('vcpc_advance');
    if(earlyEndEnabled&&!ledger!.unresolved()&&raw.phase==='strategy'&&ledger!.startAttempts()<contestLimit)allowed.push('vcpc_start_and_end_contest');
    if(earlyEndEnabled&&ledger!.unresolved()&&raw.phase==='end_confirmation')allowed.push('vcpc_reconcile_early_end');
    allowed.push('vcpc_screenshot');
    allowed.push('vcpc_get_run_report','vcpc_get_profile_stats');
    return Observation.parse({schema_version:'vcpc-mcp.v1',session_id:id,run_id:ledger!.starts()?controller.runId:null,snapshot_id:randomUUID(),observed_at:new Date().toISOString(),...raw,run_context:runContext(ledger!),training:raw.training?{...(raw.training as object),budget_remaining_tp:Math.max(0,trainingTpBudget-controller.trainingSpent())}:null,uncertainties:ledger!.starts()?(raw.uncertainties as string[]).map(x=>x.startsWith('run_id')?'run_id 为本地生成的场次标识，非站点标识；题目评级不在赛中输出':x):raw.uncertainties,allowed_actions:allowed});};
   const wrapped:ActionDriver={documentToken:()=>driver.documentToken(),wasDispatched:()=>driver.wasDispatched(),connected:()=>driver.connected(),observe:async()=>await read() as View,validate:(tool,args,before)=>driver.validate(tool,args,before),perform:async(tool,args,before)=>{await driver.perform(tool,args,before);return await read() as View;}};
   if(connection.fresh && newProfile && registrationEnabled && !ledger.entries.length)writeFileSync(registrationMarker,JSON.stringify({profile,expectedTeam}),{flag:'wx',mode:0o600});
   controller=new ActionController(wrapped,ledger,expectedTeam,()=>Date.now(),2*60*60*1000,contestLimit,trainingTpBudget,earlyEndEnabled);const observation=await read();if(observation.identity.team_name!==expectedTeam && !(observation.phase==='registration' && observation.identity.team_name===null && registrationAuthorized())){await connection.close();ledger.close();return fail('identity_mismatch','没有识别到指定测试队伍，停止。',{before:observation});}
   active={id,connection,driver,controller,ledger,read};return ok(ConnectOutput.parse({session_id:id,observation}));
  }catch(e){await connection?.close().catch(()=>{});try{ledger?.close();}catch{}console.error('vcpc_connect: connection failed');const message=e instanceof Error?e.message:'';const code=message.startsWith('controller_locked')?'controller_locked':message.startsWith('previous_recovery_incomplete')?'previous_recovery_incomplete':message.startsWith('browser_recovery_required')?'browser_recovery_required':message.startsWith('browser_metadata_invalid')?'browser_metadata_invalid':message.startsWith('browser_target_mismatch')?'target_mismatch':'browser_disconnected';return fail(recover?'recovery_blocked':code,recover?`恢复未完成：${message||'unknown'}；保留浏览器、账本和恢复证据。`:'无法安全连接专用浏览器或获取独占锁；保留页面和日志，不刷新比赛。');}finally{connecting=false;}
 };
 server.registerTool('vcpc_connect',{description:'连接仍运行的专用浏览器并核验队伍；不会重启已退出浏览器。',inputSchema:z.object({}).strict(),outputSchema:ConnectOutput,annotations:{readOnlyHint:true}},async()=>connectOwned(false));
 server.registerTool('vcpc_reconcile_early_end',{description:'仅修复未知提前结束请求留下的同一页面结束确认框。核验唯一原未知动作、原run和文档、指定队伍及可见结束比赛确认后，只点击放弃并滚榜；最终结算核验成功才追加服务器核验记录，保留原unknown，不重开比赛。',inputSchema:z.object({session_id:key,action_id:key,confirm_early_end:z.literal(true)}).strict(),annotations:{readOnlyHint:false}},async({session_id,action_id})=>serial(async()=>{
  if(!active||active.id!==session_id)return fail('invalid_session','使用当前会话');
  if(!earlyEndEnabled)return fail('early_end_not_authorized','此模式未授权提前结束');
  try{return ok(await reconcileEarlyEnd(active.driver,active.ledger,expectedTeam,action_id));}catch(e){return fail('early_end_reconciliation_blocked',e instanceof Error?e.message:'核验失败，保留原始记录');}
 }));
 server.registerTool('vcpc_reconcile_start',{description:'仅核验最近一次开赛未知动作：原页面文档未变化、队伍匹配且当前已明确在比赛中时，追加可见观察核验记录。不会点击、重开或刷新。不适用于其他未知动作。action_id 必须是原开赛动作 ID。',inputSchema:z.object({session_id:key,action_id:key,confirm_no_unrecorded_activity:z.literal(true)}).strict(),annotations:{readOnlyHint:false}},async({session_id,action_id})=>serial(async()=>{if(!active||active.id!==session_id)return fail('invalid_session','使用当前连接句柄');try{await reconcileStart(active.driver,active.ledger,expectedTeam,action_id);return ok({status:'start_verified',observation:await active.read()});}catch(e){return fail('start_reconciliation_blocked',e instanceof Error?e.message:'核验失败，未发送游戏动作');}}));
 server.registerTool('vcpc_diagnose_recovery',{description:'只读诊断专用档案恢复条件；不取得游戏锁或连接浏览器。',inputSchema:z.object({}).strict(),annotations:{readOnlyHint:true}},async()=>{const d=inspectRecovery({dir,profile,expectedTeam});const advice:Record<string,string>={controller_locked:'确认控制者正常退出；保留锁，不手动删除。',previous_recovery_incomplete:'保留恢复标记、浏览器和元数据，人工核查此前启动及可见页面。',browser_process_alive_verify_endpoint:'调用 vcpc_connect 核验已有专用浏览器；不要重新启动。',settled_browser_exited:'仅在确认没有未记录的人工接管后显式调用 vcpc_recover_browser。',unknown_action_present:'保留 unknown，停止写入并核查证据。',in_flight_action:'保留账本，核查未确认动作，不能恢复。',settlement_not_confirmed:'最后一场未确认领奖；保留档案，不重启赛中页面。',latest_progress_unverified:'最新可见进度不足，保留档案并人工核查。',browser_metadata_invalid:'元数据损坏或不匹配；不要覆盖，保留并核查。',singleton_process_mismatch:'档案锁指向其他进程；不要关闭任何浏览器，核查是否人工接管。',port_metadata_mismatch:'端口证据冲突；不连接、不重启，保留证据。'};return ok({...d,next_step:advice[d.reason]??'保留原始文件和浏览器，核查诊断原因；不要删除锁或强制恢复。',warning:'账本不能证明是否存在未记录的人工接管；若有或无法确认，请停止恢复。'});});
 server.registerTool('vcpc_recover_browser',{description:'显式恢复已退出、已领奖且无未知动作的专用档案；须确认没有未记录的人工操作或接管。启动可见 Chrome 并核验最新进度，不恢复赛中比赛。',inputSchema:z.object({confirm_no_unrecorded_activity:z.literal(true)}).strict(),annotations:{readOnlyHint:false,openWorldHint:true}},async()=>serial(async()=>connectOwned(true)));
 server.registerTool('vcpc_recover_registration',{description:'显式恢复仅有一次注册 begin/unknown、尚未开赛的原档案。须确认无未记录活动；重开后核对队名、赛季1网络赛、Rating及3 TP，匹配才追加核验记录。不能恢复比赛或训练未知动作。',inputSchema:z.object({confirm_no_unrecorded_activity:z.literal(true)}).strict(),annotations:{readOnlyHint:false,openWorldHint:true}},async()=>serial(async()=>connectOwned(true,true)));
 server.registerTool('vcpc_observe',{description:'只读当前页面，不导航。',inputSchema:z.object({session_id:key}).strict(),outputSchema:Observation,annotations:{readOnlyHint:true}},async({session_id})=>{
  if(!active||session_id!==active.id)return fail('invalid_session','使用当前连接返回的 session_id');
  try{const o=await active.read();if(o.identity.team_name&&o.identity.team_name!==expectedTeam)return fail('identity_mismatch','当前队伍不匹配',{before:o});return ok(o);}catch(e){console.error('observe: page unavailable');return fail(e instanceof Error&&e.message.includes('target_mismatch')?'target_mismatch':'browser_disconnected','观察失败或已离开目标站点；不刷新页面。');}
 });
 const stage=z.enum(['网络赛','区域赛','区域决赛','世界总决赛','可观测宇宙总决赛']);
 server.registerTool('vcpc_get_run_report',{description:'只读本档案账本，按run_id生成本场逐题提交、揭牌前准备度、已选事件、结算及证据覆盖。传goal={stage,achievement}核验指定赛段的自然完赛/金牌/第一名，只有goal_verification.verified=true满足指定目标；顶部进度、早退、未领奖、旧记录缺失赛段都不算成功。缺省run_id为最近一场，不会操作游戏。',inputSchema:z.object({session_id:key,run_id:key.optional(),goal:z.object({stage,achievement:z.enum(['completed','gold','champion'])}).strict().optional()}).strict(),annotations:{readOnlyHint:true}},async({session_id,run_id,goal})=>serial(async()=>{
  if(!active||active.id!==session_id)return fail('invalid_session','使用当前会话');
  try{const report=runReport(active.ledger,run_id);return ok({...report,...(goal?{goal_verification:verifyGoal(report,goal)}:{}),evidence_location:active.ledger.logPath});}catch(e){return fail('run_report_unavailable',e instanceof Error?e.message:'记录不可读');}
 }));
 server.registerTool('vcpc_get_profile_stats',{description:'只读当前专用档案账本，去重汇总比赛、经过赛段双校验的冠军、训练实际收益和最近记录。limit只控制最近记录窗口；不读取其他档案，不把剩余TP折算为Rating，不推断内部概率或硬上限。旧记录缺失的赛段会标未核验。',inputSchema:z.object({session_id:key,limit:z.number().int().min(1).max(100).default(20)}).strict(),annotations:{readOnlyHint:true}},async({session_id,limit})=>serial(async()=>{
  if(!active||active.id!==session_id)return fail('invalid_session','使用当前会话');
  try{return ok({...profileReport(active.ledger,limit),evidence_location:active.ledger.logPath});}catch(e){return fail('profile_report_unavailable',e instanceof Error?e.message:'记录不可读');}
 }));
 const schemas={
  vcpc_end_contest:z.object({...common,confirm_early_end:z.literal(true)}).strict(),
  vcpc_return_lobby:z.object({...common}).strict(),
  vcpc_open_training:z.object({...common}).strict(),
  vcpc_draw_training:z.object({...common}).strict(),
  vcpc_draw_training_ten:z.object({...common}).strict(),
  vcpc_collect_training:z.object({...common,decision_id:key}).strict(),
  vcpc_register_team:z.object({...common,team_name:z.string().min(1).max(24).refine(s=>s===s.trim() && !/[\u0000-\u001f\u007f]/.test(s))}).strict(),
  vcpc_confirm_initial_rating:z.object({...common}).strict(),
  vcpc_select_problem:z.object({...common,problem_id:z.string().regex(/^[A-Z]$/)}).strict(),
  vcpc_enter_stage:z.object({...common}).strict(),
  vcpc_select_strategy:z.object({...common,strategy:z.string().min(1).max(100)}).strict(),
  vcpc_start_contest:z.object({...common,expected_stage:stage.optional()}).strict(),
  vcpc_control_contest:z.union([z.object({...common,operation:z.enum(['pause','resume'])}).strict(),z.object({...common,operation:z.literal('speed'),speed:z.union([z.literal(1),z.literal(2),z.literal(4)])}).strict()]),
  vcpc_choose_event:z.object({...common,decision_id:key,option_id:key}).strict(),
  vcpc_continue_event:z.object({...common,decision_id:key}).strict(),
  vcpc_reveal_judgement:z.object({...common,decision_id:key}).strict(),
  vcpc_collect_judgement:z.object({...common,decision_id:key}).strict(),
  vcpc_claim_review_reward:z.object({...common}).strict()
 };
 const descriptions:Record<string,string>={vcpc_end_contest:'用户明确授权的提前结束比赛：仅专用owned-test且VCPC_ALLOW_EARLY_END=1启用。点击可见结束比赛按钮并确认结算，不能当作自然完赛。',vcpc_return_lobby:'已领奖结算页、明确无复盘按钮的 AK 结算页或训练页返回大厅；不受开赛额度影响，不会开赛。',vcpc_open_training:'从大厅打开训练页，不消耗 TP。',vcpc_draw_training:'消耗 1 TP 抽一张训练卡，受本地持久化 TP 总预算约束；记录揭晓结果，Rating 可能升降。',vcpc_draw_training_ten:'消耗10TP点击网站原生十连训练；一次真实十连而非十次单抽。逐项读取可见十连回执，随后必须用最新decision_id调用vcpc_collect_training收下十张卡。受同一累计TP预算限制。',vcpc_collect_training:'收下已揭晓单张或十连训练结果并返回训练页，不再次抽卡。',vcpc_register_team:'仅在明确授权的新档案注册指定队名，并观察确认。',vcpc_confirm_initial_rating:'确认已显示的初始评级并进入规则页。',vcpc_select_problem:'选择当前可见题目并确认瞬时选中；暂停中可操作，后续可能自动换题，应再次观察。',vcpc_enter_stage:'已领取复盘奖励或明确无复盘按钮的 AK 结算页返回大厅；从大厅进入普通或可观测宇宙赛前页，或关闭赛制规则；每次只执行一步。宇宙入口必须为唯一的路线卡按钮。',vcpc_select_strategy:'按页面原文选择比赛策略并确认选中。',vcpc_start_contest:'开始一次比赛；建议显式传expected_stage，以赛前主标题核对目标赛段，缺证据或不一致不点击。受持久化场次上限限制。',vcpc_control_contest:'暂停、继续或设定 1/2/4 倍速；已是目标倍速时不点击，返回 already_satisfied。',vcpc_choose_event:'按当前 decision_id 和 option_id 选择事件选项；不会代为决策。',vcpc_continue_event:'关闭当前事件结果并识别后续状态。',vcpc_reveal_judgement:'翻开当前待判题卡并等待揭晓。',vcpc_collect_judgement:'收取已揭晓的判题卡并确认弹窗消失。',vcpc_claim_review_reward:'领取本场已完成比赛的复盘奖励并确认。'};
 for(const [name,schema] of Object.entries(schemas))server.registerTool(name,{description:`${descriptions[name]} 使用 action_id 去重，校验身份和状态。`,inputSchema:schema,outputSchema:ActionOutput,annotations:{readOnlyHint:false,destructiveHint:true,openWorldHint:true}},async(input:unknown)=>serial(async()=>{
   const data=input as Record<string,unknown>;const {session_id,action_id,...args}=data;
   if(!active||session_id!==active.id)return fail('invalid_session','使用当前连接返回的 session_id');
   if(name==='vcpc_register_team' && (!registrationAuthorized() || (active.ledger.entries.length>0 && !active.ledger.records(String(action_id)).length)))return fail('registration_not_authorized','仅允许明确启用且首次创建的新档案注册');
   if(name==='vcpc_control_contest'&&((args.operation==='speed'&&args.speed===undefined)||(args.operation!=='speed'&&args.speed!==undefined)))return fail('invalid_argument','speed 只在 operation=speed 时必填');
   try{const result=await active.controller.execute(name as Tool,String(action_id),args);if(!['confirmed','confirmed_replay','already_satisfied'].includes(result.status))return fail(result.status,result.message??'前置条件不满足，未确认执行',result);if(result.after)result.after=await active.read() as View;return ok(ActionOutput.parse(result));}catch(e){console.error(`${name}: execution failed`);return fail('execution_failed','操作前检查或日志失败；停止并检查。');}
 }));
 server.registerTool('vcpc_start_and_end_contest',{description:'仅授权刷TP模式：从已选策略页真实开赛，立即点击网站结束比赛并确认结算。两个步骤均独立记账；不领奖、不训练。相同action_id重试沿用原场次，禁止未知结果重放。普通赛季不得使用。',inputSchema:z.object({...common,confirm_early_end:z.literal(true)}).strict(),annotations:{readOnlyHint:false}},async({session_id,action_id})=>serial(async()=>{
  if(!active||session_id!==active.id)return fail('invalid_session','使用当前会话');
  if(!earlyEndEnabled)return fail('early_end_not_authorized','本专用模式未启用提前结束');
  const result=await startAndEnd(active.controller,async()=>await active!.read() as View,action_id);
  return result.status==='confirmed'?ok(result):fail(result.status,'批次已停止；请观察原场次，不要重开',{...result});
 }));
 server.registerTool('vcpc_advance',{description:'Bounded play with per-click checks and logging. stop_after_judgements counts collected cards in this batch; stop_at_elapsed_minutes uses game minutes (0:30=30, 1:00=60). stop_on_failure_streak and stop_on_preparation_stall_minutes use observed per-problem history, not hidden rage. pause_at_checkpoint requests a checked pause; inspect checkpoint.paused and pause_blocked_reason. pause_drain_limit (0-5, default 0) explicitly permits handling extra routine dialogs to reach a pause, within max_steps/timeout_ms; requires pause_at_checkpoint=true. Never chooses an event while seeking a pause. No background intent survives the batch. target_speed stops after confirming speed. Explicit immutable policy or full event_rules authorizes normal event choices. Never starts, trains, claims rewards or changes problems. Reusing action_id is observe-only.',inputSchema:AdvanceOptions.extend(common).strict(),annotations:{readOnlyHint:false,destructiveHint:true,openWorldHint:true}},async(input,ctx)=>serial(async()=>{
  const {session_id,action_id,...options}=input;if(!active||session_id!==active.id)return fail('invalid_session','使用当前会话');const current=active;if(Date.now()>current.controller.deadline)return fail('deadline_exceeded','运行时间边界已到');
  try{let policy:Parameters<typeof advance>[0]['policy'];if(options.policy){if(options.event_rules.length)throw Error('policy_and_inline_rules_conflict');const saved=policies.get(options.policy);if(saved.disabled)throw Error('policy_disabled');const ref=options.policy;policy={...ref,rules:saved.definition.rules,sha256:saved.sha256,validate:()=>{const latest=policies.get(ref);if(latest.disabled||latest.sha256!==saved.sha256)throw Error('policy_changed_or_disabled');}};}return ok(await advance({read:async()=>await current.read() as View,execute:(tool,id,args)=>current.controller.execute(tool,id,args),wait:(ms,signal)=>current.driver.waitForChange(ms,signal),ledger:current.ledger,policy},action_id,options,ctx.mcpReq.signal));}catch(e){const message=e instanceof Error?e.message:'';const code=ctx.mcpReq.signal.aborted?'cancelled':message.startsWith('pause_drain_')?'invalid_argument':message.startsWith('policy_')?'policy_unavailable':'advance_failed';return fail(code,code==='invalid_argument'?message:code==='policy_unavailable'?`策略不可用：${message}；请检查策略版本、停用状态和参数。`:'批处理已停止；已发送动作仍以账本为准，请重新观察，不重放批处理。');}
 }));
 server.registerTool('vcpc_wait_for_change',{description:'限时等到事件、判题、结算或异常；不执行动作。',inputSchema:z.object({session_id:key,timeout_ms:z.number().int().min(1000).max(30000)}).strict(),outputSchema:WaitOutput,annotations:{readOnlyHint:true}},async({session_id,timeout_ms},ctx)=>{
  if(!active||session_id!==active.id)return fail('invalid_session','使用当前连接返回的 session_id');
  try{if(Date.now()>active.controller.deadline)return fail('deadline_exceeded','运行时间边界已到，停止等待。');const r=await active.driver.waitForChange(Math.min(timeout_ms,Math.max(1,active.controller.deadline-Date.now())),ctx.mcpReq.signal);const observation=await active.read();if(r.status==='timeout')return fail('timeout','等待超时；未暂停比赛。',{before:observation});return ok({status:r.status,observation});}catch(e){if(ctx.mcpReq.signal.aborted)return fail('cancelled','等待已取消；比赛是否暂停未知。');console.error('wait: observation failed');return fail(e instanceof Error&&e.message.includes('target_mismatch')?'target_mismatch':'browser_disconnected','等待期间无法观察页面；不刷新，也不表示比赛已暂停。');}
 });
 server.registerTool('vcpc_get_result',{description:'只读最终结算。',inputSchema:z.object({session_id:key}).strict(),outputSchema:Observation,annotations:{readOnlyHint:true}},async({session_id})=>{
  if(!active||session_id!==active.id)return fail('invalid_session','使用当前连接返回的 session_id');try{const o=await active.read();if(o.identity.team_name!==expectedTeam)return fail('identity_mismatch','无法核验当前测试队伍',{before:o});if(o.phase!=='final')return fail('invalid_phase','当前并非最终结算');return ok(o);}catch{return fail('browser_disconnected','读取结算失败');}
 });
 return server;
};
serveStdio(serverFactory,{onerror:()=>console.error('mcp: transport error')});
let closing=false;const shutdown=async()=>{if(closing)return;closing=true;await writeTail.catch(()=>{});await active?.connection.close().catch(()=>{});try{active?.ledger.close();}catch{}};
process.stdin.on('end',()=>{void shutdown();});process.on('SIGTERM',()=>{void shutdown().finally(()=>process.exit(0));});process.on('SIGINT',()=>{void shutdown().finally(()=>process.exit(0));});
