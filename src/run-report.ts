import type {Entry} from './actions/ledger.js';
import {reviewNotOffered} from './actions/settlement.js';
import {trainingBands, trainingCardCoverage, trainingWindow} from './training-stats.js';

type Obj=Record<string,any>;
const object=(x:unknown):Obj=>x&&typeof x==='object'&&!Array.isArray(x)?x as Obj:{};
const integer=(x:unknown):number|null=>typeof x==='number'&&Number.isInteger(x)?x:null;
const numeric=(x:unknown):number|null=>typeof x==='string'&&/^[+-]?\d[\d,]*$/.test(x.trim())?Number(x.replaceAll(',','')):integer(x);
const fact=(f:Obj,label:string):string|null=>{
 const values=(Array.isArray(f.facts)?f.facts:[]).filter((s:unknown):s is string=>typeof s==='string').map((s:string)=>s.trim().match(new RegExp(`^(.+?)\\s+${label}$`))?.[1]).filter(Boolean);
 return values.length===1?values[0]??null:null;
};
export type ReportLedger={entries:Entry[];resolution?:(id:string)=>'confirmed'|'not_sent'|undefined;unresolved?:()=>boolean};
const confirmed=(ledger:ReportLedger,id:string)=>ledger.entries.some(e=>e.action_id===id&&e.kind==='confirmed')||ledger.resolution?.(id)==='confirmed';
const notSent=(ledger:ReportLedger,id:string)=>ledger.entries.some(e=>e.action_id===id&&e.kind==='not_sent')||ledger.resolution?.(id)==='not_sent';

export function runContext(ledger:ReportLedger,runId?:string){
 const start=[...ledger.entries].reverse().find(e=>e.kind==='begin'&&e.tool==='vcpc_start_contest'&&(!runId||e.detail===runId));
 if(!start?.detail)return null;
 const before=object(start.before),identity=object(before.identity),competition=object(before.competition);
 const stage=competition.source==='precontest_title'&&typeof competition.stage==='string'?competition.stage:null;
 return {run_id:start.detail,season:integer(identity.season),stage,stage_source:stage?'precontest_title':'unverified',
         strategy:(before.strategy_details as Obj[]|undefined)?.find(s=>s.selected)?.name??null,
         rating_before:integer(identity.rating),tp_before:integer(identity.tp),start_confirmed:confirmed(ledger,start.action_id)};
}

