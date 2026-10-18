import {test} from 'node:test';
import assert from 'node:assert/strict';
import {build} from 'esbuild';
import {Miniflare,convertV4MiniflareOptions} from 'miniflare';
import {generateKeyPair,SignJWT,exportJWK} from 'jose';
import path from 'node:path';
const sse=(events:any[])=>events.map(e=>'data: '+JSON.stringify(e)+'\n\n').join('');
const call={type:'function_call',id:'fc_fixture',call_id:'call_fixture',name:'test_status',arguments:'{}'};
const first=sse([{type:'response.created',response:{id:'resp_aaaaaaaa'}},{type:'response.output_item.added',output_index:0,item:{...call,arguments:''}},{type:'response.output_item.done',output_index:0,item:call},{type:'response.completed',response:{id:'resp_aaaaaaaa',status:'completed',output:[call],usage:{input_tokens:1,output_tokens:1,total_tokens:2}}}]);
const text='Confirmed openai-compat-v1.';
const item={type:'message',id:'msg_fixture',role:'assistant',content:[{type:'output_text',text,annotations:[]}]};
const last=sse([{type:'response.created',response:{id:'resp_bbbbbbbb'}},{type:'response.output_item.added',output_index:0,item:{...item,content:[]}},{type:'response.content_part.added',output_index:0,content_index:0,part:{type:'output_text',text:'',annotations:[]}},{type:'response.output_text.delta',output_index:0,content_index:0,delta:text},{type:'response.output_item.done',output_index:0,item},{type:'response.completed',response:{id:'resp_bbbbbbbb',status:'completed',output:[item],usage:{input_tokens:1,output_tokens:1,total_tokens:2}}}]);
async function fixture(mode:string){
 const origin='https://chat.example.test',{privateKey,publicKey}=await generateKeyPair('RS256');const jwks={keys:[{...await exportJWK(publicKey),kid:'local'}]};
 const token=await new SignJWT({email:'owner@example.test'}).setProtectedHeader({alg:'RS256',kid:'local'}).setIssuer('https://owner.cloudflareaccess.com').setAudience('app').setSubject('owner').setIssuedAt().setExpirationTime('10m').sign(privateKey);
 const contents=`import worker,{Assistant as Original} from '../src/index.ts';import {zstdDecompressSync} from 'node:zlib';
 const jwks=${JSON.stringify(jwks)},bodies=[],counts={};let oauth=0,accessToken='';const schedule=setTimeout;
 ${mode==='timeout'?"globalThis.setTimeout=(fn,ms,...args)=>schedule(fn,ms===120000?20:ms,...args);":''}
 globalThis.fetch=async(input,init)=>{const url=String(input);if(url==='https://owner.cloudflareaccess.com/cdn-cgi/access/certs')return Response.json(jwks);
 if(url!=='https://chatgpt.com/backend-api/codex/responses'){oauth++;throw Error('Unexpected external network');}
 const raw=typeof init.body==='string'?init.body:new TextDecoder().decode(zstdDecompressSync(init.body));const body=JSON.parse(raw);counts[body.model]=(counts[body.model]||0)+1;const round=counts[body.model];bodies.push({model:body.model,round,choice:body.tool_choice,store:body.store,parallel:body.parallel_tool_calls,tools:body.tools.map(x=>x.name),hasOutput:body.input.some(x=>x.type==='function_call_output')});
 if(${JSON.stringify(mode)}==='capture-json')return Response.json({error:{code:'model_access_denied',type:'permission_error',message:'Plan denied. Contact owner@example.test; https://example.test/help?case=403',access_token:accessToken,refresh_token:'PRIVATE_REFRESH'}},{status:403,headers:{'content-type':'application/problem+json; charset=UTF-8','cf-ray':'a4a13acd98a8f9ce-LAX','x-request-id':'req_fixture','cf-mitigated':'challenge'}});
 if(${JSON.stringify(mode)}==='capture-html')return new Response('<html><h1>Unable to load site</h1><p>owner@example.test https://example.test/help?case=403</p><p>'+accessToken+' PRIVATE_REFRESH</p></html>',{status:403,headers:{'content-type':'text/html; charset=UTF-8','cf-ray':'a4a13acd98a8f9ce-LAX','x-request-id':'req_fixture'}});
 if(${JSON.stringify(mode)}==='timeout')return new Promise((_,reject)=>init.signal.addEventListener('abort',()=>reject(Error('PRIVATE timeout')),{once:true}));
 if(${JSON.stringify(mode)}==='redirect')return new Response('PRIVATE redirect',{status:302,headers:{location:'https://unapproved.example/private'}});
 if(${JSON.stringify(mode)}==='oversize')return new Response('X'.repeat(70000),{headers:{'content-type':'text/event-stream'}});
 if(${JSON.stringify(mode)}==='first403'||(${JSON.stringify(mode)}==='second403'&&round===2))return new Response('Bearer PRIVATE_TOKEN upstream body',{status:403,headers:{'content-type':'text/plain'}});
 const payload=round===1?${JSON.stringify(first)}:${JSON.stringify(last)};
 return new Response(${JSON.stringify(mode)}==='wrongtool'?payload.replaceAll('test_status','arbitrary_exec'):payload,{headers:{'content-type':'text/event-stream','x-request-id':'Bearer PRIVATE_TOKEN'}});
 };
 export class Assistant extends Original {async seed(){const access='e30.'+btoa(JSON.stringify({'https://api.openai.com/auth':{chatgpt_account_id:'fixture'}}))+'.signature';accessToken=access;await this.credentials.modify('openai-codex',()=>({type:'oauth',access,refresh:'PRIVATE_REFRESH',expires:Date.now()+(${JSON.stringify(mode)}==='expired'?-1:3600000)}));await this.credentials.modify('xai',()=>({type:'oauth',access:'PRIVATE_XAI',refresh:'PRIVATE_XAI_REFRESH',expires:Date.now()+3600000}));this.before=JSON.stringify([...await this.ctx.storage.list({prefix:'credentials:'})]);}
 async evidence(){return {bodies,oauth,credentialsUnchanged:this.before===JSON.stringify([...await this.ctx.storage.list({prefix:'credentials:'})]),saved:[...this.ctx.storage.sql.exec('SELECT result FROM app_openai_check_results')].map(x=>JSON.parse(x.result))};}}
 export default {async fetch(request,env){const p=new URL(request.url).pathname,s=env.Assistant.getByName('private-owner-v1');if(p==='/fixture-seed'){await s.seed();return Response.json({ok:true});}if(p==='/fixture-evidence')return Response.json(await s.evidence());return worker.fetch(request,env);}};`;
 const b=await build({stdin:{contents,resolveDir:path.resolve('tests'),loader:'ts'},bundle:true,write:false,format:'esm',platform:'browser',target:'es2022',external:['node:*','cloudflare:*'],logLevel:'silent'});
 const mf=new Miniflare(convertV4MiniflareOptions({cf:false,modules:true,script:b.outputFiles[0].text,compatibilityDate:'2026-10-11',compatibilityFlags:['nodejs_compat'],durableObjects:{Assistant:{className:'Assistant',useSQLite:true}},assets:{directory:path.resolve('public'),binding:'ASSETS',run_worker_first:true,routerConfig:{has_user_worker:true}},bindings:{ACCESS_TEAM_DOMAIN:'https://owner.cloudflareaccess.com',ACCESS_AUD:'app',OWNER_EMAILS:'owner@example.test',APP_ORIGIN:origin,ENABLE_MODEL:'true',ENABLE_SUBSCRIPTION_LOGIN:'false',ENABLE_GROK_SUBSCRIPTION:'true',CREDENTIAL_ENCRYPTION_KEY:Buffer.alloc(32,42).toString('base64')}}));
 const headers={'Cf-Access-Jwt-Assertion':token,origin,'Content-Type':'application/json'};
 const get=(p:string)=>mf.dispatchFetch(origin+p,{headers,redirect:'manual'});
 const post=(body:any,h:any=headers,route='/api/openai-check/run')=>mf.dispatchFetch(origin+route,{method:'POST',headers:h,body:JSON.stringify(body),signal:AbortSignal.timeout(5000)});
 return {mf,get,post,capture:(body:any,h:any=headers)=>post(body,h,'/api/openai-check/recheck'),headers,dispose:()=>mf.dispose()};
}
for(const mode of ['success','first403','second403','redirect','oversize','wrongtool','timeout'])test('fixed OpenAI native encrypted subscription transport '+mode,{timeout:10000},async()=>{
 const f=await fixture(mode);try{
  if(mode==='success'){
   assert.equal((await f.mf.dispatchFetch('https://chat.example.test/openai-check')).status,403);
   assert.equal((await f.post({approved:true},{})).status,403);
   assert.equal((await f.post({approved:true},{...f.headers,origin:'https://evil.example'})).status,403);
   assert.equal((await f.post({approved:true,model:'gpt-6-sol'})).status,400);
   const page=await f.get('/openai-check');assert.equal(page.status,200);assert.match(await page.text(),/gpt-6.1-sol/);
   const before=await(await f.get('/api/openai-check/status')).json() as any;assert.equal(before.connected,false);assert.equal(before.loginEnabled,false);
   const missing=await(await f.post({approved:true})).json() as any[];assert.equal(missing[0].status,'not_connected');
  }
  await f.get('/fixture-seed');const result=await(await f.post({approved:true})).json() as any[];
  assert.equal(result.length,2);assert.ok(result.every(x=>x.status===(mode==='success'?'passed':'failed')),JSON.stringify(result));
  const evidence=await(await f.get('/fixture-evidence')).json() as any;
  assert.equal(evidence.oauth,0);assert.equal(evidence.credentialsUnchanged,true);assert.deepEqual(evidence.saved,result);
  assert.ok(evidence.bodies.every((b:any)=>['gpt-6.1-sol','gpt-6-luna'].includes(b.model)&&b.tools.join(',')==='test_status'&&b.store===false&&b.parallel===false));
  assert.equal(evidence.bodies.length,['success','second403'].includes(mode)?4:2);
  if(mode==='success'){assert.ok(evidence.bodies.filter((x:any)=>x.round===2).every((x:any)=>x.hasOutput));assert.ok(result.every(x=>x.responses.length===2&&x.responses[1].textObserved));assert.equal(result[0].responses[0].responseId,'resp_aaaaaaaa');}
  if(mode==='second403')assert.ok(result.every(x=>x.http[1].status===403));
  assert.ok(!JSON.stringify(result).includes('PRIVATE'));assert.ok(!JSON.stringify(result).includes(text));
  assert.deepEqual(await(await f.post({approved:true})).json(),result);assert.equal((await(await f.get('/fixture-evidence')).json() as any).bodies.length,evidence.bodies.length);
  assert.equal((await f.mf.dispatchFetch('https://chat.example.test/api/login',{method:'POST',headers:f.headers,body:'{}'})).status,403);
 }finally{await f.dispose();}
});

