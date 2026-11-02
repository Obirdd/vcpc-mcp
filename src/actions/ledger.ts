import {openSync,closeSync,writeSync,fsyncSync,readFileSync,existsSync,mkdirSync,unlinkSync,lstatSync,constants,chmodSync,fstatSync} from 'node:fs';
import path from 'node:path';
import {createHash} from 'node:crypto';

export type Entry={at:string;kind:'begin'|'confirmed'|'unknown'|'not_sent'|'resolution';action_id:string;tool:string;args:string;before?:unknown;after?:unknown;detail?:string;task_id?:string;document_token?:number};
// Preserve the original unknown and accept only an independently verified,
// matching registration snapshot before any other action has been attempted.
export function verifiedRegistrationResolution(entries:Entry[],id:string):boolean {
 const index=entries.findIndex(e=>e.action_id===id&&e.kind==='resolution'&&e.tool==='vcpc_reconcile_registration');
 if(index<0)return false;
 const prior=entries.slice(0,index),r=entries[index];
 if(prior.length!==2)return false;
 const [b,u]=prior;
 if(b.kind!=='begin'||u.kind!=='unknown'||b.tool!=='vcpc_register_team'||u.tool!==b.tool||b.action_id!==id||u.action_id!==id||b.args!==u.args)return false;
 try{
  const d=JSON.parse(r.detail??'{}'),args=JSON.parse(b.args);
  const old=u.after as {identity?:Record<string,unknown>}|undefined;
  const v=r.after as {phase?:string;identity?:Record<string,unknown>}|undefined;
  if(d.actor!=='server_verified_registration'||d.result!=='confirmed'||!v||!['lobby','initial_rating'].includes(v.phase??'')||v.identity?.team_name!==args.team_name)return false;
  if(d.evidence_sha256!==createHash('sha256').update(JSON.stringify(v)).digest('hex'))return false;
  return ['season','stage','rating','tp'].every(k=>old?.identity?.[k]!=null&&old.identity[k]===v.identity?.[k]);
 }catch{return false;}
}
export function verifiedStartResolution(entries:Entry[],id:string):boolean {
 const index=entries.findIndex(e=>e.action_id===id&&e.kind==='resolution'&&e.tool==='vcpc_reconcile_start');
 if(index<2)return false;
 const b=entries[index-2],u=entries[index-1],r=entries[index];
 if(b.kind!=='begin'||u.kind!=='unknown'||b.tool!=='vcpc_start_contest'||u.tool!==b.tool||b.action_id!==id||u.action_id!==id||b.args!==u.args)return false;
 const before=b.before as {phase?:string;identity?:{team_name?:string}}|undefined;
 const after=r.after as {phase?:string;identity?:{team_name?:string}}|undefined;
 try{const d=JSON.parse(r.detail??'{}');return before?.phase==='strategy'&&!!before.identity?.team_name&&after?.identity?.team_name===before.identity.team_name&&['contest_running','contest_paused','judge_pending','judge_revealed','event_choice','event_result'].includes(after?.phase??'')&&!!b.document_token&&r.document_token===b.document_token&&d.actor==='server_verified_same_document_start'&&d.result==='confirmed'&&d.evidence_sha256===createHash('sha256').update(JSON.stringify(after)).digest('hex');}catch{return false;}
}
export function verifiedEarlyEndResolution(entries:Entry[],id:string):boolean {
 const index=entries.findIndex(e=>e.kind==='resolution'&&e.tool==='vcpc_reconcile_early_end'&&e.action_id===id);
 if(index<4)return false;
 if(verifiedFinalEarlyEndResolution(entries,index,id))return true;
 const r=entries[index],rb=entries[index-2],rc=entries[index-1];
 const b=entries.find(e=>e.kind==='begin'&&e.action_id===id),u=entries.find(e=>e.kind==='unknown'&&e.action_id===id);
 if(!b||!u||b.tool!=='vcpc_end_contest'||u.tool!==b.tool||u.args!==b.args||entries[index-3]!==u)return false;
 if(rb.kind!=='begin'||rc.kind!=='confirmed'||rb.tool!==b.tool||rc.tool!==b.tool||rb.action_id!==rc.action_id||rb.action_id===id||rb.args!==rc.args||rb.detail!=='reconcile_unknown_end:'+id)return false;
 const old=b.before as {phase?:string;identity?:{team_name?:string}}|undefined,before=rb.before as {phase?:string;identity?:{team_name?:string};dialog?:{type?:string}}|undefined,after=r.after as {phase?:string;identity?:{team_name?:string}}|undefined;
 const start=entries.slice(0,entries.indexOf(b)).filter(e=>e.kind==='begin'&&e.tool==='vcpc_start_contest').at(-1);
 try{const d=JSON.parse(r.detail??'{}');return !!old?.identity?.team_name&&['contest_running','contest_paused'].includes(old.phase??'')&&before?.phase==='end_confirmation'&&before.dialog?.type==='end_confirmation'&&before.identity?.team_name===old.identity.team_name&&after?.phase==='final'&&after.identity?.team_name===old.identity.team_name&&JSON.stringify(rc.after)===JSON.stringify(after)&&!!b.document_token&&[rb.document_token,rc.document_token,r.document_token,start?.document_token].every(t=>t===b.document_token)&&!!start&&entries.slice(entries.indexOf(start)+1,entries.indexOf(b)).some(e=>e.kind==='confirmed'&&e.tool==='vcpc_start_contest'&&e.action_id===start.action_id)&&d.actor==='server_verified_early_end'&&d.result==='confirmed'&&d.evidence_sha256===createHash('sha256').update(JSON.stringify(after)).digest('hex');}catch{return false;}
}
function verifiedFinalEarlyEndResolution(entries:Entry[],index:number,id:string):boolean {
 const r=entries[index],after=r.after as {phase?:string;identity?:{team_name?:string};final?:{rank?:string;facts?:string[]}}|undefined;
 const startIndex=entries.slice(0,index).reduce((last,e,i)=>e.kind==='begin'&&e.tool==='vcpc_start_contest'?i:last,-1);
 if(startIndex<0||after?.phase!=='final'||!after.identity?.team_name||!after.final?.rank||!Array.isArray(after.final.facts))return false;
 const start=entries[startIndex],tail=entries.slice(startIndex+1,index);
 if(!start.document_token||r.document_token!==start.document_token||!tail.some(e=>e.kind==='confirmed'&&e.tool==='vcpc_start_contest'&&e.action_id===start.action_id))return false;
 const ends=tail.filter(e=>e.kind==='begin'&&e.tool==='vcpc_end_contest');
 if(!ends.some(e=>e.action_id===id)||!ends.length)return false;
 for(const b of ends){const before=b.before as {phase?:string;identity?:{team_name?:string}}|undefined;if(b.document_token!==start.document_token||before?.identity?.team_name!==after.identity.team_name||!['contest_running','contest_paused','end_confirmation'].includes(before.phase??'')||!tail.some(e=>e.kind==='unknown'&&e.action_id===b.action_id&&e.tool===b.tool&&e.args===b.args))return false;}
 for(const e of tail){
  if(e.kind==='confirmed'&&e.tool==='vcpc_start_contest'&&e.action_id===start.action_id)continue;
  if(['begin','unknown'].includes(e.kind)&&e.tool==='vcpc_end_contest'&&ends.some(b=>b.action_id===e.action_id))continue;
  if(e.kind==='resolution'&&e.tool==='vcpc_reconcile_early_end'&&ends.some(b=>b.action_id===e.action_id)){try{const d=JSON.parse(e.detail??'{}');if(d.actor==='server_verified_early_end_final'&&e.document_token===start.document_token&&JSON.stringify(e.after)===JSON.stringify(after))continue;}catch{}}
  return false;
 }
 try{const d=JSON.parse(r.detail??'{}');return d.actor==='server_verified_early_end_final'&&d.result==='confirmed'&&d.evidence_sha256===createHash('sha256').update(JSON.stringify(after)).digest('hex');}catch{return false;}
}
export class Ledger {
  private lockFd:number;
  readonly logPath:string;
  readonly entries:Entry[];
  readonly allEntries:Entry[];
  private readonly lockPath:string;
  constructor(readonly dir:string,readonly taskId?:string){
    mkdirSync(dir,{recursive:true,mode:0o700});if(lstatSync(dir).isSymbolicLink())throw new Error('unsafe_log_directory');chmodSync(dir,0o700);this.lockPath=path.join(dir,'controller.lock');
    try {this.lockFd=openSync(this.lockPath,'wx',0o600);} catch {throw new Error('controller_locked: 测试存档已有控制器或遗留锁，停止写入');}
    this.logPath=path.join(dir,'actions.jsonl');
    try {if(existsSync(this.logPath) && !lstatSync(this.logPath).isFile())throw new Error('unsafe_action_log');this.allEntries=existsSync(this.logPath)?readFileSync(this.logPath,'utf8').split('\n').filter(Boolean).map(x=>JSON.parse(x) as Entry):[];this.entries=taskId?this.allEntries.filter(e=>e.task_id===taskId):this.allEntries;} catch(e){closeSync(this.lockFd);unlinkSync(this.lockPath);throw e;}
  }
  assertOwned(){const own=fstatSync(this.lockFd);let current;try{current=lstatSync(this.lockPath);}catch{throw Error('control_revoked');}if(!current.isFile()||own.dev!==current.dev||own.ino!==current.ino)throw Error('control_revoked');}
  append(entry:Entry){this.assertOwned();if(this.taskId)entry={...entry,task_id:this.taskId};const fd=openSync(this.logPath,constants.O_WRONLY|constants.O_CREAT|constants.O_APPEND|constants.O_NOFOLLOW,0o600);try{writeSync(fd,JSON.stringify(entry)+'\n');fsyncSync(fd);}finally{closeSync(fd);}this.allEntries.push(entry);if(this.entries!==this.allEntries)this.entries.push(entry);}
  records(id:string){return this.allEntries.filter(e=>e.action_id===id);}
  resolution(id:string):'confirmed'|'not_sent'|undefined {if(verifiedRegistrationResolution(this.allEntries,id)||verifiedStartResolution(this.allEntries,id)||verifiedEarlyEndResolution(this.allEntries,id))return 'confirmed';let index=this.allEntries.reduce((last,e,i)=>e.action_id===id&&e.kind==='unknown'?i:last,-1);if(index<0)index=this.allEntries.reduce((last,e,i)=>e.action_id===id&&e.kind==='begin'?i:last,-1);if(index<0)return undefined;for(const entry of this.allEntries.slice(index+1)){if(entry.action_id!==id||entry.kind!=='resolution'||entry.tool!=='user_reconcile'||!entry.detail)continue;try{const d=JSON.parse(entry.detail);if(d.actor==='local_user'&&/^[a-f0-9]{64}$/.test(d.evidence_sha256)&&['confirmed','not_sent'].includes(d.result))return d.result;}catch{}}return undefined;}
  unresolved(){const begins=this.allEntries.filter(e=>e.kind==='begin');return begins.some(b=>!this.allEntries.some(e=>e.action_id===b.action_id&&(e.kind==='confirmed'||e.kind==='unknown'||e.kind==='not_sent'))&&!this.resolution(b.action_id)) || this.allEntries.some(e=>e.kind==='unknown'&&!this.resolution(e.action_id));}
  startAttempts(){return this.entries.filter(e=>e.kind==='begin' && e.tool==='vcpc_start_contest').length;}
  starts(){return this.entries.filter(e=>e.kind==='begin' && e.tool==='vcpc_start_contest' && !this.records(e.action_id).some(x=>x.kind==='not_sent') && this.resolution(e.action_id)!=='not_sent').length;}
  close(){try{this.assertOwned();}catch(e){closeSync(this.lockFd);throw e;}closeSync(this.lockFd);unlinkSync(this.lockPath);}
}
