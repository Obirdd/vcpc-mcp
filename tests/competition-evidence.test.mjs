import {test} from 'node:test';
import assert from 'node:assert/strict';
import {chromium} from 'playwright';
import {VcpcPageAdapter} from '../dist/adapter.js';
const top='<div id="topbar-meta"><span class="topbar__chip">SEASON 14</span><span class="topbar__chip">世界总决赛</span></div>';
test('visible precontest title distinguishes universe from topbar and exposes only public strategy details',async()=>{
 const browser=await chromium.launch({headless:true,executablePath:process.env.VCPC_CHROME_PATH||'/Applications/Google Chrome.app/Contents/MacOS/Google Chrome'});
 try{const page=await browser.newPage();await page.route('https://vcpc.snakes.moe/',r=>r.fulfill({body:'<!doctype html>'}));await page.goto('https://vcpc.snakes.moe/');
  const adapter=new VcpcPageAdapter(page);
  await page.setContent(`${top}<section class="screen--precontest"><h1 class="page-title">可观测宇宙总决赛</h1><button class="strategy-card is-selected"><b class="prep-card__name">求稳流</b><p class="prep-card__desc">先补思路</p><p class="strategy-card__rule">失败先打印</p><div class="prep-card__chips"><span>体力 ×0.92</span><span hidden>SECRET</span></div></button><div class="panel"><h2>赛场情报</h2><p>预测头名 5000</p><p hidden>SECRET</p></div></section>`);
  let o=await adapter.read();assert.equal(o.identity.stage,'世界总决赛');assert.equal(o.competition.stage,'可观测宇宙总决赛');assert.equal(o.competition.source,'precontest_title');
  assert.equal(o.strategy_details[0].selected,true);assert.deepEqual(o.strategy_details[0].modifiers,['体力 ×0.92']);assert.match(o.competition.field_intel,/5000/);assert.ok(!JSON.stringify(o).includes('SECRET'));
  const result=`${top}<section class="screen--result"><p>FINAL STANDINGS · 区域决赛</p><div class="result-rank">#1/276</div><div>金牌 MEDAL</div><div class="panel"><h2>题目复盘</h2><p>A 题 评价 3000</p><span style="opacity:0">SECRET</span></div><div class="topboard-result">第一名 10AC</div></section>`;
  await page.setContent(result);o=await adapter.read();assert.equal(o.final.stage,'区域决赛');assert.equal(o.competition.stage,'区域决赛');assert.equal(o.final.medal,'gold');assert.match(o.final.review_text,/3000/);assert.equal(o.strategy_details,null);assert.ok(!JSON.stringify(o).includes('SECRET'));
  await page.setContent(result.replace('</section>','<p>FINAL STANDINGS · 世界总决赛</p></section>'));o=await adapter.read();assert.equal(o.final.stage,null);assert.equal(o.competition.source,'unverified');
  await page.setContent(`${top}<section class="screen--contest"><button data-action="toggle-play">暂停</button><div class="panel"><h2>题目复盘</h2>SECRET 3000</div><p>FINAL STANDINGS · 可观测宇宙总决赛</p></section>`);o=await adapter.read();assert.equal(o.final,null);assert.equal(o.competition.stage,null);assert.ok(!JSON.stringify(o).includes('SECRET'));
 }finally{await browser.close();}
});
