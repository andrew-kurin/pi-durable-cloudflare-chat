import {chromium} from 'playwright-core';
import {readFile,mkdir} from 'node:fs/promises';
import assert from 'node:assert/strict';
const out='.runtime/maintenance';await mkdir(out,{recursive:true});
const browser=await chromium.launch({executablePath:process.env.CHROME_EXECUTABLE||(process.platform==='darwin'?'/Applications/Google Chrome.app/Contents/MacOS/Google Chrome':'/usr/bin/google-chrome'),headless:true,args:['--no-sandbox']});
const state={mode:'frozen',revision:'a'.repeat(40),workerVersion:'version-1',phase:'paused',epoch:'initial',pi:{activities:[],pending:[]},workspaces:[],blockers:[],checkpoint:null},requests=[],errors=[];let held,fail=false;
try{
 const page=await browser.newPage({viewport:{width:390,height:844}});page.setDefaultTimeout(5000);page.on('pageerror',e=>errors.push(e.message));
 await page.route('**/*',async route=>{const u=new URL(route.request().url());assert.equal(u.origin,'https://chat.example.test');if(u.pathname==='/api/maintenance'){
  const b=route.request().postDataJSON();if(b)requests.push(b);if(held)await held;if(fail)return route.fulfill({status:503,json:{error:'Native checkpoint unavailable; remain paused.'}});
  if(b?.action==='pause'){assert.notEqual(b.operationId,'initial');assert.match(b.operationId,/^[a-zA-Z0-9-]{8,80}$/);state.epoch=b.operationId;}
  if(b?.action==='checkpoint')state.checkpoint={id:'checkpoint-1',bookmark:'test-stub',revision:state.revision};
  if(b?.action==='resume'){assert.equal(b.epoch,state.epoch);assert.equal(b.checkpointId,state.checkpoint.id);assert.equal(b.workerVersion,state.workerVersion);state.phase='active';}
  return route.fulfill({json:state});
 }if(u.pathname==='/favicon.ico')return route.fulfill({status:404});const file=u.pathname==='/maintenance'?'maintenance.html':u.pathname.slice(1);assert.ok(['maintenance.html','maintenance.js'].includes(file));return route.fulfill({body:await readFile('public/'+file),contentType:file.endsWith('.js')?'text/javascript':'text/html'});});
 await page.goto('https://chat.example.test/maintenance');await page.locator('#status').filter({hasText:'version-1'}).waitFor();assert.equal(await page.locator('#resume').isEnabled(),false);assert.equal(await page.locator('#stop').isEnabled(),false);
 await page.locator('#pause').click();await page.waitForFunction(()=>JSON.parse(document.querySelector('#status').textContent).epoch!=='initial');assert.equal(requests.filter(x=>x.action==='pause').length,1);assert.notEqual(requests[0].operationId,'initial');
 let release;held=new Promise(resolve=>release=resolve);await page.locator('#checkpoint').click();assert.equal(await page.locator('#checkpoint').isEnabled(),false);assert.equal(await page.locator('#resume').isEnabled(),false);release();held=undefined;await page.locator('#status').filter({hasText:'checkpoint-1'}).waitFor();assert.equal(requests.filter(x=>x.action==='checkpoint').length,1);assert.equal(await page.locator('#resume').isEnabled(),false,'frozen never offers resume');
 state.mode='active';state.workerVersion='version-2';await page.locator('#refresh').click();await page.locator('#status').filter({hasText:'version-2'}).waitFor();assert.equal(await page.locator('#resume').isEnabled(),true);
 fail=true;await page.locator('#resume').click();await page.locator('#message').filter({hasText:'Native checkpoint unavailable'}).waitFor();assert.equal(state.phase,'paused');fail=false;await page.locator('#resume').click();await page.locator('#message').filter({hasText:'Admission is active'}).waitFor();assert.equal(await page.locator('#resume').isEnabled(),false);
 await page.screenshot({path:out+'/resumed-mobile.png'});assert.deepEqual(errors,[]);console.log('PASS maintenance controls: frozen/active, stale serving version refresh, duplicate prevention, explicit checkpoint resume and safe failure feedback');
}finally{await browser.close();}
