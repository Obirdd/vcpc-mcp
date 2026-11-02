import {test} from 'node:test';
import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';
import {mkdtempSync,rmSync} from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {chromium} from 'playwright';
import {registrationEvidence,verifyRecoveredProgress,settledEvidence} from '../dist/recovery.js';
import {Ledger,verifiedRegistrationResolution} from '../dist/actions/ledger.js';
import {PageDriver} from '../dist/actions/page-driver.js';
const identity={team_name:'test',season:1,stage:'网络赛',rating:1025,tp:3};
const base=()=>[
 {at:new Date().toISOString(),kind:'begin',tool:'vcpc_register_team',action_id:'reg',args:'{"team_name":"test"}',before:{phase:'registration',identity:{team_name:null}}},
 {at:new Date().toISOString(),kind:'unknown',tool:'vcpc_register_team',action_id:'reg',args:'{"team_name":"test"}',after:{phase:'unknown',identity:{...identity,team_name:null}}}
];
const resolution=(after={phase:'lobby',identity})=>({at:new Date().toISOString(),kind:'resolution',action_id:'reg',tool:'vcpc_reconcile_registration',args:'{}',after,detail:JSON.stringify({actor:'server_verified_registration',result:'confirmed',evidence_sha256:createHash('sha256').update(JSON.stringify(after)).digest('hex')})});
test('registration-only recovery excludes later actions, wrong team, missing progress and every contest state',()=>{
 const entries=base(),evidence=registrationEvidence(entries,'test');
 assert.equal(evidence.registration_action_id,'reg');
 for(const phase of ['lobby','initial_rating'])verifyRecoveredProgress({phase,identity},evidence);
 for(const phase of ['contest_running','strategy','final','registration'])assert.throws(()=>verifyRecoveredProgress({phase,identity},evidence),/recovered_phase_not_settled/);
 assert.throws(()=>verifyRecoveredProgress({phase:'lobby',identity:{...identity,rating:1026}},evidence),/mismatch/);
 assert.throws(()=>registrationEvidence([...entries,{...entries[0],tool:'vcpc_start_contest'}],'test'),/registration_only/);
 assert.throws(()=>registrationEvidence(entries,'other'),/identity_unverified/);
 for(const key of ['rating','season','tp','stage']){const a=base();a[1].after.identity[key]=null;assert.throws(()=>registrationEvidence(a,'test'),/identity_unverified/);}
});
test('verified registration resolution preserves unknown, checks snapshot hash and allows later settled recovery only after a reward',()=>{
 const root=mkdtempSync(path.join(os.tmpdir(),'vcpc-reg-'));const ledger=new Ledger(root);
 try{
  for(const e of base())ledger.append(e);
  assert.equal(ledger.unresolved(),true);
  const r=resolution();ledger.append(r);
  assert.equal(ledger.unresolved(),false);assert.equal(ledger.entries[1].kind,'unknown');
  assert.throws(()=>settledEvidence(ledger.entries,'test'),/settlement_not_confirmed/);
  const entries=[...ledger.entries,{at:r.at,kind:'begin',action_id:'s',tool:'vcpc_start_contest',args:'{}'},{at:r.at,kind:'confirmed',action_id:'s',tool:'vcpc_start_contest',args:'{}'},{at:r.at,kind:'begin',action_id:'r',tool:'vcpc_claim_review_reward',args:'{}'},{at:r.at,kind:'confirmed',action_id:'r',tool:'vcpc_claim_review_reward',args:'{}',after:{phase:'final',identity,final:{reward:'已领取'}}}];
  assert.equal(settledEvidence(entries,'test').identity.rating,1025);
  const bad=base();bad.push(resolution({phase:'lobby',identity:{...identity,tp:4}}));assert.equal(verifiedRegistrationResolution(bad,'reg'),false);
  const tampered=[...base(),{...r,after:{phase:'lobby',identity:{...identity,rating:9999}}}];assert.equal(verifiedRegistrationResolution(tampered,'reg'),false);
  assert.equal(verifiedRegistrationResolution([...base(),{...r,tool:'arbitrary'}],'reg'),false);
 }finally{ledger.close();rmSync(root,{recursive:true,force:true});}
});
test('registration waits for the visible rating dialog animation and reads its team identity',async()=>{
 const browser=await chromium.launch({executablePath:process.env.VCPC_CHROME_PATH||'/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',headless:true});
 try{
  const page=await browser.newPage();await page.route('https://vcpc.snakes.moe/',r=>r.fulfill({status:200,body:'<!doctype html>'}));await page.goto('https://vcpc.snakes.moe/');
  await page.setContent('<input placeholder="给队伍起个名字" data-field="team-name"><button data-action="create-team">注册</button>');
  await page.locator('[data-action="create-team"]').evaluate(e=>e.addEventListener('click',()=>{
   window.clicks=(window.clicks??0)+1;document.body.innerHTML='<section class="screen--hub" style="opacity:0"></section><div class="modal-layer"><div class="reveal-card reveal-card--rating" style="opacity:0"><h2 class="reveal-card__name">test</h2><div class="reveal-card__rating">1,025</div><button data-ui="close-reveal">进入第一场网络赛</button></div></div>';
   setTimeout(()=>document.querySelector('.reveal-card').style.opacity='1',250);
  }));
  const driver=new PageDriver(page,2000),before=await driver.observe(),after=await driver.perform('vcpc_register_team',{team_name:'test'},before);
  assert.equal(after.phase,'initial_rating');assert.equal(after.identity.team_name,'test');assert.equal(await page.evaluate(()=>window.clicks),1);
 }finally{await browser.close();}
});
