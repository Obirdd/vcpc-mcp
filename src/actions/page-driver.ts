import {randomUUID} from 'node:crypto';
import type {Page,ElementHandle} from 'playwright';
import {VcpcPageAdapter} from '../adapter.js';
import type {ActionDriver,Tool,View} from './controller.js';
import {reviewNotOffered} from './settlement.js';

export class PageDriver implements ActionDriver {
  private dispatched=false;
  private verifiedTeam:{team:string;token:number}|undefined;
  rememberTeam(team:string,token:number){this.verifiedTeam={team,token};}
  wasDispatched():boolean{return this.dispatched;}
  private modal:ElementHandle<SVGElement|HTMLElement>|null=null;
  private decisionId:string|null=null;
  private optionIds:string[]=[];
  private optionFingerprint:string|null=null;
  constructor(readonly page:Page,readonly confirmationTimeoutMs=12000,readonly beforeClick:(tool:Tool)=>void|Promise<void>=()=>{},readonly requireForeground=false,readonly allowEarlyEnd=false){}
  private async lobbyEntrySelector():Promise<string>{
    const normal='[data-action="start-precontest"]';
    const observable='[data-action="start-observable"]';
    const route='button[data-action="start-observable"]:text-is("进入可观测宇宙总决赛 →")';
    const normalCount=await this.page.locator(normal).filter({visible:true}).count();
    const observableCount=await this.page.locator(observable).filter({visible:true}).count();
    // The observable shortcut persists after that contest ends. A unique
    // normal route is the current season's entry and takes priority over it.
    if(normalCount===1)return normal;
    // The champion hub has two equivalent observable controls. Bind only the
    // uniquely labelled route button, never an arbitrary first match.
    if(normalCount===0&&observableCount>0&&await this.page.locator(route).filter({visible:true}).count()===1)return route;
    throw Error('stage_entry_missing_or_ambiguous');
  }
  async documentToken():Promise<number>{const token=await this.page.evaluate(()=>performance.timeOrigin);if(!Number.isFinite(token)||token<=0)throw Error('document_token_unavailable');return token;}
  connected():boolean{return !this.page.isClosed() && (this.page.context().browser()?.isConnected()??false);}
  async observe():Promise<View>{
    const snapshot=await new VcpcPageAdapter(this.page).read();
    const token=await this.documentToken();
    if(snapshot.identity.team_name)this.rememberTeam(snapshot.identity.team_name,token);
    else if(['training','training_result'].includes(snapshot.phase)&&this.verifiedTeam?.token===token){snapshot.identity.team_name=this.verifiedTeam.team;snapshot.uncertainties.push('训练页不显示队名；沿用同一页面文档内已核验身份');}
    const decision=['training_result','event_choice','event_result','judge_pending','judge_revealed'].includes(snapshot.phase);
    if(decision){
      const same=this.modal && await this.modal.evaluate(el=>el.isConnected && el===document.querySelector('.modal-layer')).catch(()=>false);
      if(!same){await this.modal?.dispose();this.modal=await this.page.locator('.modal-layer').elementHandle();this.decisionId=randomUUID();this.optionIds=[];this.optionFingerprint=null;}
      if(!this.modal) throw Error('decision_missing');
    }else{await this.modal?.dispose();this.modal=null;this.decisionId=null;this.optionIds=[];this.optionFingerprint=null;}
    const source=snapshot.dialog;
    let dialog:View['dialog']=null;
    if(source){if(decision){const fingerprint=JSON.stringify({phase:snapshot.phase,source});if(this.optionFingerprint!==null&&fingerprint!==this.optionFingerprint){this.decisionId=randomUUID();this.optionIds=[];}this.optionFingerprint=fingerprint;}const opts=source.options?.map((v,i)=>{const label=typeof v==='string'?v:v.label;this.optionIds[i]??=randomUUID();return {option_id:this.optionIds[i],label};})??null;dialog={...source,decision_id:decision?this.decisionId:null,options:opts};}
    const allowed=['vcpc_observe','vcpc_wait_for_change'];
    const mapping:Record<string,string[]>={registration:['vcpc_register_team'],initial_rating:['vcpc_confirm_initial_rating'],lobby:['vcpc_enter_stage','vcpc_open_training'],rules:['vcpc_enter_stage'],strategy:['vcpc_select_strategy','vcpc_start_contest'],contest_running:['vcpc_control_contest','vcpc_select_problem'],contest_paused:['vcpc_control_contest','vcpc_select_problem'],event_choice:['vcpc_choose_event'],event_result:['vcpc_continue_event'],judge_pending:['vcpc_reveal_judgement'],judge_revealed:['vcpc_collect_judgement'],training:['vcpc_draw_training','vcpc_draw_training_ten','vcpc_return_lobby'],training_result:['vcpc_collect_training'],final:['vcpc_return_lobby','vcpc_get_result','vcpc_claim_review_reward','vcpc_enter_stage']};
    allowed.push(...(mapping[snapshot.phase]??[]));
    if(this.allowEarlyEnd&&['contest_running','contest_paused'].includes(snapshot.phase))allowed.push('vcpc_end_contest');
    return {...snapshot,dialog,allowed_actions:allowed};
  }
  async validate(tool:Tool,args:Record<string,unknown>,before:View):Promise<void>{
    if(tool==='vcpc_end_contest'&&!this.allowEarlyEnd)throw Error('early_end_not_authorized');
    if(this.requireForeground && await this.page.evaluate(()=>document.hidden))throw Error('page_not_visible');
    const selectors:Record<Tool,string>={vcpc_end_contest:'button[aria-label="结束比赛"]',vcpc_return_lobby:before.phase==='final'?'[data-action="continue-after-result"]':'.screen--training [data-action="go-hub"]',vcpc_open_training:'[data-action="open-training"]',vcpc_draw_training:'.screen--training [data-action="draw-training"]',vcpc_draw_training_ten:'.screen--training button:text-is("十连训练 · 10 TP")',vcpc_collect_training:before.dialog?.type==='training_batch'?'.modal-layer button:text-is("收下十张卡")':'.modal-layer .reveal-card [data-ui="close-reveal"]',vcpc_register_team:'[data-action="create-team"]',vcpc_confirm_initial_rating:'[data-ui="close-reveal"]',vcpc_select_problem:'#contest-problems .problem-card',vcpc_enter_stage:before.phase==='rules'?'.rules-modal [data-ui="close-rules"]':before.phase==='final'?'[data-action="continue-after-result"]':'[data-action="start-precontest"]',vcpc_select_strategy:'.strategy-card',vcpc_start_contest:'[data-action="start-contest"]',vcpc_control_contest:args.operation==='speed'?`[data-action="set-speed"][data-speed="${args.speed}"]`:'[data-action="toggle-play"]',vcpc_choose_event:'.event-card .event-choice',vcpc_continue_event:'[data-ui="event-continue"]',vcpc_reveal_judgement:'[data-ui="draw-gacha"]',vcpc_collect_judgement:'[data-ui="close-gacha"]',vcpc_claim_review_reward:'[data-action="claim-review"]'};
    const selector=tool==='vcpc_enter_stage'&&before.phase==='lobby'?await this.lobbyEntrySelector():selectors[tool];
    let target=tool==='vcpc_end_contest'?this.page.getByRole('button',{name:'结束比赛',exact:true}).filter({visible:true}):this.page.locator(selector).filter({visible:true});
    if(tool==='vcpc_open_training')target=target.first();
    if(tool==='vcpc_enter_stage' && before.phase==='rules') target=target.last();
    if(tool==='vcpc_select_problem') target=target.filter({has:this.page.locator('.problem-card__label').getByText(String(args.problem_id),{exact:true})});
    if(tool==='vcpc_select_strategy') target=target.filter({has:this.page.getByText(String(args.strategy),{exact:true})});
    if(tool==='vcpc_choose_event'){const index=before.dialog?.options?.findIndex(o=>o.option_id===args.option_id)??-1;if(index<0)throw Error('选项已失效');target=target.nth(index);}
    if(await target.count()!==1 || !await target.isVisible() || !await target.isEnabled())throw Error('目标控件缺失、不可见、不可用或不唯一');
  }
  async perform(tool:Tool,args:Record<string,unknown>,before:View):Promise<View>{
    this.dispatched=false;const page=this.page;
    if(tool==='vcpc_end_contest'&&!this.allowEarlyEnd)throw Error('early_end_not_authorized');
    const current=await this.observe();
    const actionDocument=await this.documentToken();
    if(current.identity.team_name!==before.identity.team_name || current.phase!==before.phase)throw Error('page_changed_before_click');
    if(tool==='vcpc_start_contest'&&args.expected_stage!==undefined){const c=current.competition as {stage?:string|null;source?:string}|undefined;if(c?.source!=='precontest_title'||c.stage!==args.expected_stage)throw Error('stage_changed_before_click');}
    if(['vcpc_enter_stage','vcpc_return_lobby'].includes(tool)&&reviewNotOffered(before)&&!reviewNotOffered(current))throw Error('review_state_changed_before_click');
    if(before.dialog?.decision_id && current.dialog?.decision_id!==before.dialog.decision_id)throw Error('decision_changed_before_click');
    const click=async(sel:string)=>{const l=page.locator(sel);if(await l.count()!==1 || !await l.isVisible() || !await l.isEnabled())throw Error('control_not_unique_visible_enabled');await this.beforeClick(tool);this.dispatched=true;await l.click({timeout:5000});};
    const waitHidden=async(handle:ElementHandle<SVGElement|HTMLElement>|null)=>{if(!handle)throw Error('decision_handle_missing');await handle.waitForElementState('hidden',{timeout:12000});};
    const waitVisible=async(sel:string)=>{await page.locator(sel).waitFor({state:'visible',timeout:12000});};
    const verifyModal=async()=>{if(!this.modal||!await this.modal.evaluate(el=>el.isConnected && el===document.querySelector('.modal-layer')))throw Error('stale_modal');};
    switch(tool){
      case 'vcpc_open_training':{const button=page.locator('[data-action="open-training"]:visible').first();await this.beforeClick(tool);this.dispatched=true;await button.click({timeout:5000});await waitVisible('.screen--training');break;}
      case 'vcpc_draw_training':await click('.screen--training [data-action="draw-training"]');await waitVisible('.modal-layer .reveal-card:not(.reveal-card--rating) [data-ui="close-reveal"]');break;
      case 'vcpc_draw_training_ten':await click('.screen--training button:text-is("十连训练 · 10 TP")');await waitVisible('.modal-layer button:text-is("收下十张卡")');break;
      case 'vcpc_collect_training':await verifyModal();await click(before.dialog?.type==='training_batch'?'.modal-layer button:text-is("收下十张卡")':'.modal-layer .reveal-card [data-ui="close-reveal"]');await waitHidden(this.modal);break;
      case 'vcpc_return_lobby':await click(before.phase==='final'?'[data-action="continue-after-result"]':'.screen--training [data-action="go-hub"]');await waitVisible('.screen--hub');break;
      case 'vcpc_register_team': {
        const input=page.locator('input[data-field="team-name"]:visible');
        if(await input.count()!==1)throw Error('registration_input_not_unique');
        await input.fill(String(args.team_name));
        if(await input.inputValue()!==args.team_name)throw Error('registration_name_mismatch');
        await click('[data-action="create-team"]');
        await page.locator('input[data-field="team-name"]').waitFor({state:'hidden',timeout:12000});
        break;
      }
      case 'vcpc_select_problem': {const card=page.locator('#contest-problems .problem-card').filter({has:page.locator('.problem-card__label').getByText(String(args.problem_id),{exact:true})});if(await card.count()!==1 || !await card.isVisible() || !await card.isEnabled())throw Error('problem_not_unique');await this.beforeClick(tool);this.dispatched=true;await card.click({timeout:5000});await page.waitForFunction(id=>Array.from(document.querySelectorAll('#contest-problems .problem-card.is-selected')).some(e=>e.querySelector('.problem-card__label')?.textContent?.trim()===id),String(args.problem_id),{timeout:12000});break;}
      case 'vcpc_confirm_initial_rating': await click('[data-ui="close-reveal"]');await page.locator('.reveal-card--rating').waitFor({state:'hidden',timeout:12000});break;
      case 'vcpc_enter_stage':
        if(before.phase==='final'){await click('[data-action="continue-after-result"]');await waitVisible('.screen--hub');}
        else if(before.phase==='lobby'){await click(await this.lobbyEntrySelector());await page.waitForFunction(()=>!!document.querySelector('.screen--precontest, .rules-modal'),null,{timeout:12000});}
        else {const m=page.locator('.rules-modal [data-ui="close-rules"]:visible').last();await this.beforeClick(tool);this.dispatched=true;await m.click({timeout:5000});await page.locator('.rules-modal').waitFor({state:'hidden',timeout:12000});}
        break;
      case 'vcpc_select_strategy': {
        const names=page.locator('.strategy-card').filter({has:page.getByText(String(args.strategy),{exact:true})});
        if(await names.count()!==1 || !await names.isVisible() || !await names.isEnabled())throw Error('strategy_not_unique');
        await this.beforeClick(tool);this.dispatched=true;await names.click({timeout:5000});
        await page.waitForFunction((name)=>Array.from(document.querySelectorAll('.strategy-card')).some(e=>e.getAttribute('aria-pressed')==='true'&&e.querySelector('.prep-card__name')?.textContent?.trim()===name),String(args.strategy),{timeout:12000});break;
      }
      case 'vcpc_start_contest':await click('[data-action="start-contest"]');await waitVisible('.screen--contest');break;
      case 'vcpc_end_contest':{
        const button=page.getByRole('button',{name:'结束比赛',exact:true});
        const acceptEnd=async(dialog:import('playwright').Dialog)=>{
          if(dialog.type()==='confirm'&&/结束.*比赛|比赛.*结束/u.test(dialog.message()))await dialog.accept();
          else await dialog.dismiss();
        };
        page.on('dialog',acceptEnd);
        try{
          if(before.phase!=='end_confirmation'){
            if(await button.count()!==1||!await button.isVisible()||!await button.isEnabled())throw Error('end_control_not_unique_visible_enabled');
            await this.beforeClick(tool);this.dispatched=true;await button.click({timeout:5000});
            await page.waitForFunction(()=>!!document.querySelector('.screen--result')||Array.from(document.querySelectorAll('.modal-layer button')).some(e=>e instanceof HTMLElement&&e.getClientRects().length>0&&e.innerText.trim()==='放弃并滚榜'),null,{timeout:12000});
          }
          let confirmation=await this.observe();const modalDeadline=Date.now()+this.confirmationTimeoutMs;
          while(!['end_confirmation','final'].includes(confirmation.phase)&&Date.now()<modalDeadline){
            if(await this.documentToken()!==actionDocument)throw Error('document_changed_after_click');
            await page.waitForTimeout(100);confirmation=await this.observe();
          }
          if(confirmation.phase==='end_confirmation'){
            const confirm=page.getByRole('button',{name:'放弃并滚榜',exact:true});
            if(await confirm.count()!==1||!await confirm.isVisible()||!await confirm.isEnabled())throw Error('end_confirmation_not_unique_visible_enabled');
            await this.beforeClick(tool);this.dispatched=true;await confirm.click({timeout:5000});
            await confirm.waitFor({state:'hidden',timeout:12000});
          }
          await waitVisible('.screen--result');
        }
        finally{page.off('dialog',acceptEnd);}
        break;
      }
      case 'vcpc_control_contest': {
        if(args.operation==='speed'){const speed=Number(args.speed);const sel=`[data-action="set-speed"][data-speed="${speed}"]`;await click(sel);await page.waitForFunction(s=>document.querySelector(s)?.classList.contains('is-on')===true,sel,{timeout:this.confirmationTimeoutMs});}
        else {await click('[data-action="toggle-play"]');const target=args.operation==='pause'?'继续':'暂停';await page.waitForFunction(t=>document.querySelector('[data-action="toggle-play"]')?.textContent?.includes(t)===true,target,{timeout:12000});}break;
      }
      case 'vcpc_choose_event': {
        await verifyModal();const options=before.dialog?.options??[];const index=options.findIndex(o=>o.option_id===args.option_id);if(index<0)throw Error('stale_option');
        const button=page.locator('.event-card .event-choice:visible').nth(index);const label=(await button.innerText()).trim();if(label!==options[index].label)throw Error('option_changed');await this.beforeClick(tool);this.dispatched=true;await button.click({timeout:5000});await waitVisible('.event-outcome [data-ui="event-continue"]');break;
      }
      case 'vcpc_continue_event':await verifyModal();await click('[data-ui="event-continue"]');await waitHidden(this.modal);break;
      case 'vcpc_reveal_judgement':await verifyModal();await click('[data-ui="draw-gacha"]');await page.waitForFunction(()=>{const l=document.querySelector('.modal-layer--gacha');const close=l?.querySelector<HTMLElement>('[data-ui="close-gacha"]');const title=l?.querySelector('#gacha-title')?.textContent?.trim();return !!(l?.classList.contains('is-revealed')&&l.querySelector('.gacha-card.is-flipped')&&close&&!close.hidden&&close.getClientRects().length&&title&&title!=='评测中…');},null,{timeout:20000});break;
      case 'vcpc_collect_judgement':await verifyModal();await click('[data-ui="close-gacha"]');await waitHidden(this.modal);break;
      case 'vcpc_claim_review_reward':await click('[data-action="claim-review"]');await page.waitForFunction(()=>{const e=document.querySelector<HTMLButtonElement>('[data-action="claim-review"]');return !!e && e.disabled && (e.textContent?.includes('已领取')??false);},null,{timeout:12000});break;
    }
    let after=await this.observe();
    // Click handlers may replace the DOM before the next visible animation
    // frame. Re-observe only; never click twice or follow a new document.
    const trainingDraw=tool==='vcpc_draw_training'||tool==='vcpc_draw_training_ten';
    const settleDeadline=Date.now()+(tool==='vcpc_register_team'||trainingDraw?this.confirmationTimeoutMs:1500);
    // A transparent training receipt leaves the underlying training page
    // recognizable. Wait for the receipt without dispatching a second draw.
    while((after.phase==='unknown'||trainingDraw&&after.phase==='training')&&Date.now()<settleDeadline){
      if(await this.documentToken()!==actionDocument)throw Error('document_changed_after_click');
      await page.waitForTimeout(100);after=await this.observe();
    }
    if(await this.documentToken()!==actionDocument)throw Error('document_changed_after_click');
    const expected:Partial<Record<Tool,string[]>>={vcpc_open_training:['training'],vcpc_draw_training:['training_result'],vcpc_draw_training_ten:['training_result'],vcpc_collect_training:['training'],vcpc_return_lobby:['lobby'],vcpc_register_team:['initial_rating'],vcpc_confirm_initial_rating:['rules','lobby'],vcpc_enter_stage:['strategy','rules','lobby'],vcpc_select_strategy:['strategy'],vcpc_end_contest:['final'],vcpc_start_contest:['contest_running','contest_paused','event_choice','event_result','judge_pending','judge_revealed'],vcpc_choose_event:['event_result'],vcpc_reveal_judgement:['judge_revealed'],vcpc_claim_review_reward:['final']};
    if(expected[tool] && !expected[tool]!.includes(after.phase))throw Error(`unexpected_after:${after.phase}`);
    return after;
  }
  async waitForChange(timeoutMs:number,signal?:AbortSignal){
    const deadline=Date.now()+timeoutMs;
    while(true){
      if(signal?.aborted) throw new Error('wait_cancelled');
      const observation=await this.observe();
      if(signal?.aborted) throw new Error('wait_cancelled');
      if(observation.phase!=='contest_running')return {status:'changed',observation};
      const remaining=deadline-Date.now();if(remaining<=0)return {status:'timeout',observation};
      await new Promise<void>((resolve,reject)=>{
        const timer=setTimeout(()=>{signal?.removeEventListener('abort',cancel);resolve();},Math.min(250,remaining));
        const cancel=()=>{clearTimeout(timer);signal?.removeEventListener('abort',cancel);reject(new Error('wait_cancelled'));};
        signal?.addEventListener('abort',cancel,{once:true});if(signal?.aborted)cancel();
      });
    }
  }
}
