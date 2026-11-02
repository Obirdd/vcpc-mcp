import {test} from 'node:test';
import assert from 'node:assert/strict';
import {profileReport} from '../dist/run-report.js';
import {trainingCardCoverage, trainingBands} from '../dist/training-stats.js';
const receipt=deltas=>({dialog:{effects:['十连训练','10 TP','结果',...deltas.flatMap((n,i)=>['SSR',String(i),`卡${i}`,String(n)])]}});
test('card statistics require complete reconciled receipts; unknown values remain unknown',()=>{
 const deltas=[0,1,0,-1,0,2,0,-1,0,0];
 const ok=trainingCardCoverage(receipt(deltas),10,1);assert.equal(ok.zero_delta_cards,6);assert.equal(ok.complete,true);
 for(const [view,cost,delta] of [[{},10,0],[receipt(deltas.slice(1)),10,1],[receipt(deltas),10,3]]){
  const c=trainingCardCoverage(view,cost,delta);assert.equal(c.complete,false);assert.equal(c.zero_delta_cards,null);assert.equal(c.observed_cards,0);
 }
 assert.equal(trainingCardCoverage({dialog:{result:'0 RATING'}},1,0).zero_delta_cards,1);
 assert.equal(trainingCardCoverage({dialog:{result:'0 RATING'}},1,2).complete,false);
});
test('profile stats group by starting Rating, deduplicate draws and exclude unconfirmed spend from gains',()=>{
 const entries=[];const add=(kind,id,rating,dialog)=>entries.push({at:'2026-11-02T00:00:00Z',kind,tool:'vcpc_draw_training_ten',action_id:id,args:'{}',
  [kind==='begin'?'before':'after']:{identity:{rating},dialog}});
 add('begin','low',1200);add('confirmed','low',1300,receipt(Array(10).fill(10)).dialog);
 add('begin','high',3990);add('confirmed','high',3991,receipt([0,1,0,-1,0,2,0,-1,0,0]).dialog);
 entries.push(structuredClone(entries.at(-1)));
 add('begin','unknown',3991);add('unknown','unknown',3900);
 add('begin','missing-cards',3400);add('confirmed','missing-cards',3390);
 const report=profileReport({entries},2),t=report.training;
 assert.equal(t.draws,3);assert.equal(t.spent_tp,30);assert.equal(t.reserved_tp,40);assert.equal(t.rating_delta,91);
 assert.equal(t.by_starting_rating.length,3);const high=t.by_starting_rating.find(b=>b.min_rating===3950);
 assert.equal(high.spent_tp,10);assert.equal(high.mean_rating_delta_per_ten,1);assert.equal(high.card_coverage.zero_delta_fraction_of_observed_cards,0.6);
 assert.equal(t.card_coverage.observed_cards,20);assert.equal(t.card_coverage.expected_cards,30);assert.equal(t.card_coverage.complete,false);
 assert.equal(t.recent.draws,2);assert.equal(t.recent.rating_delta,-9);assert.deepEqual(t.unconfirmed_draws,['unknown']);
 assert.equal(trainingBands([{cost_tp:1,rating_before:5000,rating_delta:1,card_coverage:trainingCardCoverage({dialog:{result:'+1 RATING'}},1,1)}])[0].min_rating,4000);
});
