import {existsSync,openSync,closeSync,unlinkSync,writeSync,fsyncSync} from 'node:fs';
import path from 'node:path';
import {randomUUID} from 'node:crypto';
import {Ledger} from './ledger.js';
import {ExistingRunRegistry,type ExistingPolicy,type Continuity} from './existing-registry.js';
import type {ActionDriver,Phase,Tool as AllTool,View} from './controller.js';

type Tool=Exclude<AllTool,'vcpc_end_contest'|'vcpc_register_team'|'vcpc_confirm_initial_rating'|'vcpc_select_problem'|'vcpc_return_lobby'|'vcpc_open_training'|'vcpc_draw_training'|'vcpc_draw_training_ten'|'vcpc_collect_training'>;
type Run=ReturnType<ExistingRunRegistry['attach']>;
const phases:Record<Tool,Phase[]>={vcpc_enter_stage:['lobby','rules','final'],vcpc_select_strategy:['strategy'],vcpc_start_contest:['strategy'],vcpc_control_contest:['contest_running','contest_paused'],vcpc_choose_event:['event_choice'],vcpc_continue_event:['event_result'],vcpc_reveal_judgement:['judge_pending'],vcpc_collect_judgement:['judge_revealed'],vcpc_claim_review_reward:['final']};
const contest=new Set<Tool>(['vcpc_control_contest','vcpc_choose_event','vcpc_continue_event','vcpc_reveal_judgement','vcpc_collect_judgement']);
const decisions=new Set<Tool>(['vcpc_choose_event','vcpc_continue_event','vcpc_reveal_judgement','vcpc_collect_judgement']);
const stable=(o:Record<string,unknown>)=>JSON.stringify(Object.fromEntries(Object.entries(o).sort(([a],[b])=>a.localeCompare(b))));

