import {test} from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync, writeFileSync, appendFileSync, rmSync} from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {eventKnowledge, KNOWLEDGE_MAX_BYTES} from '../dist/knowledge.js';

const record=(n,result='结果甲')=>[
 {kind:'begin',tool:'vcpc_choose_event',action_id:`choice-${n}`,args:'{"option_id":"a"}',before:{dialog:{title:'分页测试',options:[{option_id:'a',label:'选项甲'}]}}},
 {kind:'confirmed',tool:'vcpc_choose_event',action_id:`choice-${n}`,args:'{"option_id":"a"}',after:{dialog:{result,effects:['士气 +1']}}}
].map(x=>JSON.stringify(x)+'\n').join('');
const setup=()=>{const dir=mkdtempSync(path.join(os.tmpdir(),'vcpc-bounded-'));return {log:path.join(dir,'actions.jsonl'),done(){rmSync(dir,{recursive:true,force:true});}};};
test('hundreds of repeated observations keep exact counts but only two summary refs',()=>{
 const t=setup();try{writeFileSync(t.log,Array.from({length:600},(_,n)=>record(n)).join(''));
  const r=eventKnowledge('分页测试',t.log),out=r.events[0].branches[0].outcomes[0];
  assert.equal(r.counts.observation_count,600);assert.equal(out.sample_count,600);assert.equal(out.evidence_ref_count,600);assert.equal(out.evidence_refs.length,2);
  assert.ok(Buffer.byteLength(JSON.stringify(r))<5000);assert.equal(r.events[0].observations,undefined);
 }finally{t.done();}
});
test('detail pages recover every original observation once and reject stale or mismatched cursors',()=>{
 const t=setup();try{writeFileSync(t.log,Array.from({length:53},(_,n)=>record(n,`结果${n}`)).join(''));
  const ids=[],key=eventKnowledge('分页测试',t.log).events[0].event_key;let cursor;
  do{const r=eventKnowledge('分页测试',t.log,true,{limit:7,event_key:key,cursor});
   assert.equal(r.counts.observation_count,53);assert.ok(Buffer.byteLength(JSON.stringify(r))<=KNOWLEDGE_MAX_BYTES);
   ids.push(...r.events.flatMap(e=>e.observations.map(o=>o.action_id)));cursor=r.pagination.next_cursor??undefined;
  }while(cursor);
  assert.equal(ids.length,53);assert.equal(new Set(ids).size,53);
  const first=eventKnowledge('分页测试',t.log,true,{limit:1});cursor=first.pagination.next_cursor;
  assert.throws(()=>eventKnowledge('其他标题',t.log,true,{cursor}),/query_mismatch/);
  assert.throws(()=>eventKnowledge('分页测试',t.log,false,{cursor}),/query_mismatch/);
  appendFileSync(t.log,record(54));assert.throws(()=>eventKnowledge('分页测试',t.log,true,{cursor}),/cursor_stale/);
  assert.throws(()=>eventKnowledge('分页测试',t.log,true,{cursor:Buffer.from('null').toString('base64url')}),/cursor_invalid/);
  assert.throws(()=>eventKnowledge('分页测试',t.log,true,{limit:0}));
 }finally{t.done();}
});
test('outcome truncation is explicit, detail retains omitted groups and byte limits reduce page size',()=>{
 const t=setup();try{writeFileSync(t.log,Array.from({length:14},(_,n)=>record(n,`结果${n} ${'长'.repeat(1400)}`)).join(''));
  const summary=eventKnowledge('分页测试',t.log),branch=summary.events[0].branches[0];
  assert.equal(branch.outcome_count,14);assert.equal(branch.outcomes.length,8);assert.equal(branch.omitted_outcomes,6);
  const r=eventKnowledge('分页测试',t.log,true,{limit:100});assert.ok(r.pagination.returned<14);assert.ok(r.pagination.next_cursor);
  assert.ok(Buffer.byteLength(JSON.stringify(r))<=KNOWLEDGE_MAX_BYTES);
  let count=r.pagination.returned,cursor=r.pagination.next_cursor;
  while(cursor){const next=eventKnowledge('分页测试',t.log,true,{limit:100,cursor});
   assert.ok(Buffer.byteLength(JSON.stringify(next))<=KNOWLEDGE_MAX_BYTES);count+=next.pagination.returned;cursor=next.pagination.next_cursor;}
  assert.equal(count,14);
 }finally{t.done();}
});
test('summary event pagination preserves global match counts',()=>{
 const all=eventKnowledge(),r=eventKnowledge(undefined,undefined,false,{limit:2});
 assert.equal(r.events.length,2);assert.equal(r.counts.variant_count,all.counts.variant_count);
 const next=eventKnowledge(undefined,undefined,false,{limit:2,cursor:r.pagination.next_cursor});
 assert.ok(next.events.every(e=>!r.events.some(first=>first.event_key===e.event_key)));
});
