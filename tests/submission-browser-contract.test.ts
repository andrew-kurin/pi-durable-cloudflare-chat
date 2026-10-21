import {copyControl} from '../public/copy-control.js';
import {test} from 'node:test';
import assert from 'node:assert/strict';
import {JSDOM} from 'jsdom';
import {readFile} from 'node:fs/promises';
import {fixture} from './fixtures/submission-worker';
import {createChatSession} from '../public/chat-session.js';
import {createHistoryClient} from '../public/history-client.js';
import {historyPresentation} from '../public/history-view.js';
import {renderMarkdown} from '../public/markdown.js';
import {toolActivity} from '../public/tool-activity.js';
// Real browser controller + app HTTP adapter + signed native HTTP routes/SQLite.
// Only the server's downstream runtime and browser EventSource are deterministic adapters.
async function browser(f:Awaited<ReturnType<typeof fixture>>) {
 const dom=new JSDOM(await readFile('public/index.html','utf8'),{url:'https://chat.example.test/?session=1',runScripts:'outside-only'});
 const w=dom.window as any;const operations:any[]=[];w.fetch=(url:string,init:any={})=>{if(url.startsWith('/api/submit'))operations.push(JSON.parse(init.body));return f.browserFetch(url,init);};
 w.createChatSession=(options:any)=>createChatSession({...options,platform:w});
 w.createHistoryClient=(options:any)=>createHistoryClient({...options,platform:w});
 w.historyPresentation=historyPresentation;w.renderMarkdown=renderMarkdown;w.toolActivity=toolActivity;
 w.EventSource=class {addEventListener(){}close(){}};
 w.copyControl=copyControl;w.eval((await readFile('public/app.js','utf8')).replace(/^import .*\n/gm,''));
 // Initialization is observable in the rendered view, not a private controller hook.
 for(let i=0;i<100&&w.document.getElementById('current-chat-title').textContent!=='First';i++)await new Promise(r=>setTimeout(r,10));
 assert.equal(w.document.getElementById('current-chat-title').textContent,'First');
 const send=()=>w.document.getElementById('form').onsubmit({preventDefault(){}});
 const draft=(value:string)=>{const p=w.document.getElementById('prompt');p.value=value;p.dispatchEvent(new w.Event('input'));};
 return {w,dom,send,draft,operations};
}
test('terminal cancellation crosses native HTTP and the actual app adapter; next explicit Send uses fresh identity, with no automatic retry',async()=>{
 const f=await fixture();const b=await browser(f);let sending:Promise<unknown>|undefined;
 try{
  await f.control('config',{hold:'submit'});b.draft('Same work');sending=b.send();await f.control('wait?name=submit:entered');
  await f.post('/api/abort?session=1',{});await f.control('release?name=submit');await sending;
  assert.match(b.w.document.getElementById('activity').textContent,/Submission cancelled/);
  assert.equal(b.w.document.getElementById('prompt').value,'Same work');
  const before=await f.control('evidence');assert.equal(before.dispatches,1);assert.equal(before.quota.count,1);
  await f.control('config',{});await b.send();
  const after=await f.control('evidence');assert.equal(after.dispatches,2);assert.equal(after.effects,2);assert.equal(after.quota.count,2);assert.equal(b.w.document.getElementById('prompt').value,'');assert.notEqual(b.operations[0].operationId,b.operations[1].operationId);
 }finally{await f.control('release?name=submit');await sending;b.dom.window.close();await f.dispose();}
});
for(const mode of [{failAfter:true},{busy:true}])test('ambiguous failure or unrelated 409 preserves identity through the real browser/server interface '+JSON.stringify(mode),async()=>{
 const f=await fixture();const b=await browser(f);try{
  await f.control('config',mode);b.draft('Retry safely');await b.send();const before=await f.control('evidence');
  await f.control('config',{});await b.send();const after=await f.control('evidence');
  assert.equal(after.effects,1);assert.equal(after.quota.count,1);
  assert.equal(after.dispatches,mode.busy?1:2);assert.equal(b.operations[0].operationId,b.operations[1].operationId);
  assert.equal(b.w.document.getElementById('prompt').value,'');
 }finally{b.dom.window.close();await f.dispose();}
});
