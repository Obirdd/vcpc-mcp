import {createHash} from 'node:crypto';
import type {Ledger} from './actions/ledger.js';
import type {ActionDriver,View} from './actions/controller.js';

// A read-only re-observation of the same document can establish that the one
// uncertain start succeeded. It must never dispatch, reload or restart a game.
export async function reconcileStart(driver:ActionDriver,ledger:Ledger,expectedTeam:string,actionId:string):Promise<View>{
 ledger.assertOwned();
 const u=ledger.entries.at(-1),b=ledger.entries.at(-2);
 if(!u||!b||u.kind!=='unknown'||b.kind!=='begin'||u.tool!=='vcpc_start_contest'||b.tool!==u.tool||u.action_id!==actionId||b.action_id!==actionId||u.args!==b.args)throw Error('no_unresolved_start_candidate');
 const otherUnresolved=ledger.allEntries.some(e=>e.action_id!==actionId&&!ledger.resolution(e.action_id)&&(e.kind==='unknown'||e.kind==='begin'&&!ledger.records(e.action_id).some(r=>['confirmed','unknown','not_sent'].includes(r.kind))));
 if(otherUnresolved)throw Error('other_unresolved_action');
 const before=b.before as View;
 if(before.phase!=='strategy'||before.identity.team_name!==expectedTeam||!b.document_token||await driver.documentToken?.()!==b.document_token)throw Error('start_document_or_identity_unverified');
 const after=await driver.observe();
 if(await driver.documentToken?.()!==b.document_token||after.identity.team_name!==expectedTeam||!['contest_running','contest_paused','event_choice','event_result','judge_pending','judge_revealed'].includes(after.phase))throw Error('start_result_unverified');
 ledger.assertOwned();
 ledger.append({at:new Date().toISOString(),kind:'resolution',tool:'vcpc_reconcile_start',action_id:actionId,args:'{}',document_token:b.document_token,after,detail:JSON.stringify({actor:'server_verified_same_document_start',result:'confirmed',evidence_sha256:createHash('sha256').update(JSON.stringify(after)).digest('hex')})});
 ledger.append({at:new Date().toISOString(),kind:'confirmed',tool:b.tool,action_id:actionId,args:b.args,document_token:b.document_token,after,detail:'confirmed_by_same_document_reobservation'});
 if(ledger.unresolved())throw Error('other_unresolved_action');
 return after;
}
