import {test} from 'node:test';import assert from 'node:assert/strict';import {BACKGROUND_CONTEXT as context} from '@earendil-works/chord/context';import {createModels} from '@earendil-works/pi-ai/models';import {fauxProvider,fauxAssistantMessage,fauxText,fauxToolCall} from '@earendil-works/pi-ai/providers/faux';import {createRegistry,Harness,MemoryStorage} from '@earendil-works/pi-durable';import {delegation} from '../src/delegate';
test('fake Sol delegates to fake Luna and gives final answer',async()=>{const faux=fauxProvider();faux.setResponses([fauxAssistantMessage([fauxToolCall('ask_luna',{task:'17 + 25'},{id:'one'})],{stopReason:'toolUse'}),fauxAssistantMessage([fauxText('42')]),fauxAssistantMessage([fauxText('The answer is 42.')])]);const models=createModels();models.setProvider(faux.provider);const registry=createRegistry();registry.install(delegation('faux','faux-1'));const h=await Harness.open(new MemoryStorage(),{models,registry},context);try{const root=await h.root(context,{agent:{model:{provider:'faux',modelId:'faux-1'}}});const result=await(await root.submit({type:'input',content:'Calculate',requestId:'offline-test'},context)).wait(context);assert.equal(result.status,'done');const entries=await root.entries({},20,undefined,context);assert.ok(JSON.stringify(entries).includes('The answer is 42.'))}finally{await h.close(context)}});

test('cancelling an actual delegate tool aborts its owned child before a fresh explicit submission',{timeout:5000},async()=>{
 let entered!:()=>void;const ready=new Promise<void>(r=>entered=r);let childAborts=0;
 const faux=fauxProvider();faux.setResponses([
  fauxAssistantMessage([fauxToolCall('ask_luna',{task:'Synthetic held delegate'},{id:'owned-delegate'})],{stopReason:'toolUse'}),
  async(_c,options)=>{entered();await new Promise<void>(r=>{options.signal?.addEventListener('abort',()=>{childAborts++;r();},{once:true});});return fauxAssistantMessage('Stopped delegate');},
  fauxAssistantMessage('Fresh explicit response')
 ]);
 const models=createModels();models.setProvider(faux.provider);const registry=createRegistry();registry.install(delegation('faux','faux-1'));const storage=new MemoryStorage(),h=await Harness.open(storage,{models,registry},context);
 try{
  const root=await h.root(context,{agent:{model:{provider:'faux',modelId:'faux-1'}}});const run=await root.submit({type:'input',content:'Delegate synthetic work',requestId:'owned-submission'},context);await ready;
  const children=await storage.scanConversations({},20,undefined,context);const child=children.items.find(c=>c.owner&&'taskId' in c.owner);assert.ok(child,'delegate conversation must be owned by its tool task');
  await root.abort(context);assert.equal((await run.wait(context)).status,'unanswered');assert.equal(childAborts,1);
  const next=await(await root.submit({type:'input',content:'Fresh after Stop',requestId:'fresh-after-delegate-stop'},context)).wait(context);assert.equal(next.status,'done');
  assert.equal((await storage.scanConversations({},20,undefined,context)).items.length,2,'fresh input must not recreate the delegate');
 }finally{await h.close(context);}
});