/** One lock for the installation, independent of aliases or endpoint. */
export class ExistingController {
 readonly ledger:Ledger;readonly registry:ExistingRunRegistry;readonly controlId=randomUUID();
 private run:Run|null=null;private tail:Promise<unknown>=Promise.resolve();private stopping=false;private closed=false;private releaseStatus='released';private releasePromise?:Promise<{status:string}>;private revokeTimer?:NodeJS.Timeout;
 private readonly revokePath:string;
 constructor(readonly dir:string,readonly policy:ExistingPolicy,readonly driver:ActionDriver,readonly assertBinding:()=>void,public continuity:Continuity){
  this.ledger=new Ledger(dir,policy.task_id);this.revokePath=path.join(dir,'revoke.request');
  try{if(existsSync(this.revokePath))throw Error('control_revoked');this.registry=new ExistingRunRegistry(this.ledger,policy);this.ledger.append({at:new Date().toISOString(),kind:'confirmed',tool:'existing_control_acquired',action_id:this.controlId,args:'{}',detail:JSON.stringify({control_id:this.controlId,pid:process.pid,continuity})});this.revokeTimer=setInterval(()=>{if(existsSync(this.revokePath))void this.release().catch(()=>{});},200);this.revokeTimer.unref();}catch(e){this.ledger.close();throw e;}
 }
 assertWritable(tool?:Tool){this.check();if(Date.now()>=Date.parse(this.policy.expires_at))throw Error('deadline_exceeded');if(tool&&!this.policy.actions.includes(tool))throw Error('action_not_authorized');}
 setNewRunContinuity(c:Continuity){this.check();if(!c.witness_id||c.witness_invalid)throw Error('run_continuity_unknown');this.continuity=c;}
 verifyContinuity(c:Continuity){this.check();const expected=this.run?.continuity;if(expected && (!expected.witness_id||expected.target_id!==c.target_id||expected.document_id!==c.document_id||expected.witness_id!==c.witness_id||c.witness_invalid))throw Error('run_continuity_unknown');}
 private rewarded(runId:string|null):boolean {return this.ledger.entries.some(e=>e.tool==='vcpc_claim_review_reward'&&(e.kind==='confirmed'||(e.kind==='unknown'&&this.ledger.resolution(e.action_id)==='confirmed'))&&this.ledger.records(e.action_id).some(b=>b.kind==='begin'&&(b.detail??null)===runId));}
 private check(){if(this.stopping||this.closed||existsSync(this.revokePath))throw Error('control_revoked');this.ledger.assertOwned();this.assertBinding();}
 private queue<T>(operation:()=>Promise<T>):Promise<T>{const p=this.tail.then(operation);this.tail=p.catch(()=>{});return p;}
 async attach(continuity:Continuity):Promise<Run>{return this.queue(async()=>{this.check();const view=await this.driver.observe();this.check();this.run=this.registry.attach(view,continuity);return this.run;});}
 get runId(){return this.run?.run_id??null;}
 can(tool:Tool){try{this.check();if((contest.has(tool)&&!this.run)||(!this.run&&this.registry.runs().length))return false;this.registry.authorize(tool,this.run);return true;}catch{return false;}}
 execute(tool:Tool,id:string,args:Record<string,unknown>):Promise<{status:string;before?:View;after?:View;run_id?:string;message?:string}>{
  return this.queue(async()=>{
   try{this.check();}catch{return {status:'control_revoked'};}
   const encoded=stable(args);const records=this.ledger.records(id);const begin=records.find(e=>e.kind==='begin');
   if(begin){if(begin.tool!==tool||begin.args!==encoded)return {status:'action_id_conflict'};return (records.some(e=>e.kind==='confirmed')||this.ledger.resolution(id)==='confirmed')?{status:'confirmed_replay',run_id:begin.detail}:(records.some(e=>e.kind==='not_sent')||this.ledger.resolution(id)==='not_sent')?{status:'not_sent'}:{status:'outcome_unknown'};}
   try{this.registry.authorize(tool,this.run);}catch(e){return {status:e instanceof Error?e.message:'not_authorized'};}
   if(!this.run&&this.registry.runs().length)return {status:'run_continuity_unknown'};
   if(contest.has(tool)&&!this.run)return {status:'run_not_confirmed'};
   if(tool==='vcpc_start_contest'&&this.run && !this.rewarded(this.run.run_id))return {status:'previous_run_not_complete'};
   let before:View;try{before=await this.driver.observe();this.check();}catch{return {status:'binding_invalid'};}
   if(before.identity.team_name!==this.policy.expected_team)return {status:'identity_mismatch',before};
   if(tool==='vcpc_enter_stage' && before.phase==='lobby' && this.ledger.starts()>=this.policy.max_starts)return {status:'contest_limit_reached',before};
   if(!phases[tool].includes(before.phase))return {status:before.phase==='unknown'?'unknown_state':before.blocking_dialog?'blocked_by_dialog':'invalid_phase',before};
   if(tool==='vcpc_enter_stage'&&before.phase==='final'&& !this.rewarded(this.runId))return {status:'previous_run_not_complete',before};
   if(decisions.has(tool)&&(!args.decision_id||args.decision_id!==before.dialog?.decision_id))return {status:'stale_decision',before};
   if(tool==='vcpc_choose_event'&&!before.dialog?.options?.some(o=>o.option_id===args.option_id))return {status:'stale_option',before};
   if(tool==='vcpc_control_contest'&&((args.operation==='pause'&&before.phase!=='contest_running')||(args.operation==='resume'&&before.phase!=='contest_paused')))return {status:'invalid_phase',before};
   try{await this.driver.validate?.(tool,args,before);this.check();this.registry.authorize(tool,this.run);}catch(e){return {status:e instanceof Error?e.message:'precondition_failed',before};}
   const runId=tool==='vcpc_start_contest'?randomUUID():this.runId??undefined;
   this.ledger.append({at:new Date().toISOString(),kind:'begin',tool,action_id:id,args:encoded,before,detail:runId});
   try{
    this.check();const after=await this.driver.perform(tool,args,before);this.assertBinding();this.ledger.assertOwned();
    if(after.identity.team_name!==this.policy.expected_team)throw Error('identity_changed');
    this.ledger.append({at:new Date().toISOString(),kind:'confirmed',tool,action_id:id,args:encoded,after});
    if(tool==='vcpc_start_contest')this.run=this.registry.started(runId!,this.continuity,after);
    return {status:'confirmed',before,after,run_id:runId};
   }catch(e){const detail=e instanceof Error&&e.message==='page_not_visible'?'page_not_visible':e instanceof Error&&e.message.includes('Timeout')?'confirmation_timeout':'confirmation_failed';const notSent=this.driver.wasDispatched?.()===false;try{this.ledger.append({at:new Date().toISOString(),kind:notSent?'not_sent':'unknown',tool,action_id:id,args:encoded,detail});}catch{return {status:'outcome_unknown',before,run_id:runId};}return {status:notSent?'not_sent':'outcome_unknown',before,run_id:runId};}
  });
 }
 /** Stops new work immediately; waits for the in-flight click and its durable outcome. */
 async release():Promise<{status:string}>{
  this.stopping=true;
  this.releasePromise??=(async()=>{
   await this.tail;if(this.closed)return {status:this.releaseStatus};
   const unknown=this.ledger.unresolved();
   this.ledger.assertOwned();
   this.ledger.append({at:new Date().toISOString(),kind:'confirmed',tool:'existing_control_released',action_id:randomUUID(),args:'{}',detail:JSON.stringify({control_id:this.controlId,outcome_unknown:unknown})});
   try{unlinkSync(this.revokePath);}catch(e){if((e as NodeJS.ErrnoException).code!=='ENOENT')throw e;}
   this.ledger.close();clearInterval(this.revokeTimer);this.closed=true;this.releaseStatus=unknown?'outcome_unknown':'released';return {status:this.releaseStatus};
  })();
  return this.releasePromise;
 }

}
/** Request revocation only; deliberately never deletes the lock or assumes a click was cancelled. */
export function requestExistingRevocation(dir:string):void {
 const file=path.join(dir,'revoke.request');const fd=openSync(file,'wx',0o600);try{writeSync(fd,`${new Date().toISOString()}\n`);fsyncSync(fd);}finally{closeSync(fd);}
}
