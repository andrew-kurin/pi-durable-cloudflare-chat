import {chromium} from 'playwright-core';
import {readFile,mkdir,writeFile} from 'node:fs/promises';
import {execFileSync} from 'node:child_process';
import assert from 'node:assert/strict';
const base=process.env.PI_ID_BASE_REF,out=process.env.PI_ID_CAPTURE_DIR||'.runtime/compact-identifiers';
const id='0123456789abcdef'.repeat(4),input=JSON.stringify({runId:id},null,2),output=JSON.stringify({runId:id,outcome:'still_running'},null,2);
const view={historyProtocol:2,failureState:null,messages:[{id:'u',role:'user',text:'Review the code'},{id:'a',role:'assistant',text:'Waiting for the existing command.',tools:Array.from({length:6},(_,i)=>({id:'wait-'+i,roundId:'round-'+i,label:'Wait for command',state:'success',context:id,input,output,summary:(1500-i*35)+'s remaining. Command still running. Wait again; work is not complete.',detail:'Completed.'}))}],partial:'',busy:false};
await mkdir(out,{recursive:true});const browser=await chromium.launch({executablePath:process.env.CHROME_EXECUTABLE||(process.platform==='darwin'?'/Applications/Google Chrome.app/Contents/MacOS/Google Chrome':'/usr/bin/google-chrome'),headless:true,args:['--no-sandbox','--disable-dev-shm-usage']});
const report={baseline:!!base,errors:[],measurements:[]};
try{
 const page=await browser.newPage({viewport:{width:390,height:844},isMobile:true,hasTouch:true});page.on('pageerror',e=>report.errors.push(e.message));page.setDefaultTimeout(5000);
 await page.addInitScript(()=>{window.streams=[];window.EventSource=class{constructor(){window.streams.push(this);queueMicrotask(()=>this.onopen?.())}close(){}};});
 await page.route('**/*',async route=>{const u=new URL(route.request().url());assert.equal(u.origin,'https://chat.example.test');
  if(u.pathname==='/api/status')return route.fulfill({json:{connected:true,modelEnabled:true,workspaceEnabled:true,workspaceRepository:'owner/example'}});
  if(u.pathname==='/api/sessions')return route.fulfill({json:[{id:'1',title:'Review the code'}]});if(u.pathname==='/api/workspaces')return route.fulfill({json:{}});if(u.pathname==='/api/events')return route.fulfill({json:view});if(u.pathname==='/api/events/close')return route.fulfill({json:{closed:true}});if(u.pathname==='/favicon.ico')return route.fulfill({status:404});
  const file=u.pathname==='/'?'index.html':u.pathname.slice(1);assert.ok(!file.includes('..'));return route.fulfill({body:base?execFileSync('git',['show',base+':public/'+file]):await readFile('public/'+file),contentType:file.endsWith('.css')?'text/css':file.endsWith('.js')?'text/javascript':'text/html'});
 });
 await page.goto('https://chat.example.test');await page.waitForFunction(()=>window.streams.length);
 const emit=()=>page.evaluate(v=>window.streams.at(-1).onmessage({data:JSON.stringify(v)}),view);await emit();
 for(const [name,width,height] of [['mobile',390,844],['narrow',320,568],['desktop',1280,900]]){
  await page.setViewportSize({width,height});await page.locator('#messages').evaluate(e=>e.scrollTop=0);
  const row=page.locator('.tool-context').first();report.measurements.push({name,contextHeight:await row.evaluate(e=>e.getBoundingClientRect().height)});
  if(!base){assert.equal(await row.textContent(),'01234567…89abcdef');assert.equal(await row.getAttribute('title'),id);assert.equal(await row.getAttribute('aria-label'),id);assert.ok(await row.evaluate(e=>e.getBoundingClientRect().height<22));assert.equal(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth),true);}
  await page.screenshot({path:out+'/'+name+'-collapsed.png'});
  await page.locator('.tool-row>summary').first().click();
  if(!base){assert.equal(await page.locator('.tool-input').first().textContent(),input);assert.equal(await page.locator('.tool-output').first().textContent(),output);
   const selected=await page.locator('.tool-input').first().evaluate(e=>{const range=document.createRange();range.selectNodeContents(e);const selection=getSelection();selection.removeAllRanges();selection.addRange(range);return selection.toString();});assert.equal(selected,input);await page.evaluate(()=>getSelection().removeAllRanges());
  }
  await page.screenshot({path:out+'/'+name+'-expanded.png'});await emit();assert.equal(await page.locator('.tool-row').first().getAttribute('open'),'');await page.locator('.tool-row>summary').first().click();
 }
 assert.deepEqual(report.errors,[]);await writeFile(out+'/checks.json',JSON.stringify(report,null,2));console.log(JSON.stringify({passed:true,...report}));
}finally{await browser.close();}
