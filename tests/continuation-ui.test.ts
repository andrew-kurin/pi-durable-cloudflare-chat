import {copyControl} from '../public/copy-control.js';
import {createChatSession} from '../public/chat-session.js';
import {historyPresentation} from '../public/history-view.js';
import {createHistoryClient} from '../public/history-client.js';
import {test} from 'node:test';
import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import {JSDOM} from 'jsdom';
import {ChatProjection} from '../src/projector';
import {renderMarkdown} from '../public/markdown.js';
import {toolActivity} from '../public/tool-activity.js';
const user={id:'u',kind:'pi.user',model:[{role:'user',content:'Review the project'}]} as never;
const call={id:'a',kind:'pi.assistant',model:[{role:'assistant',content:[{type:'toolCall',id:'c',name:'workspace_status',arguments:{}}]}]} as never;
const result={id:'r',kind:'pi.tool-result',model:[{role:'toolResult',toolCallId:'c',toolName:'workspace_status',content:[{type:'text',text:JSON.stringify({data:{phase:'ready'}})}]}]} as never;
const failure={id:'e',kind:'pi.assistant',model:[{role:'assistant',content:[],stopReason:'error',errorMessage:'400: No tool output found for function call PRIVATE_TOKEN_DIAGNOSTIC'}]} as never;
const reply={id:'reply',kind:'pi.assistant',model:[{role:'assistant',content:[{type:'text',text:'Review complete.'}],stopReason:'stop'}]} as never;
function snapshot(entries:never[]){return {type:'snapshot',entries,tools:[],inbox:[],agent:{},usage:{},compactions:[]} as never;}
async function browser(){
 const html=await readFile('public/index.html','utf8'),script=(await readFile('public/app.js','utf8')).replace(/^import .*\n/gm,'');
 const dom=new JSDOM(html,{url:'https://chat.example.test',runScripts:'outside-only'}),w=dom.window as any,requests:string[]=[];let stream:any;
 w.createChatSession=(options:any)=>createChatSession({...options,platform:w});w.historyPresentation=historyPresentation;w.createHistoryClient=(options:any)=>createHistoryClient({...options,platform:w});w.renderMarkdown=renderMarkdown;w.toolActivity=toolActivity;
 w.EventSource=class{onmessage:any;close(){}constructor(){stream=this}};
 w.fetch=async(path:string,options:any)=>{assert.ok(!options?.method||options.method==='GET');requests.push(path);return {ok:true,json:async()=>path==='/api/sessions'?[{id:'1',title:'Great'}]:{connected:true,modelEnabled:true}}};
 w.copyControl=copyControl;w.eval(script);await new Promise(r=>setTimeout(r,0));
 return {dom,requests,send:(p:ChatProjection)=>stream.onmessage({data:JSON.stringify(p.view())})};
}
test('actual chat UI displays terminal model error after workspace tool results and reload without submitting again',async()=>{
 const p=new ChatProjection();p.apply({type:'run_start',inputs:[]});for(const entry of [user,call,result,failure])p.apply({type:'entry_appended',entry});p.apply({type:'run_end',inputs:[]});
 for(const reload of [false,true]){
  if(reload)p.apply(snapshot([user,call,result,failure]));
  const b=await browser();try{b.send(p);const d=b.dom.window.document;assert.match(d.getElementById('messages')!.textContent!,/Response interrupted/);assert.match(d.getElementById('messages')!.textContent!,/tool response protocol.*Reported HTTP 400/);assert.match(d.getElementById('messages')!.textContent!,/Workspace status/);assert.ok(!d.body.textContent!.includes('PRIVATE_TOKEN_DIAGNOSTIC'));assert.equal((d.getElementById('send') as HTMLButtonElement).disabled,true);assert.ok(b.requests.every(path=>!path.includes('submit')));}finally{b.dom.window.close()}
 }
});
test('actual chat UI keeps task fault visible through run_end and clears it when next run starts',async()=>{
 const b=await browser();try{const p=new ChatProjection();p.apply({type:'task_failed',taskId:'fault' as never,kind:'network',message:'PRIVATE_TOKEN_DIAGNOSTIC'});p.apply({type:'run_end',inputs:[]});b.send(p);assert.match(b.dom.window.document.getElementById('activity')!.textContent!,/Response interrupted/);assert.ok(!b.dom.window.document.body.textContent!.includes('PRIVATE_TOKEN_DIAGNOSTIC'));p.apply({type:'run_start',inputs:[]});b.send(p);assert.equal(b.dom.window.document.getElementById('activity')!.textContent,'Assistant is thinking…');}finally{b.dom.window.close()}
});
test('actual chat UI renders successful tool continuation without a failure notice on reconnect',async()=>{
 const p=new ChatProjection();p.apply(snapshot([user,call,result,reply]));const b=await browser();try{b.send(p);const text=b.dom.window.document.getElementById('messages')!.textContent!;assert.match(text,/Review complete/);assert.match(text,/Workspace status/);assert.ok(!text.includes('could not finish'));assert.equal(p.view().messages.find(m=>m.id==='reply')!.tools[0].linkage,'following_response');}finally{b.dom.window.close()}
});

test('structured saved failure renders recovery controls even when human-readable copy changes',async()=>{const p=new ChatProjection();p.apply(snapshot([user,failure]));const view=p.view();view.messages.find(m=>m.failure)!.text='Different server presentation copy';const b=await browser();try{b.send({view:()=>view} as ChatProjection);const d=b.dom.window.document;assert.match(d.getElementById('messages')!.textContent!,/Response interrupted/);assert.match(d.getElementById('messages')!.textContent!,/tool response protocol/);assert.ok(d.querySelector('.status-action'));assert.ok(!d.body.textContent!.includes('PRIVATE_TOKEN_DIAGNOSTIC'));}finally{b.dom.window.close();}});
