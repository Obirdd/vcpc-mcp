import {randomUUID} from 'node:crypto';
import {createHash} from 'node:crypto';
import {readFileSync} from 'node:fs';
import {z} from 'zod/v4';
import {Ledger} from './ledger.js';
import type {Phase,View} from './controller.js';

// This file is read from a local operator-supplied path, never from MCP arguments.
export const ExistingPolicy=z.object({
  task_id:z.string().min(1).max(100), expected_team:z.string().min(1).max(100),
  max_attached:z.number().int().min(0).max(100), max_starts:z.number().int().min(0).max(100),
  allow_attached_reward:z.boolean(), allow_old_reward:z.boolean(), allow_started_reward:z.boolean().default(false),
  expires_at:z.iso.datetime(), stop_after_reward:z.boolean(),
  actions:z.array(z.enum(['vcpc_enter_stage','vcpc_select_strategy','vcpc_start_contest','vcpc_control_contest','vcpc_choose_event','vcpc_continue_event','vcpc_reveal_judgement','vcpc_collect_judgement','vcpc_claim_review_reward'])).max(9)
}).strict();
export type ExistingPolicy=z.infer<typeof ExistingPolicy>;
export function readExistingPolicy(file:string):ExistingPolicy {return ExistingPolicy.parse(JSON.parse(readFileSync(file,'utf8')));}
export type Continuity={target_id:string;document_id:string;witness_id?:string;witness_invalid?:boolean};
export type Run={run_id:string;origin:'attached_existing'|'started_here';attached_at:string;continuity:Continuity;phase:Phase;visible_contest:unknown;history:'unknown'};
const running=new Set<Phase>(['contest_running','contest_paused','event_choice','event_result','judge_pending','judge_revealed']);
const digest=(policy:ExistingPolicy)=>createHash('sha256').update(JSON.stringify(policy)).digest('hex');
const entry=(tool:string,detail:string)=>({at:new Date().toISOString(),kind:'confirmed' as const,action_id:randomUUID(),tool,args:'{}',detail});

/** Must be held under the global existing-user Ledger lock. Never supplied with an AI-selected directory. */
export class ExistingRunRegistry {
  readonly policyHash:string;
  constructor(readonly ledger:Ledger,readonly policy:ExistingPolicy,readonly now=()=>Date.now()) {
    this.policyHash=digest(policy);
    const pinned=ledger.entries.find(e=>e.tool==='existing_policy');
    if(pinned && pinned.detail!==this.policyHash)throw Error('task_policy_changed');
    if(!pinned)ledger.append(entry('existing_policy',this.policyHash));
  }
  private check():void {
    this.ledger.assertOwned();
    if(this.ledger.unresolved())throw Error('outcome_unknown');
    if(this.now()>=Date.parse(this.policy.expires_at))throw Error('deadline_exceeded');
    if(this.policy.stop_after_reward && this.ledger.entries.some(e=>e.tool==='vcpc_claim_review_reward'&&(e.kind==='confirmed'||(e.kind==='unknown'&&this.ledger.resolution(e.action_id)==='confirmed'))))throw Error('task_complete');
  }
  runs():Run[] {return this.ledger.entries.filter(e=>(e.tool==='attach_existing'||e.tool==='started_here')&&e.kind==='confirmed').map(e=>JSON.parse(e.detail!) as Run);}
  attach(view:View,continuity:Continuity):Run {
    this.check();
    if(!running.has(view.phase) && view.phase!=='final')throw Error('invalid_phase');
    if(view.identity.team_name!==this.policy.expected_team)throw Error('identity_mismatch');
    const runs=this.runs();
    if(runs.length) {
      const last=runs.at(-1)!;
      if(last.continuity.target_id!==continuity.target_id || last.continuity.document_id!==continuity.document_id)throw Error('run_continuity_unknown');
      if(!last.continuity.witness_id || last.continuity.witness_id!==continuity.witness_id || continuity.witness_invalid)throw Error('run_continuity_unknown');
      return last;
    }
    if(view.phase==='final')throw Error('invalid_phase');
    if(!continuity.witness_id || continuity.witness_invalid)throw Error('run_continuity_unknown');
    if(runs.length>=this.policy.max_attached)throw Error('attach_limit_reached');
    const run:Run={run_id:randomUUID(),origin:'attached_existing',attached_at:new Date(this.now()).toISOString(),continuity,phase:view.phase,visible_contest:view.contest??null,history:'unknown'};
    this.ledger.append(entry('attach_existing',JSON.stringify(run)));return run;
  }
  started(runId:string,continuity:Continuity,view:View):Run {
    const run:Run={run_id:runId,origin:'started_here',attached_at:new Date(this.now()).toISOString(),continuity,phase:view.phase,visible_contest:view.contest??null,history:'unknown'};
    this.ledger.append(entry('started_here',JSON.stringify(run)));return run;
  }
  authorize(tool:string,run:Run|null):void {
    this.check();if(!this.policy.actions.includes(tool as ExistingPolicy['actions'][number]))throw Error('action_not_authorized');
    if(tool==='vcpc_start_contest'&&this.ledger.starts()>=this.policy.max_starts)throw Error('contest_limit_reached');
    if(tool==='vcpc_claim_review_reward' && !(run?.origin==='attached_existing'?this.policy.allow_attached_reward:run?.origin==='started_here'?this.policy.allow_started_reward:this.policy.allow_old_reward))throw Error('reward_not_authorized');
  }
}
