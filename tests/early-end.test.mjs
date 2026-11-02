import {test,before,after} from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync,rmSync} from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {chromium} from 'playwright';
import {PageDriver} from '../dist/actions/page-driver.js';
import {ActionController} from '../dist/actions/controller.js';
import {Ledger} from '../dist/actions/ledger.js';
import {startAndEnd} from '../dist/actions/start-and-end.js';
import {reconcileEarlyEnd} from '../dist/reconcile-early-end.js';
import {verifiedEarlyEndResolution} from '../dist/actions/ledger.js';
import {settledEvidence} from '../dist/recovery.js';

let browser,page;
before(async()=>{
  browser=await chromium.launch({executablePath:process.env.VCPC_CHROME_PATH||'/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',headless:true});
  page=await browser.newPage();await page.route('https://vcpc.snakes.moe/',r=>r.fulfill({status:200,contentType:'text/html',body:'<!doctype html>'}));
  await page.goto('https://vcpc.snakes.moe/');
});
after(async()=>await browser?.close());
const contest=(buttons='<button aria-label="结束比赛">结束</button>')=>`<section class="screen--contest"><div class="contest-bar__left"><span class="chip--soft">test</span></div><button data-action="toggle-play">暂停</button>${buttons}</section>`;
const final='<section class="screen--result"><div class="topboard-result"><div class="panel__head"><span class="mono">test</span></div></div><div class="result-rank">#2000/2300</div><div class="result-facts"><span>0 过题</span></div><button data-action="claim-review">赛后复盘 +1 TP</button></section>';

test('only opted-in page drivers expose early end; one native click and matching browser confirmation reach final',async()=>{
  for(const confirm of [false,true]){
    await page.setContent(contest());
    const standard=new PageDriver(page),enabled=new PageDriver(page,12000,()=>{},false,true);
    assert.equal((await standard.observe()).allowed_actions.includes('vcpc_end_contest'),false);
    assert.equal((await enabled.observe()).allowed_actions.includes('vcpc_end_contest'),true);
    await assert.rejects(standard.validate('vcpc_end_contest',{},await standard.observe()),/early_end_not_authorized/);
    await page.getByRole('button',{name:'结束比赛',exact:true}).evaluate((e,{html,confirm})=>e.onclick=()=>{window.endClicks=(window.endClicks??0)+1;if(!confirm||window.confirm('确定结束本场比赛？'))document.body.innerHTML=html;},{html:final,confirm});
    const before=await enabled.observe();await enabled.validate('vcpc_end_contest',{confirm_early_end:true},before);
    const after=await enabled.perform('vcpc_end_contest',{confirm_early_end:true},before);
    assert.equal(after.phase,'final');assert.equal(after.identity.team_name,'test');
    assert.equal(await page.evaluate(()=>window.endClicks),confirm?2:1);
    assert.equal(page.listenerCount('dialog'),0);
  }
  const enabled=new PageDriver(page,12000,()=>{},false,true);
  for(const buttons of ['', '<button aria-label="结束比赛" disabled>结束</button>', '<button aria-label="结束比赛">结束</button>'.repeat(2)]){
    await page.setContent(contest(buttons));await assert.rejects(enabled.validate('vcpc_end_contest',{},await enabled.observe()));
  }
});

const fixture=(enabled=true)=>{
  const dir=mkdtempSync(path.join(os.tmpdir(),'vcpc-early-')),ledger=new Ledger(dir);
  const state={phase:'strategy',identity:{team_name:'test'},dialog:null};let calls=[];let token=123;
  const driver={documentToken:async()=>token,observe:async()=>structuredClone(state),perform:async(tool)=>{calls.push(tool);if(tool==='vcpc_start_contest')state.phase='contest_running';if(tool==='vcpc_end_contest')state.phase='final';return structuredClone(state);}};
  const controller=new ActionController(driver,ledger,'test',()=>1800000000000,100000,3,0,enabled);
  return {ledger,state,driver,controller,calls,setToken:v=>token=v,clean:()=>{ledger.close();rmSync(dir,{recursive:true,force:true});}};
};

