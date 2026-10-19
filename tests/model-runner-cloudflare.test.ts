import { test } from 'node:test';
import assert from 'node:assert/strict';
import { once } from 'node:events';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { build } from 'esbuild';
import { Miniflare, convertV4MiniflareOptions } from 'miniflare';
import { generateKeyPair, SignJWT, exportJWK } from 'jose';
import { createSiwcRunner } from '../services/model-runner/live-runner';
import { createRunnerServer } from '../services/model-runner/http';
import { MemoryRoundJournal } from '../services/model-runner/core';
import { fakeBackend } from '../services/model-runner/fake-backend';
import { transportKey } from '../src/model-runner-protocol';
async function fixture(tamper=false,held=false){
 const pair=await generateKeyPair('RS256'),jwks={keys:[{...await exportJWK(pair.publicKey),kid:'fixture'}]};
 const token=await new SignJWT({email:'owner@example.test'}).setProtectedHeader({alg:'RS256',kid:'fixture'}).setIssuer('https://owner.cloudflareaccess.com').setAudience('fixture').setSubject('fixture').setIssuedAt().setExpirationTime('5m').sign(pair.privateKey);
 let started!:()=>void,stopped!:()=>void;const entered=new Promise<void>(ok=>started=ok),canceled=new Promise<void>(ok=>stopped=ok);
 const journal=new MemoryRoundJournal(),bodies:any[]=[],wire:any[]=[];
 const runner=createSiwcRunner({key:await transportKey(new Uint8Array(32).fill(7)),journal,credentials:{access:async()=>'SYNTHETIC-ACCESS'},fetch:async(_u,init)=>{const body=JSON.parse(init!.body as string);bodies.push(body);started();if(held){init!.signal!.addEventListener('abort',()=>stopped(),{once:true});return new Response(new ReadableStream({start(out){out.enqueue(new TextEncoder().encode('data: {\"type\":\"response.created\"}\n\n'));}}));}return fakeBackend(body,'',init!.signal!);}});
 const server=createRunnerServer(async request=>{wire.push({body:await request.clone().text(),id:request.headers.get('x-pi-round-id')});assert.equal(request.headers.has('authorization'),false);assert.equal(request.headers.has('x-pi-generation-task'),false);return runner(request);});server.listen(0,'127.0.0.1');await once(server,'listening');const port=(server.address() as import('node:net').AddressInfo).port;
 const contents=`const nativeFetch=globalThis.fetch;globalThis.fetch=async(input,init)=>{const req=new Request(input,init),url=new URL(req.url);if(url.href==='https://owner.cloudflareaccess.com/cdn-cgi/access/certs')return Response.json(${JSON.stringify(jwks)});if(url.href!=='https://runner.example/v1/responses')throw Error('External network denied in fixture');const body=await req.text(),headers=new Headers(req.headers);headers.delete('content-length');return nativeFetch('http://127.0.0.1:${port}/v1/responses',{method:req.method,body:body+${JSON.stringify(tamper?' ':'')},headers,signal:req.signal,redirect:'manual'});};import worker,{Assistant} from '../src/index';export class TestAssistant extends Assistant {async settle(op,session){return this.harness.session(session).wait(op);}async rounds(){return [...(await this.ctx.storage.list({prefix:'runner-round:v1:'})).entries()];}}export default {fetch(r,env){const u=new URL(r.url);if(u.pathname==='/__test/settle')return env.Assistant.getByName('private-owner-v1').settle(u.searchParams.get('op'),u.searchParams.get('session')).then(x=>Response.json(x));if(u.pathname==='/__test/rounds')return env.Assistant.getByName('private-owner-v1').rounds().then(x=>Response.json(x));return worker.fetch(r,env);}};`;
 const bundle=await build({stdin:{contents,resolveDir:path.resolve('tests'),loader:'ts'},bundle:true,write:false,format:'esm',platform:'browser',target:'es2022',external:['node:*','cloudflare:*'],logLevel:'silent'});
 const persist=await mkdtemp(path.join(tmpdir(),'pi-worker-sqlite-'));
 const options=convertV4MiniflareOptions({cf:false,modules:true,script:bundle.outputFiles[0].text,compatibilityDate:'2026-10-11',compatibilityFlags:['nodejs_compat'],durableObjects:{Assistant:{className:'TestAssistant',useSQLite:true}},resourcePersistencePath:persist,
  bindings:{ACCESS_TEAM_DOMAIN:'https://owner.cloudflareaccess.com',ACCESS_AUD:'fixture',OWNER_EMAILS:'owner@example.test',APP_ORIGIN:'https://chat.example.test',ENABLE_MODEL:'true',ENABLE_SUBSCRIPTION_LOGIN:'false',ENABLE_MODEL_RUNNER:'true',MODEL_RUNNER_ENDPOINT:'https://runner.example/v1/responses',MODEL_RUNNER_TRANSPORT_KEY:'07'.repeat(32),CREDENTIAL_ENCRYPTION_KEY:Buffer.alloc(32,42).toString('base64')},

 });
 let mf=new Miniflare(options);const headers={'Cf-Access-Jwt-Assertion':token,origin:'https://chat.example.test','content-type':'application/json'};
 let session='1';
 const call=async(p:string,body?:any)=>{const url=new URL('https://chat.example.test/'+p);url.searchParams.set('session',session);const r=await mf.dispatchFetch(url,{headers,...(body?{method:'POST',body:JSON.stringify(body)}:{}),signal:AbortSignal.timeout(8000)});assert.equal(r.status,200,await r.clone().text());const result=await r.json() as any;if(p==='api/sessions'&&body)session=result.id;return result;};
 return{bodies,wire,journal,call,entered,canceled,restart:async()=>{await mf.dispose();mf=new Miniflare(options);},dispose:async()=>{await mf.dispose();server.closeAllConnections();await new Promise<void>(ok=>server.close(()=>ok()));await rm(persist,{recursive:true,force:true});}};
}
test('actual authenticated Assistant/SQLite Worker -> signed HTTP runner -> fake SIWC tool continuation, durable replay after process reconstruction',{timeout:20000},async()=>{
 const f=await fixture();try{
  const chat=await f.call('api/sessions',{});assert.match(chat.id,/^\d+$/);const status=await f.call('api/status');assert.equal(status.model.provider,'model-runner-siwc');assert.equal(status.connected,true);assert.equal(status.canLogin,false);
  const body={text:'offline integration fixture',operationId:'cloudflare-operation-1'},first=await f.call('api/submit',body);assert.equal((await f.call('__test/settle?op='+body.operationId)).status,'done',JSON.stringify({snapshot:await f.call('api/events?snapshot=1'),rounds:await f.call('__test/rounds')}));assert.equal(f.bodies.length,2);assert.equal(f.wire.length,2);assert.notEqual(f.wire[0].id,f.wire[1].id);assert.equal(f.journal.rounds.size,2);
  const records=await f.call('__test/rounds');assert.equal(records.length,2);assert.notEqual(records[0][1].task,records[1][1].task);assert.ok(f.bodies[1].input.some((x:any)=>x.type==='function_call_output'));
  const snapshot=await f.call('api/events?snapshot=1');assert.match(JSON.stringify(snapshot),/offline-marker/);await f.restart();assert.deepEqual(await f.call('api/submit',body),first);assert.deepEqual(await f.call('__test/rounds'),records);assert.deepEqual(await f.call('api/events?snapshot=1'),snapshot);assert.equal(f.wire.length,2);
 }finally{await f.dispose();}
});
test('actual Worker signed-body tampering fails before SIWC credentials/inference and never harness-retries',{timeout:20000},async()=>{
 const f=await fixture(true);try{await f.call('api/sessions',{});const body={text:'tamper fixture',operationId:'cloudflare-operation-2'};await f.call('api/submit',body);assert.equal((await f.call('__test/settle?op='+body.operationId)).status,'unanswered');assert.equal(f.wire.length,1);assert.equal(f.journal.rounds.size,0);assert.equal(f.bodies.length,0);assert.equal((await f.call('__test/rounds')).length,1);}finally{await f.dispose();}
});
test('actual Worker Stop aborts the signed runner stream and input replay cannot resurrect it',{timeout:20000},async()=>{
 const f=await fixture(false,true);try{await f.call('api/sessions',{});const body={text:'held cancellation fixture',operationId:'cloudflare-stop-operation'};const receipt=await f.call('api/submit',body);await f.entered;await f.call('api/abort',{});assert.equal((await f.call('__test/settle?op='+body.operationId)).status,'unanswered');await Promise.race([f.canceled,new Promise((_,reject)=>setTimeout(()=>reject(Error('Runner cancellation did not arrive')),2000))]);assert.equal(f.bodies.length,1);assert.equal(f.journal.rounds.size,1);assert.deepEqual(await f.call('api/submit',body),receipt);assert.equal(f.wire.length,1);}finally{await f.dispose();}
});
