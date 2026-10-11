import {test} from 'node:test';import assert from 'node:assert/strict';import {ChatProjection} from '../src/projector';
test('streams text while keeping thinking and errors out of UI',()=>{const p=new ChatProjection();p.apply({type:'message_update',usage:{} as never,changes:[{type:'text_delta',contentIndex:0,delta:'Hello'},{type:'thinking_delta',contentIndex:1,delta:'private thinking'}]});assert.equal(p.view().partial,'Hello');p.apply({type:'task_failed',taskId:'1' as never,kind:'network',message:'secret token'});assert.ok(!JSON.stringify(p.view()).includes('secret token'))});
test('snapshot reconnect replaces rather than duplicates',()=>{const p=new ChatProjection();const entry={id:'1',kind:'pi.user',model:[{role:'user',content:'Hi'}]} as never;const snap={type:'snapshot',entries:[entry],tools:[],inbox:[],agent:{},usage:{},compactions:[]} as never;p.apply(snap);p.apply(snap);assert.equal(p.view().messages.length,1);assert.equal(p.view().messages[0].text,'Hi')});
test('tool activity names describe source reads without exposing arguments',()=>{const p=new ChatProjection();for(const [toolName,label] of [['web_search','Searching the public web…'],['fetch_page','Reading a public page…'],['github_read','Reading public GitHub…'],['ask_luna','Working with Luna…']]){p.apply({type:'tool_execution_start',toolCallId:'one',toolName,args:{query:'private query'}});assert.equal(p.view().activity,label);assert.ok(!JSON.stringify(p.view()).includes('private query'));}});
function assistant(id:string,calls:{id:string;name:string}[]){return {id,kind:'pi.assistant',model:[{role:'assistant',content:[{type:'thinking',thinking:'hidden reasoning'},...calls.map(c=>({type:'toolCall',...c,arguments:{query:'password=private',task:'private task'}}))]}]} as never;}
function resultEntry(callId:string,name:string,data:unknown={},error=false,code?:string){return {id:'result-'+callId,kind:'pi.tool-result',data:{diagnostics:code?[{code,message:'raw secret diagnostic'}]:[]},model:[{role:'toolResult',toolCallId:callId,toolName:name,isError:error,durationMs:1234,content:[{type:'text',text:JSON.stringify({data})}]}]} as never;}
function snapshot(entries:never[],tools:any[]=[],run?:any){return {type:'snapshot',entries,tools,run,inbox:[],agent:{},usage:{},compactions:[]} as never;}
test('tool calls attach to originating assistant even with no text; pending, running and results are verified',()=>{
 const p=new ChatProjection();p.apply({type:'message_end',entry:assistant('a',[{id:'search',name:'web_search'},{id:'luna',name:'ask_luna'}])});
 assert.deepEqual(p.view().messages[0].tools.map(t=>t.state),['pending','pending']);
 p.apply({type:'tool_execution_start',toolCallId:'search',toolName:'web_search',args:{secret:'private'}});
 assert.equal(p.view().messages[0].tools[0].state,'running');
 p.apply({type:'tool_execution_end',toolCallId:'search',toolName:'web_search',entry:resultEntry('search','web_search',{results:[{title:'<script>attack</script>',url:'javascript:attack',excerpt:'token=private'}],truncated:true})});
 const row=p.view().messages[0].tools[0];assert.equal(row.state,'success');assert.match(row.detail,/1 result returned.*truncated.*1.234s/);
 const view=JSON.stringify(p.view());for(const secret of ['password=private','private task','token=private','hidden reasoning','<script>','javascript:'])assert.ok(!view.includes(secret),secret);
});
test('read envelope errors, harness errors and explicit interruption get safe distinct outcomes',()=>{
 for(const [entry,state] of [[resultEntry('c','fetch_page',{error:'secret raw provider error'}),'error'],[resultEntry('c','ask_luna',{},true),'error'],[resultEntry('c','ask_luna',{},true,'aborted'),'interrupted'],[resultEntry('c','ask_luna',{},true,'interrupted'),'interrupted']] as const){const p=new ChatProjection();p.entry(assistant('a',[{id:'c',name:'ask_luna'}]));p.entry(entry);assert.equal(p.view().messages[0].tools[0].state,state);assert.ok(!JSON.stringify(p.view()).includes('secret raw'));}
});
test('snapshot, reconnect, repeated events and replay keep one historical result per call',()=>{
 const entries=[assistant('a',[{id:'c',name:'github_read'}]),resultEntry('c','github_read',{text:'huge private payload',truncated:true})];const p=new ChatProjection();
 for(let i=0;i<3;i++){p.apply(snapshot(entries));p.apply({type:'entry_appended',entry:entries[1]});p.apply({type:'tool_execution_end',toolCallId:'c',toolName:'github_read',entry:entries[1]});p.apply({type:'tool_execution_start',toolCallId:'c',toolName:'github_read',args:{}});assert.equal(p.view().messages.length,1);assert.equal(p.view().messages[0].tools.length,1);assert.equal(p.view().messages[0].tools[0].state,'success');}
});
test('live snapshot slots preserve pending/running; missing historical or orphaned result is unavailable',()=>{
 const p=new ChatProjection();const entries=[assistant('a',[{id:'one',name:'web_search'},{id:'two',name:'ask_luna'},{id:'old',name:'github_read'}])];
 p.apply(snapshot(entries,[{callId:'one',name:'web_search',status:'running',output:'private output'},{callId:'two',name:'ask_luna',status:'pending',details:{secret:'raw'}}],{inputs:[]}));assert.deepEqual(p.view().messages[0].tools.map(t=>t.state),['running','pending','unavailable']);
 p.apply({type:'tool_execution_update',toolCallId:'one',toolName:'web_search',output:{set:'private output'},details:{secret:'raw'}});assert.ok(!JSON.stringify(p.view()).includes('private output'));
 p.apply({type:'tool_execution_end',toolCallId:'one',toolName:'web_search'});assert.equal(p.view().messages[0].tools[0].state,'unavailable');p.apply({type:'run_end',inputs:[]});assert.equal(p.view().messages[0].tools[1].state,'unavailable');
 p.apply(snapshot([{id:'legacy',kind:'pi.assistant',model:[{role:'assistant',content:[{type:'text',text:'Older answer'}]}]} as never]));assert.equal(p.view().messages[0].tools.length,0);
});
test('oversize tool payloads and unknown tool names never leak output, args or arbitrary labels',()=>{
 const p=new ChatProjection();p.entry(assistant('a',[{id:'c',name:'<img onerror=attack>'}]));p.entry(resultEntry('c','<img onerror=attack>',{text:'sensitive'.repeat(10000)}));const view=JSON.stringify(p.view());assert.ok(view.length<700);assert.ok(!view.includes('sensitive'));assert.ok(!view.includes('onerror'));assert.equal(p.view().messages[0].tools[0].label,'Tool');
});
