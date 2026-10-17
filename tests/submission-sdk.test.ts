import {test} from 'node:test';
import assert from 'node:assert/strict';
import {BACKGROUND_CONTEXT as context} from '@earendil-works/chord/context';
import {createModels} from '@earendil-works/pi-ai/models';
import {fauxProvider,fauxAssistantMessage} from '@earendil-works/pi-ai/providers/faux';
import {createRegistry,Harness,MemoryStorage,watchEvents} from '@earendil-works/pi-durable';
test('pinned SDK request IDs deduplicate accepted input, but do not enforce the app text fingerprint',async()=>{
 const faux=fauxProvider();faux.setResponses([fauxAssistantMessage([{type:'text',text:'Offline reply.'}],{stopReason:'stop'})]);
 const models=createModels({authContext:{env:async()=>undefined,fileExists:async()=>false}});models.setProvider(faux.provider);
 const storage=new MemoryStorage();
 // The fixture owns this retained in-memory store. Closing either harness must
 // not close shared storage; this tests reconstruction, not disk/crash recovery.
 const retained=new Proxy(storage,{get(target,key){if(key==='close')return async()=>{};const value=Reflect.get(target,key);return typeof value==='function'?value.bind(target):value;}});
 let h=await Harness.open(retained,{models,registry:createRegistry(),settings:{retry:{enabled:false}}},context);
 try{
  let root=await h.root(context,{agent:{model:{provider:'faux',modelId:'faux-1'}}});
  const first=await root.submit({type:'input',content:'Original input',requestId:'offline-same-operation'},context);await first.wait(context);
  const before=await storage.submissionByRequest(root.id,'offline-same-operation',context);assert.ok(before);
  for(const content of ['Original input','Different input that the app must reject']){
   const repeated=await root.submit({type:'input',content,requestId:'offline-same-operation'},context);await repeated.wait(context);
   const after=await storage.submissionByRequest(root.id,'offline-same-operation',context);assert.equal(after!.id,before.id);
  }
  await h.close(context);
  h=await Harness.open(retained,{models,registry:createRegistry(),settings:{retry:{enabled:false}}},context);
  root=await h.root(context);
  await(await root.submit({type:'input',content:'Original input',requestId:'offline-same-operation'},context)).wait(context);
  assert.equal((await storage.submissionByRequest(root.id,'offline-same-operation',context))!.id,before.id);
  const events=await watchEvents(h,root.id,context);try{const users=events.snapshot.entries.filter(e=>e.kind==='pi.user');assert.equal(users.length,1);assert.match(JSON.stringify(users[0]),/Original input/);assert.ok(!JSON.stringify(users).includes('Different input'));}finally{await events.stop();}
 }finally{await h.close(context);await storage.close();}
});
