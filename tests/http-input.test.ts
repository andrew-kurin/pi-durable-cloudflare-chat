import {test} from 'node:test';
import assert from 'node:assert/strict';
import {discardBody,RequestError} from '../src/http-input';

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
