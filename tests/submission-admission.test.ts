import {test} from 'node:test';
import assert from 'node:assert/strict';
import {build} from 'esbuild';
import {Miniflare,convertV4MiniflareOptions} from 'miniflare';
import {generateKeyPair,SignJWT,exportJWK} from 'jose';
import path from 'node:path';
// Actual signed-owner HTTP admission/submit routes and SQLite storage. Chat/provider
// eligibility and downstream submit/abort/control effects are simulated. This
// fixture does NOT prove SDK deduplication or production latency.
async function fixture() {
 const origin='https://chat.example.test', {privateKey,publicKey}=await generateKeyPair('RS256');
 const jwks={keys:[{...await exportJWK(publicKey),kid:'local'}]};
 const token=await new SignJWT({email:'owner@example.test'}).setProtectedHeader({alg:'RS256',kid:'local'}).setIssuer('https://owner.cloudflareaccess.com').setAudience('app').setSubject('owner').setIssuedAt().setExpirationTime('10m').sign(privateKey);
 const source=`import worker,{Assistant as Original} from '../src/index.ts';import {RequestError} from '../src/http-input.ts';
 globalThis.fetch=async input=>{if(String(input)==='https://owner.cloudflareaccess.com/cdn-cgi/access/certs')return Response.json(${JSON.stringify(jwks)});throw Error('No external provider network')};
 export class Assistant extends Original {
  trace=[];mode={};waiters=new Map();releases=new Map();
  signal(name){this.trace.push(name);this.waiters.get(name)?.();}
  async wait(name){if(this.trace.includes(name))return;await new Promise(resolve=>this.waiters.set(name,resolve));}
  async configure(mode){this.mode=mode;this.trace=[];const put=this.ctx.storage.put.bind(this.ctx.storage);
   if(!this.installed){this.installed=true;this.originalPut=put;const transaction=this.ctx.storage.transaction.bind(this.ctx.storage);this.ctx.storage.transaction=work=>transaction(async tx=>{const txPut=tx.put.bind(tx);tx.put=async(key,value)=>{if(this.mode.failReservation&&String(key).startsWith('admission:')){this.mode.failReservation=false;throw Error('Synthetic reservation write failure');}return txPut(key,value);};return work(tx);});this.ctx.storage.put=async(key,value)=>{if(this.mode.failReceipt&&String(key).startsWith('admission:')&&value.receipt){this.mode.failReceipt=false;throw Error('Synthetic receipt write failure');}return put(key,value);};
    this.providers.assertCanSubmit=async()=>{if(this.mode.blockedProvider)throw new RequestError(503,'Synthetic provider disabled');};
    this.harness.sessions.list=async()=>[{id:'1',busy:!!this.mode.busy},{id:'2',busy:false}];
    this.chatCatalog.requireActive=async id=>{if(!['1','2'].includes(id))throw new RequestError(404,'Conversation not found');};
    this.harness.submit=async(text,options)=>{this.dispatches=(this.dispatches||0)+1;this.reservedAtDispatch=await this.ctx.storage.get('admission:'+options.session+':'+options.operationId);
     if(this.mode.hold==='submit')await new Promise(resolve=>{this.releases.set('submit',resolve);this.signal('submit:entered');});else this.signal('submit:entered');
     if(this.mode.failBefore){this.mode.failBefore=false;throw Error('Synthetic before SDK acceptance');}
     const key='fixture-sdk:'+options.session+':'+options.operationId;const prior=await this.ctx.storage.get(key);const receipt={operationId:options.operationId,session:options.session,accepted:!prior};
     if(!prior){await put(key,receipt);await put('fixture-effects',((await this.ctx.storage.get('fixture-effects'))||0)+1);}
     if(this.mode.failAfter){this.mode.failAfter=false;throw Error('Synthetic lost SDK response');}
     this.signal('submit:returned');return receipt;
    };
    this.harness.abort=async({session})=>{this.signal('abort:called');return session==='1';};
    this.chatCatalog.rename=async(id,title)=>{this.signal('rename:entered');if(this.mode.hold==='rename')await new Promise(resolve=>this.releases.set('rename',resolve));this.signal('rename:returned');if(this.mode.failRename)throw Error('Synthetic rename failure');return {title};};
    const autoTitle=this.chatCatalog.autoTitle.bind(this.chatCatalog);this.chatCatalog.autoTitle=async(...args)=>{if(this.mode.failAutoTitle){this.mode.failAutoTitle=false;throw Error('Synthetic auto-title failure');}return autoTitle(...args);};
    this.history.close=async()=>{this.signal('close:called');return Response.json({closed:true});};
    this.workspaces.enabled=()=>true;this.workspaces.ownerAction=async()=>{this.signal('workspace:called');return {phase:'stopping'};};
   }
  }
  async fetch(request){const path=new URL(request.url).pathname;if(path==='/api/abort')this.signal('abort:arrived');if(path==='/api/submit')this.signal('submit-request:'+ (this.submitRequests=(this.submitRequests||0)+1));return super.fetch(request);}
  async release(name){this.releases.get(name)?.();}
  async quota(count,day){await this.originalPut('quota',{day:day||new Date().toISOString().slice(0,10),count});}
  async evidence(sid,op){return {trace:this.trace,quota:await this.ctx.storage.get('quota'),admission:await this.ctx.storage.get('admission:'+sid+':'+op),effects:(await this.ctx.storage.get('fixture-effects'))||0,dispatches:this.dispatches||0,reservedAtDispatch:this.reservedAtDispatch,title:await this.ctx.storage.get('chat-auto-title:'+sid)};}
 }
 export default {async fetch(request,env){const u=new URL(request.url),stub=env.Assistant.getByName('private-owner-v1');if(u.pathname==='/fixture/config'){await stub.configure(await request.json());return Response.json({ok:true});}if(u.pathname==='/fixture/wait'){await stub.wait(u.searchParams.get('name'));return Response.json({ok:true});}if(u.pathname==='/fixture/release'){await stub.release(u.searchParams.get('name'));return Response.json({ok:true});}if(u.pathname==='/fixture/quota'){await stub.quota(Number(u.searchParams.get('count')),u.searchParams.get('day'));return Response.json({ok:true});}if(u.pathname==='/fixture/evidence')return Response.json(await stub.evidence(u.searchParams.get('session')||'1',u.searchParams.get('op')));return worker.fetch(request,env);}};`;
 const bundle=await build({stdin:{contents:source,resolveDir:path.resolve('tests'),loader:'ts'},bundle:true,write:false,format:'esm',platform:'browser',target:'es2022',external:['node:*','cloudflare:*'],logLevel:'silent'});
 let outbound=0;
 const mf=new Miniflare(convertV4MiniflareOptions({cf:false,modules:true,script:bundle.outputFiles[0].text,compatibilityDate:'2026-10-11',compatibilityFlags:['nodejs_compat'],durableObjects:{Assistant:{className:'Assistant',useSQLite:true}},bindings:{ACCESS_TEAM_DOMAIN:'https://owner.cloudflareaccess.com',ACCESS_AUD:'app',OWNER_EMAILS:'owner@example.test',APP_ORIGIN:origin,ENABLE_MODEL:'false',ENABLE_SUBSCRIPTION_LOGIN:'false',CREDENTIAL_ENCRYPTION_KEY:Buffer.alloc(32,42).toString('base64')},outboundService:async(request:any)=>{outbound++;assert.equal(request.url,'https://owner.cloudflareaccess.com/cdn-cgi/access/certs');return Response.json(jwks);}}));
 const headers={'Cf-Access-Jwt-Assertion':token,origin,'Content-Type':'application/json'};
 const post=(url:string,body:any)=>mf.dispatchFetch(origin+url,{method:'POST',headers,body:JSON.stringify(body),signal:AbortSignal.timeout(5000)});
 const control=async(url:string,body?:any)=>{const response=body===undefined?await mf.dispatchFetch(origin+'/fixture/'+url,{signal:AbortSignal.timeout(5000)}):await post('/fixture/'+url,body);assert.equal(response.status,200);return response.json() as Promise<any>;};
 const submit=(operationId:string,text='Hello',session='1')=>post('/api/submit?session='+session,{operationId,text});
 await control('config',{});
 return {post,control,submit,dispose:async()=>{assert.ok(outbound<=1,'Only generated JWKS is allowed; no provider requests');await mf.dispose();}};
}
test('exact fingerprints and cached receipts: duplicates reserve once, changed raw text conflicts, sessions scope IDs',async()=>{
 const f=await fixture();try{
  const a=await f.submit('same-operation');assert.equal(a.status,200);const receipt=await a.json();assert.equal((receipt as any).accepted,true);
  const evidence=await f.control('evidence?op=same-operation');assert.ok(evidence.reservedAtDispatch.digest);assert.equal(evidence.quota.count,1);
  const b=await f.submit('same-operation');assert.equal(b.status,200);assert.deepEqual(await b.json(),receipt);
  assert.equal((await f.submit('same-operation','Hello ')).status,409);
  const after=await f.control('evidence?op=same-operation');assert.equal(after.dispatches,1);assert.equal(after.effects,1);assert.equal(after.quota.count,1);
  assert.equal((await f.submit('same-operation','Hello','2')).status,200);assert.equal((await f.control('evidence?op=same-operation&session=2')).quota.count,2);
 }finally{await f.dispose();}
});
test('busy and daily caps reject new operations without a reservation; UTC day rollover reserves anew',async()=>{
 const f=await fixture();try{
  await f.control('config',{busy:true});assert.equal((await f.submit('busy-operation')).status,409);let e=await f.control('evidence?op=busy-operation');assert.equal(e.admission,undefined);assert.equal(e.quota,undefined);
  await f.control('config',{});await f.control('quota?count=50');assert.equal((await f.submit('quota-operation')).status,429);e=await f.control('evidence?op=quota-operation');assert.equal(e.admission,undefined);assert.equal(e.dispatches,0);
  await f.control('quota?count=50&day=2000-01-01');assert.equal((await f.submit('next-day-operation')).status,200);assert.equal((await f.control('evidence?op=next-day-operation')).quota.count,1);
 }finally{await f.dispose();}
});
for(const failure of ['failBefore','failAfter','failReceipt'])test('reserved submission recovery after '+failure+' retains fingerprint and quota',async()=>{
 const f=await fixture();try{
  await f.control('config',{[failure]:true});assert.equal((await f.submit('recovery-operation')).status,500);
  const before=await f.control('evidence?op=recovery-operation');assert.ok(before.admission.digest);assert.equal(before.admission.receipt,undefined);assert.equal(before.quota.count,1);assert.equal(before.effects,failure==='failBefore'?0:1);
  await f.control('config',{busy:true});await f.control('quota?count=50');assert.equal((await f.submit('recovery-operation','Different')).status,409);assert.equal((await f.submit('recovery-operation')).status,200);
  const after=await f.control('evidence?op=recovery-operation');assert.equal(after.quota.count,50);assert.equal(after.dispatches,2);assert.equal(after.effects,1);assert.ok(after.admission.receipt);
 }finally{await f.dispose();}
});
test('receipt replay still checks provider availability first; post-receipt title failure is not repaired on replay',async()=>{
 const f=await fixture();try{
  await f.control('config',{failAutoTitle:true});assert.equal((await f.submit('title-operation')).status,500);let e=await f.control('evidence?op=title-operation');assert.ok(e.admission.receipt);assert.equal(e.title,undefined);
  await f.control('config',{blockedProvider:true});assert.equal((await f.submit('title-operation')).status,503);
  await f.control('config',{});assert.equal((await f.submit('title-operation')).status,200);e=await f.control('evidence?op=title-operation');assert.equal(e.dispatches,1);assert.equal(e.title,undefined);assert.equal(e.quota.count,1);
 }finally{await f.dispose();}
});
for(const hold of ['rename','submit'])test('abort is admitted only after slow '+hold+' returns; close/workspace control bypass it', {timeout:10000},async()=>{
 const f=await fixture();let blocked:Promise<Response>|undefined,abort:Promise<Response>|undefined;try{
  await f.control('config',{hold});blocked=hold==='rename'?f.post('/api/session-title?session=1',{title:'Slow rename'}):f.submit('held-operation');
  await f.control('wait?name='+hold+':entered');abort=f.post('/api/abort?session=1',{});await f.control('wait?name=abort:arrived');
  assert.equal((await f.post('/api/events/close?stream=aaaaaaaa-aaaa-4aaa-aaaa-aaaaaaaaaaaa',{})).status,200);
  assert.equal((await f.post('/api/workspaces/aaaaaaaa-aaaa-4aaa-aaaa-aaaaaaaaaaaa?session=1',{action:'cancel',operationId:'test-operation'})).status,200);
  let e=await f.control('evidence?op=held-operation');assert.ok(!e.trace.includes('abort:called'));assert.ok(e.trace.includes('close:called'));assert.ok(e.trace.includes('workspace:called'));
  await f.control('release?name='+hold);assert.equal((await blocked).status,200);assert.equal((await abort).status,200);e=await f.control('evidence?op=held-operation');assert.ok(e.trace.indexOf(hold+':returned')<e.trace.indexOf('abort:called'));
 }finally{await f.control('release?name='+hold);await Promise.allSettled([blocked,abort].filter(Boolean) as Promise<Response>[]);await f.dispose();}
});
test('a failed queued mutation does not poison subsequent abort admission',async()=>{
 const f=await fixture();try{await f.control('config',{failRename:true});assert.equal((await f.post('/api/session-title?session=1',{title:'fails'})).status,500);assert.equal((await f.post('/api/abort?session=1',{})).status,200);assert.ok((await f.control('evidence')).trace.includes('abort:called'));}finally{await f.dispose();}
});

