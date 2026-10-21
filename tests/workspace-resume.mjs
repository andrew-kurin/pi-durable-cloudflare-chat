import {chromium} from 'playwright-core';
import {readFile,mkdir} from 'node:fs/promises';
import assert from 'node:assert/strict';
const out=process.env.PI_WORKSPACE_CAPTURE_DIR||'.runtime/workspace-resume';await mkdir(out,{recursive:true});
const browser=await chromium.launch({executablePath:process.env.CHROME_EXECUTABLE||(process.platform==='darwin'?'/Applications/Google Chrome.app/Contents/MacOS/Google Chrome':'/usr/bin/google-chrome'),headless:true,args:['--no-sandbox']});
try{
 for(const [name,width,height] of [['mobile',390,844],['desktop',1280,900]]){
  const page=await browser.newPage({viewport:{width,height}});const errors=[];page.on('pageerror',e=>errors.push(e.message));let submits=0,opens=0;
  let state={id:'aaaaaaaa-aaaa-4aaa-aaaa-aaaaaaaaaaaa',phase:'ready',runs:{},activation:{mode:'owner_open'}};
  await page.addInitScript(()=>{window.streams=[];window.EventSource=class{addEventListener(){}constructor(){window.streams.push(this);queueMicrotask(()=>this.onopen?.());}close(){}};});
  await page.route('**/*',async route=>{const req=route.request(),u=new URL(req.url());assert.equal(u.origin,'https://chat.example.test');
   if(u.pathname==='/api/status')return route.fulfill({json:{connected:true,modelEnabled:true,workspaceEnabled:true,workspaceRepository:'owner/example'}});
   if(u.pathname==='/api/sessions')return route.fulfill({json:[{id:'1',title:'Review the code'}]});
   if(u.pathname==='/api/submit'){submits++;state={...state,phase:'closed',activation:{mode:'automatic'}};return route.fulfill({json:{accepted:true,operationId:req.postDataJSON().operationId,session:'1'}});}
   if(u.pathname==='/api/workspaces'){if(req.method()==='POST')opens++;return route.fulfill({json:{workspaceId:state.id}});}
   if(u.pathname.startsWith('/api/workspaces/'))return route.fulfill({json:state});
   if(u.pathname==='/api/events/close')return route.fulfill({json:{closed:true}});if(u.pathname==='/favicon.ico')return route.fulfill({status:404});
   const file=u.pathname==='/'?'index.html':u.pathname.slice(1);assert.ok(!file.includes('..'));return route.fulfill({body:await readFile('public/'+file),contentType:file.endsWith('.css')?'text/css':file.endsWith('.js')?'text/javascript':'text/html'});
  });
  await page.goto('https://chat.example.test');await page.waitForFunction(()=>document.getElementById('workspace-state').textContent==='Stopped');await page.evaluate(()=>window.streams.at(-1).onmessage({data:JSON.stringify({historyProtocol:2,messages:[{id:'user',role:'user',text:'Review the code'}],partial:'',busy:false})}));await page.locator('#workspace-panel>summary').click();await page.screenshot({path:out+'/'+name+'-stopped.png'});
  await page.locator('#prompt').fill('Review the project');await page.locator('#send').click();await page.waitForFunction(()=>document.getElementById('workspace-state').textContent==='Closed');assert.equal(submits,1);assert.equal(opens,0);
  state={...state,id:'bbbbbbbb-bbbb-4bbb-bbbb-bbbbbbbbbbbb',phase:'ready',activation:{mode:'ready'}};await page.locator('#workspace-refresh').click();await page.waitForFunction(()=>document.getElementById('workspace-state').textContent==='Ready');await page.screenshot({path:out+'/'+name+'-ready.png'});
  await page.reload();await page.waitForFunction(()=>document.getElementById('workspace-state').textContent==='Ready');assert.equal(opens,0);assert.equal(submits,1);assert.equal(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth),true);assert.deepEqual(errors,[]);await page.close();
 }
 console.log('PASS stopped activation overrides stale Ready; new submission refreshes; ready successor survives reload without manual open (390px/1280px, mocked APIs)');
}finally{await browser.close();}
