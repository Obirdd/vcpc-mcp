import {test} from 'node:test';
import assert from 'node:assert/strict';
import {runContext,runReport,profileReport,verifyGoal} from '../dist/run-report.js';
const universe='可观测宇宙总决赛';
function fixture({stage=universe,resultStage=stage,rank='#1/16',reward=true,legacy=false,early=false}={}){
 const entries=[];let tick=0;
 const add=(kind,tool,id,view,extra={})=>entries.push({at:new Date(1000+tick++).toISOString(),kind,tool,action_id:id,args:'{}',[kind==='begin'?'before':'after']:structuredClone(view),...extra});
 const identity={team_name:'test',season:7,stage:'世界总决赛',rating:3950,tp:10};
 const before={phase:'strategy',run_id:null,identity,competition:{stage,source:'precontest_title'},strategy_details:[{name:'求稳流',selected:true}]};
 if(legacy)delete before.competition;
 add('begin','vcpc_start_contest','start',before,{detail:'run-1',document_token:1});
 const live={phase:'judge_pending',run_id:'run-1',identity,contest:{current_problem:{id:'A',insight:'90%',code:'100%',testing:'100%'},team:{stamina:'80',morale:'70'}},dialog:{problem_id:'A',submitted_at:'0:30'}};
 add('confirmed','vcpc_start_contest','start',live);
 add('begin','vcpc_reveal_judgement','judge',live);
 add('confirmed','vcpc_reveal_judgement','judge',{...live,phase:'judge_revealed',dialog:{...live.dialog,result:'AC'}});
 const final={phase:'final',run_id:'run-1',identity:{...identity,season:8,stage:'网络赛',rating:3951,tp:20},final:{stage:resultStage,heading:`FINAL STANDINGS · ${resultStage}`,rank,facts:['1\n过题','30\n罚时','1\n提交'],verdicts:[{verdict:'AC',count:1}],rating:['3,950','3,951'],reward:reward?'赛后复盘奖励已领取':'赛后复盘 +1 TP',review_status:reward?'claimed':'pending',medal:'gold'}};
 if(legacy)delete final.final.stage;
 if(early){add('begin','vcpc_end_contest','end',live);add('confirmed','vcpc_end_contest','end',final);}
 if(reward){add('begin','vcpc_claim_review_reward','claim',final);add('confirmed','vcpc_claim_review_reward','claim',final);}
 else{add('confirmed','vcpc_advance_result','batch',final);}
 return {entries,add,final,live};
}
test('verified universe first place uses precontest/result evidence, not the two different topbar stages',()=>{
 const l=fixture();const r=runReport(l);
 assert.equal(r.context.stage,universe);assert.equal(r.context.season,7);assert.equal(r.result.stage,universe);
 assert.equal(r.context.strategy,'求稳流');assert.equal(r.verification.champion_verified,true);
 assert.equal(verifyGoal(r,{stage:universe,achievement:'champion'}).verified,true);
 assert.equal(r.coverage.complete,true);assert.equal(r.judgements.length,1);assert.equal(r.problems[0].solved,true);
 assert.equal(r.judgements[0].preparation_timing,'visible_before_reveal_not_submission_time');
});
test('historical test1 failure mode: regional final rank1 cannot satisfy a world or universe championship',()=>{
 const l=fixture({stage:'区域决赛',rank:'#1/276'});const r=runReport(l);
 assert.equal(r.legacy_topbar_stage_hint,'世界总决赛');assert.equal(r.verification.champion_verified,true);
 for(const stage of ['世界总决赛',universe])assert.equal(verifyGoal(r,{stage,achievement:'champion'}).verified,false);
});
test('mismatched stages, missing legacy evidence, rank3, early end, missing reward and unresolved actions never verify champion',()=>{
 for(const args of [{resultStage:'世界总决赛'},{legacy:true},{rank:'#3/16'},{early:true},{reward:false}]){
  const r=runReport(fixture(args));assert.equal(verifyGoal(r,{stage:universe,achievement:'champion'}).verified,false,JSON.stringify(args));
 }
 const l=fixture();l.add('begin','vcpc_select_problem','unknown',l.live);
 assert.equal(runReport(l).verification.champion_verified,false);
 assert.equal(runContext(l).stage,universe);
});
test('AK requires the explicit observed no-review predicate; missing reward text is not sufficient',()=>{
 const l=fixture({reward:false});let f=l.entries.at(-1).after.final;
 f.reward=null;f.review_status='not_offered';assert.equal(runReport(l).verification.champion_verified,false);
 f.facts.push('AK\n全过');assert.equal(runReport(l).verification.champion_verified,true);
});
test('wrong run final and incomplete reveal history remain visible coverage gaps',()=>{
 const l=fixture();l.entries.at(-1).after.run_id='other';
 l.entries.find(e=>e.kind==='begin'&&e.tool==='vcpc_claim_review_reward').before.run_id='other';
 assert.equal(runReport(l).verification.champion_verified,false);
 const m=fixture();m.entries=m.entries.filter(e=>e.tool!=='vcpc_reveal_judgement');
 assert.equal(runReport(m).coverage.complete,false);assert.equal(runReport(m).coverage.final_submissions,1);
});
test('profile totals derive from unique actions and show actual training changes without valuing remaining TP',()=>{
 const l=fixture();l.add('begin','vcpc_draw_training_ten','train',{identity:{rating:3951}});
 l.add('confirmed','vcpc_draw_training_ten','train',{identity:{rating:3940}});
 l.entries.push(structuredClone(l.entries.at(-1)));
 const r=profileReport(l);assert.equal(r.contests.starts,1);assert.equal(r.contests.verified_champions.length,1);
 assert.equal(r.training.draws,1);assert.equal(r.training.spent_tp,10);assert.equal(r.training.rating_delta,-11);
 assert.equal(r.training.observed_rating_per_tp,-1.1);
});
test('problem selection report distinguishes the requested problem from immediate and post-resume samples',()=>{
 const l=fixture();
 for(const [id,wanted,immediate,resumed] of [['one','B','B','C'],['two','D','D','D']]){
  const args=JSON.stringify({problem_id:wanted}),view={...l.live,contest:{selected_problem:immediate}};
  l.add('begin','vcpc_select_problem',id,l.live,{args});l.add('confirmed','vcpc_select_problem',id,view,{args});
  l.add('begin','vcpc_control_contest',id+'-resume',view,{args:'{"operation":"resume"}'});
  l.add('confirmed','vcpc_control_contest',id+'-resume',{...view,contest:{selected_problem:resumed}},{args:'{"operation":"resume"}'});
 }
 const r=runReport(l).problem_selections;
 assert.equal(r.length,2);assert.equal(r[0].requested_problem_id,'B');assert.equal(r[0].observed_immediate_problem_id,'B');
 assert.equal(r[0].observed_after_resume_problem_id,'C');assert.equal(r[0].selection_observed_after_resume,false);
 assert.equal(r[1].selection_observed_after_resume,true);
});
test('conflicting public verdict totals cannot verify a result even if its rank and stage match',()=>{
 const l=fixture();l.entries.at(-1).after.final.verdicts[0].count=0;
 const r=runReport(l);assert.ok(r.verification.reasons.includes('result_totals_incomplete_or_conflicting'));
 assert.equal(verifyGoal(r,{stage:universe,achievement:'champion'}).verified,false);
});
test('attempted/not-sent starts and unconfirmed training spend cannot masquerade as completed actions',()=>{
 const l=fixture();const before={phase:'strategy',run_id:null,identity:{team_name:'test'},competition:{stage:universe,source:'precontest_title'}};
 l.add('begin','vcpc_start_contest','refused',before,{detail:'run-2'});l.add('not_sent','vcpc_start_contest','refused',{});
 l.add('begin','vcpc_draw_training_ten','uncertain',{identity:{rating:3900}});l.add('unknown','vcpc_draw_training_ten','uncertain',{identity:{rating:3850}});
 const r=profileReport(l);assert.equal(r.contests.start_attempts,2);assert.equal(r.contests.starts,1);assert.equal(r.contests.not_sent,1);
 assert.equal(r.training.spent_tp,0);assert.equal(r.training.reserved_tp,10);assert.deepEqual(r.training.unconfirmed_draws,['uncertain']);assert.equal(r.training.rating_delta,0);
});
