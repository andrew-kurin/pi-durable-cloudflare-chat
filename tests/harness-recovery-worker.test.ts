import {test} from 'node:test';
import assert from 'node:assert/strict';
import {build} from 'esbuild';
import {Miniflare,convertV4MiniflareOptions} from 'miniflare';
import {generateKeyPair,SignJWT,exportJWK} from 'jose';
import path from 'node:path';

test('actual Assistant disposes Agents 0.28 cached failed PiHarness and reopens the same SQLite history on a new request',{timeout:15000},async()=>{
 const origin='https://chat.example.test';const {privateKey,publicKey}=await generateKeyPair('RS256');
 const jwks={keys:[{...await exportJWK(publicKey),kid:'local'}]};
 const token=await new SignJWT({email:'owner@example.test'}).setProtectedHeader({alg:'RS256',kid:'local'}).setIssuer('https://owner.cloudflareaccess.com').setAudience('app').setSubject('owner').setIssuedAt().setExpirationTime('5m').sign(privateKey);
 const contents=`import worker,{Assistant as Original} from '../src/index.ts';import {BACKGROUND_CONTEXT as context} from '@earendil-works/chord/context';
 globalThis.fetch=async input=>{if(String(input)==='https://owner.cloudflareaccess.com/cdn-cgi/access/certs')return Response.json(${JSON.stringify(jwks)});throw Error('No external network')};
 export class Assistant extends Original {
  async seed(){const root=await(await this.harness.pi()).root(context);await(await root.submit({type:'write',requestId:'before-failure',entry:{kind:'pi.user',model:[{role:'user',content:'Durable history before failure',timestamp:1}]}},context)).wait(context);}
  async fail(){this.failedPi=await this.harness.pi();const storage=await this.harness.storage();storage.commit=async()=>{throw Error('SYNTHETIC_PRIVATE_STORAGE_FAILURE')};try{await this.failedPi.commit(tx=>tx.appendEntry(1,{kind:'pi.user'}),context)}catch{}return (await this.failedPi.closed).reason;}
  async cached(){return (await this.harness.pi())===this.failedPi;}
 }
 export default {async fetch(request,env){const p=new URL(request.url).pathname,stub=env.Assistant.getByName('private-owner-v1');if(p==='/fixture-seed'){await stub.seed();return Response.json(true)}if(p==='/fixture-fail')return Response.json(await stub.fail());if(p==='/fixture-cached')return Response.json(await stub.cached());return worker.fetch(request,env)}};`;
 const bundle=await build({stdin:{contents,resolveDir:path.resolve('tests'),loader:'ts'},bundle:true,write:false,format:'esm',platform:'browser',target:'es2022',external:['node:*','cloudflare:*'],logLevel:'silent'});
 const mf=new Miniflare(convertV4MiniflareOptions({cf:false,modules:true,script:bundle.outputFiles[0].text,compatibilityDate:'2026-10-11',compatibilityFlags:['nodejs_compat'],durableObjects:{Assistant:{className:'Assistant',useSQLite:true}},bindings:{ACCESS_TEAM_DOMAIN:'https://owner.cloudflareaccess.com',ACCESS_AUD:'app',OWNER_EMAILS:'owner@example.test',APP_ORIGIN:origin,ENABLE_MODEL:'false',ENABLE_SUBSCRIPTION_LOGIN:'false',CREDENTIAL_ENCRYPTION_KEY:Buffer.alloc(32,42).toString('base64')},outboundService:()=>{throw Error('No external network allowed')}}));
 const call=(p:string)=>mf.dispatchFetch(origin+p,{headers:{'Cf-Access-Jwt-Assertion':token}});
 try{
  await (await call('/fixture-seed')).text();const stream=await call('/api/events?session=1');assert.equal(stream.status,200);const reader=stream.body!.getReader();await reader.read();
  assert.equal(await(await call('/fixture-fail')).json(),'failed');assert.equal(await(await call('/fixture-cached')).json(),true,'adapter still caches its failed Harness');
  const end=new TextDecoder().decode((await reader.read()).value);assert.match(end,/"kind":"session"/);assert.doesNotMatch(end,/SYNTHETIC_PRIVATE/);assert.equal((await reader.read()).done,true);
  const reloaded=await call('/api/events?session=1&snapshot=1');assert.equal(reloaded.status,200);const view=await reloaded.json() as any;assert.ok(view.messages.some((m:any)=>m.text==='Durable history before failure'));
  assert.equal(await(await call('/fixture-cached')).json(),false,'new authenticated request must dispose and reopen the cached adapter');
 }finally{await mf.dispose();}
});
