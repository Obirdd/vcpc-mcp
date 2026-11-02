import {test} from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync, rmSync} from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {Ledger} from '../dist/actions/ledger.js';
import {advance, AdvanceOptions} from '../dist/advance.js';
import {StrategyWatch} from '../dist/strategy-checkpoints.js';
import {gameMinutes} from '../dist/game-clock.js';
import {settledEvidence} from '../dist/recovery.js';

const view=(phase, minute='0:30', problem='A', preparation=['50%','50%','50%'], result='WA')=>({
 phase, run_id:'run', identity:{team_name:'test'},
 contest:{elapsed:minute, selected_problem:problem, speed:4, playback:phase==='contest_paused'?'paused':'running',
  current_problem:{id:problem,insight:preparation[0],code:preparation[1],testing:preparation[2]}},
 dialog:['judge_pending','judge_revealed','event_choice','event_result'].includes(phase)
  ?{decision_id:phase+minute,problem_id:problem,result:phase==='judge_revealed'?result:null,title:'event',options:[{option_id:'a',label:'a'}]}:null
});
function setup(states){
 const dir=mkdtempSync(path.join(os.tmpdir(),'vcpc-reliability-')),ledger=new Ledger(dir);let n=0;
 const calls=[];const io={ledger,read:async()=>structuredClone(states[n]),wait:async()=>{},execute:async(tool,id,args)=>{
  calls.push({tool,id,args});const before=states[n];n=Math.min(n+1,states.length-1);const after=structuredClone(states[n]);
  ledger.append({at:new Date().toISOString(),kind:'begin',tool,action_id:id,args:JSON.stringify(args),before});
  ledger.append({at:new Date().toISOString(),kind:'confirmed',tool,action_id:id,args:JSON.stringify(args),after});
  return {status:'confirmed',after};
 }};
 return {ledger,io,calls,done(){ledger.close();rmSync(dir,{recursive:true,force:true});}};
}
test('game clock parses hours and minutes without assuming seconds or a fixed 300-minute total',()=>{
 for(const [s,n] of [['0:06',6],['1:00',60],['5:00',300],['5:12',312],['剩余 4:54',294],['已用 0:06',6]])assert.equal(gameMinutes(s),n);
 for(const s of [null,undefined,'0:60','00:6','-1:00','2 minutes','999999999999999999999:00'])assert.equal(gameMinutes(s),null);
});
test('explicit drain handles one intervening judgement and pauses, then replay performs no actions',async()=>{
 const t=setup([view('judge_revealed'),view('judge_pending'),view('judge_revealed'),view('contest_running'),view('contest_paused')]);
 try{const opts=AdvanceOptions.parse({stop_after_judgements:1,pause_at_checkpoint:true,pause_drain_limit:1});
  const r=await advance(t.io,'drain',opts);assert.equal(r.checkpoint.paused,true);assert.equal(r.checkpoint.drained_dialogs,1);
  assert.equal(r.checkpoint.pause_blocked_reason,null);assert.equal(r.collected_judgements,2);
  assert.deepEqual(t.calls.map(c=>c.tool),['vcpc_collect_judgement','vcpc_reveal_judgement','vcpc_collect_judgement','vcpc_control_contest']);
  assert.equal((await advance(t.io,'drain',opts)).status,'batch_replay');assert.equal(t.calls.length,4);
 }finally{t.done();}
});
test('drain never chooses an event, stops at its limit and honors disabled automatic handling',async()=>{
 for(const [phase,extra,reason,n] of [
  ['event_choice',{},'event_choice_requires_decision',1],
  ['judge_pending',{auto_judgements:false},'auto_judgements_disabled',0],
  ['event_result',{continue_event_results:false},'continue_event_results_disabled',0]
 ]){
  const states=n?[view('judge_revealed'),view(phase)]:[view(phase)];const t=setup(states);
  try{const r=await advance(t.io,'blocked',AdvanceOptions.parse({stop_at_elapsed_minutes:30,pause_at_checkpoint:true,pause_drain_limit:1,
   event_rules:[{title:'event',options:['a'],choose:'a'}],...extra}));
   assert.equal(r.status,'checkpoint');assert.equal(r.checkpoint.paused,false);assert.equal(r.checkpoint.pause_blocked_reason,reason);
   assert.ok(!t.calls.some(c=>c.tool==='vcpc_choose_event'));
  }finally{t.done();}
 }
 const t=setup([view('judge_pending'),view('judge_revealed'),view('judge_pending')]);
 try{const r=await advance(t.io,'limit',AdvanceOptions.parse({stop_at_elapsed_minutes:30,pause_at_checkpoint:true,pause_drain_limit:1}));
  assert.equal(r.checkpoint.pause_blocked_reason,'drain_limit_reached');assert.equal(r.checkpoint.drained_dialogs,1);assert.equal(t.calls.length,2);
 }finally{t.done();}
});
test('pause losing its clear window can drain normally; unknown results, step budget and cancellation stop writes',async()=>{
 const t=setup([view('contest_running'),view('judge_revealed'),view('contest_running'),view('contest_paused')]);
 try{const execute=t.io.execute;let first=true;
  t.io.execute=async(...args)=>{const r=await execute(...args);if(first){first=false;return {status:'blocked_by_dialog',before:r.after};}return r;};
  const r=await advance(t.io,'race',AdvanceOptions.parse({stop_at_elapsed_minutes:30,pause_at_checkpoint:true,pause_drain_limit:1}));
  assert.equal(r.checkpoint.paused,true);assert.deepEqual(t.calls.map(c=>c.tool),['vcpc_control_contest','vcpc_collect_judgement','vcpc_control_contest']);
 }finally{t.done();}
 for(const kind of ['unknown','cancelled','steps']){
  const t=setup([view('judge_revealed'),view('contest_running')]),abort=new AbortController();
  try{if(kind==='unknown')t.io.execute=async()=>{t.calls.push({tool:'attempt'});return {status:'outcome_unknown'};};
   if(kind==='cancelled'){const execute=t.io.execute;t.io.execute=async(...args)=>{const r=await execute(...args);abort.abort();return r;};}
   const r=await advance(t.io,kind,AdvanceOptions.parse({stop_at_elapsed_minutes:30,pause_at_checkpoint:true,pause_drain_limit:1,...(kind==='steps'?{max_steps:1}:{})}),abort.signal);
   assert.equal(r.status,kind==='unknown'?'outcome_unknown':kind==='cancelled'?'cancelled':'step_limit');
   assert.equal(r.checkpoint.paused,false);assert.equal(t.calls.length,1);
  }finally{t.done();}
 }
 const u=setup([view('contest_running')]);try{await assert.rejects(advance(u.io,'bad',AdvanceOptions.parse({pause_drain_limit:1})),/requires_pause/);assert.equal(u.ledger.entries.length,0);}finally{u.done();}
});
test('failure checkpoint persists across batches, resets on AC, and a failed old problem does not block a new selection',async()=>{
 const t=setup([view('judge_pending'),view('judge_revealed'),view('judge_pending','0:40'),view('judge_revealed','0:40'),view('contest_running','0:40'),view('contest_paused','0:40')]);
 try{await advance(t.io,'first',AdvanceOptions.parse({max_steps:2}));
  const r=await advance(t.io,'second',AdvanceOptions.parse({stop_on_failure_streak:2,pause_at_checkpoint:true}));
  assert.equal(r.status,'checkpoint');assert.equal(r.checkpoint.reason,'failure_streak');assert.equal(r.checkpoint.observed_failures,2);assert.equal(r.checkpoint.paused,true);
  const watch=new StrategyWatch(t.ledger.entries,'run');
  assert.equal(watch.checkpoint(view('contest_running','0:50','B'),2),undefined);
  watch.judgement('success',{problem_id:'A',result:'AC'});assert.equal(watch.checkpoint(view('contest_running'),2),undefined);
  watch.judgement('success',{problem_id:'A',result:'WA'});assert.equal(watch.summary().failure_streaks_observed[0].count,0);
 }finally{t.done();}
});
test('an expired drain budget never dispatches the pending pause',async()=>{
 const t=setup([view('judge_revealed'),view('contest_running')]);let time=0;
 try{t.io.now=()=>time;const execute=t.io.execute;t.io.execute=async(...args)=>{const r=await execute(...args);time=2000;return r;};
  const r=await advance(t.io,'time',AdvanceOptions.parse({timeout_ms:1000,stop_at_elapsed_minutes:30,pause_at_checkpoint:true,pause_drain_limit:1}));
  assert.equal(r.status,'time_limit');assert.equal(r.checkpoint.pause_blocked_reason,'time_limit');assert.equal(t.calls.length,1);
 }finally{t.done();}
});
test('a final-screen batch preserves settled recovery evidence rather than replacing it with an incomplete identity',async()=>{
 const identity={team_name:'test',season:2,stage:'网络赛',rating:1000,tp:12};
 const final={phase:'final',run_id:'run',identity,final:{reward:'赛后复盘奖励已领取'}};
 const t=setup([final]);
 try{const add=(kind,tool,action_id,after)=>t.ledger.append({kind,tool,action_id,args:'{}',at:new Date().toISOString(),...(after?{after}:{})});
  add('begin','vcpc_start_contest','start');add('confirmed','vcpc_start_contest','start');
  add('begin','vcpc_claim_review_reward','reward');add('confirmed','vcpc_claim_review_reward','reward',final);
  assert.equal((await advance(t.io,'finished',AdvanceOptions.parse({}))).status,'final');assert.equal(t.calls.length,0);
  assert.deepEqual(settledEvidence(t.ledger.entries,'test').identity,identity);
 }finally{t.done();}
});
test('preparation stalls use game time and survive batch boundaries; changes, switches and missing values reset the window',async()=>{
 const t=setup([view('contest_running','0:10')]);
 try{await advance(t.io,'save',AdvanceOptions.parse({stop_at_elapsed_minutes:10}));
  t.io.read=async()=>view('contest_paused','0:16');
  const r=await advance(t.io,'stall',AdvanceOptions.parse({stop_on_preparation_stall_minutes:5}));
  assert.equal(r.checkpoint.reason,'preparation_stall');assert.equal(r.checkpoint.unchanged_for_game_minutes,6);assert.equal(t.calls.length,0);
  for(const changed of [view('contest_running','0:14','B'),view('contest_running','0:14','A',['51%','50%','50%']),view('contest_running','0:14','A',[null,'50%','50%'])]){
   const w=new StrategyWatch([],'run');w.observe(view('contest_running','0:10'));w.observe(changed);w.observe(view('contest_running','0:16'));
   assert.equal(w.checkpoint(view('contest_running','0:16'),undefined,5),undefined);
  }
 }finally{t.done();}
});
