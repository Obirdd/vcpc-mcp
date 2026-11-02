import {test} from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync,rmSync} from 'node:fs';
import os from 'node:os';import path from 'node:path';
import {Ledger} from '../dist/actions/ledger.js';
import {advance,AdvanceOptions,EventRule} from '../dist/advance.js';
import {ActionController} from '../dist/actions/controller.js';
const view=(phase,elapsed='0:30')=>({phase,identity:{team_name:'test'},contest:{elapsed,speed:4,playback:phase==='contest_paused'?'paused':'running'},dialog:['judge_pending','judge_revealed','event_choice'].includes(phase)?{decision_id:phase,title:'event',options:[{label:'a',option_id:'a'}],result:phase==='judge_revealed'?'WA':null}:null});
function setup(states){const dir=mkdtempSync(path.join(os.tmpdir(),'vcpc-decision-'));const ledger=new Ledger(dir);let n=0;const calls=[];return {ledger,calls,io:{ledger,read:async()=>structuredClone(states[n]),wait:async()=>{},execute:async(tool,id,args)=>{calls.push({tool,id,args});n=Math.min(n+1,states.length-1);return {status:'confirmed',after:structuredClone(states[n])};}},done(){ledger.close();rmSync(dir,{recursive:true,force:true});}};}
test('one collected judgement checkpoints and pauses through the normal controller, never replaying',async()=>{
 const t=setup([view('judge_pending'),view('judge_revealed'),view('contest_running'),view('contest_paused')]);
 try{const o=AdvanceOptions.parse({stop_after_judgements:1,pause_at_checkpoint:true});const r=await advance(t.io,'one',o);
  assert.equal(r.status,'checkpoint');assert.equal(r.collected_judgements,1);assert.equal(r.checkpoint.paused,true);
  assert.deepEqual(t.calls.map(x=>x.tool),['vcpc_reveal_judgement','vcpc_collect_judgement','vcpc_control_contest']);
  assert.deepEqual(t.calls.at(-1).args,{operation:'pause'});assert.equal((await advance(t.io,'one',o)).status,'batch_replay');assert.equal(t.calls.length,3);
 }finally{t.done();}
});
test('checkpoint never dismisses an intervening event or claims a pause it did not confirm',async()=>{
 for(const phase of ['event_choice','judge_pending']){const t=setup([view('judge_revealed'),view(phase)]);try{
  const r=await advance(t.io,'blocked',AdvanceOptions.parse({stop_after_judgements:1,pause_at_checkpoint:true,event_rules:[{title:'event',options:['a'],choose:'a'}]}));
  assert.equal(r.status,'checkpoint');assert.equal(r.checkpoint.paused,false);assert.deepEqual(t.calls.map(c=>c.tool),['vcpc_collect_judgement']);
 }finally{t.done();}}
});
test('in-game elapsed checkpoint interprets 1:00 as sixty minutes; final takes priority',async()=>{
 const t=setup([view('contest_running','1:00')]);try{const r=await advance(t.io,'time',AdvanceOptions.parse({stop_at_elapsed_minutes:60}));assert.equal(r.status,'checkpoint');assert.equal(r.checkpoint.reason,'elapsed_time');assert.equal(t.calls.length,0);}finally{t.done();}
 const u=setup([view('final','5:00')]);try{assert.equal((await advance(u.io,'final',AdvanceOptions.parse({stop_at_elapsed_minutes:60,pause_at_checkpoint:true}))).status,'final');assert.equal(u.calls.length,0);}finally{u.done();}
});
test('step budget, cancellation and failed pause stop without extra dispatch or false success',async()=>{
 const t=setup([view('judge_revealed'),view('contest_running')]);try{const r=await advance(t.io,'limited',AdvanceOptions.parse({max_steps:1,stop_after_judgements:1,pause_at_checkpoint:true}));assert.equal(r.status,'checkpoint');assert.equal(r.checkpoint.paused,false);assert.equal(t.calls.length,1);}finally{t.done();}
 const u=setup([view('contest_running')]);try{u.io.execute=async()=>({status:'outcome_unknown'});const r=await advance(u.io,'fail',AdvanceOptions.parse({stop_at_elapsed_minutes:30,pause_at_checkpoint:true}));assert.equal(r.status,'outcome_unknown');assert.equal(r.checkpoint.paused,false);}finally{u.done();}
 const v=setup([view('contest_running')]);try{assert.equal((await advance(v.io,'cancel',AdvanceOptions.parse({stop_at_elapsed_minutes:0,pause_at_checkpoint:true}),AbortSignal.abort())).status,'cancelled');assert.equal(v.calls.length,0);}finally{v.done();}
});
test('expected_stage refuses topbar-only and changed-stage starts before logging or clicking',async()=>{
 const t=setup([]);let clicks=0;const state={phase:'strategy',identity:{team_name:'test',stage:'世界总决赛'},competition:{stage:'区域决赛',source:'precontest_title'}};
 const driver={observe:async()=>structuredClone(state),perform:async()=>{clicks++;return structuredClone(state);}};
 const c=new ActionController(driver,t.ledger,'test');try{
  assert.equal((await c.execute('vcpc_start_contest','wrong',{expected_stage:'世界总决赛'})).status,'stage_unverified_or_mismatch');
  state.competition.stage='世界总决赛';state.competition.source='unverified';
  assert.equal((await c.execute('vcpc_start_contest','unknown',{expected_stage:'世界总决赛'})).status,'stage_unverified_or_mismatch');
  assert.equal(t.ledger.entries.length,0);assert.equal(clicks,0);
  state.competition.source='precontest_title';assert.equal((await c.execute('vcpc_start_contest','valid',{expected_stage:'世界总决赛'})).status,'confirmed');assert.equal(clicks,1);
 }finally{t.done();}
});

test('whitespace matching is opt-in, preserves actual option IDs and rejects cost/order/ambiguity changes',async()=>{
 const rule={title:'上下文窗口已满',options:['压缩到一页纸 5 分钟 思路 +20','保留关键边界 2 分钟 思路 +8'],choose:'压缩到一页纸 5 分钟 思路 +20'};
 const labels=['压缩到一页纸\n5 分钟\n思路 +20','保留关键边界\n2 分钟\n思路 +8'];
 for(const [matching,opts,clicks] of [[undefined,labels,0],['whitespace',labels,1],['whitespace',[labels[0].replace('5 分钟','6 分钟'),labels[1]],0],['whitespace',[labels[1],labels[0]],0]]){
  const first=view('event_choice');first.dialog.title='上下文窗口已满';first.dialog.options=opts.map((label,i)=>({label,option_id:`real-${i}`}));
  const t=setup([first,view('final')]);try{const r=await advance(t.io,'format',AdvanceOptions.parse({event_rules:[{...rule,...(matching?{matching}:{})}]}));assert.equal(t.calls.length,clicks);if(clicks){assert.equal(t.calls[0].args.option_id,'real-0');assert.equal(r.steps[0].match.matching,'whitespace');}}finally{t.done();}
 }
 assert.throws(()=>EventRule.parse({title:'e',options:['a b','a\nb'],choose:'a b',matching:'whitespace'}));
 const first=view('event_choice');first.dialog.title=rule.title;first.dialog.options=labels.map((label,i)=>({label,option_id:String(i)}));
 const t=setup([first]);try{const r=await advance(t.io,'duplicate',AdvanceOptions.parse({event_rules:[{...rule,matching:'whitespace'},{...rule,matching:'whitespace'}]}));assert.equal(r.status,'decision_required');assert.equal(r.decision.match.reason,'ambiguous');assert.equal(t.calls.length,0);}finally{t.done();}
});
