import {chromium, type Browser, type Page} from 'playwright';
import {spawn} from 'node:child_process';
import {existsSync,readFileSync,writeFileSync,statSync,mkdirSync,readlinkSync} from 'node:fs';
import path from 'node:path';
import {resolveConfig} from './config.js';
export interface BrowserConnection {page:Page;fresh:boolean;close():Promise<void>}
export interface BrowserConnector {connect():Promise<BrowserConnection>}
const {dir,profile}=resolveConfig();const metadata=path.join(dir,'browser.json');
type BrowserInfo={pid:number;port:number;profile:string};
const alive=(pid:number)=>{try{process.kill(pid,0);return true;}catch(e){if((e as NodeJS.ErrnoException).code==='ESRCH')return false;throw Error('browser_process_unknown');}};
export function mayLaunchFreshBrowser(logPath:string):boolean {
  if(!existsSync(logPath)) return true;
  try{return !readFileSync(logPath,'utf8').split('\n').filter(Boolean).some(line=>{const e=JSON.parse(line);return e.kind==='begin' && e.tool==='vcpc_start_contest';});}catch{return false;}
}
export class PersistentTestBrowser implements BrowserConnector {
 async connect():Promise<BrowserConnection>{
  mkdirSync(dir,{recursive:true});
  if(existsSync(path.join(dir,'recovery-pending.json')))throw Error('previous_recovery_incomplete');
  let info:BrowserInfo|undefined;
  if(existsSync(metadata)) {try{info=JSON.parse(readFileSync(metadata,'utf8'));}catch{throw Error('browser_metadata_invalid: 元数据损坏，保留文件并人工核对');}if(info?.profile!==profile || !Number.isInteger(info?.pid) || info.pid<1 || !Number.isInteger(info?.port) || info.port<1 || info.port>65535)throw Error('browser_metadata_invalid: 元数据与档案不符');if(!alive(info.pid)) throw Error('browser_recovery_required: 浏览器已退出，拒绝刷新比赛或自动重新启动');}
  let browser:Browser;let fresh=false;
  if(!info){
    if(!mayLaunchFreshBrowser(path.join(dir,'actions.jsonl')))throw Error('browser_recovery_required: 已有比赛记录，拒绝自动打开新页');
    mkdirSync(path.dirname(profile),{recursive:true,mode:0o700});
    const exe=process.env.VCPC_CHROME_PATH || (process.platform==='darwin'?'/Applications/Google Chrome.app/Contents/MacOS/Google Chrome':'');if(!exe)throw Error('VCPC_CHROME_PATH required');
    const started=Date.now();const child=spawn(exe,[`--user-data-dir=${profile}`,'--remote-debugging-address=127.0.0.1','--remote-debugging-port=0','--no-first-run','--no-default-browser-check','--use-mock-keychain','--password-store=basic',...(process.env.VCPC_HEADED==='1'?[]:['--headless=new']),'about:blank'],{detached:true,stdio:'ignore'});child.unref();let spawnError:Error|undefined;child.once('error',e=>{spawnError=e;});if(!child.pid)throw Error('browser_launch_failed');
    const portfile=path.join(profile,'DevToolsActivePort'); let port:number|undefined;
    try {
      for(let i=0;i<100;i++){
        if(spawnError || child.exitCode!==null || child.signalCode!==null || !alive(child.pid))throw Error('browser_launch_failed');
        if(existsSync(portfile)&&statSync(portfile).mtimeMs>=started-1000){const n=Number(readFileSync(portfile,'utf8').split('\n')[0]);if(Number.isInteger(n)&&n>0 && n<=65535){port=n;break;}}
        await new Promise(r=>setTimeout(r,100));
      }
      if(!port)throw Error('browser_endpoint_timeout');
      info={pid:child.pid,port,profile};writeFileSync(metadata,JSON.stringify(info,null,2)+'\n',{mode:0o600,flag:'wx'});fresh=true;
    } catch(e) {
      if(child.exitCode===null && child.signalCode===null){child.kill('SIGTERM');for(let i=0;i<30 && child.exitCode===null && child.signalCode===null;i++)await new Promise(r=>setTimeout(r,100));if(child.exitCode===null && child.signalCode===null)child.kill('SIGKILL');}
      throw e;
    }
  }
  // Bind endpoint to this profile's Chrome singleton and DevTools port file.
  const lock=readlinkSync(path.join(profile,'SingletonLock'));const [portLine,wsPath]=readFileSync(path.join(profile,'DevToolsActivePort'),'utf8').trim().split('\n');
  if(!lock.endsWith(`-${info.pid}`)||Number(portLine)!==info.port||!/^\/devtools\/browser\/[a-f0-9-]+$/i.test(wsPath??''))throw Error('browser_target_mismatch');
  browser=await chromium.connectOverCDP(`ws://127.0.0.1:${info.port}${wsPath}`,{timeout:10000});
  try {
  const contexts=browser.contexts();if(contexts.length!==1)throw Error('unexpected_browser_context');
  const pages=contexts[0].pages();if(pages.length!==1)throw Error('unexpected_browser_pages');const page=pages[0];
  if(fresh){if(page.url()!=='about:blank')throw Error('unexpected_initial_page');await page.goto('https://vcpc.snakes.moe/',{waitUntil:'domcontentloaded',timeout:30000});await page.locator('body').waitFor({state:'visible',timeout:15000});}
  else if(new URL(page.url()).origin!=='https://vcpc.snakes.moe')throw Error('target_mismatch');
  // Disconnecting CDP leaves the independently launched browser and current page alive.
  return {page,fresh,close:async()=>{await browser.close();}};
  } catch(e) { await browser.close().catch(()=>{}); throw e; }
 }
}
