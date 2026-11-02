import {test} from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync,rmSync} from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {chromium} from 'playwright';
import {Ledger} from '../dist/actions/ledger.js';
import {ActionController} from '../dist/actions/controller.js';
import {PageDriver} from '../dist/actions/page-driver.js';

test('native ten training charges ten budget units, mixes with singles, persists across reconnect and never repeats a draw',async()=>{
 const dir=mkdtempSync(path.join(os.tmpdir(),'vcpc-ten-'));let ledger=new Ledger(dir),clicks=0;
 const state={phase:'training',identity:{team_name:'test',tp:25},training:{cost_tp:1,cost_ten_tp:10}};
 const driver={observe:async()=>structuredClone(state),perform:async()=>{clicks++;state.identity.tp+=5;return structuredClone(state);}};
 try{
  const c=new ActionController(driver,ledger,'test',Date.now,100000,0,21);
  assert.equal((await c.execute('vcpc_draw_training','single',{})).status,'confirmed');
  assert.equal((await c.execute('vcpc_draw_training_ten','ten1',{})).status,'confirmed');
  assert.equal((await c.execute('vcpc_draw_training_ten','ten1',{})).status,'confirmed_replay');
  assert.equal((await c.execute('vcpc_draw_training_ten','ten2',{})).status,'confirmed');
  assert.equal(c.trainingSpent(),21);assert.equal(clicks,3);
  assert.equal((await c.execute('vcpc_draw_training_ten','over-budget',{})).status,'training_budget_exceeded');
  ledger.close();ledger=new Ledger(dir);
  const next=new ActionController(driver,ledger,'test',Date.now,100000,0,21);
  assert.equal(next.trainingSpent(),21);assert.equal((await next.execute('vcpc_draw_training_ten','after-restart',{})).status,'training_budget_exceeded');
 }finally{ledger.close();rmSync(dir,{recursive:true,force:true});}
});
test('ten training refuses unknown cost and TP below ten; an uncertain ten draw consumes its attempted budget and blocks replay',async()=>{
 const dir=mkdtempSync(path.join(os.tmpdir(),'vcpc-ten-guard-')),ledger=new Ledger(dir);let clicks=0;
 const state={phase:'training',identity:{team_name:'test',tp:9},training:{cost_tp:1,cost_ten_tp:10}};
 const driver={observe:async()=>structuredClone(state),perform:async()=>{clicks++;throw Error('lost after native ten click');}};
 try{
  const c=new ActionController(driver,ledger,'test',Date.now,100000,0,20);
  assert.equal((await c.execute('vcpc_draw_training_ten','too-few',{})).status,'insufficient_tp');
  state.identity.tp=20;state.training.cost_ten_tp=null;
  assert.equal((await c.execute('vcpc_draw_training_ten','unknown-cost',{})).status,'training_price_unknown');assert.equal(clicks,0);
  state.training.cost_ten_tp=10;
  assert.equal((await c.execute('vcpc_draw_training_ten','uncertain',{})).status,'outcome_unknown');assert.equal(c.trainingSpent(),10);
  assert.equal((await c.execute('vcpc_draw_training_ten','uncertain',{})).status,'outcome_unknown');
  assert.equal((await c.execute('vcpc_draw_training_ten','another',{})).status,'outcome_unknown');assert.equal(clicks,1);
 }finally{ledger.close();rmSync(dir,{recursive:true,force:true});}
});
test('native ten button is clicked once, visible ten receipt is recognized after animation, hidden text stays hidden, and collection uses its fresh decision',async()=>{
 const browser=await chromium.launch({executablePath:process.env.VCPC_CHROME_PATH||'/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',headless:true});
 try{
  const page=await browser.newPage();await page.route('https://vcpc.snakes.moe/',r=>r.fulfill({status:200,body:'<!doctype html>'}));await page.goto('https://vcpc.snakes.moe/');
  const driver=new PageDriver(page);
  await page.setContent('<section class="screen--hub"><div class="team-card__identity"><h2>test</h2></div></section>');await driver.observe();
  await page.setContent('<div id="topbar-meta"><span class="topbar__tp"><b>27</b></span></div><section class="screen--training"><div class="training-hero__copy"><p>消耗 1 TP 抽一张训练卡，或花 10 TP 一次抽十张。</p></div><button data-action="draw-training">抽一张训练卡</button><button id="native-ten">十连训练 · 10 TP</button></section>');
  await page.locator('#native-ten').evaluate(e=>e.addEventListener('click',()=>{
   window.tenClicks=(window.tenClicks??0)+1;document.querySelector('.topbar__tp b').textContent='19';
   document.body.insertAdjacentHTML('beforeend','<div class="modal-layer" style="opacity:0"><section><small>TRAINING DRAW ×10</small><h2>十连训练</h2><p>10 <span>TP</span></p>'+Array.from({length:10},(_,i)=>'<div>R 可见卡'+i+' +10</div>').join('')+'<p>合计 Rating 变化</p><strong>+100</strong><p>当前 Rating 1,100</p><span hidden>HIDDEN_FUTURE_CARD</span><span style="opacity:0">INVISIBLE_CARD</span><button>收下十张卡</button></section></div>');
   document.querySelector('.modal-layer button').addEventListener('click',()=>document.querySelector('.modal-layer').remove());
   setTimeout(()=>document.querySelector('.modal-layer').style.opacity='1',250);
  }));
  let v=await driver.observe();assert.equal(v.training.cost_ten_tp,10);assert.equal(v.training.can_draw_ten,true);
  await driver.validate('vcpc_draw_training_ten',{},v);v=await driver.perform('vcpc_draw_training_ten',{},v);
  assert.equal(v.phase,'training_result');assert.equal(v.dialog.type,'training_batch');assert.equal(v.identity.team_name,'test');assert.equal(v.identity.tp,19);
  assert.match(v.dialog.result,/可见卡9/);assert.ok(!JSON.stringify(v).includes('HIDDEN_FUTURE_CARD'));assert.ok(!JSON.stringify(v).includes('INVISIBLE_CARD'));
  const id=v.dialog.decision_id;assert.ok(id);assert.equal(await page.evaluate(()=>window.tenClicks),1);
  await driver.validate('vcpc_collect_training',{},v);v=await driver.perform('vcpc_collect_training',{},v);
  assert.equal(v.phase,'training');assert.equal(v.dialog,null);assert.equal(v.identity.tp,19);
  await page.locator('#native-ten').evaluate(e=>e.disabled=true);v=await driver.observe();assert.equal(v.training.can_draw_ten,false);
  await assert.rejects(driver.validate('vcpc_draw_training_ten',{},v));assert.equal(await page.evaluate(()=>window.tenClicks),1);
 }finally{await browser.close();}
});
