import {test,before,after} from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync,rmSync} from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {chromium} from 'playwright';
import {PageDriver} from '../dist/actions/page-driver.js';
import {ActionController} from '../dist/actions/controller.js';
import {Ledger} from '../dist/actions/ledger.js';
import {settledEvidence} from '../dist/recovery.js';

let browser,page,driver;
before(async()=>{
  browser=await chromium.launch({executablePath:process.env.VCPC_CHROME_PATH||'/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',headless:true});
  page=await browser.newPage();
  await page.route('https://vcpc.snakes.moe/',r=>r.fulfill({status:200,contentType:'text/html',body:'<!doctype html>'}));
  await page.goto('https://vcpc.snakes.moe/');
  driver=new PageDriver(page);
});
after(async()=>await browser?.close());
const identity={team_name:'test',season:11,stage:'区域决赛',rating:3915,tp:15};
const ak={phase:'final',identity,final:{reward:null,review_status:'not_offered',facts:['13\n过题','AK\n全过']}};
const finalHtml=(fact='AK<br>全过',claim='',exit='<button data-action="continue-after-result">返回大厅 →</button>')=>`<section class="screen--result"><div class="topboard-result"><div class="panel__head"><span class="mono">test</span></div></div><div class="result-rank">#1/363</div><div class="result-facts"><span>13<br>过题</span><span>${fact}</span></div>${claim}${exit}</section>`;

test('AK without a review control is explicit; missing, hidden, duplicate or disabled controls stay ambiguous',async()=>{
  for(const [html,status] of [
    [finalHtml(),'not_offered'],
    [finalHtml('冠军'),'unknown'],
    [finalHtml('AK<br>全过','<button data-action="claim-review">赛后复盘 +1 TP</button>'),'pending'],
    [finalHtml('AK<br>全过','<button data-action="claim-review" disabled>赛后复盘奖励已领取</button>'),'claimed'],
    [finalHtml('AK<br>全过','<button hidden data-action="claim-review">赛后复盘 +1 TP</button>'),'unknown'],
    [finalHtml('AK<br>全过','',''),'unknown'],
    [finalHtml('AK<br>全过','','<button data-action="continue-after-result" disabled>返回大厅 →</button>'),'unknown'],
    [finalHtml('AK<br>全过','','<button data-action="continue-after-result">返回大厅 →</button>'.repeat(2)),'unknown'],
  ]){
    await page.setContent(html);
    const view=await driver.observe();
    assert.equal(view.final.review_status,status);
    if(status==='not_offered')assert.equal(view.final.reward,null);
  }
});

test('AK exit records the actual lobby transition, permits the next run and renews its deadline across reconnect',async()=>{
  const dir=mkdtempSync(path.join(os.tmpdir(),'vcpc-ak-'));const ledger=new Ledger(dir);let time=1000;
  const c=new ActionController(driver,ledger,'test',()=>time,100,3);
  const strategy='<section class="screen--precontest"><div class="start-dock__info"><b>test</b></div><button data-action="start-contest">开始比赛</button></section>';
  const contest='<section class="screen--contest"><div class="contest-bar__left"><span class="chip--soft">test</span></div><button data-action="toggle-play">暂停</button></section>';
  const prep=async()=>{await page.setContent(strategy);await page.locator('[data-action="start-contest"]').evaluate((e,html)=>e.onclick=()=>document.body.innerHTML=html,contest);};
  try{
    await prep();assert.equal((await c.execute('vcpc_start_contest','first',{})).status,'confirmed');
    await page.setContent(finalHtml());
    await page.locator('[data-action="continue-after-result"]').evaluate(e=>e.onclick=()=>{document.body.innerHTML='<section class="screen--hub"><div class="team-card__identity"><h2>test</h2></div></section>';});
    time=1050;const result=await c.execute('vcpc_return_lobby','leave-ak',{});
    assert.equal(result.status,'confirmed');assert.equal(result.after.phase,'lobby');
    const exit=ledger.entries.at(-1);assert.equal(exit.detail,'ak_review_not_offered');assert.equal(exit.before.final.reward,null);
    assert.equal(ledger.entries.some(e=>e.tool==='vcpc_claim_review_reward'),false);
    assert.equal((await c.execute('vcpc_return_lobby','leave-ak',{})).status,'confirmed_replay');
    assert.equal(c.deadline,1150);
    const reconnected=new ActionController(driver,ledger,'test',()=>time,100,3);assert.equal(reconnected.deadline,1150);
    await prep();time=1110;assert.equal((await reconnected.execute('vcpc_start_contest','second',{})).status,'confirmed');
    assert.equal(reconnected.deadline,1210);
  }finally{ledger.close();rmSync(dir,{recursive:true,force:true});}
});

