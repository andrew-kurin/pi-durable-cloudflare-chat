import {copyControl} from '../public/copy-control.js';
import {createChatSession} from '../public/chat-session.js';
import {historyPresentation} from '../public/history-view.js';
import {createHistoryClient} from '../public/history-client.js';
import {test} from 'node:test';import assert from 'node:assert/strict';import {JSDOM} from 'jsdom';import {readFile} from 'node:fs/promises';import {renderMarkdown} from '../public/markdown.js';import {toolActivity} from '../public/tool-activity.js';
test('pending submissions preserve edited drafts and drafts in another conversation',async()=>{
 const html=await readFile('public/index.html','utf8'),script=(await readFile('public/app.js','utf8')).replace(/^import .*\n/gm,'');
 for(const change of ['edited','switched','unchanged']){
  const dom=new JSDOM(html,{url:'https://chat.example.test',runScripts:'outside-only'}),w=dom.window as any;let resolveSubmit:any,stream:any;
  w.createChatSession=(options:any)=>createChatSession({...options,platform:w});w.historyPresentation=historyPresentation;w.createHistoryClient=(options:any)=>createHistoryClient({...options,platform:w});w.renderMarkdown=renderMarkdown;w.toolActivity=toolActivity;w.EventSource=class{onmessage:any;close(){}constructor(){stream=this}};
  w.fetch=async(path:string)=>path.startsWith('/api/submit')?new Promise(r=>resolveSubmit=()=>r({ok:true,json:async()=>({accepted:true})})):{ok:true,json:async()=>path==='/api/sessions'?[{id:'1',title:'Intentional title'},{id:'2'}]:{connected:true,modelEnabled:true}};
  w.copyControl=copyControl;w.eval(script);await new Promise(r=>setTimeout(r,0));const input=w.document.getElementById('prompt');input.value='Original draft';input.dispatchEvent(new w.Event('input'));const submitted=w.document.getElementById('form').onsubmit({preventDefault(){}});
  assert.equal(w.document.getElementById('send').disabled,true);stream.onmessage({data:JSON.stringify({messages:[],partial:'',busy:false})});assert.equal(w.document.getElementById('send').disabled,true,'Idle snapshot cannot re-enable a pending POST');
  if(change==='edited'){input.value='Newer draft';input.dispatchEvent(new w.Event('input'));}if(change==='switched'){w.document.querySelector('[data-session-id="2"]').click();input.value='Other conversation draft';input.dispatchEvent(new w.Event('input'));}
  resolveSubmit();await submitted;assert.equal(input.value,change==='edited'?'Newer draft':change==='switched'?'Other conversation draft':'');assert.equal(w.document.querySelector('[data-session-id="1"]').textContent,'Intentional title');dom.window.close();
 }
});

test('full titles remain available as inert text in existing chat details and history actions after title updates',async()=>{
 const html=await readFile('public/index.html','utf8'),script=(await readFile('public/app.js','utf8')).replace(/^import .*\n/gm,'');
 const dom=new JSDOM(html,{url:'https://chat.example.test',runScripts:'outside-only'}),w=dom.window as any;let stream:any;
 const title='A complete long conversation title with recovery details beyond the clipped row';
 w.createChatSession=(o:any)=>createChatSession({...o,platform:w});w.historyPresentation=historyPresentation;w.createHistoryClient=(o:any)=>createHistoryClient({...o,platform:w});w.renderMarkdown=renderMarkdown;w.toolActivity=toolActivity;
 w.EventSource=class{constructor(){stream=this}close(){}};w.fetch=async(p:string)=>({ok:true,json:async()=>p==='/api/sessions'?[{id:'1',title}]:{connected:true,modelEnabled:true}});
 try{w.copyControl=copyControl;w.eval(script);await new Promise(r=>setTimeout(r,0));assert.equal(w.document.getElementById('chat-full-title').textContent,title);assert.equal(w.document.querySelector('.chat-menu-title').textContent,title);
  const updated='<img src=x onerror=attack> A revised complete title';stream.onmessage({data:JSON.stringify({messages:[],partial:'',busy:false,title:updated})});
  assert.equal(w.document.getElementById('chat-full-title').textContent,updated);assert.equal(w.document.querySelector('.chat-menu-title').textContent,updated);assert.equal(w.document.querySelector('#chat-info img,.chat-menu img'),null);
 }finally{w.dispatchEvent(new w.Event('pagehide'));w.close();}
});
