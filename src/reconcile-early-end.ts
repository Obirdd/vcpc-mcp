import {createHash} from 'node:crypto';
import type {ActionDriver,View} from './actions/controller.js';
import type {Ledger} from './actions/ledger.js';

export async function reconcileEarlyEnd(driver:ActionDriver,ledger:Ledger,team:string,id:string){
  ledger.assertOwned();
  const records=ledger.records(id),b=records.find(e=>e.kind==='begin'),u=records.find(e=>e.kind==='unknown');
  if(!b||!u||b.tool!=='vcpc_end_contest'||u.tool!==b.tool||b.args!==u.args||ledger.resolution(id))throw Error('not_pending_early_end');
  const current=await driver.observe(),currentToken=await driver.documentToken?.();
  if(current.phase==='final'){
    const startIndex=ledger.entries.reduce((last,e,i)=>e.kind==='begin'&&e.tool==='vcpc_start_contest'?i:last,-1),start=ledger.entries[startIndex];
    if(startIndex<0||!currentToken||currentToken!==start.document_token||currentToken!==b.document_token||current.identity.team_name!==team||!(current.final as {rank?:string}|null)?.rank)throw Error('final_run_unverified');
    const tail=ledger.entries.slice(startIndex+1),unknowns=tail.filter(e=>e.kind==='unknown');
    if(!tail.some(e=>e.kind==='confirmed'&&e.tool==='vcpc_start_contest'&&e.action_id===start.action_id)||!unknowns.some(e=>e.action_id===id))throw Error('final_run_unverified');
    for(const e of tail){
      if(e.kind==='confirmed'&&e.tool==='vcpc_start_contest'&&e.action_id===start.action_id)continue;
      const begin=tail.find(b=>b.kind==='begin'&&b.action_id===e.action_id),oldView=begin?.before as View|undefined;
      if(!['begin','unknown'].includes(e.kind)||e.tool!=='vcpc_end_contest'||!begin||begin.document_token!==currentToken||oldView?.identity.team_name!==team||!['contest_running','contest_paused','end_confirmation'].includes(oldView.phase)||!unknowns.some(u=>u.action_id===e.action_id&&u.args===begin.args))throw Error('other_activity_after_unknown');
    }
    for(const unknown of unknowns)ledger.append({at:new Date().toISOString(),kind:'resolution',tool:'vcpc_reconcile_early_end',action_id:unknown.action_id,args:'{}',after:current,document_token:currentToken,detail:JSON.stringify({actor:'server_verified_early_end_final',result:'confirmed',evidence_sha256:createHash('sha256').update(JSON.stringify(current)).digest('hex')})});
    if(ledger.unresolved())throw Error('final_end_resolution_unverified');
    return {status:'early_end_verified',observation:current};
  }
  const old=b.before as View|undefined;
  if(!old||!['contest_running','contest_paused'].includes(old.phase)||old.identity.team_name!==team)throw Error('original_end_unverified');
  const unresolved=ledger.entries.filter(e=>e.kind==='unknown'&&!ledger.resolution(e.action_id));
  if(unresolved.length!==1||unresolved[0].action_id!==id||ledger.entries.at(-1)!==u)throw Error('other_activity_after_unknown');
  const token=await driver.documentToken?.();
  const start=ledger.entries.filter(e=>e.kind==='begin'&&e.tool==='vcpc_start_contest').at(-1);
  if(!token||token!==b.document_token||token!==start?.document_token||!ledger.records(start.action_id).some(e=>e.kind==='confirmed'&&e.tool==='vcpc_start_contest'))throw Error('same_run_document_unverified');
  const before=await driver.observe();
  if(before.phase!=='end_confirmation'||before.dialog?.type!=='end_confirmation'||before.identity.team_name!==team)throw Error('visible_end_confirmation_required');
  const recoveryId='reconcile-end-'+createHash('sha256').update(id).digest('hex').slice(0,40),args=JSON.stringify({confirm_early_end:true});
  ledger.append({at:new Date().toISOString(),kind:'begin',tool:'vcpc_end_contest',action_id:recoveryId,args,before,document_token:token,detail:'reconcile_unknown_end:'+id});
  try{
    const after=await driver.perform('vcpc_end_contest',{confirm_early_end:true},before);
    if(after.phase!=='final'||after.identity.team_name!==team||await driver.documentToken?.()!==token)throw Error('end_final_unverified');
    ledger.append({at:new Date().toISOString(),kind:'confirmed',tool:'vcpc_end_contest',action_id:recoveryId,args,after,document_token:token});
    ledger.append({at:new Date().toISOString(),kind:'resolution',tool:'vcpc_reconcile_early_end',action_id:id,args:'{}',after,document_token:token,detail:JSON.stringify({actor:'server_verified_early_end',result:'confirmed',evidence_sha256:createHash('sha256').update(JSON.stringify(after)).digest('hex')})});
    if(ledger.unresolved())throw Error('end_resolution_not_verified');
    return {status:'early_end_verified',observation:after};
  }catch(error){
    if(!ledger.records(recoveryId).some(e=>e.kind==='confirmed'))ledger.append({at:new Date().toISOString(),kind:driver.wasDispatched?.()===false?'not_sent':'unknown',tool:'vcpc_end_contest',action_id:recoveryId,args,detail:'reconciliation_confirmation_failed'});
    throw error;
  }
}
