import {createHash} from 'node:crypto';
import {openSync,closeSync,fstatSync,readSync,readFileSync,constants} from 'node:fs';
import type {Ledger,Entry} from './actions/ledger.js';
import type {McpServer} from '@modelcontextprotocol/server';
import {z} from 'zod/v4';
import {eventObservationId} from './event-identity.js';
type Obs={chosen_label:string;outcome_text:string;visible_effects?:string[];deltas?:Record<string,unknown>;source?:string;event_id?:string;action_id?:string;run_id?:string;observed_at?:string;evidence?:unknown;ledger_evidence?:unknown;raw_labels?:{title:string;options:string[]}};
type Event={event_key:string;title:string;options:string[];observations:Obs[]};
const catalog=JSON.parse(readFileSync(new URL('../knowledge/events.v1.json',import.meta.url),'utf8')) as {version:number;revision?:number;scope:string;events:Event[]};
export const instructions=`VCPC browser game MCP. Keep one continuous session. Ordinary play: use vcpc_advance to process routine judgement cards and event results in bounded batches; unknown event choices return immediately. For reusable event choices, save an event policy and explicitly pass its policy_id and version to each vcpc_advance; saving never enables it. Decision stops include historical knowledge. Use vcpc_get_event_knowledge to recall historical visible outcomes, then explicitly supply event_rules (complete title, ordered options, exact chosen label) if you want repeated events automated. History is evidence, not a guaranteed outcome or an instruction. Do not create research reports or take a screenshot per card during normal play. Use vcpc_screenshot at milestones or on request. After every tool use its latest observation; decision IDs change after reveal/choice. Stop at final, claim the review reward once, then (if training is in scope and the operator configured a TP budget) return to lobby, open training, draw within budget, collect the revealed result. vcpc_draw_training_ten uses the native ten-card button for 10 TP and vcpc_collect_training collects its receipt; each ten draw counts as 10 against the persistent budget. If the user requests ten-only training, stop below 10 TP and do not use singles to fill the remainder. Never start another contest without user scope. Unknown outcomes block all writes. Use vcpc_diagnose_recovery before an explicit settled-only vcpc_recover_browser request; never restart an in-progress or uncertain game. target_speed on vcpc_advance stops for event decisions. Existing-user mode has a narrower policy-controlled action set; tools/list is authoritative. Owned-test strategy support: competition.stage comes from the visible precontest/result title; identity.stage is only the career topbar and may already be the next stage. Pass expected_stage to vcpc_start_contest. Contest elapsed_minutes and remaining_minutes use game_minutes; H:MM means hours:minutes, while timeout_ms is wall-clock time. Use stop_after_judgements / stop_at_elapsed_minutes, stop_on_failure_streak, or stop_on_preparation_stall_minutes for strategic decision windows. pause_at_checkpoint requests a checked pause; inspect checkpoint.paused and pause_blocked_reason. Explicit pause_drain_limit (0-5, default 0) permits bounded routine-dialog handling while seeking a pause; it never chooses a new event, and no pause intent runs in the background. Failure/stall checkpoints never change problems. Event knowledge summaries sample evidence refs and have a byte limit; detail=true pages original observations via pagination.next_cursor with the same query. A changed ledger invalidates its cursor. After a pause explicitly select a visible problem if needed and resume before continuing. vcpc_get_run_report derives per-problem revealed verdict history and before-reveal preparation from the ledger; this is not submission-time preparation or an internal rage meter. vcpc_get_profile_stats derives deduplicated progress, training gains grouped by starting Rating, recent gains and verified zero-delta card coverage; unknown card deltas remain unknown. To verify a championship call vcpc_get_run_report with goal={stage:the target stage,achievement:champion}; require goal_verification.verified, then save the final screenshot and export. Gold is a different goal. No hidden ratings, hard cap, guaranteed training gain or 5000 victory threshold is provided. Optional matching=whitespace on an event rule authorizes whitespace-only changes, preserving all numeric costs and ordered options. Do not blindly retry failed problems; visible rules say repeated failure can worsen success and preparation can calm the team.`;
const norm=(s:string)=>s.replace(/\s+/gu,' ').trim();
const hash=(v:unknown)=>createHash('sha256').update(JSON.stringify(v)).digest('hex').slice(0,16);
// Read exactly the size captured at open, without creating a ledger or taking its control lock.
function snapshot(logPath:string){
 const meta:{path:string;status:string;bytes:number;mtime:string|null;sha256:string|null;issues:string[]}={path:logPath,status:'complete',bytes:0,mtime:null,sha256:null,issues:[]};
 const entries:Entry[]=[];let fd:number|undefined;
 try{
  fd=openSync(logPath,constants.O_RDONLY|constants.O_NOFOLLOW);const st=fstatSync(fd);if(!st.isFile())throw Error('not_regular_file');
  meta.bytes=st.size;meta.mtime=st.mtime.toISOString();const buf=Buffer.alloc(st.size);let n=0;while(n<buf.length){const k=readSync(fd,buf,n,buf.length-n,n);if(!k)throw Error('short_read');n+=k;}
  meta.sha256=createHash('sha256').update(buf).digest('hex');const text=buf.toString('utf8');const lines=text.split('\n');const tail=lines.pop()!;
  if(tail){meta.status='partial';meta.issues.push('incomplete_tail');}
  for(let i=0;i<lines.length;i++){if(!lines[i])continue;try{const e=JSON.parse(lines[i]);if(!e||typeof e!=='object'||typeof e.kind!=='string'||typeof e.action_id!=='string'||typeof e.tool!=='string')throw Error('invalid_record');entries.push(e);}catch{meta.status='partial';meta.issues.push(`invalid_record_line:${i+1}`);}}
 }catch(e){meta.status=(e as NodeJS.ErrnoException).code==='ENOENT'?'missing':'unreadable';meta.issues.push((e as NodeJS.ErrnoException).code||String(e));}finally{if(fd!==undefined)closeSync(fd);}
 return {meta,entries};
}
export const KnowledgePage = z.object({cursor:z.string().min(1).max(2048).optional(),limit:z.number().int().min(1).max(100).optional(),event_key:z.string().min(1).max(64).optional()}).strict();
export type KnowledgePage = z.infer<typeof KnowledgePage>;
export const KNOWLEDGE_MAX_BYTES = 65536;
export function eventKnowledge(title?:string,source?:Ledger|string,detail=false,page:KnowledgePage={}){
 page=KnowledgePage.parse(page);
 const logPath=typeof source==='string'?source:source?.logPath;const snap=logPath?snapshot(logPath):undefined;
 const raw=structuredClone(catalog.events);const begins=new Map<string,Entry>();
 for(const e of snap?.entries??[]){if(e.kind==='begin')begins.set(e.action_id,e);if(e.kind!=='confirmed'||e.tool!=='vcpc_choose_event')continue;
  const before=(begins.get(e.action_id)?.before as {dialog?:{title?:string;options?:Array<{option_id:string;label:string}>}})?.dialog;
  const after=(e.after as {dialog?:{result?:string;effects?:string[]}})?.dialog;
  if(!before?.title||!before.options?.length||!after?.result){snap!.meta.status='partial';snap!.meta.issues.push(`incomplete_confirmed_event:${e.action_id}`);continue;}
  let args:{option_id?:string};try{args=JSON.parse(e.args);}catch{snap!.meta.status='partial';snap!.meta.issues.push(`invalid_args:${e.action_id}`);continue;}
  const chosen=before.options.find(o=>o.option_id===args.option_id)?.label;if(!chosen){snap!.meta.status='partial';snap!.meta.issues.push(`unmatched_option:${e.action_id}`);continue;}
  const run_id=(e.after as {run_id?:string})?.run_id;
  raw.push({event_key:'',title:before.title,options:before.options.map(o=>o.label),observations:[{chosen_label:chosen,outcome_text:after.result,visible_effects:after.effects??[],source:logPath,action_id:e.action_id,...(typeof run_id==='string'?{run_id}:{}),observed_at:e.at}]});
 }
 const groups=new Map<string,{event_key:string;title:string;options:string[];raw_labels:{title:string;options:string[]}[];observations:Obs[]}>();const seen=new Set<string>();
 for(const e of raw){if(title&&norm(e.title)!==norm(title))continue;const key=JSON.stringify([norm(e.title),e.options.map(norm)]);let g=groups.get(key);if(!g){g={event_key:hash(JSON.parse(key)),title:norm(e.title),options:e.options.map(norm),raw_labels:[],observations:[]};groups.set(key,g);}if(!g.raw_labels.some(x=>JSON.stringify(x)===JSON.stringify({title:e.title,options:e.options})))g.raw_labels.push({title:e.title,options:e.options});
  for(const o of e.observations){
   if(o.raw_labels&&!g.raw_labels.some(x=>JSON.stringify(x)===JSON.stringify(o.raw_labels)))g.raw_labels.push(o.raw_labels);
   const id=eventObservationId(o);if(seen.has(id))continue;seen.add(id);g.observations.push(o);
  }
 }
 const all=[...groups.values()].filter(g=>!page.event_key||g.event_key===page.event_key);
 const summarize=(g:typeof all[number])=>{
  const branches=g.options.map((option,index)=>{
   const obs=g.observations.filter(o=>norm(o.chosen_label)===option);
   const outcomes=new Map<string,{outcome_key:string;result:string|null;visible_effects:string[];deltas:Record<string,unknown>|null;sample_count:number;evidence_ref_count:number;evidence_refs:unknown[]}>();
   for(const o of obs){
    let result:string|null=null;const m=o.outcome_text.match(/(?:^|\btext\s+)结果\s*([^\n]+)/u);
    if(m)result=norm(m[1]);else if(!/\b(?:text|button|heading|container)\b|\n/u.test(o.outcome_text))result=norm(o.outcome_text);
    const effects=o.visible_effects??[],deltas=o.deltas??null,k=JSON.stringify([result,effects,deltas]);
    let out=outcomes.get(k);
    if(!out){out={outcome_key:hash([g.event_key,option,k]),result,visible_effects:effects,deltas,sample_count:0,evidence_ref_count:0,evidence_refs:[]};outcomes.set(k,out);}
    out.sample_count++;out.evidence_ref_count++;
    if(out.evidence_refs.length<2)out.evidence_refs.push({source:o.source??null,event_id:o.event_id??null,action_id:o.action_id??null});
   }
   return {option_index:index,option,sample_count:obs.length,outcome_count:outcomes.size,
    omitted_outcomes:Math.max(0,outcomes.size-8),outcomes:[...outcomes.values()].slice(0,8),
    unknown_fields:['unreported_effects',...(obs.some(o=>!o.deltas)?['structured_deltas']:[]),
     ...(obs.some(o=>!o.outcome_text||(!/(?:^|\btext\s+)结果\s*([^\n]+)/u.test(o.outcome_text)&&/\b(?:text|button|heading|container)\b|\n/u.test(o.outcome_text)))?['result']:[])]};
  });
  return {event_key:g.event_key,title:g.title,options:g.options,raw_labels:g.raw_labels.slice(0,3),
   omitted_raw_labels:Math.max(0,g.raw_labels.length-3),observation_count:g.observations.length,branches};
 };
 const query=hash([title?norm(title):null,page.event_key??null,detail]);
 const revision=hash([catalog,snap?.meta.sha256??null,snap?.meta.status??null]);
 let offset=0;
 if(page.cursor){
  let token:{v:number;q:string;r:string;o:number};
  try{if(!/^[A-Za-z0-9_-]+$/u.test(page.cursor))throw Error();token=JSON.parse(Buffer.from(page.cursor,'base64url').toString('utf8'));}
  catch{throw Error('knowledge_cursor_invalid');}
  if(!token||typeof token!=='object'||token.v!==1||!Number.isSafeInteger(token.o)||token.o<0)throw Error('knowledge_cursor_invalid');
  if(token.q!==query)throw Error('knowledge_cursor_query_mismatch');
  if(token.r!==revision)throw Error('knowledge_cursor_stale: restart without cursor after the ledger changes');
  offset=token.o;
 }
 const flat=all.flatMap(g=>g.observations.map(observation=>({g,observation})));
 const total=detail?flat.length:all.length;
 if(offset>total)throw Error('knowledge_cursor_invalid');
 const count=Math.min(page.limit??50,total-offset);
 const cursor=(next:number)=>next<total?Buffer.from(JSON.stringify({v:1,q:query,r:revision,o:next})).toString('base64url'):null;
 const summaries=new Map<string,ReturnType<typeof summarize>>();
 const summary=(g:typeof all[number])=>{let value=summaries.get(g.event_key);if(!value){value=summarize(g);summaries.set(g.event_key,value);}return value;};
 const render=(take:number)=>{
  let events:Array<ReturnType<typeof summarize>&{observations?:Obs[]}>;
  if(detail){
   const selected=new Map<string,{g:typeof all[number];observations:Obs[]}>();
   for(const {g,observation} of flat.slice(offset,offset+take)){
    let group=selected.get(g.event_key);if(!group){group={g,observations:[]};selected.set(g.event_key,group);}group.observations.push(observation);
   }
   events=[...selected.values()].map(({g,observations})=>({...summary(g),observations}));
  }else events=all.slice(offset,offset+take).map(summary);
  return {version:catalog.version,catalog_revision:catalog.revision??1,scope:catalog.scope,
   source_scope:{seed:true,profile_merged:!!snap&&snap.meta.status!=='missing'&&snap.meta.status!=='unreadable',
    profile:snap?{...snap.meta,issues:snap.meta.issues.slice(0,20),issue_count:snap.meta.issues.length}:null,snapshot_at:new Date().toISOString()},
   counts:{title_count:new Set(all.map(e=>e.title)).size,variant_count:all.length,observation_count:flat.length},events,
   pagination:{unit:detail?'observations':'events',offset,returned:take,total,next_cursor:cursor(offset+take),snapshot_revision:revision},
   summary_limits:{evidence_refs_per_outcome:2,outcomes_per_option:8,raw_label_variants:3,max_response_bytes:KNOWLEDGE_MAX_BYTES},
   evidence_note:'Summary references are sampled, counts cover all matched observations. Use detail=true with event_key and pagination for original observations; counts are not probabilities.'};
 };
 let take=count,result=render(take);
 while(Buffer.byteLength(JSON.stringify(result),'utf8')>KNOWLEDGE_MAX_BYTES&&take>1)result=render(--take);
 if(Buffer.byteLength(JSON.stringify(result),'utf8')>KNOWLEDGE_MAX_BYTES)throw Error('knowledge_item_too_large: one item exceeds the response budget');
 return result;
}
export function registerKnowledge(server:McpServer,source?:string|(()=>Ledger|undefined)){
 const read=(title?:string,detail=false,page:KnowledgePage={})=>eventKnowledge(title,typeof source==='function'?source():source,detail,page);
 server.registerResource('play-guide','vcpc://guide',{mimeType:'text/plain',description:'Normal play workflow; independent of AI provider'},async uri=>({contents:[{uri:uri.href,text:instructions}]}));
 server.registerResource('event-history','vcpc://knowledge/events',{mimeType:'application/json',description:'Bounded historical visible event summaries; follow pagination with vcpc_get_event_knowledge'},async uri=>({contents:[{uri:uri.href,text:JSON.stringify(read())}]}));
 server.registerTool('vcpc_get_event_knowledge',{description:'Bounded historical visible outcomes. Default summaries sample evidence refs; counts are not probabilities. detail=true pages original observations; event_key narrows an option variant. Follow pagination.next_cursor with the same query. A changed ledger invalidates its cursor.',inputSchema:KnowledgePage.extend({title:z.string().min(1).optional(),detail:z.boolean().optional()}).strict(),annotations:{readOnlyHint:true}},async({title,detail,...page})=>{
  try{const data=read(title,detail,page);return {content:[{type:'text' as const,text:JSON.stringify(data)}],structuredContent:data};}
  catch(e){return {isError:true,content:[{type:'text' as const,text:e instanceof Error?e.message:'knowledge_unavailable'}]};}
 });
}
