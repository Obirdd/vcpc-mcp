import {chromium} from 'playwright';
import {test} from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync,existsSync,readFileSync,rmSync} from 'node:fs';
import {spawn} from 'node:child_process';
import {tmpdir} from 'node:os';
import path from 'node:path';
const exe='/Applications/Google Chrome.app/Contents/MacOS/Google Chrome';
const delay=ms=>new Promise(r=>setTimeout(r,ms));
async function stop(child) {
 if (!child || child.exitCode!==null || child.signalCode!==null) return;
 child.kill('SIGTERM');
 for(let i=0;i<30 && child.exitCode===null && child.signalCode===null;i++) await delay(100);
 if(child.exitCode===null && child.signalCode===null){child.kill('SIGKILL');for(let i=0;i<20 && child.exitCode===null && child.signalCode===null;i++)await delay(100);}
 if(child.exitCode===null && child.signalCode===null) throw Error('Chrome child did not exit after SIGKILL');
}
test('synthetic Chrome keychain compatibility preserves cookie only with matching launch option', {timeout:45000}, async()=>{
 assert.ok(existsSync(exe),`Chrome dependency missing: ${exe}`);
 for (const useMock of [false,true]) {
  const dir=mkdtempSync(path.join(tmpdir(),'vcpc-cookie-test-'));let child;let context;let browser;let stderr='';
  try {
   context=await chromium.launchPersistentContext(dir,{headless:true,executablePath:exe,timeout:10000});
   await context.addCookies([{name:'synthetic_test',value:'synthetic_value',domain:'example.com',path:'/',expires:Date.now()/1000+3600}]);await context.close();context=undefined;
   child=spawn(exe,[`--user-data-dir=${dir}`,'--remote-debugging-port=0','--headless=new','--no-first-run',...(useMock?['--use-mock-keychain','--password-store=basic']:[]),'about:blank'],{stdio:['ignore','ignore','pipe']});
   child.stderr.on('data',d=>{stderr=(stderr+d).slice(-4000)});
   const f=path.join(dir,'DevToolsActivePort');
   for(let i=0;i<100&&!existsSync(f)&&child.exitCode===null&&child.signalCode===null;i++)await delay(100);
   if(!existsSync(f))throw Error(`Chrome endpoint unavailable; exit=${child.exitCode} signal=${child.signalCode}; ${stderr}`);
   const port=Number(readFileSync(f,'utf8').split('\n')[0]);assert.ok(Number.isInteger(port)&&port>0);
   browser=await chromium.connectOverCDP(`http://127.0.0.1:${port}`,{timeout:5000});
   const cookies=await browser.contexts()[0].cookies('https://example.com');assert.equal(cookies.some(x=>x.name==='synthetic_test'),useMock);
  } finally {await browser?.close().catch(()=>{});await context?.close().catch(()=>{});await stop(child);rmSync(dir,{recursive:true,force:true});}
 }
});
