import {test} from 'node:test';
import assert from 'node:assert/strict';
import {build} from 'esbuild';
import {Miniflare,convertV4MiniflareOptions} from 'miniflare';
import path from 'node:path';
// Actual PiHarness cancellation/withdrawal, Pi scheduler and SQLite. Only Models
// uses an offline faux provider whose response waits for release or cancellation.
async function fixture(){
 const source=`import {DurableObject} from 'cloudflare:workers';import {PiHarness} from 'agents/harness/pi';import {Lifecycle} from 'agents/lifecycle';import {Harness,createRegistry} from '@earendil-works/pi-durable';import {createModels} from '@earendil-works/pi-ai/models';import {fauxProvider,fauxAssistantMessage} from '@earendil-works/pi-ai/providers/faux';
 export class Agent extends DurableObject {
  started=0;waiters=[];releases=[];aborted=0;
  harness=new PiHarness({harness:({storage,context})=>{const f=fauxProvider();const held=async(_context,options)=>{this.started++;for(const wake of this.waiters.splice(0))wake();await new Promise(resolve=>{this.releases.push(resolve);if(options.signal?.aborted){this.aborted++;resolve();}else options.signal?.addEventListener('abort',()=>{this.aborted++;resolve();},{once:true});});return fauxAssistantMessage('Offline answer');};f.setResponses([held,held,held]);const models=createModels({authContext:{env:async()=>undefined,fileExists:async()=>false}});models.setProvider(f.provider);return Harness.open(storage,{models,registry:createRegistry(),settings:{retry:{enabled:false}}},context);},defaults:{model:{provider:'faux',id:'faux-1'},thinkingLevel:'off'}});
  lifecycle=Lifecycle.install(this).use(this.harness);
  submit(id){return this.harness.submit('Offline synthetic input',{session:'1',operationId:id});}
  stop(id){return this.harness.abort({session:'1',...(id?{operationId:id}:{})});}
  settle(id){return this.harness.session('1').wait(id);}
  async wait(count){while(this.started<count)await new Promise(resolve=>this.waiters.push(resolve));return {started:this.started};}
  release(){for(const r of this.releases.splice(0))r();return true;}
  evidence(){return {started:this.started,aborted:this.aborted};}
 }
 export default {async fetch(request,env){const u=new URL(request.url),s=env.Agent.getByName('offline');const op=u.searchParams.get('op');return Response.json(await s[u.pathname.slice(1)](u.pathname==='/wait'?Number(u.searchParams.get('count')):op));}};`;
 const bundle=await build({stdin:{contents:source,resolveDir:path.resolve('tests'),loader:'ts'},bundle:true,write:false,format:'esm',platform:'browser',target:'es2022',external:['node:*','cloudflare:*'],logLevel:'silent'});
 const mf=new Miniflare(convertV4MiniflareOptions({cf:false,modules:true,script:bundle.outputFiles[0].text,compatibilityDate:'2026-10-11',compatibilityFlags:['nodejs_compat'],durableObjects:{Agent:{className:'Agent',useSQLite:true}},outboundService:()=>{throw Error('No external network allowed')}}));
 const call=async(p:string)=>{const r=await mf.dispatchFetch('https://offline.test/'+p,{signal:AbortSignal.timeout(5000)});assert.equal(r.status,200,await r.clone().text());return r.json() as Promise<any>};
 return {call,dispose:async()=>{await call('release');await mf.dispose()}};
}
test('real PiHarness session Stop cancels running work and withdraws queued input without starting its model',{timeout:10000},async()=>{
 const f=await fixture();try{
  await f.call('submit?op=running-operation');await f.call('wait?count=1');await f.call('submit?op=queued-operation');
  assert.equal(await f.call('stop'),true);
  const first=await f.call('settle?op=running-operation'),queued=await f.call('settle?op=queued-operation');
  assert.equal(first.status,'unanswered');assert.equal(queued.status,'unanswered');assert.deepEqual(await f.call('evidence'),{started:1,aborted:1});
 }finally{await f.dispose();}
});
test('real PiHarness operation cleanup cancels accepted work; replayed cleanup of the settled ID does not stop newer work',{timeout:10000},async()=>{
 const f=await fixture();try{
  await f.call('submit?op=old-operation');await f.call('wait?count=1');assert.equal(await f.call('stop?op=old-operation'),true);await f.call('settle?op=old-operation');
  await f.call('submit?op=new-operation');await f.call('wait?count=2');assert.equal(await f.call('stop?op=old-operation'),false);assert.deepEqual(await f.call('evidence'),{started:2,aborted:1});
  await f.call('release');const newer=await f.call('settle?op=new-operation');assert.equal(newer.status,'done');
 }finally{await f.dispose();}
});
