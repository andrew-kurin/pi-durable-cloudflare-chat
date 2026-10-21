import {test} from 'node:test';
import assert from 'node:assert/strict';
import {BACKGROUND_CONTEXT as context} from '@earendil-works/chord/context';
import {createModels} from '@earendil-works/pi-ai/models';
import {fauxProvider,fauxAssistantMessage} from '@earendil-works/pi-ai/providers/faux';
import {Harness,MemoryStorage,createRegistry,StorageRequestError,SessionFailed,watchEvents} from '@earendil-works/pi-durable';
import {HarnessRecovery} from '../src/harness-recovery';
import {HistoryFeed} from '../src/history-feed';

async function fixture(){
 const storage=new MemoryStorage(),faux=fauxProvider();let inject:'read'|'commit'|undefined,started!:()=>void;
 const entered=new Promise<void>(r=>started=r);faux.setResponses([async(_c,options)=>{started();await new Promise<void>(r=>{if(options.signal?.aborted)r();else options.signal?.addEventListener('abort',()=>r(),{once:true});});return fauxAssistantMessage('Cancelled offline reply');},...Array.from({length:4},()=>fauxAssistantMessage('Fresh after valid reopen'))]);
 const models=createModels();models.setProvider(faux.provider);
 const retained=new Proxy(storage,{get(t,k){if(k==='close')return async()=>{};const v=Reflect.get(t,k);if(typeof v!=='function')return v;return (...args:any[])=>{if(k==='conversation'&&inject==='read')throw new StorageRequestError('synthetic invalid read');if(k==='commit'&&inject==='commit')throw new StorageRequestError('synthetic commit failure SECRET');return v.apply(t,args);};}});
 const recovery=new HarnessRecovery(),open=async()=>recovery.observe(await Harness.open(retained,{models,registry:createRegistry(),settings:{retry:{enabled:false}}},context));
 return {open,recovery,storage,entered,inject:(value:typeof inject)=>{inject=value;}};
}
test('StorageRequestError fails only a read; storage commit failure rejects pending waits and ends watches; explicit disposal reopens committed state',{timeout:5000},async()=>{
 const f=await fixture();let h=await f.open();
 try{
  let root=await h.root(context,{agent:{model:{provider:'faux',modelId:'faux-1'}}});
  await(await root.submit({type:'write',requestId:'saved',entry:{kind:'pi.user',model:[{role:'user',content:'Committed before storage failure',timestamp:1}]}},context)).wait(context);
  f.inject('read');await assert.rejects(h.conversation(root.id,context),StorageRequestError);f.inject(undefined);
  assert.ok(await h.conversation(root.id,context),'invalid read must not close Session');
  const submission=await root.submit({type:'input',content:'Held synthetic input',requestId:'held'},context);await f.entered;
  const events=await watchEvents(h,root.id,context);events.start(async()=>{});
  const wait=assert.rejects(submission.wait(context),SessionFailed);
  f.inject('commit');await assert.rejects(h.commit(tx=>tx.appendEntry(root.id,{kind:'pi.user',model:[{role:'user',content:'Must not commit',timestamp:2}]}),context),StorageRequestError);
  assert.equal((await events.closed).reason,'session_failed');await wait;
  assert.equal((await h.closed).reason,'failed');await assert.rejects(h.root(context),SessionFailed);
  let disposals=0;await Promise.all([f.recovery.prepare(async()=>{disposals++;await h.close(context);}),f.recovery.prepare(async()=>{disposals++;await h.close(context);})]);assert.equal(disposals,1);
  f.inject(undefined);h=await f.open();root=await h.root(context);
  const entries=await root.entries({order:'ascending'},100,undefined,context);assert.match(JSON.stringify(entries),/Committed before storage failure/);assert.doesNotMatch(JSON.stringify(entries),/Must not commit/);
  const result=await(await root.submit({type:'input',content:'Fresh explicit input',requestId:'after-reopen'},context)).wait(context);assert.equal(result.status,'done');
 }finally{await h.close(context);await f.storage.close();}
});

test('a session_failed watch emits a safe final history frame and releases its SSE lease',{timeout:5000},async()=>{
 let end!:(value:any)=>void;const closed=new Promise<any>(r=>end=r);let stops=0;
 const snapshot={type:'snapshot',entries:[],tools:[],nestedTools:[],inbox:[],agent:{},usage:{},run:{inputs:[]}};
 const feed=new HistoryFeed({session:()=>({events:async()=>({snapshot,start:()=>{},stop:async()=>{stops++;return {reason:'stopped'};},closed})}),conversation:async()=>({entries:async()=>({items:[]})})} as any,{title:async()=>undefined});
 const response=await feed.subscribe(new Request('https://offline.test/api/events?stream=aaaaaaaa-aaaa-4aaa-aaaa-aaaaaaaaaaaa'),'1');
 const reader=response.body!.getReader();await reader.read();end({reason:'session_failed',error:Error('SECRET_STORAGE_CAUSE')});
 const text=new TextDecoder().decode((await reader.read()).value),view=JSON.parse(text.split('\n')[0].slice(6));
 assert.equal(view.failureState.kind,'session');assert.equal(view.busy,false);assert.match(view.activity,/Reload saved history/);assert.doesNotMatch(text,/SECRET_STORAGE_CAUSE/);
 assert.equal((await reader.read()).done,true);assert.equal(stops,1);
 assert.equal((feed as any).activeStreams,0);assert.equal((feed as any).streamStops.size,0);
});
