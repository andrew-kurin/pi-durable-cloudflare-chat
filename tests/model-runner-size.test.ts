import {test} from 'node:test';
import assert from 'node:assert/strict';
import {once} from 'node:events';
import {request as httpRequest} from 'node:http';
import {MAX_REQUEST_BYTES,signRound,transportKey} from '../src/model-runner-protocol';
import {MAX_REQUEST_BYTES as NODE_LIMIT,MemoryRoundJournal} from '../services/model-runner/core';
import {createSiwcRunnerProvider} from '../src/model-runner-siwc-client';
import {createSiwcRunner} from '../services/model-runner/live-runner';
import {createRunnerServer} from '../services/model-runner/http';
import {fakeBackend} from '../services/model-runner/fake-backend';
const key=await transportKey(new Uint8Array(32).fill(7));
function payload(bytes:number){const p={model:'gpt-6.1-sol',input:[{role:'user',content:''}],store:false,stream:true};p.input[0].content='x'.repeat(bytes-Buffer.byteLength(JSON.stringify(p)));assert.equal(Buffer.byteLength(JSON.stringify(p)),bytes);return p;}
test('180013-byte incident and exact shared limit pass Worker signing, native HTTP and live parser unchanged',{timeout:30000},async()=>{
 assert.equal(NODE_LIMIT,MAX_REQUEST_BYTES);let calls=0;const journal=new MemoryRoundJournal();let expected:ReturnType<typeof payload>;
 const runner=createSiwcRunner({key,journal,credentials:{access:async()=>'SYNTHETIC'},fetch:async(_url,init)=>{calls++;assert.deepEqual(JSON.parse(init!.body as string),expected);return fakeBackend(expected,'',init!.signal!);}});
 const server=createRunnerServer(runner,{signed:true});server.listen(0,'127.0.0.1');await once(server,'listening');const port=(server.address() as import('node:net').AddressInfo).port;
 try{for(const bytes of [180013,MAX_REQUEST_BYTES]){
  expected=payload(bytes);let dispatched=0;const id='size-fixture-'+bytes;
  const provider=createSiwcRunnerProvider({endpoint:'https://runner.example/v1/responses',key,roundId:id,fetch:async input=>{dispatched++;const request=input as Request;const body=await request.text();assert.equal(Buffer.byteLength(body),bytes);return fetch('http://127.0.0.1:'+port+'/v1/responses',{method:'POST',body,headers:request.headers,signal:request.signal});}});
  const stream=provider.streamSimple(provider.getModels()[0],{messages:[{role:'user',content:'synthetic',timestamp:1}]},{onPayload:()=>expected});for await(const event of stream){}const result=await stream.result();assert.notEqual(result.stopReason,'error',result.errorMessage);assert.equal(dispatched,1);
 }assert.equal(calls,2);assert.equal(journal.rounds.size,2);
 }finally{server.closeAllConnections();await new Promise<void>(resolve=>server.close(()=>resolve()));}
});
test('one byte above guard is independently rejected by HTTP bridge and live parser before credentials',{timeout:30000},async()=>{
 const body=JSON.stringify(payload(MAX_REQUEST_BYTES+1));let credentials=0,requests=0;const journal=new MemoryRoundJournal();const runner=createSiwcRunner({key,journal,credentials:{access:async()=>{credentials++;return 'SYNTHETIC';}},fetch:async()=>{throw Error('No provider request permitted');}});
 const provider=createSiwcRunnerProvider({endpoint:'https://runner.example/v1/responses',key,roundId:'size-worker-overflow',fetch:async()=>{throw Error('Worker must reject before fetch');}});
 const stream=provider.streamSimple(provider.getModels()[0],{messages:[{role:'user',content:'synthetic',timestamp:1}]},{onPayload:()=>JSON.parse(body)});for await(const event of stream){}assert.match((await stream.result()).errorMessage!,/runner input limit/);
 const signed=await signRound(key,body,'size-node-overflow');
 const request=()=>new Request('https://runner.example/v1/responses',{method:'POST',body,headers:signed});
 const parsed=await runner(request());assert.equal(parsed.status,502);assert.equal((await parsed.json() as any).error.code,'invalid_body');
 const server=createRunnerServer(async request=>{requests++;return runner(request);},{signed:true});server.listen(0,'127.0.0.1');await once(server,'listening');const port=(server.address() as import('node:net').AddressInfo).port;
 try{await new Promise<void>((resolve,reject)=>{const req=httpRequest('http://127.0.0.1:'+port+'/v1/responses',{method:'POST',headers:{...signed,'content-length':String(Buffer.byteLength(body))}},response=>{assert.equal(response.statusCode,413);response.resume();response.once('end',()=>resolve());});req.on('error',reject);req.flushHeaders();});assert.equal(requests,0);}finally{server.closeAllConnections();await new Promise<void>(resolve=>server.close(()=>resolve()));}
 assert.equal(credentials,0);assert.equal(journal.rounds.size,0);
});
