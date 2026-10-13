import {test} from 'node:test';import assert from 'node:assert/strict';import {build} from 'esbuild';import {Miniflare,convertV4MiniflareOptions} from 'miniflare';import {generateKeyPair,SignJWT,exportJWK} from 'jose';import path from 'node:path';
test('existing Worker exposes only independently enabled owner smoke while ordinary tools remain off',async()=>{
 const {privateKey,publicKey}=await generateKeyPair('RS256'),jwks={keys:[{...await exportJWK(publicKey),kid:'local'}]};
 const token=await new SignJWT({email:'owner@example.test'}).setProtectedHeader({alg:'RS256',kid:'local'}).setIssuer('https://owner.cloudflareaccess.com').setAudience('app').setSubject('owner').setIssuedAt().setExpirationTime('5m').sign(privateKey);
 const contents=`import worker,{Assistant} from '../src/index.ts';import {DurableObject} from 'cloudflare:workers';export {Assistant};export class MockWorkspace extends DurableObject {async open(){return {phase:'ready'}}async request(){return {phase:'closed'}}async nativeState(){return {configured:true,running:false}}}globalThis.fetch=async input=>{if(String(input)==='https://owner.cloudflareaccess.com/cdn-cgi/access/certs')return Response.json(${JSON.stringify(jwks)});throw Error('No external test network')};export default worker;`;
 const bundle=await build({stdin:{contents,resolveDir:path.resolve('tests'),loader:'ts'},bundle:true,write:false,format:'esm',platform:'browser',target:'es2022',external:['node:*','cloudflare:*'],logLevel:'silent'});
 const base='https://chat.example.test',headers={'Cf-Access-Jwt-Assertion':token,origin:base,'Content-Type':'application/json'};
 for(const smoke of ['false','true']){
  const mf=new Miniflare(convertV4MiniflareOptions({cf:false,modules:true,script:bundle.outputFiles[0].text,compatibilityDate:'2026-10-11',compatibilityFlags:['nodejs_compat'],durableObjects:{Assistant:{className:'Assistant',useSQLite:true},Workspaces:{className:'MockWorkspace',useSQLite:true}},bindings:{ACCESS_TEAM_DOMAIN:'https://owner.cloudflareaccess.com',ACCESS_AUD:'app',OWNER_EMAILS:'owner@example.test',APP_ORIGIN:base,ENABLE_WORKSPACE:'false',ENABLE_WORKSPACE_SMOKE:smoke,WORKSPACE_IMAGE:'workspace',WORKSPACE_REPOSITORY:'owner/project',ENABLE_MODEL:'false',ENABLE_SUBSCRIPTION_LOGIN:'false',CREDENTIAL_ENCRYPTION_KEY:Buffer.alloc(32,42).toString('base64')}}));
  try{
   assert.equal((await mf.dispatchFetch(base+'/workspace-smoke')).status,403);
   assert.equal((await mf.dispatchFetch(base+'/workspace-smoke',{headers})).status,smoke==='true'?200:404);
   assert.equal((await mf.dispatchFetch(base+'/api/smoke/status',{headers})).status,smoke==='true'?200:404);
   assert.equal((await mf.dispatchFetch(base+'/api/smoke',{method:'POST',headers:{...headers,origin:'https://other.example.test'},body:'{"action":"open"}'})).status,403);
   const status=await mf.dispatchFetch(base+'/api/status',{headers});assert.equal(status.status,200);assert.equal((await status.json() as any).workspaceEnabled,false);
   assert.equal((await mf.dispatchFetch(base+'/api/workspaces',{method:'POST',headers,body:'{}'})).status,403);
   if(smoke==='true'){const result=await mf.dispatchFetch(base+'/api/smoke/status',{headers});const data=await result.json() as any;assert.equal(data.native.running,false);assert.equal(data.native.configured,true)}
  }finally{await mf.dispose()}
 }
});
