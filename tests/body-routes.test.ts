import {test} from 'node:test';
import assert from 'node:assert/strict';
import {build} from 'esbuild';
import {Miniflare,convertV4MiniflareOptions} from 'miniflare';
import {generateKeyPair,exportJWK,SignJWT} from 'jose';
import path from 'node:path';

test('owner mutation routes preserve payload limits and recover their queue after stalled, aborted and oversized bodies',async()=>{
 const origin='https://chat.example.test';
 const {privateKey,publicKey}=await generateKeyPair('RS256');
 const jwks={keys:[{...await exportJWK(publicKey),kid:'fixture'}]};
 const token=await new SignJWT({email:'owner@example.test'}).setProtectedHeader({alg:'RS256',kid:'fixture'}).setIssuer('https://owner.cloudflareaccess.com').setAudience('app').setSubject('owner').setIssuedAt().setExpirationTime('5m').sign(privateKey);
 const contents=`
 import worker,{Assistant as Original} from '../src/index.ts';
 const expirations=[];const schedule=setTimeout;
 globalThis.setTimeout=(fn,ms,...rest)=>{if(ms===10000)expirations.push(()=>fn(...rest));return schedule(fn,ms,...rest)};
 export class Assistant extends Original {
  async seed(){
   this.providers.assertCanSubmit=async()=>{};
   this.submissions.atArrival=()=>async input=>({accepted:true,text:input.text});
   await this.harness.sessions.list();
  }
  async stalled(token){
   let entered;const waiting=new Promise(resolve=>{entered=resolve});this.cancelled=0;
   this.bodyAbort=new AbortController();
   const body=new ReadableStream({pull(){entered();return new Promise(()=>{})},cancel:()=>{this.cancelled++;return new Promise(()=>{})}},{highWaterMark:0});
   this.bodyRequest=new Request('${origin}/api/session-title?session=1',{method:'POST',headers:{'Cf-Access-Jwt-Assertion':token,origin:'${origin}','Content-Type':'application/json'},body,signal:this.bodyAbort.signal});
   this.bodyResult=this.fetch(this.bodyRequest);await waiting;return {started:true};
  }
  async expire(){for(const expire of expirations.splice(0))expire();return {expired:true}}
  async abortRead(){this.bodyAbort.abort();return {aborted:true}}
  async result(){const response=await this.bodyResult;return {status:response.status,body:await response.json(),cancelled:this.cancelled,locked:this.bodyRequest.body.locked}}
 }
 export default {async fetch(request,env){
  const stub=env.Assistant.getByName('private-owner-v1'),path=new URL(request.url).pathname;
  if(path==='/fixture-seed'){await stub.seed();return Response.json({ok:true})}
  if(path==='/fixture-stall')return Response.json(await stub.stalled(request.headers.get('Cf-Access-Jwt-Assertion')));
  if(path==='/fixture-expire')return Response.json(await stub.expire());
  if(path==='/fixture-abort')return Response.json(await stub.abortRead());
  if(path==='/fixture-result')return Response.json(await stub.result());
  return worker.fetch(request,env);
 }};`;
 const bundle=await build({stdin:{contents,resolveDir:path.resolve('tests'),loader:'ts'},bundle:true,write:false,format:'esm',platform:'browser',target:'es2022',external:['node:*','cloudflare:*'],logLevel:'silent'});
 let certificates=0;
 const mf=new Miniflare(convertV4MiniflareOptions({cf:false,modules:true,script:bundle.outputFiles[0].text,compatibilityDate:'2026-10-11',compatibilityFlags:['nodejs_compat'],durableObjects:{Assistant:{className:'Assistant',useSQLite:true}},bindings:{ACCESS_TEAM_DOMAIN:'https://owner.cloudflareaccess.com',ACCESS_AUD:'app',OWNER_EMAILS:'owner@example.test',APP_ORIGIN:origin,ENABLE_MODEL:'false',ENABLE_SUBSCRIPTION_LOGIN:'false',CREDENTIAL_ENCRYPTION_KEY:Buffer.alloc(32,42).toString('base64')},outboundService:async(request:any)=>{
  assert.equal(request.url,'https://owner.cloudflareaccess.com/cdn-cgi/access/certs');certificates++;return Response.json(jwks);
 }}));
 const headers={'Cf-Access-Jwt-Assertion':token,origin,'Content-Type':'application/json'};
 const get=(url:string)=>mf.dispatchFetch(origin+url,{headers});
 const post=(url:string,body:string,h=headers)=>mf.dispatchFetch(origin+url,{method:'POST',headers:h,body});
 try {
  await get('/fixture-seed');
  const valid=JSON.stringify({text:'界'.repeat(12000),operationId:'unicode-fixture'});
  const accepted=await post('/api/submit',valid);assert.equal(accepted.status,200);assert.equal((await accepted.json() as any).text,'界'.repeat(12000));
  const exact=JSON.stringify({text:'hello',operationId:'boundary-fixture'}).padEnd(20000,' ');
  assert.equal((await post('/api/submit',exact)).status,200);
  const tooLarge=await post('/api/submit',exact+' ');assert.equal(tooLarge.status,413);assert.deepEqual(await tooLarge.json(),{error:'Message too long'});
  const title=JSON.stringify({title:'界'.repeat(80)}).padEnd(1000,' ');
  assert.equal((await post('/api/session-title',title)).status,200);
  const longTitle=await post('/api/session-title',title+' ');assert.equal(longTitle.status,400);assert.deepEqual(await longTitle.json(),{error:'Title too long'});
  for(const body of ['{','null','[]'])assert.equal((await post('/api/session-title',body)).status,400);
  assert.equal((await post('/api/session-title','{}',{'Content-Type':'application/json'} as typeof headers)).status,403);
  for(const ending of ['expire','abort']){
   assert.equal((await get('/fixture-stall')).status,200);
   const queued=post('/api/session-title',JSON.stringify({title:'After '+ending}));
   // Stop is independent of the blocked ordinary mutation queue.
   const stopped=await post('/api/abort','{}');assert.equal(stopped.status,200);await stopped.text();
   await get('/fixture-'+ending);
   const result=await(await get('/fixture-result')).json() as any;
   assert.equal(result.status,408);assert.equal(result.body.error,ending==='expire'?'Request body timed out':'Request body cancelled');
   assert.equal(result.cancelled,1);assert.equal(result.locked,false);
   assert.equal((await queued).status,200);
  }
  assert.equal(certificates,1,'only the synthetic signing certificate was fetched; no provider work');
 } finally {await mf.dispose()}
});