test('a newly appearing review control cancels an AK exit before any click',async()=>{
  await page.setContent(finalHtml());const before=await driver.observe();
  await page.locator('.screen--result').evaluate(e=>e.insertAdjacentHTML('beforeend','<button data-action="claim-review">赛后复盘 +1 TP</button>'));
  await assert.rejects(driver.perform('vcpc_return_lobby',{},before),/review_state_changed_before_click/);
  assert.equal(driver.wasDispatched(),false);assert.equal((await driver.observe()).phase,'final');
});

test('AK exit requires a confirmed start in the same document; pending or unproved review cannot bypass the gate',async()=>{
  for(const [view,confirmed,token,expected] of [
    [ak,false,1000,'previous_run_not_complete'],
    [ak,true,1001,'run_continuity_unknown'],
    [{...ak,final:{...ak.final,review_status:'pending',reward:'赛后复盘 +1 TP'}},true,1000,'previous_run_not_complete'],
    [{...ak,final:{...ak.final,facts:['冠军']}},true,1000,'previous_run_not_complete'],
  ]){
    const dir=mkdtempSync(path.join(os.tmpdir(),'vcpc-ak-gate-')),ledger=new Ledger(dir);let clicks=0;
    const at=new Date(1000).toISOString();ledger.append({at,kind:'begin',tool:'vcpc_start_contest',action_id:'start',args:'{}',document_token:1000});
    if(confirmed)ledger.append({at,kind:'confirmed',tool:'vcpc_start_contest',action_id:'start',args:'{}'});
    const d={documentToken:async()=>token,observe:async()=>view,perform:async()=>{clicks++;return {phase:'lobby',identity};}};
    try{
      const c=new ActionController(d,ledger,'test',()=>1001,10000,3);
      assert.equal((await c.execute('vcpc_return_lobby','exit',{})).status,confirmed?expected:'outcome_unknown');
      assert.equal(clicks,0);
    }finally{ledger.close();rmSync(dir,{recursive:true,force:true});}
  }
});

test('settled recovery accepts proved AK lobby exits and rejects changed documents or unproved settlement',()=>{
  const at='2026-11-01T16:30:00Z';
  const entry=(kind,tool,action_id,extra={})=>({at,kind,tool,action_id,args:'{}',...extra});
  const entries=[entry('begin','vcpc_start_contest','s',{document_token:1000}),entry('confirmed','vcpc_start_contest','s'),entry('begin','vcpc_return_lobby','exit',{before:ak,document_token:1000}),entry('confirmed','vcpc_return_lobby','exit',{before:ak,after:{phase:'lobby',identity},document_token:1000,detail:'ak_review_not_offered'})];
  assert.deepEqual(settledEvidence(entries,'test').identity,identity);
  const changed=structuredClone(entries);changed.at(-1).document_token=2000;assert.throws(()=>settledEvidence(changed,'test'),/settlement_identity_unverified/);
  const missing=structuredClone(entries);delete missing.at(-1).before;assert.throws(()=>settledEvidence(missing,'test'),/settlement_not_confirmed/);
  const pending=structuredClone(entries);pending.at(-1).before.final.review_status='pending';assert.throws(()=>settledEvidence(pending,'test'),/settlement_not_confirmed/);
  assert.throws(()=>settledEvidence(entries,'other-team'),/settlement_identity_unverified/);
});
