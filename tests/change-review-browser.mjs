import {chromium} from 'playwright-core';
import {readFile,mkdir} from 'node:fs/promises';
import assert from 'node:assert/strict';

const browser=await chromium.launch({executablePath:process.env.CHROME_EXECUTABLE||(process.platform==='darwin'?'/Applications/Google Chrome.app/Contents/MacOS/Google Chrome':'/usr/bin/google-chrome'),headless:true,args:['--no-sandbox']});
const output='.runtime/change-review';await mkdir(output,{recursive:true});
try {
 for(const [name,width,height] of [['mobile',390,844],['desktop',1280,900]]){
  const page=await browser.newPage({viewport:{width,height}}),errors=[],posts=[];
  page.on('pageerror',error=>errors.push(error.message));
  const id='a'.repeat(64),review={id,phase:'awaiting_owner',title:'<img src=x onerror=attack> safe fixture',repository:'andrew-kurin/pi-durable-cloudflare-chat',baseRevision:'b'.repeat(40),treeSha:'c'.repeat(40),patchSha256:'d'.repeat(64),checks:['test','typecheck','build'].map(check=>({check,runId:'e'.repeat(64)})),patch:'</pre><script>throw Error("injected")</script>\n+'+'雪'.repeat(160)};
  let published=false;
  await page.route('**/*',async route=>{
   const req=route.request(),url=new URL(req.url());assert.equal(url.origin,'https://chat.example.test','fixture must not access a live publisher or app');
   if(url.pathname==='/api/changes/'+id+'/review')return route.fulfill({json:review});
   if(url.pathname==='/api/changes/'+id+'/authorize'){
    assert.equal(req.method(),'POST');posts.push(req.postDataJSON());published=true;
    return route.fulfill({json:{id,phase:'dispatched',publication:{id,phase:'published',pr:{url:'https://github.com/andrew-kurin/pi-durable-cloudflare-chat/pull/1'}}}});
   }
   if(url.pathname==='/api/changes/'+id)return route.fulfill({json:{id,phase:published?'dispatched':'awaiting_owner',...(published?{publication:{id,phase:'published'}}:{})}});
   if(url.pathname==='/favicon.ico')return route.fulfill({status:404});
   const file=url.pathname==='/changes'?'changes.html':url.pathname.slice(1);assert.ok(['changes.html','changes.js','changes.css'].includes(file));
   return route.fulfill({body:await readFile('public/'+file),contentType:file.endsWith('.js')?'text/javascript':file.endsWith('.css')?'text/css':'text/html'});
  });
  await page.goto('https://chat.example.test/changes?session=1&proposal='+id);
  await page.waitForFunction(()=>!document.getElementById('authorize').disabled);
  assert.equal(posts.length,0);assert.equal(await page.locator('#patch').textContent(),review.patch);assert.equal(await page.locator('img, #patch script').count(),0);
  assert.equal(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth),true);
  await page.locator('#authorize').focus();assert.equal(await page.evaluate(()=>document.activeElement?.id),'authorize');
  await page.screenshot({path:output+'/'+name+'.png',fullPage:true});
  await page.locator('#refresh').click();await page.waitForFunction(()=>!document.getElementById('refresh').disabled);assert.equal(posts.length,0,'status must never authorize');
  await page.locator('#authorize').click();await page.waitForFunction(()=>document.getElementById('authorize').hidden);
  assert.deepEqual(posts,[{action:'authorize_signed_draft_pr',patchSha256:review.patchSha256,treeSha:review.treeSha}]);
  await page.reload();await page.waitForFunction(()=>document.getElementById('authorize').hidden);assert.equal(posts.length,1,'reload must not repeat owner authorization');
  assert.deepEqual(errors,[]);await page.close();
 }
 console.log('PASS owner review page: inert source, mobile/desktop layout, explicit hash-bound click, observational refresh and reload (intercepted APIs)');
} finally {await browser.close();}
