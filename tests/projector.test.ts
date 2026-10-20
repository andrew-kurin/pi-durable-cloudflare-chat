import {test} from 'node:test';import assert from 'node:assert/strict';import {ChatProjection} from '../src/projector';
test('streams text while keeping thinking and errors out of UI',()=>{const p=new ChatProjection();p.apply({type:'message_update',usage:{} as never,changes:[{type:'text_delta',contentIndex:0,delta:'Hello'},{type:'thinking_delta',contentIndex:1,delta:'private thinking'}]});assert.equal(p.view().partial,'Hello');p.apply({type:'task_failed',taskId:'1' as never,kind:'network',message:'secret token'});assert.ok(!JSON.stringify(p.view()).includes('secret token'))});
test('snapshot reconnect replaces rather than duplicates',()=>{const p=new ChatProjection();const entry={id:'1',kind:'pi.user',model:[{role:'user',content:'Hi'}]} as never;const snap={type:'snapshot',entries:[entry],tools:[],inbox:[],agent:{},usage:{},compactions:[]} as never;p.apply(snap);p.apply(snap);assert.equal(p.view().messages.length,1);assert.equal(p.view().messages[0].text,'Hi')});
test('tool activity names describe source reads with recorded input context',()=>{const p=new ChatProjection();for(const [toolName,label] of [['web_search','Searching the public web…'],['fetch_page','Reading a public page…'],['github_read','Reading public GitHub…'],['ask_luna','Working with Luna…']]){p.apply({type:'tool_execution_start',toolCallId:'one',toolName,args:{query:'private query'}});assert.equal(p.view().activity,label);assert.ok(JSON.stringify(p.view()).includes('private query'));}});
function assistant(id:string,calls:{id:string;name:string}[]){return {id,kind:'pi.assistant',model:[{role:'assistant',content:[{type:'thinking',thinking:'hidden reasoning'},...calls.map(c=>({type:'toolCall',...c,arguments:{query:'password=private',task:'private task'}}))]}]} as never;}
function resultEntry(callId:string,name:string,data:unknown={},error=false,code?:string){return {id:'result-'+callId,kind:'pi.tool-result',data:{diagnostics:code?[{code,message:'raw secret diagnostic'}]:[]},model:[{role:'toolResult',toolCallId:callId,toolName:name,isError:error,durationMs:1234,content:[{type:'text',text:JSON.stringify({data})}]}]} as never;}
function snapshot(entries:never[],tools:any[]=[],run?:any){return {type:'snapshot',entries,tools,run,inbox:[],agent:{},usage:{},compactions:[]} as never;}
test('workspace startup progress is controlled, survives reconnect and clears at terminal outcomes',()=>{
 const p=new ChatProjection(),entry=assistant('a',[{id:'c',name:'workspace_exec'}]);
 p.entry(entry);p.apply({type:'tool_execution_start',toolCallId:'c',toolName:'workspace_exec',args:{argv:['npm','test']}});
 for(const [phase,text] of [['starting','Starting workspace…'],['ready','Workspace ready. Running tool…'],['failed','Workspace activation failed.']]){
  p.apply({type:'tool_execution_update',toolCallId:'c',toolName:'workspace_exec',details:{workspaceActivation:phase,private:'DO_NOT_COPY'}} as never);
  assert.equal(p.view().messages[0].tools[0].summary,text);if(phase==='failed'){assert.equal(p.view().messages[0].tools[0].state,'error');assert.equal(p.view().activity,'');}assert.ok(!JSON.stringify(p.view()).includes('DO_NOT_COPY'));
  p.apply(snapshot([entry],[{callId:'c',name:'workspace_exec',status:'running',details:{workspaceActivation:phase}}],{inputs:[]}));assert.equal(p.view().messages[0].tools[0].summary,text);
 }
 p.apply({type:'tool_execution_end',toolCallId:'c',toolName:'workspace_exec',entry:resultEntry('c','workspace_exec',{error:'Startup failed. Open a workspace explicitly.'},true)});
 const result=p.view().messages[0].tools[0];assert.equal(result.state,'error');assert.match(result.summary!,/Startup failed/);
 p.apply({type:'tool_execution_update',toolCallId:'c',toolName:'workspace_exec',details:{workspaceActivation:'starting'}} as never);assert.deepEqual(p.view().messages[0].tools[0],result);
 p.apply(snapshot([entry],[{callId:'c',name:'workspace_exec',status:'running',details:{workspaceActivation:'starting'}}],{inputs:[]}));p.apply({type:'run_end',inputs:[]});assert.equal(p.view().messages[0].tools[0].summary,undefined);assert.equal(p.view().messages[0].tools[0].state,'unavailable');
});
test('tool calls attach to originating assistant even with no text; pending, running and results are verified',()=>{
 const p=new ChatProjection();p.apply({type:'message_end',entry:assistant('a',[{id:'search',name:'web_search'},{id:'luna',name:'ask_luna'}])});
 assert.deepEqual(p.view().messages[0].tools.map(t=>t.state),['pending','pending']);
 p.apply({type:'tool_execution_start',toolCallId:'search',toolName:'web_search',args:{secret:'private'}});
 assert.equal(p.view().messages[0].tools[0].state,'running');
 p.apply({type:'tool_execution_end',toolCallId:'search',toolName:'web_search',entry:resultEntry('search','web_search',{results:[{title:'<script>attack</script>',url:'javascript:attack',excerpt:'token=private'}],truncated:true})});
 const row=p.view().messages[0].tools[0];assert.equal(row.state,'success');assert.match(row.summary!,/1 result/);assert.match(row.detail,/truncated.*1.234s/);
 const view=JSON.stringify(p.view());for(const secret of ['password=private','token=private','hidden reasoning'])assert.ok(!view.includes(secret),secret);
});
test('read envelope errors, harness errors and explicit interruption get safe distinct outcomes',()=>{
 for(const [entry,state] of [[resultEntry('c','fetch_page',{error:'secret raw provider error'}),'error'],[resultEntry('c','ask_luna',{},true),'error'],[resultEntry('c','ask_luna',{},true,'aborted'),'interrupted'],[resultEntry('c','ask_luna',{},true,'interrupted'),'interrupted']] as const){const p=new ChatProjection();p.entry(assistant('a',[{id:'c',name:'ask_luna'}]));p.entry(entry);assert.equal(p.view().messages[0].tools[0].state,state);assert.ok(p.view().messages[0].tools[0].output!==undefined);}
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
test('oversize tool payloads are explicitly bounded and unknown tool names use a generic label',()=>{
 const p=new ChatProjection();p.entry(assistant('a',[{id:'c',name:'<img onerror=attack>'}]));p.entry(resultEntry('c','<img onerror=attack>',{text:'sensitive'.repeat(10000)}));const view=JSON.stringify(p.view());assert.ok(view.length<18000);assert.ok(view.includes('sensitive'));assert.equal(p.view().messages[0].tools[0].outputTruncated,true);assert.ok(!view.includes('onerror'));assert.equal(p.view().messages[0].tools[0].label,'Tool');
});
function user(id:string){return {id,kind:'pi.user',model:[{role:'user',content:'Question'}]} as never;}
function answer(id:string,text:string){return {id,kind:'pi.assistant',model:[{role:'assistant',content:[{type:'text',text}]}]} as never;}
test('completed rounds follow their recorded results to response text within the same user turn',()=>{
 const p=new ChatProjection();p.apply(snapshot([user('u'),assistant('a',[{id:'c',name:'web_search'}]),resultEntry('c','web_search',{results:[]}),answer('reply','A long answer '.repeat(500))]));
 assert.equal(p.view().messages.find(m=>m.id==='a')!.tools.length,0);const response=p.view().messages.find(m=>m.id==='reply')!;assert.equal(response.tools[0].id,'c');assert.equal(response.tools[0].roundId,'a');assert.equal(response.tools[0].state,'success');
});
test('multiple tool rounds and assistant segments preserve chronology and do not collect unrelated turns',()=>{
 const entries=[user('u1'),assistant('round1',[{id:'c1',name:'web_search'}]),resultEntry('c1','web_search'),answer('segment','First finding'),assistant('round2',[{id:'c2',name:'github_read'}]),resultEntry('c2','github_read'),assistant('round3',[{id:'c3',name:'ask_luna'}]),resultEntry('c3','ask_luna'),answer('final','Final finding'),user('u2'),answer('other','Unrelated answer')];
 const p=new ChatProjection();p.apply(snapshot(entries));const view=p.view();assert.deepEqual(view.messages.find(m=>m.id==='segment')!.tools.map(t=>t.id),['c1']);assert.deepEqual(view.messages.find(m=>m.id==='final')!.tools.map(t=>[t.id,t.roundId]),[['c2','round2'],['c3','round3']]);assert.equal(view.messages.find(m=>m.id==='other')!.tools.length,0);assert.equal(view.messages.flatMap(m=>m.tools).length,3);
 for(let i=0;i<2;i++){p.apply(snapshot(entries));for(const entry of entries)p.apply({type:'entry_appended',entry});assert.deepEqual(p.view(),view);}
});
test('recorded results sit beside streamed response and migrate once to its committed identity',()=>{
 const p=new ChatProjection();p.apply(snapshot([user('u'),assistant('a',[{id:'c',name:'ask_luna'}]),resultEntry('c','ask_luna')],[],{inputs:[]}));
 p.apply({type:'message_update',usage:{} as never,changes:[{type:'text_delta',contentIndex:0,delta:'Partial answer'}]});assert.equal(p.view().partialTools[0].id,'c');assert.equal(p.view().messages.flatMap(m=>m.tools).length,0);
 const snap={...snapshot([user('u'),assistant('a',[{id:'c',name:'ask_luna'}]),resultEntry('c','ask_luna')],[],{inputs:[]}) as any,generation:{message:{content:[{type:'text',text:'Partial answer'}]}}};p.apply(snap);assert.equal(p.view().partialTools[0].id,'c');
 p.apply({type:'message_end',entry:answer('final','Finished')});assert.equal(p.view().partialTools.length,0);assert.equal(p.view().messages.find(m=>m.id==='final')!.tools[0].id,'c');
});
test('missing linkage, missing result, late results after user boundary and resets remain at origin',()=>{
 for(const entries of [[user('u'),assistant('a',[{id:'c',name:'github_read'}]),answer('reply','No result')],[user('u'),assistant('a',[{id:'c',name:'github_read'}]),resultEntry('c','github_read'),user('next'),answer('reply','New question')],[user('u'),assistant('a',[{id:'c',name:'github_read'}]),user('next'),resultEntry('c','github_read'),answer('reply','Late result')],[user('u'),assistant('a',[{id:'c',name:'github_read'}]),resultEntry('c','github_read'),{id:'reset',kind:'pi.reset'} as never,answer('reply','Reset answer')],[assistant('a',[{id:'c',name:'github_read'}]),resultEntry('c','github_read'),answer('reply','Historical boundary unknown')]]){const p=new ChatProjection();p.apply(snapshot(entries));assert.equal(p.view().messages.find(m=>m.id==='a')!.tools[0].id,'c');assert.equal(p.view().messages.find(m=>m.id==='reply')!.tools.length,0);}
});
test('failed and interrupted rounds retain recorded diagnostic detail near the response',()=>{
 for(const [error,code,state] of [[true,undefined,'error'],[true,'aborted','interrupted']] as const){const p=new ChatProjection();p.apply(snapshot([user('u'),assistant('a',[{id:'c',name:'ask_luna'}]),resultEntry('c','ask_luna',{},error,code),answer('reply','Safe explanation')]));const row=p.view().messages.find(m=>m.id==='reply')!.tools[0];assert.equal(row.state,state);if(code)assert.ok(JSON.stringify(p.view()).includes('raw secret diagnostic'));}
});
test('observed live numeric IDs, multiple rounds and intervening Continue inputs preserve safe response linkage',()=>{
 const entries=[user('24'),assistant('28',[{id:'call_first|fc_synthetic1',name:'web_search'}]),{...resultEntry('call_first|fc_synthetic1','web_search'),id:30} as never,assistant('32',[{id:'call_second|fc_synthetic2',name:'web_search'}]),{...resultEntry('call_second|fc_synthetic2','web_search'),id:34} as never,answer('36','Recorded response'),user('37'),assistant('40',[{id:'old1',name:'github_search'}]),{...resultEntry('old1','github_search'),id:42} as never,assistant('44',[{id:'old2',name:'web_search'}]),{...resultEntry('old2','web_search'),id:46} as never,assistant('48',[{id:'old3',name:'github_read'}]),{...resultEntry('old3','github_read'),id:50} as never,user('54'),assistant('57',[{id:'new',name:'github_read'}]),{...resultEntry('new','github_read'),id:59} as never,answer('61','Following response')];
 const p=new ChatProjection();p.apply(snapshot(entries));const view=p.view();assert.equal(view.projectionVersion,2);assert.deepEqual(view.messages.find(m=>m.id==='36')!.tools.map(t=>[t.roundId,t.linkage]),[['28','following_response'],['32','following_response']]);for(const id of ['40','44','48'])assert.equal(view.messages.find(m=>m.id===id)!.tools[0].linkage,'user_boundary');assert.equal(view.messages.find(m=>m.id==='61')!.tools[0].id,'new');assert.equal(view.messages.flatMap(m=>m.tools).length,6);
});

test('model continuation failure after successful workspace tools remains visible after run end and reconnect without raw errors',()=>{
 const failed={id:'failure',kind:'pi.assistant',model:[{role:'assistant',content:[],stopReason:'error',errorMessage:'private provider token'}]} as never;
 const entries=[user('u'),assistant('a',[{id:'c',name:'workspace_status'}]),resultEntry('c','workspace_status',{phase:'ready'}),failed];
 const p=new ChatProjection();for(const entry of entries)p.apply({type:'entry_appended',entry});p.apply({type:'run_end',inputs:[]});
 const live=p.view();assert.equal(live.busy,false);assert.match(live.messages.find(m=>m.id==='failure')!.text,/could not finish/);assert.equal(live.messages.find(m=>m.id==='failure')!.tools[0].state,'success');assert.ok(!JSON.stringify(live).includes('private provider token'));
 p.apply(snapshot(entries));assert.match(p.view().messages.find(m=>m.id==='failure')!.text,/could not finish/);assert.ok(!JSON.stringify(p.view()).includes('private provider token'));
});
test('task fault notification survives run end and clears on a new run',()=>{
 const p=new ChatProjection();p.apply({type:'task_failed',taskId:'1' as never,kind:'network',message:'private raw error'});p.apply({type:'run_end',inputs:[]});assert.match(p.view().activity,/could not finish/);assert.ok(!JSON.stringify(p.view()).includes('private raw error'));p.apply({type:'run_start',inputs:[]});assert.equal(p.view().activity,'');
});

test('saved failures expose safe structured data without requiring presentation text parsing',()=>{const p=new ChatProjection();p.apply(snapshot([{id:'failed',kind:'pi.assistant',model:[{role:'assistant',content:[],stopReason:'error',errorMessage:'429: rate limit secret=PRIVATE'}]} as never]));const failure=p.view().messages[0].failure;assert.deepEqual(failure,{kind:'model',diagnostic:{category:'rate or usage limit',httpStatus:'429'},recoveryAction:'check-status'});assert.ok(!JSON.stringify(failure).includes('PRIVATE'));});

test('fresh workspace notice and predecessor reference remain visible in live and saved cards',()=>{
 const p=new ChatProjection();p.entry(assistant('a',[{id:'c',name:'workspace_read'}]));p.apply({type:'tool_execution_start',toolCallId:'c',toolName:'workspace_read',args:{path:'src/index.ts'}});
 p.apply({type:'tool_execution_update',toolCallId:'c',toolName:'workspace_read',details:{workspaceActivation:'starting',workspaceFreshStart:true}} as never);assert.match(p.view().messages[0].tools[0].summary!,/Starting fresh.*Old edits were not restored/);
 const result=resultEntry('c','workspace_read',{path:'src/index.ts',text:'source',freshWorkspace:{previousWorkspaceId:'aaaaaaaa-aaaa-4aaa-aaaa-aaaaaaaaaaaa',artifactUrl:'/api/workspaces/aaaaaaaa-aaaa-4aaa-aaaa-aaaaaaaaaaaa/artifact?session=1',notice:'Fresh workspace. Old edits were not restored.'}});
 p.entry(result);let row=p.view().messages[0].tools[0];assert.match(row.summary!,/^Fresh workspace. Old edits were not restored/);assert.match(row.output!,/contents not verified/);assert.match(row.output!,/api\/workspaces/);
 p.apply(snapshot([assistant('a',[{id:'c',name:'workspace_read'}]),result]));assert.equal(p.view().messages[0].tools[0].summary,row.summary);assert.equal(p.view().messages[0].tools[0].output,row.output);
});
test('workspace status card distinguishes normal absent workspace from a missing process',()=>{
 const p=new ChatProjection();p.entry(assistant('a',[{id:'c',name:'workspace_status'}]));p.entry(resultEntry('c','workspace_status',{phase:'absent',runs:{},process:{state:'none'},activation:{mode:'automatic',nextStep:'Use workspace_read without workspaceId'}}));let row=p.view().messages[0].tools[0];assert.equal(row.label,'Workspace status');assert.equal(row.state,'success');assert.match(row.summary!,/Workspace absent.*No active command.*activates automatically/);
 p.entry(resultEntry('c','workspace_status',{phase:'ready',runs:{},process:{state:'not_found',runId:'old-run'},activation:{mode:'ready'}}));row=p.view().messages[0].tools[0];assert.match(row.summary!,/Requested command not found/);assert.ok(!row.summary!.includes('Command running'));
});
test('wait cards show in-flight observation and do not present a still-running command as completed work',()=>{
 const p=new ChatProjection();p.entry(assistant('a',[{id:'c',name:'workspace_wait'}]));p.apply({type:'tool_execution_start',toolCallId:'c',toolName:'workspace_wait',args:{workspaceId:'aaaaaaaa-aaaa-4aaa-aaaa-aaaaaaaaaaaa',runId:'1'.repeat(64)}});p.apply({type:'tool_execution_update',toolCallId:'c',toolName:'workspace_wait',details:{workspaceWait:'waiting'}} as never);assert.equal(p.view().messages[0].tools[0].summary,'Waiting for existing command…');
 p.entry(resultEntry('c','workspace_wait',{outcome:'still_running',waitedMs:20000,taskRemainingMs:800000,commandRemainingMs:280000,nextStep:'Wait again; requested work is not complete.'}));let row=p.view().messages[0].tools[0];assert.equal(row.label,'Wait for command');assert.match(row.summary!,/still running.*not complete/);assert.match(row.output!,/280000/);
 p.entry(resultEntry('c','workspace_wait',{outcome:'completed',nextStep:'Continue requested dependent work.'}));row=p.view().messages[0].tools[0];assert.match(row.summary!,/Continue requested work/);
});

test('1.3 nested-tool events are excluded from transcript projection and aborted compaction does not clear a prior failure',()=>{
 const p=new ChatProjection();
 p.apply({type:'compaction_end',taskId:1,reason:'manual',error:'PRIVATE_FAILURE'} as any);assert.ok(p.view().compactionFailure);
 p.apply({type:'compaction_end',taskId:2,reason:'manual'} as any);assert.ok(p.view().compactionFailure);
 p.apply({type:'tool_execution_start',toolCallId:'outer/1',toolName:'workspace_exec',parentToolCallId:'outer',parentTaskId:3,args:{private:'PRIVATE_NESTED_ARGS'}} as any);
 p.apply({type:'tool_execution_end',toolCallId:'outer/1',toolName:'workspace_exec',parentToolCallId:'outer',parentTaskId:3,result:{structuredOutput:'PRIVATE_NESTED_RESULT'}} as any);
 assert.equal(p.view().messages.length,0);assert.doesNotMatch(JSON.stringify(p.view()),/PRIVATE_/);
 p.entry({id:5,kind:'pi.compaction',model:[]} as any);assert.equal(p.view().compactionFailure,null);
 p.apply({type:'snapshot',entries:[{id:5,kind:'pi.compaction',model:[]}],tools:[],inbox:[],agent:{},usage:{},compactionFailure:{taskId:6,reason:'manual',error:'PRIVATE_NEWER_FAILURE'}} as any);assert.ok(p.view().compactionFailure);assert.doesNotMatch(JSON.stringify(p.view()),/PRIVATE_/);
});
