import {test} from 'node:test';
import assert from 'node:assert/strict';
import {BACKGROUND_CONTEXT as context} from '@earendil-works/chord/context';
import {createModels} from '@earendil-works/pi-ai/models';
import {fauxProvider,fauxAssistantMessage,fauxText,fauxToolCall} from '@earendil-works/pi-ai/providers/faux';
import {createRegistry,Harness,MemoryStorage} from '@earendil-works/pi-durable';
import {WorkspaceController,DEFAULT_WORKSPACE_LIMITS,type WorkspaceAdapter,type WorkspaceLog} from '../src/workspace';
import {WorkspaceFileError} from '../src/workspace-error';
import {workspaceTools} from '../src/workspace-tools';
import {workspaceTextPage,workspaceToolResult,WORKSPACE_OUTPUT_BYTES} from '../src/workspace-output';
const id='aaaaaaaa-aaaa-4aaa-aaaa-aaaaaaaaaaaa',op=(n:number)=>n.toString(16).padStart(64,'0');
function fixture(text='old'){
 const data=new Map<string,any>();let current=text;
 const store={get:async<T>(key:string)=>structuredClone(data.get(key)) as T|undefined,put:async(key:string,v:any)=>{assert.ok(new TextEncoder().encode(JSON.stringify(v)).length<128000);data.set(key,structuredClone(v))},setAlarm:async()=>{},deleteAlarm:async()=>{}};
 const log:WorkspaceLog={text:'\u0001'.repeat(12000),retention:'tail',limitBytes:16384,retainedBytes:12000,totalBytes:18000,droppedBytes:6000,truncated:true,available:true};
 const adapter:WorkspaceAdapter={open:async()=> 'a'.repeat(40),read:async()=>current,edit:async()=>{},dispatch:async()=>{},status:async()=>({state:'running'}),logs:async()=>log,terminate:async()=>{},collect:async()=>({base:'a'.repeat(40),patch:'',logs:{},gaps:[]}),stop:async()=>{},keepAlive:async()=>{}};
 const controller=new WorkspaceController(store,adapter,DEFAULT_WORKSPACE_LIMITS,()=>0);
 return {data,adapter,controller,log,setText:(value:string)=>{current=value},open:()=>controller.open(id,'1','owner/project'),call:(request:any,n:number)=>controller.request({...request,workspaceId:id,operationId:op(n)})};
}
test('workspace text continuations preserve escaped and astral content without exceeding serialized SDK limits',async()=>{
 const original=('"\\\n\u0001😀').repeat(5000);let offset=0,expectedSha256:string|undefined,joined='';
 for(let i=0;i<10;i++){
  const data=await workspaceTextPage(original,{offset,expectedSha256},{workspaceId:id,path:'source.ts'});
  const result=workspaceToolResult(data,{action:'read',path:'source.ts',workspaceId:id,operationId:op(i+1)});
  assert.ok(new TextEncoder().encode(result.output[0].text).length<=WORKSPACE_OUTPUT_BYTES);
  assert.deepEqual(JSON.parse(result.output[0].text).data,data);joined+=data.text;
  if(!data.continuation)break;
  offset=data.continuation.offset as number;expectedSha256=data.continuation.expectedSha256 as string;
 }
 assert.equal(joined,original);
});
test('controller pages before durable receipts and rejects a changed file without exposing contents',async()=>{
 const f=fixture('\u0001'.repeat(64000));await f.open();
 const first=await f.call({action:'read',path:'source.ts'},1) as any;
 assert.equal(first.text.length,6000);assert.equal(first.totalChars,64000);assert.ok(first.continuation);
 assert.deepEqual(await f.call({action:'read',path:'source.ts'},1),first);
 const next=await f.call({action:'read',...first.continuation},2) as any;assert.equal(next.offset,6000);
 f.setText('private changed text');
 const changed=await f.call({action:'read',...first.continuation},3) as any;
 assert.equal(changed.code,'content_changed');assert.doesNotMatch(JSON.stringify(changed),/private changed text/);
 assert.equal(workspaceToolResult(changed,{action:'read',path:'source.ts',operationId:op(3)}).isError,true);
});
test('expected file failures cross the controller/RPC boundary as durable sanitized error records',async()=>{
 const f=fixture();await f.open();let edits=0;
 f.adapter.edit=async()=>{edits++;throw new WorkspaceFileError('edit_match_count')};
 const result=await f.call({action:'edit',path:'source.ts',oldText:'old',newText:'new'},1) as any;
 assert.equal(result.code,'edit_match_count');assert.match(result.nextStep,/match|context|read/i);
 assert.deepEqual(await f.call({action:'edit',path:'source.ts',oldText:'old',newText:'new'},1),JSON.parse(JSON.stringify(result)));
 assert.equal(edits,1,'expected failure receipts retain the mutation replay fence');
});
test('log pagination preserves loss metadata and handles old or absent recordings honestly',async()=>{
 const f=fixture();await f.open();await f.call({action:'exec',argv:['test']},1);
 const first=await f.call({action:'logs',runId:op(1),stream:'stdout'},2) as any;
 assert.equal(first.droppedBytes,6000);assert.equal(first.truncated,true);assert.equal(first.pageTruncated,true);assert.equal(first.text.length,6000);
 const last=await f.call({action:'logs',...first.continuation},3) as any;
 assert.equal(last.pageTruncated,false);assert.equal(last.truncated,true);assert.equal(last.incomplete,true);assert.equal(last.continuation,null);
 f.data.set('log:'+op(1)+':stdout','legacy saved text');
 const legacy=await f.call({action:'logs',runId:op(1),stream:'stdout'},4) as any;
 assert.equal(legacy.text,'legacy saved text');assert.equal(legacy.totalBytes,null);assert.equal(legacy.retainedBytes,null);assert.equal(legacy.truncated,null);assert.match(legacy.notice,/unknown/);
 f.data.delete('log:'+op(1)+':stdout');const state=f.data.get('state');state.phase='closed';f.data.set('state',state);
 const absent=await f.call({action:'logs',runId:op(1),stream:'stdout'},5) as any;
 assert.equal(absent.available,false);assert.equal(absent.incomplete,true);assert.match(absent.notice,/cannot be recovered/);
});
test('model summaries paginate run history and oversized unexpected output stays valid explicit JSON',()=>{
 const runs=Object.fromEntries(Array.from({length:100},(_,i)=>[op(i+1),{id:op(i+1),state:'done',startedAt:i,command:'test',exitCode:0}]));
 const request={action:'status' as const,workspaceId:id,runsOffset:20,operationId:op(200)};
 const result=JSON.parse(workspaceToolResult({id,phase:'ready',runs},request).output[0].text).data;
 assert.equal(Object.keys(result.runs).length,20);assert.equal(result.runHistory.total,100);assert.equal(result.runHistory.offset,20);assert.equal(result.runHistory.continuation.runsOffset,40);
 const oversized=workspaceToolResult({text:'\u0001'.repeat(64000)},request);
 assert.equal(oversized.isError,true);assert.equal(JSON.parse(oversized.output[0].text).data.code,'output_too_large');
});
test('actual pinned SDK receives a complete bounded workspace page with no harness truncation',async()=>{
 const f=fixture('\u0001'.repeat(64000));await f.open();
 const fake=fauxProvider();fake.setResponses([
  fauxAssistantMessage([fauxToolCall('workspace_read',{path:'source.ts'},{id:'read'})],{stopReason:'toolUse'}),
  transcript=>{const result=transcript.messages.find(m=>m.role==='toolResult') as any;const data=JSON.parse(result.content[0].text).data;assert.equal(data.text.length,6000);assert.equal(data.continuation.offset,6000);assert.equal(result.content.length,1);return fauxAssistantMessage([fauxText('Offline complete')]);}
 ]);
 const models=createModels();models.setProvider(fake.provider);const registry=createRegistry();registry.install(workspaceTools({request:async(_session,request)=>f.controller.request({...request,workspaceId:id} as any)}));
 const h=await Harness.open(new MemoryStorage(),{models,registry},context);
 try{const root=await h.root(context,{agent:{model:{provider:'faux',modelId:'faux-1'}}});assert.equal((await(await root.submit({type:'input',content:'Read fixture',requestId:'bounded-contract'},context)).wait(context)).status,'done');}finally{await h.close(context)}
});
