import {chromium} from 'playwright-core';
import {readFile,mkdir} from 'node:fs/promises';
import assert from 'node:assert/strict';
import {ChatProjection} from '../src/projector.ts';
const assistant=(id,text,calls=[])=>({id,kind:'pi.assistant',model:[{role:'assistant',content:[{type:'text',text},...calls.map(c=>({type:'toolCall',...c,arguments:{private:'not sent to browser'}}))]}]});
const result=(id,name,error=false)=>({id:'result-'+id,kind:'pi.tool-result',data:{diagnostics:[]},model:[{role:'toolResult',toolCallId:id,toolName:name,isError:error,content:[{type:'text',text:'private tool output'}]}]});
const markdown='# Response-local activity\n\n**Strong** and *emphasis*, [a safe link](https://example.com), `inline code`.\n\n- First item\n- Second item\n\n> A useful quote.\n\n```js\nconst longLine = '+ 'x'.repeat(220)+';\n```\n\n| Feature | Result |\n| --- | --- |\n| Saved messages | Formatted |\n\n<script>alert(1)</script>\n![remote image](https://external.invalid/a.png)';
const entries=[{id:'u',kind:'pi.user',model:[{role:'user',content:'Synthetic multi-round question'}]},assistant('round1','',[{id:'web',name:'web_search'},{id:'github',name:'github_read'}]),result('web','web_search'),result('github','github_read',true),assistant('round2','',[{id:'luna',name:'ask_luna'}]),result('luna','ask_luna'),assistant('final',markdown+'\n\n'+('A longer explanation that stays together with its recorded tool activity.\n\n'.repeat(18))+'**Final finding:** the related rounds are directly below this response.')];
const p=new ChatProjection();p.apply({type:'snapshot',entries,tools:[],inbox:[],agent:{},usage:{},compactions:[]});const finalView=p.view();
const browser=await chromium.launch({executablePath:process.env.CHROME_EXECUTABLE || (process.platform==='darwin'?'/Applications/Google Chrome.app/Contents/MacOS/Google Chrome':'/usr/bin/chromium'),headless:true,args:['--no-sandbox','--disable-dev-shm-usage']});
await mkdir('qa',{recursive:true});
try{
 const page=await browser.newPage({viewport:{width:390,height:844},deviceScaleFactor:1,isMobile:true,hasTouch:true});let sessions=[{id:'1'}],posts=0;
 await page.addInitScript(()=>{window.syntheticStreams=[];window.EventSource=class{constructor(){window.syntheticStreams.push(this);queueMicrotask(()=>this.onopen?.());}close(){}};});
 await page.route('**/*',async route=>{
  const u=new URL(route.request().url());assert.equal(u.origin,'https://chat.example.test','No external fixture requests');
  if(u.pathname==='/api/status')return route.fulfill({json:{connected:true,modelEnabled:true,webSearchEnabled:true,canLogin:false}});
  if(u.pathname==='/api/sessions'){if(route.request().method()==='POST'){sessions.push({id:String(sessions.length+1)});return route.fulfill({json:sessions.at(-1)})}return route.fulfill({json:sessions})}
  if(u.pathname==='/api/submit'){posts++;return route.fulfill({json:{accepted:true}})}
  const file=u.pathname==='/'?'index.html':u.pathname.slice(1);
  if(!['index.html','style.css','app.js','markdown.js','tool-activity.js'].includes(file))return route.fulfill({status:404,body:''});
  return route.fulfill({body:await readFile('public/'+file),contentType:file.endsWith('.js')?'text/javascript':file.endsWith('.css')?'text/css':'text/html'});
 });
 const emit=async(view=finalView)=>{await page.waitForFunction(()=>window.syntheticStreams?.length>0);await page.evaluate(v=>window.syntheticStreams.at(-1).onmessage({data:JSON.stringify(v)}),view);};
 await page.goto('https://chat.example.test/');await emit();
 assert.equal(await page.locator('.message img, .message script').count(),0);assert.equal(await page.locator('.message a').getAttribute('rel'),'noopener noreferrer');assert.equal(await page.locator('.tool-row').count(),3);assert.equal(await page.locator('.tool-round').count(),2);
 assert.equal(await page.locator('.message').last().locator('.tool-row').count(),3);assert.match(await page.locator('.message').last().textContent(),/Final finding/);
 assert.equal(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth),true);
 await page.waitForFunction(()=>{const b=document.querySelector('#messages');return b.scrollHeight-b.scrollTop-b.clientHeight<3});
 await page.evaluate(()=>document.querySelector('#messages').scrollTop=200);await page.waitForFunction(()=>Math.abs(document.querySelector('#messages').scrollTop-200)<3);
 const before=await page.evaluate(()=>document.querySelector('#messages').scrollTop);await emit();const after=await page.evaluate(()=>document.querySelector('#messages').scrollTop);assert.ok(Math.abs(after-before)<3,'Preserve reader position away from bottom');
 await page.locator('.tool-row summary').first().click();assert.equal(await page.locator('.tool-row').first().getAttribute('open'),'');await emit();assert.equal(await page.locator('.tool-row').first().getAttribute('open'),'');assert.equal(await page.evaluate(()=>document.activeElement?.tagName),'SUMMARY');
 await page.screenshot({path:'qa/mobile-response-tools.png',fullPage:true});
 await page.locator('#prompt').fill('Synthetic submit');await page.locator('#send').click();await page.waitForFunction(()=>document.getElementById('prompt').value==='');assert.equal(posts,1);
 await page.locator('#new').click();await page.waitForFunction(()=>document.getElementById('sessions').value==='2');await emit();assert.equal(sessions.length,2);assert.equal(await page.locator('.tool-row').first().getAttribute('open'),null);
 await page.locator('#sessions').selectOption('1');await emit();assert.equal(await page.locator('.tool-row').first().getAttribute('open'),'');
 await page.reload();await emit();assert.equal(await page.locator('.tool-row').count(),3);
 await page.setViewportSize({width:1280,height:900});await page.locator('.tool-row').last().scrollIntoViewIfNeeded();assert.equal(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth),true);await page.screenshot({path:'qa/desktop-response-tools.png',fullPage:true});
 console.log('PASS response-local multiple rounds, long-answer scroll/focus, reload, sessions, safe Markdown and mobile/desktop fixtures');
}finally{await browser.close()}
