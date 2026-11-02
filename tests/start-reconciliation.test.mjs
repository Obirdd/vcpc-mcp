import {test} from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync,rmSync} from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {Ledger,verifiedStartResolution} from '../dist/actions/ledger.js';
import {reconcileStart} from '../dist/reconcile-start.js';
const base=()=>[
 {at:new Date().toISOString(),kind:'begin',tool:'vcpc_start_contest',action_id:'start',args:'{}',document_token:123,before:{phase:'strategy',identity:{team_name:'test'}}},
 {at:new Date().toISOString(),kind:'unknown',tool:'vcpc_start_contest',action_id:'start',args:'{}',after:{phase:'unknown',identity:{team_name:null}}}
];
const view={phase:'judge_pending',identity:{team_name:'test'}};
const fixture=()=>{const root=mkdtempSync(path.join(os.tmpdir(),'vcpc-start-'));const ledger=new Ledger(root);return {ledger,close(){ledger.close();rmSync(root,{recursive:true,force:true});}};};
test('same-document visible start reconciliation appends evidence and confirmed without replaying any click',async()=>{
 const f=fixture();try{
  base().forEach(e=>f.ledger.append(e));let reads=0;
  const driver={documentToken:async()=>123,observe:async()=>{reads++;return view;},perform:async()=>{throw Error('must_never_click');}};
  assert.equal(f.ledger.unresolved(),true);
  assert.deepEqual(await reconcileStart(driver,f.ledger,'test','start'),view);
  assert.equal(reads,1);assert.equal(f.ledger.unresolved(),false);
  assert.equal(f.ledger.entries[1].kind,'unknown');assert.equal(f.ledger.entries.at(-1).kind,'confirmed');
  assert.equal(verifiedStartResolution(f.ledger.entries,'start'),true);
  const changed=structuredClone(f.ledger.entries);changed[2].after.identity.team_name='other';
  assert.equal(verifiedStartResolution(changed,'start'),false);
 }finally{f.close();}
});
test('start reconciliation refuses changed documents, identities, non-contest phases, other unknowns and wrong action IDs without appending',async()=>{
 for(const condition of ['changed_before','changed_during','wrong_team','lobby','wrong_id','other_unknown','other_action']){
  const f=fixture();try{
   if(condition==='other_unknown')for(const e of [{kind:'begin'},{kind:'unknown'}])f.ledger.append({at:new Date().toISOString(),action_id:'old',tool:'vcpc_select_problem',args:'{}',...e});
   const entries=base();if(condition==='other_action')entries.forEach(e=>e.tool='vcpc_select_problem');entries.forEach(e=>f.ledger.append(e));
   let n=0;const driver={documentToken:async()=>condition==='changed_before'?999:condition==='changed_during'&&n++?999:123,observe:async()=>({...view,phase:condition==='lobby'?'lobby':view.phase,identity:{team_name:condition==='wrong_team'?'other':'test'}})};
   const count=f.ledger.entries.length;
   await assert.rejects(reconcileStart(driver,f.ledger,'test',condition==='wrong_id'?'wrong':'start'));
   assert.equal(f.ledger.entries.length,count);assert.equal(f.ledger.unresolved(),true);
  }finally{f.close();}
 }
});
