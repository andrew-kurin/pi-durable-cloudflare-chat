import {chromium} from 'playwright-core';
import {readFile,mkdir} from 'node:fs/promises';
import assert from 'node:assert/strict';
const out='.runtime/session-controller/previews';await mkdir(out,{recursive:true});
const browser=await chromium.launch({executablePath:process.env.CHROME_EXECUTABLE||(process.platform==='darwin'?'/Applications/Google Chrome.app/Contents/MacOS/Google Chrome':'/usr/bin/chromium'),headless:true});
let release,entered;const submissions=[],errors=[];
try{
 const page=await browser.newPage({viewport:{width:390,height:844},isMobile:true,hasTouch:true});page.setDefaultTimeout(5000);page.on('pageerror',e=>errors.push(e.message));
 await page.addInitScript(()=>{localStorage.setItem('pi:last-chat:v1','2');window.streams=[];window.EventSource=class{addEventListener(){}constructor(url){this.url=url;window.streams.push(this);queueMicrotask(()=>this.onopen?.())}close(){this.closed=true}};});
 await page.route('**/*',async route=>{
  const u=new URL(route.request().url());assert.equal(u.origin,'https://chat.example.test','No external requests');
  if(u.pathname==='/api/sessions')return route.fulfill({json:[{id:'1',title:'First'},{id:'2',title:'Second'}]});
  if(u.pathname==='/api/status')return route.fulfill({json:{connected:true,modelEnabled:true,workspaceEnabled:false}});
  if(u.pathname==='/api/events/close')return route.fulfill({json:{closed:true}});
  if(u.pathname==='/api/submit'){
   submissions.push(route.request().postDataJSON());entered?.();
   const status=await new Promise(resolve=>{release=resolve});
   return route.fulfill({status,json:status===200?{accepted:true}:{error:'Temporary transport failure'}});
  }
  if(u.pathname==='/favicon.ico')return route.fulfill({status:404});
  const file=u.pathname==='/'?'index.html':u.pathname.slice(1);assert.ok(['index.html','app.js','history-client.js','chat-session.js','history-view.js','workspace.js','markdown.js','tool-activity.js','copy-control.js','style.css'].includes(file));
  return route.fulfill({body:await readFile('public/'+file),contentType:file.endsWith('.js')?'text/javascript':file.endsWith('.css')?'text/css':'text/html'});
 });
 await page.goto('https://chat.example.test/');await page.waitForFunction(()=>window.streams.length>0);assert.equal(await page.locator('#current-chat-title').textContent(),'Second');
 const select=async id=>{await page.locator('#history-open').click();await page.locator('[data-session-id="'+id+'"]').click();};
 const emit=async view=>page.evaluate(v=>window.streams.at(-1).onmessage({data:JSON.stringify({historyProtocol:2,messages:[],busy:false,...v})}),view);
 await emit({failureState:null});await page.locator('#prompt').fill('Original second draft');
 let started=new Promise(resolve=>{entered=resolve});await page.locator('#send').click();await started;
 await select('1');await page.locator('#prompt').fill('First chat draft');assert.equal(await page.locator('#send').isDisabled(),true);
 await select('2');assert.equal(await page.locator('#prompt').inputValue(),'Original second draft');release(503);
 await page.waitForFunction(()=>!document.querySelector('#send').disabled);assert.match(await page.locator('#activity').textContent(),/Temporary transport failure/);
 await select('1');assert.equal(await page.locator('#prompt').inputValue(),'First chat draft');await select('2');
 started=new Promise(resolve=>{entered=resolve});await page.locator('#send').click();await started;
 assert.equal(submissions.length,2);assert.equal(submissions[0].operationId,submissions[1].operationId);assert.equal(submissions[1].session,'2');
 await page.locator('#prompt').fill('Newer second draft');release(200);await page.waitForFunction(()=>!document.querySelector('#send').disabled);
 assert.equal(await page.locator('#prompt').inputValue(),'Newer second draft');
 const legacy='Sol could not finish this response. Diagnostic hint: rate or usage limit. Reported HTTP 429.';
 await emit({failureState:null,messages:[{id:'copy',role:'assistant',text:legacy}]});assert.equal(await page.locator('.status-action').count(),0);
 await emit({failureState:{kind:'model',recoveryAction:'check-status'},messages:[{id:'failed',role:'assistant',text:'Copy has changed completely.',failure:{kind:'model',diagnostic:{category:'rate or usage limit',httpStatus:'429'},recoveryAction:'check-status'}}]});
 assert.equal(await page.locator('.status-action').count(),1);assert.match(await page.locator('#messages').textContent(),/Reported HTTP 429/);
 for(const width of [390,1280]){await page.setViewportSize({width,height:844});assert.equal(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth),true);await page.screenshot({path:out+'/structured-failure-'+width+'.png'});}
 await emit({messages:[{id:'legacy',role:'assistant',text:legacy}]});assert.equal(await page.locator('.status-action').count(),1);assert.match(await page.locator('#messages').textContent(),/Reported HTTP 429/);
 assert.deepEqual(errors,[]);console.log('PASS selected-chat drafts, deferred submit/edit/switch/retry identity, modern/legacy failure rendering; zero live inference and page errors');
}finally{release?.(200);await browser.close()}
