import { test } from 'node:test';
import assert from 'node:assert/strict';
import { once } from 'node:events';
import { BACKGROUND_CONTEXT as context } from '@earendil-works/chord/context';
import { createRegistry, Harness, MemoryStorage, defineExtension, defineTool } from '@earendil-works/pi-durable';
import { Type } from '@earendil-works/pi-ai';
import { isRetryableAssistantError } from '@earendil-works/pi-ai/utils/retry';
import { createChatModels } from '../src/provider-sessions';
import { createWorkerRunnerProvider, workerRoundFence } from '../src/model-runner-worker';
import { guardModels } from '../src/model-guard';
import { createSiwcRunner } from '../services/model-runner/live-runner';
import { createRunnerServer } from '../services/model-runner/http';
import { MemoryRoundJournal } from '../services/model-runner/core';
import { fakeBackend } from '../services/model-runner/fake-backend';
import { transportKey } from '../src/model-runner-protocol';
const config={ENABLE_MODEL_RUNNER:'true',MODEL_RUNNER_ENDPOINT:'https://runner.example/v1/responses',MODEL_RUNNER_TRANSPORT_KEY:'07'.repeat(32)};
const credentialStore={read:async()=>undefined,list:async()=>[],modify:async()=>{throw Error('No credentials');}} as any;
const deferred=<T>()=>{let resolve!:(v:T)=>void;const promise=new Promise<T>(r=>resolve=r);return{promise,resolve};};
function store(){
 const records=new Map<string,any>();let line=Promise.resolve();
 const tx={get:async(k:string)=>structuredClone(records.get(k)),put:async(k:string,v:any)=>{records.set(k,structuredClone(v));}};
 return {records,transaction:(fn:any)=>{const result=line.then(()=>fn(tx));line=result.catch(()=>{});return result;}};
}
async function fixture(backend:typeof fakeBackend=fakeBackend){
 const persisted=store(),journal=new MemoryRoundJournal(),calls:{body:any;signal:AbortSignal}[]=[],wire:{id:string;body:string}[]=[];
 const runner=createSiwcRunner({key:await transportKey(new Uint8Array(32).fill(7)),journal,credentials:{access:async()=>'SYNTHETIC'},fetch:async(_url,init)=>{const body=JSON.parse(init!.body as string),signal=init!.signal!;calls.push({body,signal});return backend(body,'SYNTHETIC',signal);}});
 const server=createRunnerServer(runner);server.listen(0,'127.0.0.1');await once(server,'listening');const port=(server.address() as import('node:net').AddressInfo).port;
 const transport=(async(input:any)=>{const r=input as Request,body=await r.text();wire.push({id:r.headers.get('x-pi-round-id')!,body});assert.equal(r.headers.has('x-pi-generation-task'),false);assert.equal(r.headers.has('authorization'),false);return fetch(`http://127.0.0.1:${port}/v1/responses`,{method:r.method,headers:r.headers,body,signal:r.signal});}) as typeof fetch;
 const models=()=>guardModels(createChatModels(credentialStore,createWorkerRunnerProvider(config,persisted as any,'durable-object-fixture',transport)),async()=>{});
 return{persisted,journal,calls,wire,models,dispose:async()=>{server.closeAllConnections();await new Promise<void>(ok=>server.close(()=>ok()));}};
}
const registry=()=>{const r=createRegistry();r.install(defineExtension({name:'runner-fixture-tool',tools:[defineTool({name:'test_status',description:'offline marker',parameters:Type.Object({}),replay:'safe',execute:async()=>({content:[{type:'text',text:'offline-marker'}]})})]}));return r;};
const open=async(storage:any,models:any)=>Harness.open(storage,{models,registry:registry(),settings:{compaction:{enabled:false},retry:{enabled:true,maxRetries:1,baseDelayMs:1},stream:{maxRetries:0}}},context);
const retain=(s:MemoryStorage)=>new Proxy(s,{get(t,k){if(k==='close')return async()=>{};const v=Reflect.get(t,k);return typeof v==='function'?v.bind(t):v;}});
test('actual pinned Harness carries durable task identity; tool continuation gets a new round; input replay after reconstruction never dispatches', {timeout:10000},async()=>{
 const f=await fixture(),storage=new MemoryStorage();let h=await open(retain(storage),f.models());
 try{
  let root=await h.root(context,{agent:{model:{provider:'model-runner-siwc',modelId:'gpt-6.1-sol'}}});
  const submission=await root.submit({type:'input',content:'fixture',requestId:'accepted-operation'},context);assert.equal((await submission.wait(context)).status,'done');assert.equal(f.calls.length,2);assert.equal(f.wire.length,2);assert.notEqual(f.wire[0].id,f.wire[1].id);
  const records=[...f.persisted.records.values()];assert.equal(records.length,2);assert.notEqual(records[0].task,records[1].task);assert.equal(records[0].conversation,records[1].conversation);assert.ok(f.calls[1].body.input.some((x:any)=>x.type==='function_call_output'));
  const before=await root.entries({},100,undefined,context);await h.close(context);h=await open(retain(storage),f.models());root=await h.root(context);const again=await root.submit({type:'input',content:'fixture',requestId:'accepted-operation'},context);assert.equal((await again.wait(context)).status,'done');assert.equal(again.id,submission.id);assert.equal(f.calls.length,2);assert.deepEqual(await root.entries({},100,undefined,context),before);
 }finally{await h.close(context);await storage.close();await f.dispose();}
});
test('real Harness ambiguous dispatch is not retried despite enabled retry policy', {timeout:10000},async()=>{
 const f=await fixture(async()=>{throw Error('Connection error 503');}),storage=new MemoryStorage(),h=await open(storage,f.models());
 try{const root=await h.root(context,{agent:{model:{provider:'model-runner-siwc',modelId:'gpt-6.1-sol'}}});const receipt=await(await root.submit({type:'input',content:'fixture',requestId:'ambiguous-operation'},context)).wait(context);assert.equal(receipt.status,'unanswered');assert.equal(f.calls.length,1);assert.equal(f.wire.length,1);assert.equal(f.persisted.records.size,1);}finally{await h.close(context);await f.dispose();}
});
test('reopening an interrupted actual generation retains its round fence instead of replaying inference', {timeout:10000},async()=>{
 const entered=deferred<void>(),f=await fixture(async(_p,_a,signal)=>{entered.resolve();await new Promise<void>(ok=>{if(signal.aborted)ok();else signal.addEventListener('abort',()=>ok(),{once:true});});throw Error('Stopped');}),storage=new MemoryStorage();let h=await open(retain(storage),f.models());
 try{let root=await h.root(context,{agent:{model:{provider:'model-runner-siwc',modelId:'gpt-6.1-sol'}}});const first=await root.submit({type:'input',content:'fixture',requestId:'restart-operation'},context);await entered.promise;await h.close(context);h=await open(retain(storage),f.models());root=await h.root(context);const recovered=await root.submit({type:'input',content:'fixture',requestId:'restart-operation'},context);assert.equal(recovered.id,first.id);assert.equal((await recovered.wait(context)).status,'unanswered');assert.equal(f.calls.length,1);assert.equal(f.wire.length,1);assert.equal(f.persisted.records.size,1);assert.equal(f.calls[0].signal.aborted,true);}finally{await h.close(context);await storage.close();await f.dispose();}
});
test('Worker rejects missing identity, failed persistence, duplicate/conflicting recovery and cross-object collisions',async()=>{
 const persisted=store(),fence=workerRoundFence(persisted as any,'object-one'),id=await fence.identity('task-1','conversation-1');assert.equal(await workerRoundFence(persisted as any,'object-one').identity('task-1','conversation-1'),id);assert.notEqual(await workerRoundFence(persisted as any,'object-two').identity('task-1','conversation-1'),id);
 assert.deepEqual((await Promise.all([fence.reserve(id,'one','task-1','conversation-1'),fence.reserve(id,'one','task-1','conversation-1')])).sort(),['duplicate','new']);assert.equal(await fence.reserve(id,'different','task-1','conversation-1'),'conflict');
 let dispatches=0;const noTransport=(async()=>{dispatches++;throw Error('Must not dispatch');}) as typeof fetch;
 for(const options of [undefined,{headers:{'x-pi-generation-task':'task-1','x-pi-conversation':'conversation-1'}}]){const provider=createWorkerRunnerProvider(config,{transaction:async()=>{throw Error('Persistence failed');}} as any,'object-one',noTransport),models=createChatModels(credentialStore,provider);const r=await models.streamSimple(models.getModel(provider.id,'gpt-6.1-sol')!,{messages:[{role:'user',content:'fixture',timestamp:1}]},options).result();assert.equal(r.stopReason,'error');assert.equal(isRetryableAssistantError(r),false);}assert.equal(dispatches,0);
});
test('Stop during Worker reservation leaves durable fence without dispatch or cancellation of later intent',async()=>{
 const data=store(),entered=deferred<void>(),gate=deferred<void>(),abort=new AbortController();let dispatches=0;
 const slow={transaction:async(fn:any)=>data.transaction(async(tx:any)=>{const result=await fn(tx);entered.resolve();await gate.promise;return result;})};
 const p=createWorkerRunnerProvider(config,slow as any,'stop-fixture',(async()=>{dispatches++;throw Error();}) as typeof fetch),models=createChatModels(credentialStore,p),model=models.getModel(p.id,'gpt-6.1-sol')!;
 const options={headers:{'x-pi-generation-task':'task-old','x-pi-conversation':'conversation-1'},signal:abort.signal};const result=models.streamSimple(model,{messages:[{role:'user',content:'fixture',timestamp:1}]},options).result();await entered.promise;abort.abort();gate.resolve();await result;assert.equal(dispatches,0);assert.equal(data.records.size,1);
 const restart=createChatModels(credentialStore,createWorkerRunnerProvider(config,data as any,'stop-fixture',(async()=>{dispatches++;throw Error();}) as typeof fetch));await restart.streamSimple(restart.getModel(p.id,model.id)!,{messages:[{role:'user',content:'fixture',timestamp:1}]},{headers:options.headers}).result();assert.equal(dispatches,0);
 await restart.streamSimple(restart.getModel(p.id,model.id)!,{messages:[{role:'user',content:'new intent',timestamp:2}]},{headers:{...options.headers,'x-pi-generation-task':'task-new'}}).result();assert.equal(dispatches,1);assert.equal(data.records.size,2);
});
test('changed recovered body conflicts under the same durable generation; sibling delegation uses Luna and its own identity', {timeout:10000},async()=>{
 const f=await fixture();try{
  const models=f.models(),model=models.getModel('model-runner-siwc','gpt-6.1-sol')!,headers={'x-pi-generation-task':'recovered-task','x-pi-conversation':'recovered-conversation'};
  await models.streamSimple(model,{messages:[{role:'user',content:'first context',timestamp:1}]},{headers}).result();assert.equal(f.wire.length,1);
  const resumed=f.models(),result=await resumed.streamSimple(resumed.getModel(model.provider,model.id)!,{messages:[{role:'user',content:'changed recovered context',timestamp:1}]},{headers}).result();assert.equal(result.stopReason,'error');assert.match(result.errorMessage!,/worker round conflict/);assert.equal(f.wire.length,1);assert.equal(f.persisted.records.size,1);
 }finally{await f.dispose();}
 const {delegation}=await import('../src/delegate');
 const g=await fixture(async(body,access,signal)=>{
  if(body.model==='gpt-6-luna')return fakeBackend({...body,input:[{type:'function_call_output'}]},access,signal);
  const response=await fakeBackend(body,access,signal);if((body.input as any[]).some(x=>x.type==='function_call_output'))return response;
  const text=(await response.text()).split('\n\n').filter(Boolean).map(frame=>{const event=JSON.parse(frame.slice(6));if(event.item?.type==='function_call'){event.item.name='ask_luna';event.item.arguments=JSON.stringify({task:'offline delegate fixture'});}return 'data: '+JSON.stringify(event)+'\n\n';}).join('');return new Response(new TextEncoder().encode(text));
 });const reg=createRegistry();reg.install(delegation());const h=await Harness.open(new MemoryStorage(),{models:g.models(),registry:reg,settings:{compaction:{enabled:false},retry:{enabled:true,maxRetries:1,baseDelayMs:1}}},context);
 try{const root=await h.root(context,{agent:{model:{provider:'model-runner-siwc',modelId:'gpt-6.1-sol'}}});assert.equal((await(await root.submit({type:'input',content:'delegate fixture',requestId:'delegate-operation'},context)).wait(context)).status,'done');assert.deepEqual(g.calls.map(c=>c.body.model),['gpt-6.1-sol','gpt-6-luna','gpt-6.1-sol']);assert.equal(new Set(g.wire.map(w=>w.id)).size,3);assert.equal(new Set([...g.persisted.records.values()].map(r=>r.conversation)).size,2);assert.ok(!g.calls[1].body.input.some((x:any)=>x.type==='additional_tools'));}finally{await h.close(context);await g.dispose();}
});