export function runReport(ledger:ReportLedger,requestedRun?:string){
 const context=runContext(ledger,requestedRun);
 if(!context)throw Error('run_not_found');
 const startIndex=ledger.entries.findIndex(e=>e.kind==='begin'&&e.tool==='vcpc_start_contest'&&e.detail===context.run_id);
 const next=ledger.entries.findIndex((e,i)=>i>startIndex&&e.kind==='begin'&&e.tool==='vcpc_start_contest');
 const records=ledger.entries.slice(startIndex,next<0?undefined:next);
 const snapshots=records.flatMap(e=>['before','after'].map(k=>({entry:e,view:object((e as Obj)[k])})))
   .filter(({view})=>view.run_id===context.run_id);
 const final=[...snapshots].reverse().find(({view})=>view.phase==='final'&&view.final);
 const f=object(final?.view.final);
 const endAttempts=records.filter(e=>e.kind==='begin'&&e.tool==='vcpc_end_contest'&&!records.some(r=>r.action_id===e.action_id&&r.kind==='not_sent')&&ledger.resolution?.(e.action_id)!=='not_sent');
 const endKind=endAttempts.length?(endAttempts.some(e=>confirmed(ledger,e.action_id))?'early_end':'unknown'):final&&context.start_confirmed?'natural_by_ledger':'unknown';
 const resultStage=typeof f.stage==='string'?f.stage:null;
 const stageVerified=!!context.stage&&resultStage===context.stage;
 const rankMatch=typeof f.rank==='string'?f.rank.match(/^#(\d+)\s*\/\s*(\d+)$/):null;
 const rank=rankMatch?Number(rankMatch[1]):null,fieldSize=rankMatch?Number(rankMatch[2]):null;
 const submissions=numeric(fact(f,'提交')),solved=numeric(fact(f,'过题'));
 const verdicts=Array.isArray(f.verdicts)?f.verdicts as Obj[]:[];
 const totalsConsistent=submissions!==null&&solved!==null&&submissions>=solved&&solved>=0&&verdicts.length>0
   &&verdicts.every(v=>integer(v.count)!==null&&v.count>=0)
   &&verdicts.reduce((sum,v)=>sum+v.count,0)===submissions
   &&verdicts.filter(v=>v.verdict==='AC').length===1&&verdicts.find(v=>v.verdict==='AC')?.count===solved;
 const rewardClaim=[...records].reverse().find(e=>e.tool==='vcpc_claim_review_reward'&&e.kind==='confirmed'&&object(e.after).run_id===context.run_id);
 const rewardComplete=!!rewardClaim||reviewNotOffered(final?.view);
 const ledgerUnresolved=ledger.unresolved?.()??records.some(e=>e.kind==='begin'&&!confirmed(ledger,e.action_id)&&!records.some(r=>r.action_id===e.action_id&&r.kind==='not_sent')&&ledger.resolution?.(e.action_id)!=='not_sent');
 const reasons:string[]=[];
 if(!context.start_confirmed)reasons.push('start_not_confirmed');
 if(!final)reasons.push('final_not_observed');
 if(!context.stage)reasons.push('start_stage_unverified');
 if(!resultStage)reasons.push('result_stage_unverified');
 if(context.stage&&resultStage&&context.stage!==resultStage)reasons.push('stage_mismatch');
 if(endKind!=='natural_by_ledger')reasons.push('natural_completion_unverified');
 if(!rewardComplete)reasons.push('review_not_complete');
 if(ledgerUnresolved)reasons.push('unresolved_action');
 if(rank===null||fieldSize===null||rank<1||fieldSize<rank)reasons.push('rank_or_field_invalid');
 if(!totalsConsistent)reasons.push('result_totals_incomplete_or_conflicting');
 const judgements:Obj[]=[];const seen=new Set<string>();
 for(const e of records){
  if(e.kind!=='confirmed'||e.tool!=='vcpc_reveal_judgement'||seen.has(e.action_id))continue;
  const b=records.find(r=>r.action_id===e.action_id&&r.kind==='begin');
  const before=object(b?.before),after=object(e.after),d=object(after.dialog),cp=object(object(before.contest).current_problem);
  if(after.run_id!==context.run_id||typeof d.result!=='string')continue;
  seen.add(e.action_id);
  judgements.push({action_id:e.action_id,at:e.at,problem_id:d.problem_id??null,submitted_at:d.submitted_at??null,verdict:d.result,
                   preparation:cp.id===d.problem_id?{insight:cp.insight??null,code:cp.code??null,testing:cp.testing??null}:null,
                   preparation_timing:'visible_before_reveal_not_submission_time',team:object(before.contest).team??null});
 }
 const problems=new Map<string,Obj>();
 for(const j of judgements){
  if(!j.problem_id)continue;
  const p=problems.get(j.problem_id)??{problem_id:j.problem_id,attempts_observed:0,solved:false,failure_streak_observed:0,verdict_counts:{},last_preparation:null};
  p.attempts_observed++;p.verdict_counts[j.verdict]=(p.verdict_counts[j.verdict]??0)+1;
  p.solved ||= j.verdict==='AC';p.failure_streak_observed=j.verdict==='AC'?0:p.failure_streak_observed+1;p.last_preparation=j.preparation;p.last_observed_at=j.at;
  problems.set(j.problem_id,p);
 }
 const events=records.filter(e=>e.kind==='confirmed'&&e.tool==='vcpc_choose_event').map(e=>{
  const b=records.find(r=>r.action_id===e.action_id&&r.kind==='begin');const before=object(b?.before),d=object(before.dialog),after=object(e.after);
  let optionId:unknown;try{optionId=JSON.parse(e.args).option_id;}catch{}
  return {action_id:e.action_id,title:d.title??null,chosen_label:(d.options as Obj[]|undefined)?.find(o=>o.option_id===optionId)?.label??null,
          outcome:object(after.dialog).result??null,effects:object(after.dialog).effects??null};
 });
 const seenSelections=new Set<string>();
 const selections=records.flatMap((e,index)=>{
  if(e.kind!=='confirmed'||e.tool!=='vcpc_select_problem'||seenSelections.has(e.action_id))return [];
  seenSelections.add(e.action_id);
  const begin=records.find(r=>r.action_id===e.action_id&&r.kind==='begin');
  let requested:unknown;try{requested=JSON.parse(begin?.args??e.args).problem_id;}catch{}
  if(typeof requested!=='string')return [];
  const after=object(e.after);
  const later=records.slice(index+1);const nextSelection=later.findIndex(r=>r.kind==='begin'&&r.tool==='vcpc_select_problem');
  const window=nextSelection<0?later:later.slice(0,nextSelection);
  const resume=window.find(r=>{if(r.kind!=='confirmed'||r.tool!=='vcpc_control_contest'||object(r.after).run_id!==context.run_id)return false;try{return JSON.parse(r.args).operation==='resume';}catch{return false;}});
  const resumed=resume?object(resume.after):null;
  const immediate=after.run_id===context.run_id?object(after.contest).selected_problem??null:null;
  const afterResume=resumed?object(resumed.contest).selected_problem??null:null;
  return [{action_id:e.action_id,at:e.at,requested_problem_id:requested,observed_immediate_problem_id:immediate,
    resume_action_id:resume?.action_id??null,observed_after_resume_problem_id:afterResume,
    selection_observed_after_resume:afterResume===null?null:afterResume===requested,
    note:'Sampled selection only; this does not prove a permanent lock.'}];
 });
 const verdictCounts=Object.fromEntries((Array.isArray(f.verdicts)?f.verdicts:[]).map((v:Obj)=>[v.verdict,v.count]));
 const reasonsForChampion=[...reasons];
 if(rank!==1||fieldSize===null||fieldSize<1)reasonsForChampion.push('rank_not_first_or_missing');
 return {context,legacy_topbar_stage_hint:object(object(ledger.entries[startIndex].before).identity).stage??null,
         result:{stage:resultStage,heading:f.heading??null,rank,field_size:fieldSize,solved,penalty:numeric(fact(f,'罚时')),
                 submissions,verdict_counts:verdictCounts,rating_before:numeric(f.rating?.[0]),rating_after:numeric(f.rating?.[1]),
                 medal:f.medal??null,review_status:f.review_status??(rewardClaim?'claimed':'unknown'),
                 review_text:f.review_text??null,standings_text:f.standings_text??null},
         verification:{stage_verified:stageVerified,end_kind:endKind,review_complete:rewardComplete,ledger_unresolved:ledgerUnresolved,
                       natural_result_verified:reasons.length===0,champion_verified:reasonsForChampion.length===0,reasons,champion_reasons:reasonsForChampion},
         coverage:{revealed_judgements:judgements.length,final_submissions:submissions,complete:submissions===null?null:judgements.length===submissions,
                   note:'Preparation is visible before reveal, not guaranteed to be the submission-time state; failure streak is observed, not an internal rage meter.'},
         problems:[...problems.values()],judgements,events,problem_selections:selections,
         evidence:{start_action_id:ledger.entries[startIndex].action_id,start_line:startIndex+1,
                   final_line:final?ledger.entries.indexOf(final.entry)+1:null}};
}

export function profileReport(ledger:ReportLedger,limit=20){
 const starts=ledger.entries.filter(e=>e.kind==='begin'&&e.tool==='vcpc_start_contest'&&typeof e.detail==='string');
 const runs=[...new Set(starts.map(s=>s.detail!))].map(id=>runReport(ledger,id));
 const training=ledger.entries.filter(e=>e.kind==='confirmed'&&['vcpc_draw_training','vcpc_draw_training_ten'].includes(e.tool)).flatMap(e=>{
  const b=ledger.entries.find(r=>r.kind==='begin'&&r.action_id===e.action_id);const before=object(object(b?.before).identity),after=object(object(e.after).identity);
  if(integer(before.rating)===null||integer(after.rating)===null)return [];
  const cost=e.tool==='vcpc_draw_training_ten'?10:1,delta=after.rating-before.rating;
  return [{action_id:e.action_id,at:e.at,cost_tp:cost,rating_before:before.rating as number,rating_after:after.rating as number,rating_delta:delta,
    card_coverage:trainingCardCoverage(object(e.after),cost,delta)}];
 });
 const seen=new Set<string>();const uniqueTraining=training.filter(t=>!seen.has(t.action_id)&&!!seen.add(t.action_id));
 const window=uniqueTraining.slice(-limit),spent=uniqueTraining.reduce((s,t)=>s+t.cost_tp,0),delta=uniqueTraining.reduce((s,t)=>s+t.rating_delta,0);
 const trainingAttempts=ledger.entries.filter(e=>e.kind==='begin'&&['vcpc_draw_training','vcpc_draw_training_ten'].includes(e.tool)&&!notSent(ledger,e.action_id));
 return {contests:{start_attempts:starts.length,starts:runs.filter(r=>r.context.start_confirmed).length,
                  not_sent:starts.filter(s=>notSent(ledger,s.action_id)).length,
                  unconfirmed_starts:starts.filter(s=>!notSent(ledger,s.action_id)&&!confirmed(ledger,s.action_id)).length,
                  natural_verified:runs.filter(r=>r.verification.natural_result_verified).length,
                  early_end:runs.filter(r=>r.verification.end_kind==='early_end').length,unverified_stage:runs.filter(r=>!r.verification.stage_verified).length,
                  verified_champions:runs.filter(r=>r.verification.champion_verified).map(r=>({run_id:r.context.run_id,stage:r.context.stage,season:r.context.season}))},
         training:{draws:uniqueTraining.length,spent_tp:spent,spend_scope:'confirmed_draws_only',
                   reserved_tp:trainingAttempts.reduce((s,t)=>s+(t.tool==='vcpc_draw_training_ten'?10:1),0),
                   unconfirmed_draws:trainingAttempts.filter(t=>!confirmed(ledger,t.action_id)).map(t=>t.action_id),
                   rating_delta:delta,observed_rating_per_tp:spent?delta/spent:null,
                   by_starting_rating:trainingBands(uniqueTraining),card_coverage:trainingWindow(uniqueTraining).card_coverage,
                   recent:{...trainingWindow(window),records:window},
                   note:'Observed gains are rating-dependent and are not a guaranteed future expectation. Remaining TP is not valued as Rating.'},
         recent_runs:runs.slice(-limit).map(r=>({context:r.context,result:{...r.result,review_text:undefined,standings_text:undefined},verification:r.verification,coverage:r.coverage})),
         limitations:['Legacy runs lacking precontest/result stage evidence remain unverified; topbar hints are not promoted to proof.','No internal win probability, hidden problem rating or training cap is inferred.']};
}

export function verifyGoal(report:ReturnType<typeof runReport>,goal:{stage:string;achievement:'completed'|'gold'|'champion'}){
 const reasons=[...report.verification.reasons];
 if(report.context.stage!==goal.stage||report.result.stage!==goal.stage)reasons.push('target_stage_mismatch_or_unverified');
 if(goal.achievement==='champion'&&!report.verification.champion_verified)reasons.push(...report.verification.champion_reasons);
 if(goal.achievement==='gold'&&report.result.medal!=='gold')reasons.push('visible_gold_medal_missing');
 return {goal,verified:reasons.length===0,reasons:[...new Set(reasons)],run_id:report.context.run_id};
}
