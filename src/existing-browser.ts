import {chromium, type Browser, type Page} from 'playwright';
import {randomUUID} from 'node:crypto';

const origin='https://vcpc.snakes.moe';
export function existingEndpoint(env:NodeJS.ProcessEnv=process.env):string {
  const endpoint=env.VCPC_CDP_ENDPOINT;
  if (!endpoint) return 'chrome';
  let url:URL;
  try {url=new URL(endpoint);} catch {throw Error('invalid_cdp_endpoint');}
  if (!['http:','ws:'].includes(url.protocol) || !['localhost','127.0.0.1','[::1]'].includes(url.hostname) || url.username || url.password || url.hash) throw Error('invalid_cdp_endpoint');
  return endpoint;
}
function isTarget(page:Page):boolean {try{return !page.isClosed() && new URL(page.url()).origin===origin;}catch{return false;}}

// IDs are scoped to a single CDP connection. They are not profile or save IDs.
export class ExistingBrowser {
  private ids=new Map<Page,string>();
  private watchers=new Map<Page,()=>void>();
  private bound?:{page:Page; bindingId:string; invalid:boolean; cleanup:()=>void};
  private closed=false;
  constructor(private readonly browser:Browser) {}
  static async connect(endpoint=existingEndpoint()):Promise<ExistingBrowser> {
    return new ExistingBrowser(await chromium.connectOverCDP(endpoint,{noDefaults:true,timeout:15000}));
  }
  listTargets():Array<{target_id:string}> {
    if(this.closed || !this.browser.isConnected()) throw Error('browser_disconnected');
    const pages=this.browser.contexts().flatMap(c=>c.pages()).filter(isTarget);
    for(const page of this.ids.keys()) if(!pages.includes(page)) this.forget(page);
    return pages.map(page=>{let id=this.ids.get(page);if(!id){id=randomUUID();this.ids.set(page,id);const invalidate=()=>this.forget(page);const nav=(frame:import('playwright').Frame)=>{if(frame===page.mainFrame())invalidate();};page.on('framenavigated',nav);page.on('close',invalidate);page.on('crash',invalidate);this.watchers.set(page,()=>{page.off('framenavigated',nav);page.off('close',invalidate);page.off('crash',invalidate);});}return {target_id:id};});
  }
  private forget(page:Page):void {this.ids.delete(page);this.watchers.get(page)?.();this.watchers.delete(page);}
  bind(targetId:string):{page:Page;binding_id:string} {
    if(this.bound) throw Error('already_bound');
    this.listTargets();
    const page=[...this.ids].find(([,id])=>id===targetId)?.[0];
    if(!page || !isTarget(page)) throw Error('target_mismatch');
    const bindingId=randomUUID();
    const bound={page,bindingId,invalid:false,cleanup:()=>{}};
    const invalidate=()=>{bound.invalid=true;};
    const navigation=(frame:import('playwright').Frame)=>{if(frame===page.mainFrame()) invalidate();};
    page.on('close',invalidate);page.on('crash',invalidate);page.on('framenavigated',navigation);
    bound.cleanup=()=>{page.off('close',invalidate);page.off('crash',invalidate);page.off('framenavigated',navigation);};
    this.bound=bound;
    return {page,binding_id:bindingId};
  }
  assertBound(bindingId:string):void {
    if(this.closed || !this.browser.isConnected()) throw Error('browser_disconnected');
    if(!this.bound || this.bound.bindingId!==bindingId || this.bound.invalid || !isTarget(this.bound.page)) throw Error('binding_invalid');
  }
  // CDP target ID and document time origin are continuity evidence, not a save or contest ID.
  // Never substitute a team name for these values. A matching document still cannot prove
  // that a manually started second contest is the original run.
  async continuity(bindingId:string, installWitness=false, resetWitness=false):Promise<{target_id:string;document_id:string;witness_id?:string;witness_invalid?:boolean}> {
    this.assertBound(bindingId);const page=this.bound!.page;
    const session=await page.context().newCDPSession(page);
    try {
      const info=await session.send('Target.getTargetInfo');
      const time=await page.evaluate(()=>performance.timeOrigin);
      const frame=await session.send('Page.getFrameTree');
      const world=await session.send('Page.createIsolatedWorld',{frameId:frame.frameTree.frame.id,worldName:'vcpc-mcp-continuity-v1'});
      // Fixed internal program in an isolated world: records screen transitions only, not hidden game data.
      const script=`(() => {
        const key='__vcpc_witness_v1';
        if (${resetWitness ? 'true' : 'false'} && globalThis[key]) { globalThis[key].observer.disconnect(); delete globalThis[key]; }
        if (!globalThis[key] && ${installWitness ? 'true' : 'false'}) {
          const visible=(s)=>Array.from(document.querySelectorAll(s)).some(e=>{const h=e;return h.isConnected && !h.closest('[hidden],[aria-hidden="true"]') && getComputedStyle(h).display!=='none' && getComputedStyle(h).visibility!=='hidden' && h.getClientRects().length>0;});
          const stage=()=>visible('.screen--result')?'final':visible('.screen--contest')||!!document.querySelector('.screen--contest')?'contest':'other';
          const w={id:${JSON.stringify(randomUUID())},invalid:false,stage:stage(),root:document.documentElement};
          const containsBoundary=(n)=>n.nodeType===1 && (n.matches('.screen--contest,.screen--result,.screen--hub,.screen--precontest') || !!n.querySelector('.screen--contest,.screen--result,.screen--hub,.screen--precontest')); 
          const observer=new MutationObserver(records=>{
            let sawBoundary=records.some(r=>Array.from(r.addedNodes).some(containsBoundary) || Array.from(r.removedNodes).some(containsBoundary) || (r.type==='attributes' && containsBoundary(r.target)));
            const next=stage();
            if(w.stage==='final' && next==='contest')w.invalid=true;
            if(w.stage==='contest' && next==='contest' && sawBoundary)w.invalid=true;
            if(w.stage==='contest' && next==='other')w.invalid=true;
            if(next==='final')w.stage='final';else if(next==='contest')w.stage='contest';
          });
          observer.observe(document.documentElement,{subtree:true,childList:true,attributes:true,attributeFilter:['class','style','hidden','aria-hidden']});
          w.observer=observer;globalThis[key]=w;
        }
        const w=globalThis[key];return w?{id:w.id,invalid:w.invalid || w.root!==document.documentElement}:null;
      })()`;
      const result=await session.send('Runtime.evaluate',{contextId:world.executionContextId,expression:script,returnByValue:true});
      if(result.exceptionDetails)throw Error('continuity_unknown');
      const witness=result.result.value as {id:string;invalid:boolean}|null;
      this.assertBound(bindingId);
      if(!info.targetInfo.targetId || !Number.isFinite(time) || time<=0)throw Error('continuity_unknown');
      return {target_id:info.targetInfo.targetId,document_id:String(time),...(witness?{witness_id:witness.id,witness_invalid:witness.invalid}:{})};
    } finally {await session.detach().catch(()=>{});}
  }
  get version():string {return this.browser.version();}
  async close():Promise<void> {
    if(this.closed)return;this.closed=true;this.bound?.cleanup();for(const page of this.ids.keys())this.forget(page);
    // Playwright's CDP Browser.close disconnects its transport, not the external Chrome.
    await this.browser.close();
  }
}