test('early end requires opt-in, explicit confirmation and the same confirmed run; reward is still required before another start',async()=>{
  const off=fixture(false);try{assert.equal((await startAndEnd(off.controller,off.driver.observe,'off')).status,'early_end_not_authorized');assert.equal(off.calls.length,0);}finally{off.clean();}
  const t=fixture();try{
    assert.equal((await t.controller.execute('vcpc_end_contest','no-run',{confirm_early_end:true})).status,'run_not_confirmed');
    assert.equal((await t.controller.execute('vcpc_start_contest','start',{})).status,'confirmed');
    assert.equal((await t.controller.execute('vcpc_end_contest','no-confirm',{})).status,'early_end_not_authorized');
    t.setToken(124);assert.equal((await t.controller.execute('vcpc_end_contest','changed',{confirm_early_end:true})).status,'run_continuity_unknown');t.setToken(123);
    assert.equal((await t.controller.execute('vcpc_end_contest','end',{confirm_early_end:true})).status,'confirmed');
    assert.equal((await t.controller.execute('vcpc_end_contest','end',{confirm_early_end:true})).status,'confirmed_replay');
    t.state.phase='strategy';assert.equal((await t.controller.execute('vcpc_start_contest','again',{})).status,'previous_run_not_complete');
    assert.deepEqual(t.calls,['vcpc_start_contest','vcpc_end_contest']);
  }finally{t.clean();}
});

test('quick start/end retries retain the same run after a blocked end and never double-start',async()=>{
  const t=fixture();try{
    const original=t.driver.perform;t.driver.perform=async(tool,args,before)=>{const view=await original(tool,args,before);if(tool==='vcpc_start_contest'){t.state.phase='event_choice';t.state.blocking_dialog='event';return structuredClone(t.state);}return view;};
    assert.equal((await startAndEnd(t.controller,t.driver.observe,'farm-one')).status,'blocked_by_dialog');
    assert.equal(t.ledger.startAttempts(),1);t.state.phase='contest_running';t.state.blocking_dialog=null;
    const settled=await startAndEnd(t.controller,t.driver.observe,'farm-one');assert.equal(settled.status,'confirmed');assert.equal(settled.observation.phase,'final');
    assert.equal((await startAndEnd(t.controller,t.driver.observe,'farm-one')).status,'confirmed');
    assert.deepEqual(t.calls,['vcpc_start_contest','vcpc_end_contest']);assert.equal(t.ledger.startAttempts(),1);
  }finally{t.clean();}
});

test('an unconfirmed end blocks later writes instead of being counted as successful farming',async()=>{
  const t=fixture();try{
    assert.equal((await t.controller.execute('vcpc_start_contest','start',{})).status,'confirmed');
    t.driver.perform=async()=>structuredClone(t.state);
    assert.equal((await t.controller.execute('vcpc_end_contest','end',{confirm_early_end:true})).status,'outcome_unknown');
    assert.equal((await t.controller.execute('vcpc_end_contest','retry',{confirm_early_end:true})).status,'outcome_unknown');
    assert.equal(t.ledger.entries.filter(e=>e.tool==='vcpc_end_contest'&&e.kind==='confirmed').length,0);
  }finally{t.clean();}
});

const confirmation='<div class="modal-layer"><h2>结束比赛?</h2><p>这会放弃剩余时间并立即进入终场结算。</p><button>继续比赛</button><button>放弃并滚榜</button></div>';
test('the real custom end confirmation is recognized and confirmed once before final',async()=>{
  await page.setContent(contest());const driver=new PageDriver(page,12000,()=>{},false,true);
  await page.getByRole('button',{name:'结束比赛',exact:true}).evaluate((e,{modal,final})=>e.onclick=()=>{document.body.insertAdjacentHTML('beforeend',modal);const layer=document.querySelector('.modal-layer');layer.style.opacity='0';setTimeout(()=>layer.style.opacity='1',150);layer.querySelector('button:last-child').onclick=()=>{window.customEndCount=(window.customEndCount??0)+1;document.querySelector('.screen--contest').remove();document.body.insertAdjacentHTML('afterbegin',final);setTimeout(()=>layer.remove(),250);};},{modal:confirmation,final});
  const result=await driver.perform('vcpc_end_contest',{confirm_early_end:true},await driver.observe());
  assert.equal(result.phase,'final');assert.equal(await page.evaluate(()=>window.customEndCount),1);
  await page.setContent(contest()+confirmation);const pending=await driver.observe();assert.equal(pending.phase,'end_confirmation');assert.equal(pending.dialog.type,'end_confirmation');
});

