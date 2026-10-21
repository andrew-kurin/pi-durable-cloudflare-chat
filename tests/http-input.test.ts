import {test} from 'node:test';
import assert from 'node:assert/strict';
import {BODY_READ_TIMEOUT_MS,discardBody,jsonObject,readBodyText,RequestError} from '../src/http-input';

test('ignored request payloads are fully consumed without interpreting their contents',async()=>{
 for(const body of [undefined,'{}','not JSON','x'.repeat(20000)]){
  const request=new Request('https://fixture.test',{method:'POST',body});
  await discardBody(request);
  assert.equal(request.bodyUsed,body!==undefined);
 }
});
test('oversized ignored payloads cancel the source and release its reader',async()=>{
 let canceled=0;
 const body=new ReadableStream<Uint8Array>({pull(out){out.enqueue(new Uint8Array(10001));},cancel(){canceled++;}});
 const request=new Request('https://fixture.test',{method:'POST',body,duplex:'half'} as RequestInit);
 await assert.rejects(discardBody(request),(error:unknown)=>error instanceof RequestError&&error.status===413);
 assert.equal(canceled,1);assert.equal(request.body!.locked,false);
});
test('a broken ignored payload preserves its original read failure',async()=>{
 const cause=Error('synthetic body transport failure');
 const request=new Request('https://fixture.test',{method:'POST',body:new ReadableStream({start(out){out.error(cause);}}),duplex:'half'} as RequestInit);
 await assert.rejects(discardBody(request),error=>error===cause);
 assert.equal(request.body!.locked,false);
});

const post = (body?: BodyInit, signal?: AbortSignal) => new Request('https://fixture.test', {method:'POST',body,signal,duplex:'half'} as RequestInit);
const expected = (status: number, message?: string) => (error: unknown) => error instanceof RequestError && error.status === status && (message === undefined || error.message === message);

test('bounded text accepts exact character/byte limits, split UTF-8, BOM, and valid JSON without Content-Length',async()=>{
 const source='{"text":"界😀"}';
 const bytes=new TextEncoder().encode(source),chunks=Array.from(bytes,byte=>Uint8Array.of(byte));
 const body=new ReadableStream<Uint8Array>({pull(out){const chunk=chunks.shift();if(chunk)out.enqueue(chunk);else out.close();}});
 const request=post(body);assert.equal(request.headers.get('content-length'),null);
 assert.deepEqual(jsonObject(await readBodyText(request,source.length,{maxBytes:bytes.length})),{text:'界😀'});
 assert.equal(request.body!.locked,false);
 for(const text of ['', 'x'.repeat(100), '界'.repeat(100), '😀'.repeat(50)]){
  assert.equal(await readBodyText(post(text),text.length),text);
  assert.equal(await readBodyText(post('\uFEFF'+text),text.length),text);
 }
 assert.equal(await readBodyText(post(),0),'');
});

test('character and byte overflow reject incrementally with route-specific failures and release readers',async()=>{
 for(const [parts,maxCharacters,maxBytes] of [[['xx','x'],2,9],[['界'],3,2]] as const){
  let canceled=0,reads=0;
  const pending=[...parts];
  const body=new ReadableStream<Uint8Array>({pull(out){reads++;if(pending.length)out.enqueue(new TextEncoder().encode(pending.shift()!));else out.close();},cancel(){canceled++;}},{highWaterMark:0});
  const request=post(body);
  await assert.rejects(readBodyText(request,maxCharacters,{maxBytes,status:400,message:'Title too long'}),expected(400,'Title too long'));
  assert.equal(canceled,1);assert.equal(request.body!.locked,false);assert.equal(reads,parts.length);
 }
 const understated=post('xxx');understated.headers.set('Content-Length','1');
 await assert.rejects(readBodyText(understated,2),expected(413));
});

test('stalled text and ignored bodies time out, cancel once, and settle without waiting for source cleanup',async t=>{
 t.mock.timers.enable({apis:['setTimeout']});
 for(const read of [readBodyText,discardBody]){
  let canceled=0,release!:()=>void;
  const cleanup=new Promise<void>(resolve=>{release=resolve});
  const request=post(new ReadableStream<Uint8Array>({pull(){return new Promise(()=>{});},cancel(){canceled++;return cleanup;}},{highWaterMark:0}));
  const pending=read(request,100);
  const rejected=assert.rejects(pending,expected(408,'Request body timed out'));
  t.mock.timers.tick(BODY_READ_TIMEOUT_MS-1);await Promise.resolve();assert.equal(canceled,0);
  t.mock.timers.tick(1);await rejected;
  assert.equal(canceled,1);assert.equal(request.body!.locked,false);
  release();
 }
});

test('pre-aborted and mid-read aborts reject promptly, clean listeners/readers, and do not issue another read',async t=>{
 for(const before of [true,false])for(const read of [readBodyText,discardBody]){
  const abort=new AbortController();let pulls=0,canceled=0;
  const request=post(new ReadableStream<Uint8Array>({pull(){pulls++;return new Promise(()=>{});},cancel(){canceled++;}},{highWaterMark:0}),abort.signal);
  const remove=t.mock.method(request.signal,'removeEventListener');
  if(before)abort.abort();
  const pending=read(request,100),rejected=assert.rejects(pending,expected(408,'Request body cancelled'));
  if(!before){await Promise.resolve();abort.abort();}await rejected;
  assert.equal(pulls,before?0:1);assert.equal(canceled,1);assert.equal(request.body!.locked,false);
  assert.equal(remove.mock.calls.filter(call=>call.arguments[0]==='abort').length,1);
 }
});

test('a late underlying read rejection after timeout is observed and cannot affect a later independent read',async t=>{
 t.mock.timers.enable({apis:['setTimeout']});
 let reject!: (error: Error)=>void;
 const request=post(new ReadableStream<Uint8Array>({pull(){return new Promise<void>((_,no)=>{reject=no});}},{highWaterMark:0}));
 const pending=readBodyText(request,10),rejected=assert.rejects(pending,expected(408));
 await Promise.resolve();t.mock.timers.tick(BODY_READ_TIMEOUT_MS);await rejected;
 reject(Error('Late synthetic source failure'));await Promise.resolve();
 assert.equal(request.body!.locked,false);
 assert.equal(await readBodyText(post('{}'),2),'{}');
});

test('text source failures remain original failures and do not poison concurrent readers',async()=>{
 const cause=Error('synthetic body transport failure');
 const broken=post(new ReadableStream({start(out){out.error(cause);}}));
 await assert.rejects(readBodyText(broken,100),error=>error===cause);
 assert.equal(broken.body!.locked,false);
 assert.deepEqual(await Promise.all(Array.from({length:4},()=>readBodyText(post('{}'),2))),['{}','{}','{}','{}']);
});