test('quota and fingerprint reservation roll back together if the transaction fails before dispatch',async()=>{
 const f=await fixture();try{await f.control('quota?count=49');await f.control('config',{failReservation:true});assert.equal((await f.submit('rollback-operation')).status,500);let e=await f.control('evidence?op=rollback-operation');assert.equal(e.quota.count,49);assert.equal(e.admission,undefined);assert.equal(e.dispatches,0);assert.equal((await f.submit('rollback-operation')).status,200);e=await f.control('evidence?op=rollback-operation');assert.equal(e.quota.count,50);assert.equal(e.effects,1);}finally{await f.dispose();}
});

test('simultaneous duplicate/conflicting submits queue behind first acceptance and produce one effect/quota charge',{timeout:10000},async()=>{
 const f=await fixture();let first:Promise<Response>|undefined,duplicate:Promise<Response>|undefined,conflict:Promise<Response>|undefined;
 try{
  await f.control('config',{hold:'submit'});first=f.submit('simultaneous-operation');await f.control('wait?name=submit:entered');
  duplicate=f.submit('simultaneous-operation');await f.control('wait?name=submit-request:2');conflict=f.submit('simultaneous-operation','Changed text');await f.control('wait?name=submit-request:3');
  let e=await f.control('evidence?op=simultaneous-operation');assert.equal(e.dispatches,1);assert.equal(e.quota.count,1);
  await f.control('release?name=submit');const responses=await Promise.all([first,duplicate,conflict]);assert.deepEqual(responses.map(r=>r.status),[200,200,409]);assert.deepEqual(await responses[0].json(),await responses[1].json());
  e=await f.control('evidence?op=simultaneous-operation');assert.equal(e.dispatches,1);assert.equal(e.effects,1);assert.equal(e.quota.count,1);
 }finally{await f.control('release?name=submit');await Promise.allSettled([first,duplicate,conflict].filter(Boolean) as Promise<Response>[]);await f.dispose();}
});
