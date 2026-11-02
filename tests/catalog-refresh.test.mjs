import {test} from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync, mkdtempSync, writeFileSync, appendFileSync, rmSync} from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {createHash} from 'node:crypto';
import {eventKnowledge} from '../dist/knowledge.js';
import {eventObservationId} from '../dist/event-identity.js';

const catalogBytes=readFileSync(new URL('../knowledge/events.v1.json',import.meta.url));
const catalog=JSON.parse(catalogBytes);
const manifest=JSON.parse(readFileSync(new URL('../knowledge/events.manifest.json',import.meta.url),'utf8'));
const norm=s=>s.replace(/\s+/gu,' ').trim();
test('shared catalog revision covers five newly observed events with original action evidence and no duplicate observations',()=>{
 assert.equal(catalog.revision,2);
 assert.equal(manifest.catalog_sha256,createHash('sha256').update(catalogBytes).digest('hex'));
 assert.deepEqual(manifest.coverage,{titles:35,variants:36,observations:1094});
 const ids=catalog.events.flatMap(e=>e.observations.map(eventObservationId));
 assert.equal(ids.length,1094);assert.equal(new Set(ids).size,1094);
 for(const title of ['先别急我有个反例','工厂必须扩张，键盘不能复制','本地过了属于异地恋','注意力是你所需要的，但你在看榜','观测榜单并不能改变波函数']){
  const e=catalog.events.find(e=>norm(e.title)===title);assert.ok(e,title);assert.ok(e.observations.length);
  for(const o of e.observations){assert.ok(o.run_id&&o.action_id&&o.ledger_evidence.source_sha256);
   assert.ok(o.ledger_evidence.confirmed_line>o.ledger_evidence.begin_line);
   assert.equal(o.ledger_evidence.confirmed_line_sha256.length,64);
   assert.ok(e.options.some(option=>norm(option)===norm(o.chosen_label)));
  }
 }
 const result=eventKnowledge();assert.equal(result.catalog_revision,2);assert.equal(result.counts.observation_count,1094);
 assert.equal(result.counts.title_count,35);assert.equal(result.counts.variant_count,36);
});
test('bundled imports and the current profile count the same action once; later actions and different runs still add evidence',()=>{
 const event=catalog.events.find(e=>e.observations.some(o=>o.run_id&&o.action_id));
 const original=event.observations.find(o=>o.run_id&&o.action_id),labels=original.raw_labels?.options??event.options;
 const chosen=labels.findIndex(label=>norm(label)===norm(original.chosen_label));assert.ok(chosen>=0);
 const record=(action_id,run_id)=>[
  {at:'2026-11-02T00:00:00Z',kind:'begin',tool:'vcpc_choose_event',action_id,args:JSON.stringify({option_id:String(chosen)}),
   before:{run_id,phase:'event_choice',dialog:{title:event.title,options:labels.map((label,i)=>({label,option_id:String(i)}))}}},
  {at:'2026-11-02T00:00:00Z',kind:'confirmed',tool:'vcpc_choose_event',action_id,args:JSON.stringify({option_id:String(chosen)}),
   after:{run_id,phase:'event_result',dialog:{result:original.outcome_text,effects:original.visible_effects??[]}}}
 ].map(r=>JSON.stringify(r)+'\n').join('');
 const dir=mkdtempSync(path.join(os.tmpdir(),'vcpc-catalog-')),log=path.join(dir,'actions.jsonl');
 try{const seed=eventKnowledge(event.title).counts.observation_count;
  writeFileSync(log,record(original.action_id,original.run_id));assert.equal(eventKnowledge(event.title,log).counts.observation_count,seed);
  appendFileSync(log,record('fresh-action',original.run_id));assert.equal(eventKnowledge(event.title,log).counts.observation_count,seed+1);
  appendFileSync(log,record(original.action_id,'different-run'));assert.equal(eventKnowledge(event.title,log).counts.observation_count,seed+2);
 }finally{rmSync(dir,{recursive:true,force:true});}
});