test('read-only final verification resolves a chain of end requests after a closing animation without clicking again',async()=>{
  const t=pendingEnd();let clicks=0;const finalView={phase:'final',identity:t.identity,final:{rank:'#2000/2300',facts:['0 过题'],reward:'赛后复盘 +1 TP'}};
  t.append('begin','vcpc_end_contest','attempt2',{before:{phase:'end_confirmation',identity:t.identity},document_token:123});t.append('unknown','vcpc_end_contest','attempt2');
  const driver={documentToken:async()=>123,observe:async()=>structuredClone(finalView),perform:async()=>{clicks++;throw Error('must not click');}};
  try{
    assert.equal((await reconcileEarlyEnd(driver,t.ledger,'test','old-end')).status,'early_end_verified');
    assert.equal(clicks,0);assert.equal(t.ledger.unresolved(),false);assert.equal(t.ledger.resolution('old-end'),'confirmed');assert.equal(t.ledger.resolution('attempt2'),'confirmed');
    const corrupted=structuredClone(t.ledger.entries);corrupted.at(-1).after.identity.team_name='other';assert.equal(verifiedEarlyEndResolution(corrupted,'attempt2'),false);
    t.append('begin','vcpc_claim_review_reward','r');t.append('confirmed','vcpc_claim_review_reward','r',{after:{...finalView,final:{reward:'已领取'}}});assert.equal(settledEvidence(t.ledger.entries,'test').identity.rating,800);
  }finally{t.clean();}
});

const pendingEnd=()=>{
  const t=fixture(),at=new Date().toISOString(),identity={team_name:'test',season:2,stage:'网络赛',rating:800,tp:3};
  const append=(kind,tool,id,extra={})=>t.ledger.append({at,kind,tool,action_id:id,args:'{}',...extra});
  append('begin','vcpc_start_contest','s',{document_token:123});append('confirmed','vcpc_start_contest','s');
  append('begin','vcpc_end_contest','old-end',{before:{phase:'contest_running',identity},document_token:123});append('unknown','vcpc_end_contest','old-end',{after:{phase:'unknown',identity}});
  return {...t,identity,append};
};

test('a pending custom end is completed only in the same run/document; original unknown is preserved and independently resolved',async()=>{
  const t=pendingEnd();let clicks=0;
  const driver={documentToken:async()=>123,observe:async()=>({phase:'end_confirmation',identity:t.identity,dialog:{type:'end_confirmation'}}),perform:async()=>{clicks++;return {phase:'final',identity:t.identity,final:{reward:'赛后复盘 +1 TP'}};}};
  try{
    const r=await reconcileEarlyEnd(driver,t.ledger,'test','old-end');assert.equal(r.status,'early_end_verified');assert.equal(clicks,1);
    assert.equal(t.ledger.entries.filter(e=>e.kind==='unknown').length,1);assert.equal(t.ledger.resolution('old-end'),'confirmed');assert.equal(t.ledger.unresolved(),false);
    assert.equal(verifiedEarlyEndResolution(t.ledger.entries,'old-end'),true);
    const corrupted=structuredClone(t.ledger.entries);corrupted.at(-1).document_token=124;assert.equal(verifiedEarlyEndResolution(corrupted,'old-end'),false);
    t.append('begin','vcpc_claim_review_reward','reward');t.append('confirmed','vcpc_claim_review_reward','reward',{after:{phase:'final',identity:t.identity,final:{reward:'赛后复盘奖励已领取'}}});
    assert.equal(settledEvidence(t.ledger.entries,'test').identity.rating,800);
    await assert.rejects(reconcileEarlyEnd(driver,t.ledger,'test','old-end'),/not_pending_early_end/);
  }finally{t.clean();}
});

test('early-end reconciliation refuses changed document, absent confirmation, wrong team or extra writes before any click',async()=>{
  for(const mode of ['document','phase','identity','extra']){
    const t=pendingEnd();let clicks=0;
    const driver={documentToken:async()=>mode==='document'?124:123,observe:async()=>({phase:mode==='phase'?'contest_running':'end_confirmation',identity:mode==='identity'?{team_name:'other'}:t.identity,dialog:{type:'end_confirmation'}}),perform:async()=>{clicks++;return {phase:'final',identity:t.identity};}};
    try{
      if(mode==='extra')t.append('confirmed','vcpc_control_contest','extra');
      await assert.rejects(reconcileEarlyEnd(driver,t.ledger,'test','old-end'));
      assert.equal(clicks,0);assert.equal(t.ledger.resolution('old-end'),undefined);
    }finally{t.clean();}
  }
});
