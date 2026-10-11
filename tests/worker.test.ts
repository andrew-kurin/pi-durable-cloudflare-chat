import {test} from 'node:test';import assert from 'node:assert/strict';import {build} from 'esbuild';import {Miniflare,convertV4MiniflareOptions} from 'miniflare';import {generateKeyPair,SignJWT,exportJWK} from 'jose';import path from 'node:path';
test('actual worker rejects unauthenticated access; owner can persist sessions while model/login stay disabled',async()=>{
 const {privateKey,publicKey}=await generateKeyPair('RS256');const jwks={keys:[{...await exportJWK(publicKey),kid:'local'}]};
 const token=await new SignJWT({email:'owner@example.test'}).setProtectedHeader({alg:'RS256',kid:'local'}).setIssuer('https://owner.cloudflareaccess.com').setAudience('app').setSubject('owner').setIssuedAt().setExpirationTime('5m').sign(privateKey);
 const signed=async(email:string)=>new SignJWT({email}).setProtectedHeader({alg:'RS256',kid:'local'}).setIssuer('https://owner.cloudflareaccess.com').setAudience('app').setSubject(email).setIssuedAt().setExpirationTime('5m').sign(privateKey);
 const contents=`import worker,{Assistant} from '../src/index.ts';export {Assistant};globalThis.fetch=async input=>{if(String(input)==='https://owner.cloudflareaccess.com/cdn-cgi/access/certs')return Response.json(${JSON.stringify(jwks)});throw new Error('No external test network');};export default worker;`;
 const bundle=await build({stdin:{contents,resolveDir:path.resolve('tests'),loader:'ts'},bundle:true,write:false,format:'esm',platform:'browser',target:'es2022',external:['node:*','cloudflare:*'],logLevel:'silent'});
 const mf=new Miniflare(convertV4MiniflareOptions({cf:false,modules:true,script:bundle.outputFiles[0].text,compatibilityDate:'2026-10-11',compatibilityFlags:['nodejs_compat'],durableObjects:{Assistant:{className:'Assistant',useSQLite:true}},bindings:{ACCESS_TEAM_DOMAIN:'https://owner.cloudflareaccess.com',ACCESS_AUD:'app',OWNER_EMAILS:'owner@example.test,alternate@example.test',APP_ORIGIN:'https://chat.example.test',ENABLE_MODEL:'false',ENABLE_SUBSCRIPTION_LOGIN:'false',CREDENTIAL_ENCRYPTION_KEY:Buffer.alloc(32,42).toString('base64')}}));
 const headers={'Cf-Access-Jwt-Assertion':token,origin:'https://chat.example.test','Content-Type':'application/json'};
 try{
  assert.equal((await mf.dispatchFetch('https://chat.example.test/')).status,403);
  assert.equal((await mf.dispatchFetch('https://chat.example.test/api/sessions')).status,403);
  const status=await mf.dispatchFetch('https://chat.example.test/api/status',{headers});assert.equal(status.status,200);assert.equal((await status.json() as any).connected,false);
  const list=await mf.dispatchFetch('https://chat.example.test/api/sessions',{headers});assert.equal(list.status,200);assert.ok((await list.json() as any[]).some(x=>x.id==='1'));
  const created=await mf.dispatchFetch('https://chat.example.test/api/sessions',{method:'POST',headers,body:'{}'});assert.equal(created.status,200);const id=(await created.json() as any).id;assert.notEqual(id,'1');
  const again=await mf.dispatchFetch('https://chat.example.test/api/sessions',{headers});assert.ok((await again.json() as any[]).some(x=>x.id===id));
  const alternateHeaders={...headers,'Cf-Access-Jwt-Assertion':await signed('alternate@example.test')};
  const shared=await mf.dispatchFetch('https://chat.example.test/api/sessions',{headers:alternateHeaders});assert.equal(shared.status,200);assert.ok((await shared.json() as any[]).some(x=>x.id===id));
  assert.equal((await mf.dispatchFetch('https://chat.example.test/api/sessions',{headers:{...headers,'Cf-Access-Jwt-Assertion':await signed('other@example.test')}})).status,403);
  assert.equal((await mf.dispatchFetch('https://chat.example.test/api/submit',{method:'POST',headers,body:JSON.stringify({text:'No paid calls',operationId:'test-only-123'})})).status,503);
  assert.equal((await mf.dispatchFetch('https://chat.example.test/api/login',{method:'POST',headers,body:'{}'})).status,403);
  const events=await mf.dispatchFetch('https://chat.example.test/api/events',{headers});assert.equal(events.status,200);const reader=events.body!.getReader();const first=await reader.read();assert.ok(new TextDecoder().decode(first.value).startsWith('data: '));await reader.cancel();
 }finally{await mf.dispose();}
});
