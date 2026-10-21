import {test} from 'node:test';
import assert from 'node:assert/strict';
import {once} from 'node:events';
import {request as httpRequest} from 'node:http';
import {MAX_REQUEST_BYTES,signRound,transportKey,validRoundEnvelope} from '../src/model-runner-protocol';
import {createSiwcRunner,type LiveRunnerOptions} from '../services/model-runner/live-runner';
import {MemoryRoundJournal} from '../services/model-runner/core';
import {createRunnerServer,type RunnerServerOptions} from '../services/model-runner/http';
import {readRunnerBody} from '../services/model-runner/admission';
import {fakeBackend} from '../services/model-runner/fake-backend';
const key=await transportKey(new Uint8Array(32).fill(17));
const raw=JSON.stringify({model:'gpt-6.1-sol',input:[{role:'user',content:'fixture 🍐'}],store:false,stream:true});
const bytes=new TextEncoder().encode(raw);
const deferred=<T>()=>{let resolve!:(value:T)=>void;const promise=new Promise<T>(r=>{resolve=r});return {promise,resolve}};
const tick=()=>new Promise<void>(r=>setImmediate(r));
async function succeeds(pending:Promise<Response>){const response=await pending;assert.equal(response.status,200);await response.body?.cancel();}
function fixture(overrides:Partial<LiveRunnerOptions>={}){
 let credentials=0,calls=0;const journal=new MemoryRoundJournal(),diagnostics:any[]=[];
 const runner=createSiwcRunner({key,journal,credentials:{access:async()=>{credentials++;return 'FAKE'}},fetch:async(_url,init)=>{calls++;return fakeBackend(JSON.parse(init!.body as string),'',init!.signal!)},diagnostic:r=>diagnostics.push(r),...overrides});
 return {runner,journal,diagnostics,counts:()=>({credentials,calls})};
}
async function signed(id=crypto.randomUUID(),body:BodyInit=raw,signal?:AbortSignal,extra:Record<string,string>={}){
 return new Request('https://runner.invalid/v1/responses',{method:'POST',body,signal,headers:{...await signRound(key,raw,id),...extra},duplex:'half'} as RequestInit);
}
function stalled(cancel:()=>unknown=()=>{}){let pulls=0;const entered=deferred<void>();return {entered:entered.promise,body:new ReadableStream<Uint8Array>({pull(){pulls++;entered.resolve();return new Promise(()=>{})},cancel}, {highWaterMark:0}),pulls:()=>pulls};}
for(const change of ['missing-id','bad-id','missing-signature','short-signature','duplicate-signature','bad-timestamp','old-timestamp','future-timestamp'] as const){
 test('direct malformed envelope rejects before body read: '+change,async()=>{
  let cancels=0;const input=stalled(()=>{cancels++}),f=fixture(),r=await signed(undefined,input.body);
  if(change==='missing-id')r.headers.delete('x-pi-round-id');
  if(change==='bad-id')r.headers.set('x-pi-round-id','bad');
  if(change==='missing-signature')r.headers.delete('x-pi-signature');
  if(change==='short-signature')r.headers.set('x-pi-signature','a'.repeat(63));
  if(change==='duplicate-signature')r.headers.append('x-pi-signature','a'.repeat(64));
  if(change==='bad-timestamp')r.headers.set('x-pi-timestamp','NaN');
  if(change==='old-timestamp')r.headers.set('x-pi-timestamp',String(Date.now()-60000));
  if(change==='future-timestamp')r.headers.set('x-pi-timestamp',String(Date.now()+60000));
  assert.equal(validRoundEnvelope(r),false);assert.equal((await f.runner(r)).status,403);assert.equal(input.pulls(),0);assert.equal(cancels,1);assert.deepEqual(f.counts(),{credentials:0,calls:0});assert.equal(f.journal.rounds.size,0);
 });
}
test('valid-shaped bad signature still fails exact-body HMAC before reservation',async()=>{
 const f=fixture(),r=await signed();r.headers.set('x-pi-signature','a'.repeat(64));assert.equal(validRoundEnvelope(r),true);assert.equal((await f.runner(r)).status,403);assert.equal(f.journal.rounds.size,0);assert.deepEqual(f.counts(),{credentials:0,calls:0});
});
test('direct known-length and unknown/chunked payloads retain every UTF8 byte and fence',async()=>{
 const f=fixture();for(const known of [false,true]){
  let i=0;const body=new ReadableStream<Uint8Array>({pull(c){if(i===bytes.length)c.close();else c.enqueue(bytes.slice(i,i+=1));}},{highWaterMark:0});
  const id=crypto.randomUUID(),r=await signed(id,body,undefined,known?{'content-length':String(bytes.length)}:{});
  await succeeds(f.runner(r));assert.equal((await f.runner(await signed(id))).status,409);
 }assert.deepEqual(f.counts(),{credentials:2,calls:2});assert.ok(f.diagnostics.filter(x=>x.outcome==='authenticated').every(x=>x.bodyBytes===bytes.length));
});
for(const length of ['abc','1, 1',String(MAX_REQUEST_BYTES+1),'1',String(bytes.length+1)])test('invalid/mismatched direct content length '+length,async()=>{
 const f=fixture(),r=await signed(undefined,raw,undefined,{'content-length':length});assert.equal((await f.runner(r)).status,502);assert.deepEqual(f.counts(),{credentials:0,calls:0});assert.equal(f.journal.rounds.size,0);
});
for(const length of ['abc',String(MAX_REQUEST_BYTES+1)])test('rejected direct content length cancels source once without reading: '+length,async()=>{
 let cancels=0;const input=stalled(()=>{cancels++;return new Promise(()=>{})}),f=fixture();
 assert.equal((await f.runner(await signed(undefined,input.body,undefined,{'content-length':length}))).status,502);
 assert.equal(input.pulls(),0);assert.equal(cancels,1);assert.deepEqual(f.counts(),{credentials:0,calls:0});assert.equal(f.journal.rounds.size,0);
});
test('reader count and aggregate byte reservations reject before body access; abort releases despite stalled cancel',async()=>{
 const f=fixture({admission:{maxReaders:3,maxBodyBytes:bytes.length*2,readTimeoutMs:1000}}),aborts=[new AbortController(),new AbortController()];
 const inputs=aborts.map(()=>stalled(()=>new Promise(()=>{})));
 const pending=await Promise.all(inputs.map((s,i)=>signed(undefined,s.body,aborts[i].signal,{'content-length':String(bytes.length)})));
 const jobs=pending.map(r=>f.runner(r));await Promise.all(inputs.map(s=>s.entered));
 const rejected=stalled();assert.equal((await f.runner(await signed(undefined,rejected.body,undefined,{'content-length':String(bytes.length)}))).status,503);assert.equal(rejected.pulls(),0);
 aborts.forEach(c=>c.abort());assert.ok((await Promise.all(jobs)).every(r=>r.status===502));await succeeds(f.runner(await signed(undefined,raw,undefined,{'content-length':String(bytes.length)})));assert.equal(f.journal.rounds.size,1);
});
test('unknown-length reservations charge full limit and release on read deadline',async()=>{
 const f=fixture({admission:{maxReaders:4,maxBodyBytes:MAX_REQUEST_BYTES,readTimeoutMs:15}}),input=stalled();
 const job=f.runner(await signed(undefined,input.body));await input.entered;
 assert.equal((await f.runner(await signed())).status,503);
 const timeout=await job;assert.equal(timeout.status,502);assert.equal((await timeout.json() as any).error.code,'request_body_timeout');assert.equal(f.journal.rounds.size,0);
 await succeeds(f.runner(await signed()));assert.equal(f.journal.rounds.size,1);
});
test('admission remains held after body read through credential/upstream preparation',async()=>{
 const gate=deferred<string>(),entered=deferred<void>();const f=fixture({admission:{maxReaders:1},credentials:{access:async()=>{entered.resolve();return gate.promise}}});
 const first=f.runner(await signed());await entered.promise;const id=crypto.randomUUID();assert.equal((await f.runner(await signed(id))).status,503);assert.equal(f.journal.rounds.size,1);
 gate.resolve('FAKE');await succeeds(first);await succeeds(f.runner(await signed(id)));assert.equal((await f.runner(await signed(id))).status,409);
});
for(const phase of ['pre','chunk','eof'] as const)test('body cancellation at '+phase+' never reads or dispatches after abort',async()=>{
 const f=fixture(),abort=new AbortController();let reads=0;
 const body=new ReadableStream<Uint8Array>({pull(c){reads++;if(phase==='eof'){c.close();abort.abort()}else{c.enqueue(bytes);abort.abort()}}},{highWaterMark:0});
 if(phase==='pre')abort.abort();const response=await f.runner(await signed(undefined,body,abort.signal));assert.equal(response.status,502);assert.equal((await response.json() as any).error.code,'round_cancelled');assert.equal(reads,phase==='pre'?0:1);assert.deepEqual(f.counts(),{credentials:0,calls:0});assert.equal(f.journal.rounds.size,0);
});
test('read timeout/abort observes late failures and preserves observed diagnostic byte count',async()=>{
 const f=fixture({admission:{readTimeoutMs:10}});let cancel=0;
 const body=new ReadableStream<Uint8Array>({start(c){c.enqueue(bytes.slice(0,7))},cancel(){cancel++;return Promise.reject(Error('late synthetic cancellation'))}},{highWaterMark:0});
 assert.equal((await f.runner(await signed(undefined,body))).status,502);await tick();assert.equal(cancel,1);assert.equal(f.diagnostics.find(x=>x.outcome==='failure').bodyBytes,7);
});
test('standalone bounded reader checks abort even when read fulfills in same microtask',async()=>{
 const abort=new AbortController();const body=new ReadableStream<Uint8Array>({pull(c){c.enqueue(bytes);queueMicrotask(()=>abort.abort());}},{highWaterMark:0});
 const r=await signed(undefined,body,abort.signal);await assert.rejects(readRunnerBody(r,abort.signal,100),/round_cancelled/);
});
async function bridge(runner:(r:Request)=>Promise<Response>,options:RunnerServerOptions={signed:true}){
 const server=createRunnerServer(runner,options);server.listen(0,'127.0.0.1');await once(server,'listening');const port=(server.address() as import('node:net').AddressInfo).port;
 return {server,url:`http://127.0.0.1:${port}/v1/responses`,close:async()=>{server.closeAllConnections();await new Promise<void>(r=>server.close(()=>r()))}};
}
test('live HTTP rejects missing/duplicate signature headers before waiting for chunked EOF',async()=>{
 let calls=0;const b=await bridge(async()=>{calls++;return new Response('unexpected')});
 try{for(const duplicate of [false,true]){
  const headers:any=await signRound(key,raw,crypto.randomUUID());if(duplicate)headers['x-pi-signature']=[headers['x-pi-signature'],headers['x-pi-signature']];else delete headers['x-pi-signature'];
  await new Promise<void>((resolve,reject)=>{const req=httpRequest(b.url,{method:'POST',headers},response=>{assert.equal(response.statusCode,403);response.resume();response.once('end',()=>resolve())});req.on('error',reject);req.flushHeaders();});
 }assert.equal(calls,0);}finally{await b.close()}
});
test('HTTP aggregate admission recovers after client abort without reserving an incomplete body',async()=>{
 const f=fixture(),entered=deferred<void>(),finished=deferred<void>();
 const b=await bridge(async r=>{entered.resolve();try{return await f.runner(r)}finally{finished.resolve()}},{signed:true,maxReaders:1});
 try{
  const headers=await signRound(key,raw,crypto.randomUUID());let initial!:ReturnType<typeof httpRequest>;
  const disconnected=new Promise<void>(resolve=>{initial=httpRequest(b.url,{method:'POST',headers});initial.on('error',()=>resolve());initial.flushHeaders();initial.write(bytes.slice(0,1));});
  await entered.promise;
  const r=await fetch(b.url,{method:'POST',headers:await signRound(key,raw,crypto.randomUUID()),body:raw});assert.equal(r.status,503);
  initial.destroy();await disconnected;await finished.promise;await tick();assert.equal(f.journal.rounds.size,0);
  const good=await fetch(b.url,{method:'POST',headers:await signRound(key,raw,crypto.randomUUID()),body:raw});assert.equal(good.status,200);await good.text();assert.equal(f.journal.rounds.size,1);
 }finally{await b.close()}
});
test('HTTP body deadline cancels a stalled upload and recovers capacity',async()=>{
 const f=fixture(),b=await bridge(f.runner,{signed:true,maxReaders:1,readTimeoutMs:20});
 try{
  const headers=await signRound(key,raw,crypto.randomUUID());
  const status=await new Promise<number>((resolve,reject)=>{const req=httpRequest(b.url,{method:'POST',headers},response=>{response.resume();response.once('end',()=>resolve(response.statusCode!))});req.on('error',reject);req.flushHeaders();req.write(bytes.slice(0,1));});
  assert.equal(status,502);assert.equal(f.journal.rounds.size,0);
  const good=await fetch(b.url,{method:'POST',headers:await signRound(key,raw,crypto.randomUUID()),body:raw});assert.equal(good.status,200);await good.text();assert.equal(f.journal.rounds.size,1);
 }finally{await b.close()}
});
