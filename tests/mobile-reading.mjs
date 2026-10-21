import {chromium} from 'playwright-core';
import {readFile,mkdir,writeFile} from 'node:fs/promises';
import {execFileSync} from 'node:child_process';
import assert from 'node:assert/strict';
const out=process.env.PI_UI_CAPTURE_DIR||'.runtime/mobile-reading',base=process.env.PI_UI_BASE_REF;
await mkdir(out,{recursive:true});
const browser=await chromium.launch({executablePath:process.env.CHROME_EXECUTABLE||(process.platform==='darwin'?'/Applications/Google Chrome.app/Contents/MacOS/Google Chrome':'/usr/bin/google-chrome'),headless:true,args:['--no-sandbox','--disable-dev-shm-usage']});
const title='Review recovery, saved workspace results, and the remaining release checks';
const view={historyProtocol:2,failureState:null,messages:Array.from({length:24},(_,i)=>({id:String(i),role:i%2?'assistant':'user',text:i%2?'The saved results are intact. Review the evidence before continuing.\n\n'+('Keep each command associated with its recorded result. '.repeat(5)):'Review the saved workspace and continue the release checklist.'})),partial:'',busy:false};
const report={baseline:!!base,evidence:'Local Chrome with synthetic visualViewport events; not real iPhone keyboard testing',errors:[],requests:[]};
try{
 const page=await browser.newPage({viewport:{width:390,height:844},isMobile:true,hasTouch:true});page.setDefaultTimeout(5000);page.on('pageerror',e=>report.errors.push(e.message));
 await page.addInitScript(()=>{const v=new EventTarget();Object.assign(v,{height:844,offsetTop:0,scale:1});Object.defineProperty(window,'visualViewport',{value:v});window.viewportEvent=(height,top=0,scale=1)=>{Object.assign(v,{height,offsetTop:top,scale});v.dispatchEvent(new Event('resize'));};window.streams=[];window.EventSource=class{addEventListener(){}constructor(){window.streams.push(this);queueMicrotask(()=>this.onopen?.())}close(){}};});
 await page.route('**/*',async route=>{const u=new URL(route.request().url());assert.equal(u.origin,'https://chat.example.test');if(route.request().method()!=='GET')report.requests.push({path:u.pathname,method:route.request().method()});
  if(u.pathname==='/api/status')return route.fulfill({json:{connected:true,modelEnabled:true,workspaceEnabled:true,workspaceRepository:'owner/example'}});
  if(u.pathname==='/api/sessions')return route.fulfill({json:[{id:'1',title},{id:'2',title:'A second saved conversation with a long descriptive title'}]});
  if(u.pathname==='/api/workspaces')return route.fulfill({json:{}});
  if(u.pathname==='/api/events')return route.fulfill({json:view});
  if(u.pathname==='/api/events/close')return route.fulfill({json:{closed:true}});
  if(u.pathname==='/favicon.ico')return route.fulfill({status:404});
  const file=u.pathname==='/'?'index.html':u.pathname.slice(1);assert.ok(!file.includes('..'));
  return route.fulfill({body:base?execFileSync('git',['show',base+':public/'+file]):await readFile('public/'+file),contentType:file.endsWith('.css')?'text/css':file.endsWith('.js')?'text/javascript':'text/html'});
 });
 const emit=async(v=view)=>{await page.waitForFunction(()=>window.streams.length);await page.evaluate(v=>window.streams.at(-1).onmessage({data:JSON.stringify(v)}),v);};
 await page.goto('https://chat.example.test');await emit();await page.waitForTimeout(50);
 await page.screenshot({path:out+'/mobile-chat.png'});
 if(!base){
  assert.equal(await page.locator('#history-status').isVisible(),false);
  await page.locator('#chat-info>summary').click();assert.equal(await page.locator('#chat-full-title').textContent(),title);assert.equal(await page.locator('#chat-full-title').isVisible(),true);await page.screenshot({path:out+'/mobile-full-title.png'});await page.keyboard.press('Escape');assert.equal(await page.locator('#chat-info').getAttribute('open'),null);
  await page.locator('#history-open').click();await page.locator('.chat-menu>summary').first().click();assert.equal(await page.locator('.chat-menu-title').first().textContent(),title);assert.equal(await page.locator('.chat-menu-title').first().isVisible(),true);
  for(const button of await page.locator('.icon-button').all()){if(!await button.isVisible())continue;const box=await button.boundingBox();assert.ok(box.width>=44&&box.height>=44,JSON.stringify(box));assert.ok((await button.getAttribute('aria-label'))?.trim());}
  report.contrast=await page.evaluate(()=>{
   const luma=rgb=>rgb.match(/\d+/g).slice(0,3).map(Number).map(v=>v/255).map(v=>v<=.04045?v/12.92:((v+.055)/1.055)**2.4).reduce((a,v,i)=>a+v*[.2126,.7152,.0722][i],0);
   const ratio=(a,b)=>(Math.max(luma(a),luma(b))+.05)/(Math.min(luma(a),luma(b))+.05);
   const surface=getComputedStyle(document.documentElement).backgroundColor;
   return {historyIcon:ratio(getComputedStyle(document.getElementById('history-open')).color,surface),historyTitle:ratio(getComputedStyle(document.querySelector('.chat-select')).color,surface),focusRing:ratio('rgb(36,94,74)',surface)};
  });
  assert.ok(report.contrast.historyIcon>=3);assert.ok(report.contrast.historyTitle>=4.5);assert.ok(report.contrast.focusRing>=3);
  await page.screenshot({path:out+'/mobile-title-menu.png'});await page.keyboard.press('Escape');assert.equal(await page.locator('.chat-menu[open]').count(),0);await page.keyboard.press('Escape');assert.equal(await page.locator('#history-drawer').getAttribute('open'),null);
 }
 await page.locator('#prompt').fill(('A multiline unsent draft with saved context.\n').repeat(18));await page.locator('#prompt').focus();await page.locator('#messages').evaluate(e=>{e.style.scrollBehavior='auto';e.scrollTop=200;});
 await page.evaluate(()=>window.viewportEvent(460));if(base)await page.waitForTimeout(70);else await page.waitForFunction(()=>document.documentElement.dataset.shortViewport==='true'&&document.getElementById('prompt').getBoundingClientRect().height<=83);
 report.short=await page.evaluate(()=>({composer:document.getElementById('form').getBoundingClientRect().height,textarea:document.getElementById('prompt').getBoundingClientRect().height,reading:document.getElementById('messages').getBoundingClientRect().height,scroll:document.getElementById('messages').scrollTop}));
 await page.screenshot({path:out+'/mobile-short-composer.png',clip:{x:0,y:0,width:390,height:460}});
 if(!base){
  assert.ok(report.short.textarea<=83);assert.ok(report.short.reading>=220);assert.ok(await page.locator('#prompt').evaluate(e=>e.scrollHeight>e.clientHeight));
  const draft=await page.locator('#prompt').inputValue();
  for(let i=0;i<3;i++){await page.locator('#prompt').blur();await page.evaluate(()=>window.viewportEvent(844));await page.waitForFunction(()=>document.documentElement.dataset.shortViewport==='false');await page.locator('#prompt').focus();await page.evaluate(()=>window.viewportEvent(460));await page.waitForFunction(()=>document.documentElement.dataset.shortViewport==='true');assert.equal(await page.locator('#prompt').inputValue(),draft);assert.ok(Math.abs(await page.locator('#messages').evaluate(e=>e.scrollTop)-report.short.scroll)<3);}
  await page.evaluate(()=>window.streams.at(-1).onerror());await page.waitForFunction(()=>!document.getElementById('history-retry').hidden);assert.equal(await page.locator('#history-status').isVisible(),true);await page.screenshot({path:out+'/mobile-reconnect.png',clip:{x:0,y:0,width:390,height:460}});
  await page.locator('#history-retry').click();await emit();assert.equal(await page.locator('#history-status').isVisible(),false);assert.equal(await page.locator('#prompt').inputValue(),draft);
  await emit({...view,failureState:{kind:'model'},messages:[...view.messages,{id:'failed',role:'assistant',text:'Interrupted',failure:{kind:'model',recoveryAction:'check-status',legacyHint:'Saved work retained.'}}]});await page.locator('#messages').evaluate(e=>e.scrollTop=e.scrollHeight);await page.locator('.status-action').click();assert.equal(await page.locator('#workspace-panel').getAttribute('open'),'');await page.locator('#workspace-panel>summary').click();assert.equal(await page.locator('#prompt').inputValue(),draft);
  await page.locator('#prompt').focus();const focus=await page.locator('#form').evaluate(e=>({outline:getComputedStyle(e).outlineWidth,color:getComputedStyle(e).outlineColor}));assert.equal(focus.outline,'3px');assert.equal(await page.locator('#form').evaluate(e=>getComputedStyle(e).outlineStyle),'solid');
 }
 await page.locator('#prompt').blur();await page.evaluate(()=>window.viewportEvent(900));await page.setViewportSize({width:1280,height:900});await page.locator('#prompt').fill('');await emit();await page.locator('#chat-info>summary').click();await page.screenshot({path:out+'/desktop-title.png'});
 if(!base){assert.equal(await page.locator('#chat-full-title').textContent(),title);assert.equal(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth),true);assert.deepEqual(report.errors,[]);assert.ok(!report.requests.some(r=>r.path==='/api/submit'||r.path.startsWith('/api/workspaces')));}
 await writeFile(out+'/checks.json',JSON.stringify(report,null,2));console.log(JSON.stringify({passed:true,...report}));
}finally{await browser.close();}
