import type { Entry } from './ledger.js';

type SettlementView = {phase?:string;identity?:{team_name?:string|null};final?:{reward?:string|null;review_status?:string;facts?:string[]}|null};

// Missing reward text alone is ambiguous. The adapter marks this only after
// seeing an AK result, no claim control at all, and one enabled lobby button.
export function reviewNotOffered(value:unknown):boolean {
  const view=value as SettlementView|undefined;
  return view?.phase==='final' && view.final?.review_status==='not_offered'
    && view.final.reward===null
    && view.final.facts?.some(f=>/^AK\s+全过$/u.test(f.trim()))===true;
}

export function confirmedAkExit(entry:Entry):boolean {
  const before=entry.before as SettlementView|undefined,after=entry.after as SettlementView|undefined;
  return entry.kind==='confirmed' && ['vcpc_return_lobby','vcpc_enter_stage'].includes(entry.tool)
    && reviewNotOffered(before) && after?.phase==='lobby'
    && typeof before?.identity?.team_name==='string'
    && before.identity.team_name===after.identity?.team_name
    && typeof entry.document_token==='number' && entry.document_token>0;
}

export function confirmedSettlement(entry:Entry):boolean {
  return entry.kind==='confirmed' && entry.tool==='vcpc_claim_review_reward' || confirmedAkExit(entry);
}
