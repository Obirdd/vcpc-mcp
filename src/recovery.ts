import {randomUUID,createHash} from 'node:crypto';
import {spawn} from 'node:child_process';
import {constants,closeSync,existsSync,fsyncSync,lstatSync,openSync,readFileSync,readlinkSync,renameSync,statSync,unlinkSync,writeFileSync} from 'node:fs';
import path from 'node:path';
import {chromium} from 'playwright';
import {verifiedRegistrationResolution,verifiedStartResolution,verifiedEarlyEndResolution,type Ledger,type Entry} from './actions/ledger.js';
import {VcpcPageAdapter} from './adapter.js';
import type {BrowserConnection} from './browser.js';
import {confirmedAkExit,confirmedSettlement} from './actions/settlement.js';
export type RecoveryConfig={dir:string;profile:string;expectedTeam:string};
type Info={pid:number;port:number;profile:string};
type Identity={team_name:string|null;season:number|null;stage:string|null;rating:number|null;tp:number|null};
const exists=(p:string)=>{try{lstatSync(p);return true;}catch(e){if((e as NodeJS.ErrnoException).code==='ENOENT')return false;throw e;}};
const processState=(pid:number)=>{try{process.kill(pid,0);return 'alive';}catch(e){return (e as NodeJS.ErrnoException).code==='ESRCH'?'exited':'unknown';}};
function metadata(c:RecoveryConfig):Info{let v:Info;try{const p=path.join(c.dir,'browser.json');const fd=openSync(p,constants.O_RDONLY|constants.O_NOFOLLOW);try{v=JSON.parse(readFileSync(fd,'utf8'));}finally{closeSync(fd);}}catch{throw Error('browser_metadata_invalid');}if(v?.profile!==c.profile||!Number.isInteger(v?.pid)||v.pid<1||!Number.isInteger(v?.port)||v.port<1||v.port>65535)throw Error('browser_metadata_invalid');return v;}
export function settledEvidence(entries:Entry[],expectedTeam:string){
 if(entries.some(e=>!e||typeof e!=='object'||typeof e.action_id!=='string'||typeof e.tool!=='string'||typeof e.args!=='string'||typeof e.at!=='string'||!['begin','confirmed','unknown','not_sent','resolution'].includes(e.kind)))throw Error('ledger_invalid');
 if(entries.some(e=>e.kind==='unknown'&&!verifiedRegistrationResolution(entries,e.action_id)&&!verifiedStartResolution(entries,e.action_id)&&!verifiedEarlyEndResolution(entries,e.action_id)))throw Error('unknown_action_present');
 for(const b of entries.filter(e=>e.kind==='begin'))if(!entries.some(e=>e.action_id===b.action_id&&['confirmed','not_sent'].includes(e.kind))&&!verifiedRegistrationResolution(entries,b.action_id)&&!verifiedEarlyEndResolution(entries,b.action_id))throw Error('in_flight_action');
 const lastIndex=(predicate:(e:Entry)=>boolean)=>entries.reduce((n,e,i)=>predicate(e)?i:n,-1);
 const start=lastIndex(e=>e.kind==='begin'&&e.tool==='vcpc_start_contest');const reward=lastIndex(confirmedSettlement);
 if(start<0||reward<start||!entries.slice(start+1,reward).some(e=>e.kind==='confirmed'&&e.tool==='vcpc_start_contest'&&e.action_id===entries[start].action_id))throw Error('settlement_not_confirmed');
 const r=entries[reward].after as {phase?:string;identity?:Identity;final?:{reward?:string}}|undefined;
 const akExit=confirmedAkExit(entries[reward]);
 if(akExit){
  if(r?.phase!=='lobby'||r.identity?.team_name!==expectedTeam||entries[reward].document_token!==entries[start].document_token)throw Error('settlement_identity_unverified');
 }else if(r?.phase!=='final'||r.identity?.team_name!==expectedTeam||!String(r.final?.reward??'').includes('已领取'))throw Error('settlement_identity_unverified');
 const latest=entries.slice(reward).reverse().find(e=>e.kind==='confirmed'&&e.after&&typeof e.after==='object'&&'phase' in e.after);
 const v=latest?.after as {phase?:string;identity?:Identity}|undefined;const id=v?.identity;
 if(!['final','lobby','training'].includes(v?.phase??'')||id?.team_name!==expectedTeam||!Number.isInteger(id.season)||!Number.isInteger(id.rating)||!Number.isInteger(id.tp)||!id.stage)throw Error('latest_progress_unverified');
 return {reward_at:entries[reward].at,latest_at:latest!.at,latest_phase:v!.phase!,identity:id};
}
export function registrationEvidence(entries:Entry[],expectedTeam:string){
 if(entries.length!==2)throw Error('registration_only_recovery_required');
 const [b,u]=entries;
 if(b.kind!=='begin'||u.kind!=='unknown'||b.tool!=='vcpc_register_team'||u.tool!==b.tool||b.action_id!==u.action_id||b.args!==u.args)throw Error('registration_only_recovery_required');
 let args;try{args=JSON.parse(b.args);}catch{throw Error('registration_identity_unverified');}
 const before=b.before as {phase?:string;identity?:Identity}|undefined;
 const after=u.after as {identity?:Identity}|undefined;
 const id=after?.identity;
 if(args.team_name!==expectedTeam||before?.phase!=='registration'||before.identity?.team_name!==null||!id||id.season!==1||id.stage!=='网络赛'||!Number.isInteger(id.rating)||id.tp!==3)throw Error('registration_identity_unverified');
 return {reward_at:u.at,latest_at:u.at,latest_phase:'initial_rating',identity:{...id,team_name:expectedTeam},registration_action_id:b.action_id};
}
type RecoveryEvidence=ReturnType<typeof settledEvidence> & {registration_action_id?:string};
export function inspectRecovery(c:RecoveryConfig,entries?:Entry[],registrationOnly=false){
 const out:{status:string;reason:string;metadata:Info|null;process:string;lock_present:boolean;pending_present:boolean;evidence:ReturnType<typeof settledEvidence>|null}={status:'blocked',reason:'',metadata:null,process:'unknown',lock_present:false,pending_present:false,evidence:null};
 try{out.lock_present=exists(path.join(c.dir,'controller.lock'));out.pending_present=exists(path.join(c.dir,'recovery-pending.json'));if(out.lock_present)throw Error('controller_locked');if(out.pending_present)throw Error('previous_recovery_incomplete');
  const info=metadata(c);out.metadata=info;out.process=processState(info.pid);
  const lock=path.join(c.profile,'SingletonLock');if(exists(lock)){let target:string;try{target=readlinkSync(lock);}catch{throw Error('singleton_invalid');}if(!target.endsWith(`-${info.pid}`))throw Error('singleton_process_mismatch');}else if(out.process==='alive')throw Error('singleton_missing');
  const portfile=path.join(c.profile,'DevToolsActivePort');if(exists(portfile)){const p=Number(readFileSync(portfile,'utf8').split('\n')[0]);if(p!==info.port)throw Error('port_metadata_mismatch');}else if(out.process==='alive')throw Error('port_file_missing');
  if(!entries){const f=path.join(c.dir,'actions.jsonl');const fd=openSync(f,constants.O_RDONLY|constants.O_NOFOLLOW);try{const text=readFileSync(fd,'utf8');if(text&&!text.endsWith('\n'))throw Error('ledger_incomplete');entries=text.split('\n').filter(Boolean).map(x=>JSON.parse(x));}finally{closeSync(fd);}}
  out.evidence=registrationOnly?registrationEvidence(entries!,c.expectedTeam):settledEvidence(entries!,c.expectedTeam);
  if(out.process==='alive'){out.status='reconnect';out.reason='browser_process_alive_verify_endpoint';return out;}if(out.process!=='exited')throw Error('browser_process_unknown');
  out.status='recoverable';out.reason='settled_browser_exited';return out;
 }catch(e){out.reason=e instanceof Error?e.message:'diagnostic_failed';return out;}
}
export function verifyRecoveredProgress(view:{phase:string;identity:Identity},evidence:RecoveryEvidence){if(!(evidence.registration_action_id?['lobby','initial_rating']:['lobby','final']).includes(view.phase))throw Error('recovered_phase_not_settled');for(const key of ['team_name','season','stage','rating','tp'] as const)if(view.identity[key]!==evidence.identity[key])throw Error(`recovered_progress_mismatch:${key}`);}
export async function recoverSettledBrowser(c:RecoveryConfig,ledger:Ledger,registrationOnly=false):Promise<BrowserConnection>{
 ledger.assertOwned();const inspection=inspectRecoveryWithOwnedLock(c,ledger,registrationOnly);if(inspection.status!=='recoverable')throw Error(inspection.reason);
 if(process.env.VCPC_HEADED!=='1')throw Error('visible_browser_required');
 const old=inspection.metadata!;const evidence=inspection.evidence! as RecoveryEvidence;const pending=path.join(c.dir,'recovery-pending.json');const marker={at:new Date().toISOString(),old,evidence,status:'starting',pid:null as number|null};const fd=openSync(pending,constants.O_WRONLY|constants.O_CREAT|constants.O_EXCL|constants.O_NOFOLLOW,0o600);try{writeFileSync(fd,JSON.stringify(marker));fsyncSync(fd);}finally{closeSync(fd);}
 let browser:Awaited<ReturnType<typeof chromium.connectOverCDP>>|undefined;
 try{ledger.assertOwned();if(processState(old.pid)!=='exited')throw Error('old_process_changed');const prelock=path.join(c.profile,'SingletonLock');if(exists(prelock)&&!readlinkSync(prelock).endsWith(`-${old.pid}`))throw Error('singleton_process_mismatch');const exe=process.env.VCPC_CHROME_PATH||(process.platform==='darwin'?'/Applications/Google Chrome.app/Contents/MacOS/Google Chrome':'');if(!exe)throw Error('chrome_path_missing');const started=Date.now();const child=spawn(exe,[`--user-data-dir=${c.profile}`,'--remote-debugging-address=127.0.0.1','--remote-debugging-port=0','--no-first-run','--no-default-browser-check','--use-mock-keychain','--password-store=basic','about:blank'],{detached:true,stdio:'ignore'});child.on('error',()=>{});child.unref();if(!child.pid)throw Error('browser_launch_failed');marker.pid=child.pid;marker.status='launched';writeFileSync(pending,JSON.stringify(marker),{mode:0o600});
  const portfile=path.join(c.profile,'DevToolsActivePort');let port=0,ws='';for(let i=0;i<150;i++){if(processState(child.pid)!=='alive')throw Error('new_browser_exited_or_unknown');if(existsSync(portfile)&&statSync(portfile).mtimeMs>=started-1000){const parts=readFileSync(portfile,'utf8').trim().split('\n');port=Number(parts[0]);ws=parts[1];if(Number.isInteger(port)&&port>0&&port<=65535&&/^\/devtools\/browser\/[a-f0-9-]+$/i.test(ws??''))break;}await new Promise(r=>setTimeout(r,100));}
  if(!port||!ws)throw Error('new_endpoint_unavailable');if(!readlinkSync(path.join(c.profile,'SingletonLock')).endsWith(`-${child.pid}`))throw Error('new_singleton_mismatch');
  browser=await chromium.connectOverCDP(`ws://127.0.0.1:${port}${ws}`,{timeout:10000});const contexts=browser.contexts();if(contexts.length!==1||contexts[0].pages().length!==1)throw Error('unexpected_browser_pages');const page=contexts[0].pages()[0];if(page.url()!=='about:blank')throw Error('unexpected_initial_page');await page.goto('https://vcpc.snakes.moe/',{waitUntil:'domcontentloaded',timeout:30000});await page.locator('body').waitFor({state:'visible',timeout:15000});let view;for(let i=0;i<30;i++){view=await new VcpcPageAdapter(page).read();if(view.identity.team_name&&view.phase!=='unknown')break;await new Promise(r=>setTimeout(r,200));}
  if(!view)throw Error('recovered_phase_not_settled');verifyRecoveredProgress(view,evidence);
  ledger.assertOwned();const meta=path.join(c.dir,'browser.json');const current=metadata(c);if(JSON.stringify(current)!==JSON.stringify(old))throw Error('browser_metadata_changed');const archive=path.join(c.dir,`browser-before-recovery-${randomUUID()}.json`);const temp=path.join(c.dir,`browser-new-${randomUUID()}.json`);writeFileSync(archive,readFileSync(meta),{flag:'wx',mode:0o600});writeFileSync(temp,JSON.stringify({pid:child.pid,port,profile:c.profile},null,2)+'\n',{flag:'wx',mode:0o600});renameSync(temp,meta);
  if(evidence.registration_action_id){const result={at:new Date().toISOString(),kind:'resolution' as const,action_id:evidence.registration_action_id,tool:'vcpc_reconcile_registration',args:'{}',after:view,detail:JSON.stringify({actor:'server_verified_registration',result:'confirmed',evidence_sha256:createHash('sha256').update(JSON.stringify(view)).digest('hex')})};ledger.append(result);if(ledger.unresolved())throw Error('registration_resolution_failed');}
  unlinkSync(pending);return {page,fresh:false,close:async()=>{await browser!.close();}};
 }catch(e){await browser?.close().catch(()=>{});throw e;}
}
// The caller holds the exclusive ledger lock; inspection must ignore only that lock.
function inspectRecoveryWithOwnedLock(c:RecoveryConfig,ledger:Ledger,registrationOnly=false){ledger.assertOwned();try{const fd=openSync(ledger.logPath,constants.O_RDONLY|constants.O_NOFOLLOW);let text:string;try{text=readFileSync(fd,'utf8');}finally{closeSync(fd);}if(text&&!text.endsWith('\n'))throw Error('ledger_incomplete');const actual=text.split('\n').filter(Boolean).map(x=>JSON.parse(x));if(JSON.stringify(actual)!==JSON.stringify(ledger.entries))throw Error('ledger_changed');}catch(e){return {status:'blocked',reason:e instanceof Error?e.message:'ledger_unreadable',metadata:null,process:'unknown',lock_present:true,pending_present:false,evidence:null};}return inspectRecoveryUnlocked(c,ledger.entries,registrationOnly);}
function inspectRecoveryUnlocked(c:RecoveryConfig,entries:Entry[],registrationOnly=false){const out:{status:string;reason:string;metadata:Info|null;process:string;lock_present:boolean;pending_present:boolean;evidence:ReturnType<typeof settledEvidence>|null}={status:'blocked',reason:'',metadata:null,process:'unknown',lock_present:true,pending_present:false,evidence:null};try{if(exists(path.join(c.dir,'recovery-pending.json')))throw Error('previous_recovery_incomplete');const info=metadata(c);out.metadata=info;out.process=processState(info.pid);if(out.process!=='exited')throw Error(out.process==='alive'?'browser_still_running':'browser_process_unknown');const lock=path.join(c.profile,'SingletonLock');if(exists(lock)&&!readlinkSync(lock).endsWith(`-${info.pid}`))throw Error('singleton_process_mismatch');const port=path.join(c.profile,'DevToolsActivePort');if(exists(port)&&Number(readFileSync(port,'utf8').split('\n')[0])!==info.port)throw Error('port_metadata_mismatch');out.evidence=registrationOnly?registrationEvidence(entries,c.expectedTeam):settledEvidence(entries,c.expectedTeam);out.status='recoverable';out.reason='settled_browser_exited';}catch(e){out.reason=e instanceof Error?e.message:'diagnostic_failed';}return out;}