test('an unexpected third provider fetch is refused; interrupted journals survive reconstruction without replay',async()=>{
 const {runOpenAIChecks,OPENAI_CHECK_MODELS}=await import('../src/openai-compat-check');
 const data=new Map<string,any>();const store=()=>({get:async(k:string)=>structuredClone(data.get(k)),put:async(k:string,v:any)=>{data.set(k,structuredClone(v));}} as any);
 const interrupted={model:OPENAI_CHECK_MODELS[0],status:'running',providerRequests:1,toolCalls:0,http:[],responses:[]};data.set('openai-compat-check:v1:'+OPENAI_CHECK_MODELS[0],interrupted);
 const original=globalThis.fetch;let network=0;
 globalThis.fetch=async()=>{network++;return new Response('ignored');};
 const models={getModel:(_p:string,id:string)=>({id,provider:'openai-codex',api:'openai-codex-responses',baseUrl:'https://chatgpt.com/backend-api'}),streamSimple:(_m:any,_c:any,options:any)=>({async *[Symbol.asyncIterator](){for(let i=0;i<3;i++)await options.fetch('https://chatgpt.com/backend-api/codex/responses',{method:'POST'});},result:async()=>{throw Error('Must not finish three fetches')}})} as any;
 try{
  const first=await runOpenAIChecks(models,{read:async()=>({type:'oauth'})} as any,store(),{approved:true,signal:new AbortController().signal});
  assert.equal(network,2);assert.deepEqual(first[0],interrupted);assert.equal(first[1]!.status,'failed');assert.equal(first[1]!.providerRequests,2);
  assert.deepEqual(await runOpenAIChecks(models,{} as any,store(),{approved:true,signal:new AbortController().signal}),first);assert.equal(network,2);
 }finally{globalThis.fetch=original;}
});
test('unsupported catalog entries, missing approval, or API-key credentials never dispatch',async()=>{
 const {runOpenAIChecks}=await import('../src/openai-compat-check');
 const createStore=()=>{const data=new Map();return {get:async(k:string)=>data.get(k),put:async(k:string,v:any)=>{data.set(k,v)}} as any};
 let calls=0;const models={getModel:(_p:string,id:string)=>({id,provider:'openai-codex',api:'openai-codex-responses',baseUrl:'https://chatgpt.com/backend-api'}),streamSimple:()=>{calls++;throw Error('Must not dispatch')}} as any;
 await assert.rejects(runOpenAIChecks(models,{} as any,createStore(),{approved:false,signal:new AbortController().signal}),/approval/);
 const missing=await runOpenAIChecks(models,{read:async()=>({type:'api_key'})} as any,createStore(),{approved:true,signal:new AbortController().signal});assert.equal(missing[0]!.status,'not_connected');assert.equal(calls,0);
 const unsupported=await runOpenAIChecks({...models,getModel:()=>({provider:'other'})},{} as any,createStore(),{approved:true,signal:new AbortController().signal});assert.ok(unsupported.every(x=>x!.status==='unsupported_model'));assert.equal(calls,0);
});

