import type { Page } from 'playwright';
import type { PageSnapshot } from './model.js';
import { gameMinutes } from './game-clock.js';

export interface PageAdapter { read(): Promise<PageSnapshot> }

// A single synchronous DOM evaluation avoids mixing two frames of a changing UI.
// Only named, phase-gated elements are read. Never inspect a gacha card back.
export class VcpcPageAdapter implements PageAdapter {
  constructor(private readonly page: Page) {}
  async read(): Promise<PageSnapshot> {
    if (new URL(this.page.url()).origin !== 'https://vcpc.snakes.moe') throw new Error('target_mismatch: 页面不在指定站点');
    const snapshot: PageSnapshot = await this.page.evaluate(() => {
      type Phase = import('./model.js').Observation['phase'];
      const shown = (e: Element | null): e is HTMLElement => {
        if (!(e instanceof HTMLElement) || !e.isConnected || e.closest('[hidden],[aria-hidden="true"]')) return false;
        const style = getComputedStyle(e); if(style.display === 'none' || style.visibility === 'hidden' || e.getClientRects().length === 0)return false;for(let p:HTMLElement|null=e;p;p=p.parentElement)if(Number(getComputedStyle(p).opacity)===0)return false;return true;
      };
      const one = (selector: string, root: ParentNode = document): HTMLElement | null => {
        const items = Array.from(root.querySelectorAll(selector)).filter(shown); return items.length === 1 ? items[0] : null;
      };
      const txt = (selector: string, root: ParentNode = document): string | null => one(selector,root)?.innerText.trim() || null;
      const visibleText=(root:Element):string=>Array.from(root.childNodes).map(n=>n.nodeType===Node.TEXT_NODE?n.textContent??'':n instanceof Element&&shown(n)?visibleText(n):'').join(' ').replace(/\s+/gu,' ').trim();
      const num = (text: string | null): number | null => text && /^\d[\d,]*$/.test(text) ? Number(text.replaceAll(',','')) : null;
      const layers = Array.from(document.querySelectorAll('.modal-layer, [role="dialog"]')).filter(shown).filter(e=> !e.parentElement?.closest('.modal-layer'));
      const topChips = Array.from(document.querySelectorAll('#topbar-meta .topbar__chip')).filter(shown);
      const season = topChips[0]?.innerText.trim().match(/^SEASON\s+(\d+)$/i);
      const identity = {team_name:txt('.team-card__identity h2') ?? txt('.start-dock__info b') ?? txt('.contest-bar__left .chip--soft:last-child') ?? txt('.topboard-result .panel__head .mono'),season:season ? Number(season[1]) : null,stage:topChips[1]?.innerText.trim() || null,rating:num(txt('#topbar-meta .topbar__rating b')),tp:num(txt('#topbar-meta .topbar__tp b'))};
      const screen = ['.screen--hub','.screen--precontest','.screen--contest','.screen--result','.screen--training'].filter(s=>!!one(s));
      const registration = !!one('input[placeholder="给队伍起个名字"]');
      const contestScreen=one('.screen--contest');
      const selected=contestScreen?txt('#contest-problems .problem-card.is-selected .problem-card__label'):null;
      // Read only visible label/value pairs; ambiguous structures remain unknown.
      const metric=(root:Element|null,label:string,pattern:RegExp):string|null=>{if(!root)return null;const labels=Array.from(root.querySelectorAll('*')).filter((e):e is HTMLElement=>shown(e)&&e.children.length===0&&e.innerText.trim()===label);if(labels.length!==1)return null;let parent=labels[0].parentElement;for(let level=0;parent&&parent!==root&&level<3;level++,parent=parent.parentElement){const values=Array.from(parent.querySelectorAll('*')).filter((e):e is HTMLElement=>shown(e)&&e.children.length===0&&pattern.test(e.innerText.trim())).map(e=>e.innerText.trim());if(values.length===1)return values[0];if(values.length>1)return null;}return null;};
      const activeSpeeds=contestScreen?Array.from(contestScreen.querySelectorAll('[data-action="set-speed"].is-on')).filter(shown):[];
      const speedValues=activeSpeeds.map(e=>Number(e.getAttribute('data-speed')));const speed=activeSpeeds.length===1&&[1,2,4].includes(speedValues[0])?speedValues[0] as 1|2|4:null;
      const playText=contestScreen?txt('[data-action="toggle-play"]',contestScreen):null;const playback=playText?.includes('暂停')&&!playText.includes('继续')?'running' as const:playText?.includes('继续')&&!playText.includes('暂停')?'paused' as const:null;
      const workstation=contestScreen?one('#contest-workstation',contestScreen):null;
      const contest=contestScreen?{elapsed:txt('#clock-elapsed',contestScreen)?.replace(/^已用\s*/, '') ?? null,remaining:txt('#clock-remain',contestScreen),selected_problem:selected,speed,playback,team:{stamina:metric(contestScreen,'体力',/^\d+(?:\.\d+)?(?:\s*%|\s*\/\s*\d+)?$/),morale:metric(contestScreen,'士气',/^\d+(?:\.\d+)?(?:\s*%|\s*\/\s*\d+)?$/)},current_problem:{id:selected,insight:selected?metric(workstation,'思路',/^\d+(?:\.\d+)?%$/):null,code:selected?metric(workstation,'代码',/^\d+(?:\.\d+)?%$/):null,testing:selected?metric(workstation,'对拍',/^\d+(?:\.\d+)?%$/):null}}:null;
      const problems = one('.screen--contest') ? Array.from(document.querySelectorAll('#contest-problems .problem-card')).filter(shown).map(e=>({id:txt('.problem-card__label',e) ?? '',title:txt('.problem-card__title',e),status:txt('.problem-card__meta',e)})).filter(p=>p.id.length>0) : null;
      const evidence:string[]=[]; const uncertainties:string[]=[];
      let phase:Phase='unknown'; let blocking_dialog:string|null=null; let dialog:PageSnapshot['dialog']=null;
      if (layers.length > 1) { evidence.push('multiple_visible_dialogs'); uncertainties.push('多个遮挡层同时出现，无法安全判断优先级'); }
      else if (layers.length === 1) {
        const layer=layers[0]; blocking_dialog='unknown';
        const endTitles=Array.from(layer.querySelectorAll('h1,h2,h3,[role="heading"]')).filter(shown).filter(e=>/^结束比赛\s*[?？]$/u.test(e.innerText.trim()));
        const endButtons=Array.from(layer.querySelectorAll('button')).filter(shown);
        if(endTitles.length===1&&endButtons.filter(e=>e.innerText.trim()==='放弃并滚榜').length===1&&endButtons.filter(e=>e.innerText.trim()==='继续比赛').length===1){
          phase='end_confirmation';blocking_dialog='end_confirmation';dialog={type:'end_confirmation',title:endTitles[0].innerText.trim(),text:null,options:null,result:null,effects:null};
        } else if (one('.event-card',layer)) {
          blocking_dialog='event'; const outcome=one('.event-outcome',layer); const choices=Array.from(layer.querySelectorAll('.event-choice')).filter(shown);
          const continuing=!!one('[data-ui="event-continue"]',layer);
          if (outcome && continuing && choices.length===0) {phase='event_result'; dialog={type:'event',title:txt('.event-card__title',layer),text:txt('.event-card__text',layer),options:null,result:txt('.event-outcome__text',layer),effects:Array.from(layer.querySelectorAll('.event-outcome__effects > *')).filter(shown).map(e=>e.innerText.trim())};}
          else if (!outcome && !continuing && choices.length>0) {phase='event_choice'; dialog={type:'event',title:txt('.event-card__title',layer),text:txt('.event-card__text',layer),options:choices.map(e=>e.innerText.trim()),result:null,effects:null};}
          else evidence.push('event_state_conflict');
        } else if (one('.gacha',layer)) {
          blocking_dialog='judge'; const header=Array.from(layer.querySelectorAll('.mono')).filter((e): e is HTMLElement=>shown(e) && !e.closest('.gacha-card__face--back')).map(e=>e.innerText.trim()).find(t=>/^[A-Z]\s*·\s*\d+:\d{2}$/.test(t))?.match(/^([A-Z])\s*·\s*(\d+:\d{2})$/);const problem_id=header?.[1]??null;const submitted_at=header?.[2]??null; const draw=!!one('[data-ui="draw-gacha"]',layer); const close=!!one('[data-ui="close-gacha"]',layer); const title=txt('#gacha-title',layer); const revealed=layer.classList.contains('is-revealed') && !!one('.gacha-card.is-flipped',layer);
          if (draw && !close && !revealed) {phase='judge_pending'; dialog={type:'judge',title:null,text:null,problem_id,submitted_at,options:null,result:null,effects:null};}
          else if (!draw && close && revealed && title && title!=='评测中…') {phase='judge_revealed'; dialog={type:'judge',title,text:txt('#gacha-sub',layer),problem_id,submitted_at,options:null,result:txt('.gacha-card__face--back .verdict-label',layer),effects:null};}
          else evidence.push('judge_state_conflict_or_animation');
        } else if (one('.reveal-card--rating',layer) && one('[data-ui="close-reveal"]',layer)) {phase='initial_rating'; blocking_dialog='initial_rating'; dialog={type:'initial_rating',title:txt('.reveal-card__name',layer),text:txt('.reveal-card__rating',layer),options:null,result:null,effects:null};}
        else if (one('.screen--training') && Array.from(layer.querySelectorAll('h2')).filter(shown).filter(e=>e.innerText.trim()==='十连训练').length===1 && Array.from(layer.querySelectorAll('button')).filter(shown).filter(e=>e.innerText.trim()==='收下十张卡').length===1) {
          // The native receipt lists all ten already revealed cards. Read only
          // visible leaf text, including the displayed total and current Rating.
          const receipt=Array.from(layer.querySelectorAll('*')).filter((e):e is HTMLElement=>shown(e)&&e.children.length===0).map(e=>e.innerText.trim()).filter(Boolean);
          const receiptText=visibleText(layer);
          if(/\b10\s*TP\b/.test(receiptText)){phase='training_result';blocking_dialog='training';dialog={type:'training_batch',title:'十连训练',text:'网站原生10TP十连结果；收取后重新观察余额',options:null,result:receiptText,effects:receipt};}
          else evidence.push('training_batch_cost_unverified');
        }
        else if (one('.screen--training') && one('.reveal-card:not(.reveal-card--rating)',layer) && one('[data-ui="close-reveal"]',layer)) {phase='training_result';blocking_dialog='training';dialog={type:'training',title:txt('.reveal-card__name',layer),text:txt('.reveal-card__desc',layer),options:null,result:txt('.reveal-card__delta',layer),effects:[txt('.reveal-card__after',layer)].filter((v):v is string=>v!==null)};}
        else if (one('.rules-modal',layer)) {phase='rules'; blocking_dialog='rules'; dialog={type:'rules',title:txt('.modal__title',layer),text:null,options:null,result:null,effects:null};}
        else evidence.push('unrecognized_visible_dialog');
      } else if (screen.length + Number(registration) !== 1) {evidence.push('screen_markers_conflict_or_missing');}
      else if(registration) phase='registration';
      else if(screen[0]==='.screen--hub') phase='lobby';
      else if(screen[0]==='.screen--precontest') phase='strategy';
      else if(screen[0]==='.screen--training') phase='training';
      else if(screen[0]==='.screen--result') phase='final';
      else if(screen[0]==='.screen--contest') {
        const play=txt('[data-action="toggle-play"]');
        if (play?.includes('暂停')) phase='contest_running'; else if(play?.includes('继续')) phase='contest_paused'; else evidence.push('contest_control_unrecognized');
      }
      if(phase==='initial_rating' && dialog?.title){
        if(identity.team_name && identity.team_name!==dialog.title){phase='unknown';dialog=null;evidence.push('initial_rating_identity_conflict');}
        else identity.team_name=dialog.title;
      }
      const strategy_options = phase==='strategy' ? Array.from(document.querySelectorAll('.strategy-card .prep-card__name')).filter(shown).map(e=>e.innerText.trim()) : null;
      // Topbar chips describe career progress, which may already be the NEXT
      // stage. Only an actual precontest title or result heading verifies a run.
      const stagePattern=/^(网络赛|区域赛|区域决赛|世界总决赛|可观测宇宙总决赛)$/u;
      const preTitle=phase==='strategy'?txt('.screen--precontest h1'):null;
      const resultScreen=phase==='final'?one('.screen--result'):null;
      const resultHeadings=resultScreen?Array.from(resultScreen.querySelectorAll('*')).filter(shown).map(e=>visibleText(e)).filter(t=>/^FINAL STANDINGS\s*[·•]\s*(网络赛|区域赛|区域决赛|世界总决赛|可观测宇宙总决赛)$/u.test(t)):[];
      const uniqueHeadings=[...new Set(resultHeadings)];
      const resultHeading=uniqueHeadings.length===1?uniqueHeadings[0]:null;
      const resultStage=resultHeading?.match(/^FINAL STANDINGS\s*[·•]\s*(.+)$/u)?.[1]??null;
      const panelText=(label:string,root:Element|null):string|null=>{if(!root)return null;const hs=Array.from(root.querySelectorAll('h2,h3')).filter(shown).filter(e=>e.innerText.trim()===label);if(hs.length!==1)return null;const panel=hs[0].closest('.panel');return panel&&root.contains(panel)?visibleText(panel).slice(0,20000):null;};
      const competition:NonNullable<PageSnapshot['competition']>={stage:preTitle&&stagePattern.test(preTitle)?preTitle:resultStage,source:preTitle&&stagePattern.test(preTitle)?'precontest_title':resultStage?'result_heading':'unverified',title:phase==='strategy'?preTitle:resultHeading,topbar_stage:identity.stage,field_intel:phase==='strategy'?panelText('赛场情报',one('.screen--precontest')):null};
      const strategy_details=phase==='strategy'?Array.from(document.querySelectorAll('.strategy-card')).filter(shown).map(e=>({name:txt('.prep-card__name',e)??'',description:txt('.prep-card__desc',e),rule:txt('.strategy-card__rule',e),modifiers:Array.from(e.querySelectorAll('.prep-card__chips > *')).filter(shown).map(x=>x.innerText.trim()),selected:e.getAttribute('aria-pressed')==='true'||e.classList.contains('is-selected')})).filter(s=>s.name):null;
      const final:PageSnapshot['final'] = phase==='final' ? {rank:txt('.result-rank'), facts:Array.from(document.querySelectorAll('.result-facts > span')).filter(shown).map(e=>e.innerText.trim()), verdicts:Array.from(document.querySelectorAll('.verdict-stat')).filter(shown).map(e=>({verdict:txt('span',e)??'',count:num(txt('b',e))})), rating:Array.from(document.querySelectorAll('.rating-delta strong')).filter(shown).map(e=>e.innerText.trim()), reward:txt('[data-action="claim-review"]')} : null;
      if(final){
        final.stage=resultStage;final.heading=resultHeading;
        const medals=resultScreen?Array.from(resultScreen.querySelectorAll('*')).filter(shown).map(e=>visibleText(e)).filter(t=>/^(金牌|银牌|铜牌)\s+MEDAL$/u.test(t)):[];
        const uniqueMedals=[...new Set(medals)];
        final.medal=uniqueMedals.length===1?({'金牌':'gold','银牌':'silver','铜牌':'bronze'} as const)[uniqueMedals[0].split(/\s/u)[0] as '金牌'|'银牌'|'铜牌']:null;
        final.review_text=panelText('题目复盘',resultScreen);
        const standings=one('.topboard-result');final.standings_text=standings?visibleText(standings).slice(0,20000):null;
        const exit=one('[data-action="continue-after-result"]');
        const ak=final.facts.some(f=>/^AK\s+全过$/u.test(f.trim()));
        final.review_status=final.reward?.includes('已领取')?'claimed':final.reward?.includes('+1 TP')?'pending'
          :ak&&document.querySelectorAll('[data-action="claim-review"]').length===0
            &&exit instanceof HTMLButtonElement&&!exit.disabled?'not_offered':'unknown';
        if(final.review_status==='not_offered')evidence.push('ak_review_not_offered');
      }
      if (phase==='unknown') uncertainties.push('页面状态未知或证据冲突，未输出弹窗内容');
      if(['strategy','final'].includes(phase)&&!competition.stage)uncertainties.push('本场赛段未由赛前标题或结算标题唯一核验；不得用顶部进度或名次补推');
      if (identity.team_name===null) uncertainties.push('当前页面未识别到可见队名');
      if (contest) {uncertainties.push('比赛可能自行推进；观察为单次页面快照，playback 为控件状态，弹窗可能暂时阻塞推进');if(contest.selected_problem===null)uncertainties.push('当前题目未唯一选中，无法归属准备进度');if(contest.speed===null)uncertainties.push('speed 缺失、未显示选中或多个选中');if(contest.playback===null)uncertainties.push('playback 控件缺失或状态冲突');for(const [k,v] of Object.entries({...contest.team,insight:contest.current_problem.insight,code:contest.current_problem.code,testing:contest.current_problem.testing}))if(v===null)uncertainties.push(`${k} 可见值缺失或不唯一`);}
      uncertainties.push('run_id 无法从页面可靠确定；题目评级不在赛中输出');
      const tenButtons=Array.from(document.querySelectorAll('.screen--training button')).filter((e):e is HTMLButtonElement=>shown(e)&&e instanceof HTMLButtonElement&&e.innerText.trim()==='十连训练 · 10 TP');
      const training=['training','training_result'].includes(phase) ? {cost_tp:/消耗\s*1\s*TP\s*抽/.test(txt('.training-hero__copy p')??'')?1 as const:null,can_draw:phase==='training'&&!!one('[data-action="draw-training"]'),cost_ten_tp:/10\s*TP\s*一次抽十张/.test(txt('.training-hero__copy p')??'')&&tenButtons.length===1?10 as const:null,can_draw_ten:phase==='training'&&tenButtons.length===1&&!tenButtons[0].disabled,result:phase==='training_result'?dialog?.result??null:null} : null;
      if(training){const button=one('[data-action="draw-training"]');training.can_draw=phase==='training'&&button instanceof HTMLButtonElement&&!button.disabled;}
      return {training,phase,blocking_dialog,identity,competition,strategy_details,contest,problems,strategy_options,final,dialog,uncertainties,evidence};
    });
    if (snapshot.contest) {
      snapshot.contest.elapsed_minutes = gameMinutes(snapshot.contest.elapsed);
      snapshot.contest.remaining_minutes = gameMinutes(snapshot.contest.remaining);
      snapshot.contest.time_unit = 'game_minutes';
      snapshot.contest.clock_format = 'H:MM';
      if (snapshot.contest.elapsed_minutes === null || snapshot.contest.remaining_minutes === null)
        snapshot.uncertainties.push('游戏时钟缺失或格式未识别；分钟数为 null，不按秒或固定总时长补推');
    }
    return snapshot;
  }
}
