import {test} from 'node:test';import assert from 'node:assert/strict';import {JSDOM} from 'jsdom';import {readFile} from 'node:fs/promises';import {renderMarkdown} from '../public/markdown.js';import {toolActivity} from '../public/tool-activity.js';
test('pending submissions preserve edited drafts and drafts in another conversation',async()=>{
 const html=await readFile('public/index.html','utf8'),script=(await readFile('public/app.js','utf8')).replace(/^import .*\n/gm,'');
 for(const change of ['edited','switched','unchanged']){
  const dom=new JSDOM(html,{url:'https://chat.example.test',runScripts:'outside-only'}),w=dom.window as any;let resolveSubmit:any,stream:any;
  w.renderMarkdown=renderMarkdown;w.toolActivity=toolActivity;w.EventSource=class{onmessage:any;close(){}constructor(){stream=this}};
  w.fetch=async(path:string)=>path.startsWith('/api/submit')?new Promise(r=>resolveSubmit=()=>r({ok:true,json:async()=>({accepted:true})})):{ok:true,json:async()=>path==='/api/sessions'?[{id:'1',title:'Intentional title'},{id:'2'}]:{connected:true,modelEnabled:true}};
  w.eval(script);await new Promise(r=>setTimeout(r,0));const input=w.document.getElementById('prompt');input.value='Original draft';input.dispatchEvent(new w.Event('input'));const submitted=w.document.getElementById('form').onsubmit({preventDefault(){}});
  assert.equal(w.document.getElementById('send').disabled,true);stream.onmessage({data:JSON.stringify({messages:[],partial:'',busy:false})});assert.equal(w.document.getElementById('send').disabled,true,'Idle snapshot cannot re-enable a pending POST');
  if(change==='edited'){input.value='Newer draft';input.dispatchEvent(new w.Event('input'));}if(change==='switched'){w.document.querySelector('[data-session-id="2"]').click();input.value='Other conversation draft';input.dispatchEvent(new w.Event('input'));}
  resolveSubmit();await submitted;assert.equal(input.value,change==='edited'?'Newer draft':change==='switched'?'Other conversation draft':'');assert.equal(w.document.querySelector('[data-session-id="1"]').textContent,'Intentional title');dom.window.close();
 }
});