for(const mode of ['capture-html','capture-json'])test('fresh Sol-only evidence preserves old one-shot results, headers and error text '+mode,async()=>{
 const f=await fixture(mode);try{
  await f.get('/fixture-seed');const old=await(await f.post({approved:true})).json();
  const before=await(await f.get('/fixture-evidence')).json() as any;
  assert.equal((await f.capture({approved:true},{})).status,403);
  assert.equal((await f.capture({approved:true},{...f.headers,origin:'https://evil.example'})).status,403);
  assert.equal((await f.capture({approved:true,model:'gpt-6-luna'})).status,400);
  const response=await f.capture({approved:true});assert.equal(response.status,200);const reports=await response.json() as any[];assert.equal(reports.length,1);const r=reports[0];
  assert.equal(r.model,'gpt-6.1-sol');assert.equal(r.attempt,'failure-v2');assert.equal(r.providerRequests,1);assert.equal(r.toolCalls,0);assert.equal(r.status,'failed');
  assert.equal(r.http[0].cfRay,'a4a13acd98a8f9ce-LAX');assert.equal(r.http[0].requestId,'req_fixture');assert.equal(r.http[0].bodyTruncated,false);
  assert.match(r.http[0].bodyExcerpt,/owner@example.test/);assert.match(r.http[0].bodyExcerpt,/https:\/\/example.test\/help\?case=403/);assert.ok(!JSON.stringify(r).includes('PRIVATE_REFRESH'));assert.ok(!JSON.stringify(r).includes('e30.'));
  assert.ok(r.responses[0].sdkErrorMessage);assert.ok(!r.http[0].bodyExcerpt.includes('[unparseable body'));
  if(mode==='capture-html'){assert.equal(r.http[0].contentType,'text/html; charset=UTF-8');assert.match(r.http[0].bodyExcerpt,/<h1>Unable to load site<\/h1>/);assert.match(r.responses[0].sdkErrorMessage,/Unable to load site/);}
  else{assert.equal(r.http[0].contentType,'application/problem+json; charset=UTF-8');assert.equal(r.http[0].errorCode,'model_access_denied');assert.equal(r.http[0].errorType,'permission_error');assert.match(r.http[0].errorMessage,/Plan denied/);assert.equal(r.http[0].cfMitigated,'challenge');}
  const status=await(await f.get('/api/openai-check/status')).json() as any;assert.deepEqual(status.reports,old);assert.deepEqual(status.failureCaptureReport,r);
  assert.deepEqual(await(await f.capture({approved:true})).json(),reports);const after=await(await f.get('/fixture-evidence')).json() as any;
  assert.equal(after.bodies.length,before.bodies.length+1);assert.equal(after.bodies.at(-1).model,'gpt-6.1-sol');assert.equal(after.credentialsUnchanged,true);assert.equal(after.oauth,0);assert.deepEqual(after.saved.slice(0,2),before.saved);
 }finally{await f.dispose();}
});
test('fresh diagnostic refuses credential refresh instead of modifying auth',async()=>{
 const f=await fixture('expired');try{await f.get('/fixture-seed');const reports=await(await f.capture({approved:true})).json() as any[];assert.equal(reports.length,1);assert.equal(reports[0].status,'failed');assert.equal(reports[0].providerRequests,0);const e=await(await f.get('/fixture-evidence')).json() as any;assert.equal(e.oauth,0);assert.equal(e.credentialsUnchanged,true);assert.equal(e.bodies.length,0);}finally{await f.dispose();}
});
