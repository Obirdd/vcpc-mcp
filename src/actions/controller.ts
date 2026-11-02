import { randomUUID } from 'node:crypto';
import { Ledger, type Entry } from './ledger.js';
import { confirmedSettlement, reviewNotOffered } from './settlement.js';

export type Phase='lobby'|'strategy'|'contest_running'|'contest_paused'|'event_choice'|'event_result'|'judge_pending'|'judge_revealed'|'final'|'rules'|'unknown'|'registration'|'initial_rating'|'training'|'training_result'|'end_confirmation';
export type View={phase:Phase;identity:{team_name:string|null;tp?:number|null};dialog?:{type?:string;decision_id?:string|null;options?:Array<{option_id:string;label:string}>|null}|null;[key:string]:unknown};
export type Tool='vcpc_register_team'|'vcpc_confirm_initial_rating'|'vcpc_select_problem'|'vcpc_enter_stage'|'vcpc_select_strategy'|'vcpc_start_contest'|'vcpc_end_contest'|'vcpc_control_contest'|'vcpc_choose_event'|'vcpc_continue_event'|'vcpc_reveal_judgement'|'vcpc_collect_judgement'|'vcpc_claim_review_reward'|'vcpc_return_lobby'|'vcpc_open_training'|'vcpc_draw_training'|'vcpc_draw_training_ten'|'vcpc_collect_training';
export interface ActionDriver { documentToken?():Promise<number>; wasDispatched?():boolean; connected?():boolean; observe():Promise<View>; validate?(tool:Tool,args:Record<string,unknown>,before:View):Promise<void>; perform(tool:Tool,args:Record<string,unknown>,before:View):Promise<View>; }
const phases:Record<Tool,Phase[]>={vcpc_register_team:['registration'],vcpc_confirm_initial_rating:['initial_rating'],vcpc_select_problem:['contest_running','contest_paused'],vcpc_enter_stage:['lobby','rules','final'],vcpc_select_strategy:['strategy'],vcpc_start_contest:['strategy'],vcpc_end_contest:['contest_running','contest_paused'],vcpc_control_contest:['contest_running','contest_paused'],vcpc_choose_event:['event_choice'],vcpc_continue_event:['event_result'],vcpc_reveal_judgement:['judge_pending'],vcpc_collect_judgement:['judge_revealed'],vcpc_claim_review_reward:['final'],vcpc_return_lobby:['final','training'],vcpc_open_training:['lobby'],vcpc_draw_training:['training'],vcpc_draw_training_ten:['training'],vcpc_collect_training:['training_result']};
const decisions=new Set<Tool>(['vcpc_choose_event','vcpc_continue_event','vcpc_reveal_judgement','vcpc_collect_judgement','vcpc_collect_training']);
const stable=(obj:Record<string,unknown>)=>JSON.stringify(Object.fromEntries(Object.entries(obj).sort(([a],[b])=>a.localeCompare(b))));
export class ActionController {
  private tail=Promise.resolve();
  private readonly connectedAt:number;
  get deadline():number {
    const lastReward=this.ledger.entries.reduce((last,e,i)=>confirmedSettlement(e)?i:last,-1);
    const pending=this.ledger.entries.slice(lastReward+1);
    const start=pending.find(e=>e.kind==='begin'&&e.tool==='vcpc_start_contest');
    const first=start??pending.find(e=>e.kind==='begin');
    const anchor=first?.at??(lastReward>=0?this.ledger.entries[lastReward].at:undefined);
    const anchoredAt=anchor?Date.parse(anchor):this.connectedAt;
    // A saved, completed run can be resumed on a later day. Renew only the
    // between-contest window; an unfinished contest keeps its start deadline.
    return (lastReward>=0&&!start?Math.max(anchoredAt,this.connectedAt):anchoredAt)+this.maxDurationMs;
  }
  private nextRunId:string;
  get runId():string { return this.ledger.entries.filter(e=>e.kind==='begin' && e.tool==='vcpc_start_contest').at(-1)?.detail ?? this.nextRunId; }
  constructor(readonly driver:ActionDriver,readonly ledger:Ledger,readonly expectedTeam:string,readonly now=()=>Date.now(),readonly maxDurationMs=2*60*60*1000,readonly maxStarts=1,readonly trainingTpBudget=0,readonly allowEarlyEnd=false){
    this.connectedAt=now();
    this.nextRunId=randomUUID();
  }
  trainingSpent():number {return this.ledger.entries.filter(e=>e.kind==='begin'&&['vcpc_draw_training','vcpc_draw_training_ten'].includes(e.tool)&&!this.ledger.records(e.action_id).some(r=>r.kind==='not_sent')&&this.ledger.resolution(e.action_id)!=='not_sent').reduce((spent,e)=>spent+(e.tool==='vcpc_draw_training_ten'?10:1),0);}
  execute(tool:Tool,actionId:string,args:Record<string,unknown>):Promise<{status:string;before?:View;after?:View;message?:string;run_id?:string}> {
    const promise=this.tail.then(()=>this.executeLocked(tool,actionId,args));this.tail=promise.then(()=>{},()=>{});return promise;
  }
  private async executeLocked(tool:Tool,actionId:string,args:Record<string,unknown>){
    if(tool==='vcpc_end_contest'&&(!this.allowEarlyEnd||args.confirm_early_end!==true))return {status:'early_end_not_authorized'};
    const encoded=stable(args);const existing=this.ledger.records(actionId);const begin=existing.find(e=>e.kind==='begin');
    if(begin){if(begin.tool!==tool||begin.args!==encoded)return {status:'action_id_conflict'};const end=existing.find(e=>e.kind==='confirmed'||e.kind==='unknown');if(existing.some(e=>e.kind==='not_sent'))return {status:'not_sent',message:'该动作已确认未发送；请重新观察并使用新 action_id'};return end?.kind==='confirmed'?{status:'confirmed_replay',message:'动作此前已确认，未再次执行；请观察当前页面',run_id:begin.detail ?? (begin.before as {run_id?:string}|undefined)?.run_id ?? this.runId}:{status:'outcome_unknown',message:'该动作已记录但效果未确认；禁止重放'};}
    if(existing.length&&!begin)return {status:'action_id_conflict'};
    if(this.ledger.unresolved())return {status:'outcome_unknown',message:'存在未确认动作，停止全部写入'};
    if(this.now()>this.deadline)return {status:'deadline_exceeded'};
    if(tool==='vcpc_start_contest' && this.ledger.startAttempts()>=this.maxStarts)return {status:'contest_limit_reached'};
    const lastStart=this.ledger.entries.map((e,i)=>e.kind==='begin' && e.tool==='vcpc_start_contest'?i:-1).reduce((a,b)=>Math.max(a,b),-1);
    if(tool==='vcpc_start_contest' && lastStart>=0 && !this.ledger.entries.slice(lastStart+1).some(confirmedSettlement))return {status:'previous_run_not_complete'};
    if(tool==='vcpc_enter_stage' && this.ledger.startAttempts()>=this.maxStarts)return {status:'contest_limit_reached'};
    const contestTools:Tool[]=['vcpc_end_contest','vcpc_select_problem','vcpc_control_contest','vcpc_choose_event','vcpc_continue_event','vcpc_reveal_judgement','vcpc_collect_judgement','vcpc_claim_review_reward'];
    if(contestTools.includes(tool) && (lastStart<0 || !this.ledger.entries.slice(lastStart+1).some(e=>e.tool==='vcpc_start_contest' && e.kind==='confirmed' && e.action_id===this.ledger.entries[lastStart].action_id))) return {status:'run_not_confirmed'};
    let documentToken:number|undefined;
    if(this.driver.documentToken){try{documentToken=await this.driver.documentToken();}catch{return {status:'browser_disconnected',message:'无法核验页面连续性；未执行动作'};}if(contestTools.includes(tool) && (lastStart<0 || this.ledger.entries[lastStart].document_token!==documentToken))return {status:'run_continuity_unknown',message:'页面文档已变化或缺少连续性证据；停止写入，不刷新'};}
    let before:View;try{before=await this.driver.observe();}catch(e){return {status:e instanceof Error && e.message.includes('target_mismatch')?'target_mismatch':'browser_disconnected',message:'点击前页面不可读或已离开目标；没有执行动作'};}
    if(tool==='vcpc_register_team' ? (before.identity.team_name!==null || args.team_name!==this.expectedTeam) : before.identity.team_name!==this.expectedTeam)return {status:'identity_mismatch',before};
    const akExit=(tool==='vcpc_enter_stage'||tool==='vcpc_return_lobby') && reviewNotOffered(before);
    if((tool==='vcpc_enter_stage'||tool==='vcpc_return_lobby') && before.phase==='final' && (lastStart<0||!this.ledger.entries.slice(lastStart+1).some(confirmedSettlement))){
      const start=lastStart>=0?this.ledger.entries[lastStart]:undefined;
      const started=start&&this.ledger.entries.slice(lastStart+1).some(e=>e.kind==='confirmed'&&e.tool==='vcpc_start_contest'&&e.action_id===start.action_id);
      if(!akExit||!started)return {status:'previous_run_not_complete',before};
      if(documentToken===undefined||start!.document_token!==documentToken)return {status:'run_continuity_unknown',before};
    }
    if(tool==='vcpc_draw_training'||tool==='vcpc_draw_training_ten'){
      const cost=tool==='vcpc_draw_training_ten'?10:1;
      if(this.trainingSpent()+cost>this.trainingTpBudget)return {status:'training_budget_exceeded',before};
      const training=before.training as {cost_tp?:number;cost_ten_tp?:number}|undefined;
      if((cost===10?training?.cost_ten_tp:training?.cost_tp)!==cost)return {status:'training_price_unknown',before};
      if(typeof before.identity.tp!=='number'||before.identity.tp<cost)return {status:'insufficient_tp',before};
    }
    if(!phases[tool].includes(before.phase))return {status:before.phase==='unknown'?'unknown_state':before.blocking_dialog?'blocked_by_dialog':'invalid_phase',before};
    if(tool==='vcpc_start_contest'&&args.expected_stage!==undefined){
      const c=before.competition as {stage?:string|null;source?:string}|undefined;
      if(c?.source!=='precontest_title'||c.stage!==args.expected_stage)return {status:'stage_unverified_or_mismatch',before,message:'赛前标题未唯一核验为指定赛段；未开赛。顶部进度不能替代本场赛段。'};
    }
    if(decisions.has(tool) && (!args.decision_id || args.decision_id!==before.dialog?.decision_id))return {status:'stale_decision',before};
    if(tool==='vcpc_choose_event' && !before.dialog?.options?.some(o=>o.option_id===args.option_id))return {status:'stale_option',before};
    if(tool==='vcpc_control_contest' && ((args.operation==='pause'&&before.phase!=='contest_running')||(args.operation==='resume'&&before.phase!=='contest_paused')))return {status:'invalid_phase',before};
    if(tool==='vcpc_control_contest'&&args.operation==='speed'&&(before.contest as {speed?:number|null}|null)?.speed===args.speed){const at=new Date(this.now()).toISOString();this.ledger.append({at,kind:'begin',tool,action_id:actionId,args:encoded,before,document_token:documentToken,detail:'already_satisfied_no_click'});this.ledger.append({at:new Date(this.now()).toISOString(),kind:'confirmed',tool,action_id:actionId,args:encoded,after:before,detail:'already_satisfied_no_click'});return {status:'already_satisfied',before,after:before,message:'目标倍速已生效；未发送点击',run_id:this.runId};}
    try {await this.driver.validate?.(tool,args,before);} catch{return {status:this.driver.connected && !this.driver.connected()?'browser_disconnected':'precondition_failed',before,message:'目标控件或连接不可用；请重新观察'};}
    const at=new Date(this.now()).toISOString();const base:Entry={at,kind:'begin',tool,action_id:actionId,args:encoded,before,detail:tool==='vcpc_start_contest'?this.nextRunId:undefined,document_token:documentToken};this.ledger.append(base);if(tool==='vcpc_start_contest')this.nextRunId=randomUUID();
    try {const after=await this.driver.perform(tool,args,before);if(after.identity.team_name!==this.expectedTeam)throw new Error('identity_changed_after_action');if(tool==='vcpc_end_contest'&&after.phase!=='final')throw Error('early_end_not_confirmed');if(akExit&&after.phase!=='lobby')throw Error('ak_exit_not_confirmed');this.ledger.append({at:new Date(this.now()).toISOString(),kind:'confirmed',tool,action_id:actionId,args:encoded,after,...(akExit?{before,document_token:documentToken,detail:'ak_review_not_offered'}:{})});return {status:'confirmed',before,after,message:tool==='vcpc_select_problem'?((after.contest as {selected_problem?:string|null}|null)?.selected_problem===args.problem_id?'已确认当前选中；后续可能由系统自动换题，请继续观察':'曾观察到选中，之后的快照已变化；不能视为持续生效'):tool==='vcpc_control_contest'&&args.operation==='speed'&&(after.contest as {speed?:number|null}|null)?.speed!==args.speed?'曾观察到目标倍速选中，但后续快照未确认持续生效':tool==='vcpc_control_contest'&&args.operation!=='speed'&&(after.contest as {playback?:string|null}|null)?.playback!==(args.operation==='pause'?'paused':'running')?'控件曾确认切换，但后续快照未确认持续状态':undefined,run_id:this.runId};}
    catch(e){if(this.driver.wasDispatched && !this.driver.wasDispatched()){this.ledger.append({at:new Date(this.now()).toISOString(),kind:'not_sent',tool,action_id:actionId,args:encoded,detail:'failed_before_click'});return {status:'not_sent',before,message:'点击前失败，未发送动作；请重新观察'};}const message='confirmation_failed';let after:View|undefined;try{after=await this.driver.observe();}catch{}this.ledger.append({at:new Date(this.now()).toISOString(),kind:'unknown',tool,action_id:actionId,args:encoded,after,detail:message});return {status:'outcome_unknown',before,after,message:'操作后未能确认效果，禁止重放或继续写入',run_id:this.runId};}
  }
}
