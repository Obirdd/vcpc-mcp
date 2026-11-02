import {test} from 'node:test';
import assert from 'node:assert/strict';
import {chromium} from 'playwright';
import {PageDriver} from '../dist/actions/page-driver.js';
const normal='<button data-action="start-precontest">进入网络赛</button>';
const shortcut='<button data-action="start-observable">🌌 可观测宇宙总决赛</button>';
const route='<button data-action="start-observable">进入可观测宇宙总决赛 →</button>';
const hub=buttons=>'<section class="screen--hub"><div class="team-card__identity"><h2>test</h2></div>'+buttons+'</section>';
async function fixture(fn){const b=await chromium.launch({executablePath:process.env.VCPC_CHROME_PATH||'/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',headless:true});try{const p=await b.newPage();await p.route('https://vcpc.snakes.moe/',r=>r.fulfill({status:200,body:'<!doctype html>'}));await p.goto('https://vcpc.snakes.moe/');await fn(p,new PageDriver(p));}finally{await b.close();}}
test('observable entry chooses the unique route among shortcut and route, confirms strategy, then uses normal start with the visible observable stage',async()=>fixture(async(page,driver)=>{
 await page.setContent(hub(shortcut+route));
 await page.locator('[data-action="start-observable"]').evaluateAll(es=>es.forEach((e,i)=>e.addEventListener('click',()=>{
  window.entryClicks=(window.entryClicks??0)+1;window.chosenEntry=i;
  document.body.innerHTML='<div id="topbar-meta"><span class="topbar__chip">SEASON 7</span><span class="topbar__chip">可观测宇宙总决赛</span></div><section class="screen--precontest"><div class="start-dock__info"><b>test</b></div><button class="strategy-card" aria-pressed="false"><span class="prep-card__name">对拍流</span></button><button data-action="start-contest">开始</button></section>';
  document.querySelector('.strategy-card').addEventListener('click',e=>e.currentTarget.setAttribute('aria-pressed','true'));
  document.querySelector('[data-action="start-contest"]').addEventListener('click',()=>{window.startClicks=(window.startClicks??0)+1;document.body.innerHTML='<section class="screen--contest"><div class="contest-bar__left"><span class="chip--soft">test</span></div><button data-action="toggle-play">暂停</button></section>';});
 })));
 let v=await driver.observe();await driver.validate('vcpc_enter_stage',{},v);v=await driver.perform('vcpc_enter_stage',{},v);
 assert.equal(v.phase,'strategy');assert.equal(v.identity.stage,'可观测宇宙总决赛');assert.equal(await page.evaluate(()=>window.entryClicks),1);assert.equal(await page.evaluate(()=>window.chosenEntry),1);
 v=await driver.perform('vcpc_select_strategy',{strategy:'对拍流'},v);v=await driver.perform('vcpc_start_contest',{},v);assert.equal(v.phase,'contest_running');assert.equal(await page.evaluate(()=>window.startClicks),1);
}));
test('missing, conflicting, duplicated and disabled observable routes refuse without clicking',async()=>fixture(async(page,driver)=>{
 for(const buttons of ['',shortcut,route+route,normal+normal,route.replace('<button','<button disabled')]){
  await page.setContent(hub(buttons));await page.locator('button').evaluateAll(es=>es.forEach(e=>e.addEventListener('click',()=>window.unexpectedClicks=(window.unexpectedClicks??0)+1)));
  const v=await driver.observe();await assert.rejects(driver.validate('vcpc_enter_stage',{},v));assert.equal(await page.evaluate(()=>window.unexpectedClicks??0),0);
 }
}));
test('the current normal season route takes priority over persistent observable shortcuts and routes',async()=>fixture(async(page,driver)=>{
 for(const buttons of [normal+shortcut,normal+route,normal+shortcut+route]){
  await page.setContent(hub(buttons));
  await page.locator('button').evaluateAll(es=>es.forEach(e=>e.addEventListener('click',()=>{
   window.lastEntry=e.getAttribute('data-action');
   document.body.innerHTML='<div id="topbar-meta"><span class="topbar__chip">SEASON 8</span><span class="topbar__chip">网络赛</span></div><section class="screen--precontest"><div class="start-dock__info"><b>test</b></div><button data-action="start-contest">开始</button></section>';
  })));
  const before=await driver.observe();await driver.validate('vcpc_enter_stage',{},before);const after=await driver.perform('vcpc_enter_stage',{},before);
  assert.equal(after.phase,'strategy');assert.equal(after.identity.stage,'网络赛');assert.equal(await page.evaluate(()=>window.lastEntry),'start-precontest');
 }
}));
