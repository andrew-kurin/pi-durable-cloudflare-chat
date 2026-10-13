import {test} from 'node:test';import assert from 'node:assert/strict';import {build} from 'esbuild';import {Miniflare,convertV4MiniflareOptions} from 'miniflare';import {generateKeyPair,SignJWT,exportJWK} from 'jose';import path from 'node:path';import {JSDOM} from 'jsdom';
test('shell staging bundle has no Assistant, credential storage or provider implementation',async()=>{
 const result=await build({entryPoints:['src/workspace-smoke.ts'],bundle:true,write:false,metafile:true,format:'esm',platform:'browser',target:'es2022',external:['node:*','cloudflare:*'],logLevel:'silent'});
 const inputs=Object.keys(result.metafile!.inputs);
 for(const forbidden of ['src/index.ts','src/credentials.ts','src/oauth-loader.ts','src/model-guard.ts'])assert.ok(!inputs.includes(forbidden),forbidden);
 assert.ok(!inputs.some(input=>input.includes('@earendil-works/')||input.includes('agents/')));
 assert.ok(!result.outputFiles[0].text.includes('CREDENTIAL_ENCRYPTION_KEY'));
});
test('owner-only shell staging runs fixed smoke through the actual controller without a credential secret',async()=>{
 const {privateKey,publicKey}=await generateKeyPair('RS256'),jwks={keys:[{...await exportJWK(publicKey),kid:'local'}]};
 const signed=async(email='owner@example.test',aud='app')=>new SignJWT({email}).setProtectedHeader({alg:'RS256',kid:'local'}).setIssuer('https://owner.cloudflareaccess.com').setAudience(aud).setSubject(email).setIssuedAt().setExpirationTime('5m').sign(privateKey);
 const contents=`import worker from '../src/workspace-smoke.ts';import {WorkspaceController} from '../src/workspace.ts';import {DurableObject} from 'cloudflare:workers';
 export class MockWorkspace extends DurableObject {files=new Map();runs=new Map();stopped=false;controller;
 constructor(ctx,env){super(ctx,env);const adapter={open:async()=> 'a'.repeat(40),keepAlive:async()=>{},read:async p=>this.files.get(p),edit:async(p,oldText,newText)=>{const prior=this.files.get(p);if(oldText===''){if(prior!==undefined)throw Error('Exists');this.files.set(p,newText)}else{if(!prior?.includes(oldText))throw Error('Match');this.files.set(p,prior.replace(oldText,newText));}},dispatch:async(id,argv)=>{this.runs.set(id,{state:argv[0]==='sh'?'running':'exited',exitCode:argv[0]==='sh'?undefined:0})},status:async id=>this.runs.get(id),logs:async(id,stream)=>stream==='stdout'?'PASS native shell smoke':'stderr captured',terminate:async id=>this.runs.set(id,{state:'exited',exitCode:143}),collect:async base=>({base,patch:'new file .pi-cloudflare-native-smoke.txt',logs:{stdout:'PASS native shell smoke'},gaps:[]}),stop:async()=>{this.stopped=true}};
 this.controller=new WorkspaceController(ctx.storage,adapter,{taskMs:720000,commandMs:600000,idleMs:60000,warningMs:60000,graceMs:1,artifactMs:20000,operationMs:30000,setupMs:300000});}
 nativeState(){return {configured:true,running:!this.stopped,checkedAt:Date.now()}}
 open(...args){return this.controller.open(...args)} async request(r){if(r.action==='status')await this.controller.tick();const result=await this.controller.request(r);return {...result,syntheticGuestStopped:this.stopped};}artifact(){return this.controller.artifact()}alarm(){return this.controller.tick()}}
 globalThis.fetch=async input=>{if(String(input)==='https://owner.cloudflareaccess.com/cdn-cgi/access/certs')return Response.json(${JSON.stringify(jwks)});throw Error('No external test network')};export default worker;`;
 const bundle=await build({stdin:{contents,resolveDir:path.resolve('tests'),loader:'ts'},bundle:true,write:false,format:'esm',platform:'browser',target:'es2022',external:['node:*','cloudflare:*'],logLevel:'silent'});
 const base='https://pi-private-chat-workspace-staging.synthetic.workers.dev';
 const mf=new Miniflare(convertV4MiniflareOptions({cf:false,modules:true,script:bundle.outputFiles[0].text,compatibilityDate:'2026-10-11',compatibilityFlags:['nodejs_compat'],durableObjects:{Workspaces:{className:'MockWorkspace',useSQLite:true}},bindings:{ACCESS_TEAM_DOMAIN:'https://owner.cloudflareaccess.com',ACCESS_AUD:'app',OWNER_EMAILS:'owner@example.test',APP_ORIGIN:base,ENABLE_WORKSPACE:'true',WORKSPACE_IMAGE:'workspace',WORKSPACE_REPOSITORY:'owner/project'}}));
 const headers={'Cf-Access-Jwt-Assertion':await signed(),origin:base,'Content-Type':'application/json'};
 const action=(action:string,extra={})=>mf.dispatchFetch(base+'/api/smoke',{method:'POST',headers,body:JSON.stringify({action,...extra})});
 try{
  for(const route of ['/','/smoke.js','/api/smoke/status','/api/smoke/artifact'])assert.equal((await mf.dispatchFetch(base+route)).status,403);
  for(const token of ['forged',await signed('other@example.test'),await signed('owner@example.test','other')])assert.equal((await mf.dispatchFetch(base+'/',{headers:{...headers,'Cf-Access-Jwt-Assertion':token}})).status,403);
  assert.equal((await mf.dispatchFetch(base+'/api/smoke',{method:'POST',headers:{...headers,origin:'https://other.example.test'},body:'{"action":"open"}'})).status,403);
  assert.equal((await mf.dispatchFetch('https://other.example.test/',{headers})).status,403);
  const page=await mf.dispatchFetch(base+'/',{headers});assert.equal(page.status,200);assert.match(await page.text(),/Run fixed smoke/);assert.equal(page.headers.get('Cache-Control'),'no-store');
  const client=await (await mf.dispatchFetch(base+'/smoke.js',{headers})).text();
  const dom=new JSDOM('<button id="run"></button><button id="cancel"></button><button id="status"></button><pre id="result"></pre>',{url:base,runScripts:'outside-only'});
  const actions:string[]=[];let last='',captureIncomplete=false;
  (dom.window as any).fetch=async(url:string,init:any)=>{
   if(init){last=JSON.parse(init.body).action;actions.push(last);return Response.json(last==='read'?{text:'native staging edited\n'}:{phase:'ready'});}
   if(url.endsWith('/logs'))return Response.json({stdout:{text:'PASS native shell smoke'},stderr:{text:'stderr captured'}});
   if(url.endsWith('/artifact'))return Response.json({patch:'.pi-cloudflare-native-smoke.txt native staging edited'});
   return Response.json({phase:last==='cancel'?'closed':'ready',native:{configured:true,running:last!=='cancel'},runs:{run:{command:'node',state:'done',exitCode:0}},gaps:captureIncomplete?['Final patch/log capture incomplete. Available prior artifacts remain saved.']:[]});
  };
  try{dom.window.eval(client);await (dom.window.document.querySelector('#run') as any).onclick();assert.deepEqual(actions,['open','create','edit','read','run','export','slow','cancel']);assert.match(dom.window.document.querySelector('#result')!.textContent!,/container reports not running/);captureIncomplete=true;await (dom.window.document.querySelector('#run') as any).onclick();assert.match(dom.window.document.querySelector('#result')!.textContent!,/Native cleanup or artifacts not confirmed/);assert.doesNotMatch(dom.window.document.querySelector('#result')!.textContent!,/^PASS/);}finally{dom.window.close()}
  for(const route of ['/api/login','/api/submit','/api/sessions'])assert.equal((await mf.dispatchFetch(base+route,{headers})).status,404);
  for(const input of [['exec',{}],['run',{argv:['curl','https://example.test']}],['extend',{}],['open',{workspaceId:'other'}]])assert.equal((await action(input[0] as string,input[1])).status,400);
  assert.equal((await mf.dispatchFetch(base+'/api/smoke',{method:'POST',headers,body:'{bad'})).status,400);
  const opened=await action('open');assert.equal(opened.status,200);const openedState=await opened.json() as any;assert.equal(openedState.phase,'ready');assert.equal(openedState.id,'00000000-0000-4000-8000-000000000002');assert.equal(openedState.session,'native-shell-smoke-v2');
  for(const step of ['create','edit'])assert.equal((await action(step)).status,200);
  assert.equal((await (await action('read')).json() as any).text,'native staging edited\n');
  const run=await action('run');assert.equal(run.status,200);
  const done=await mf.dispatchFetch(base+'/api/smoke/status',{headers}),state=await done.json() as any;assert.equal(Object.values(state.runs).length,1);assert.equal((Object.values(state.runs)[0] as any).exitCode,0);
  const replay=await action('run');assert.equal(Object.values((await replay.json() as any).runs).length,1,'Retry must not create another command');
  const logs=await mf.dispatchFetch(base+'/api/smoke/logs',{headers});assert.match((await logs.json() as any).stdout.text,/PASS native shell smoke/);
  assert.equal((await action('export')).status,200);const artifact=await mf.dispatchFetch(base+'/api/smoke/artifact',{headers});assert.match((await artifact.json() as any).patch,/pi-cloudflare-native-smoke/);assert.match(artifact.headers.get('Content-Disposition')!,/attachment/);
  assert.equal((await action('slow')).status,200);assert.equal((await action('cancel')).status,200);
  let closed:any;for(let i=0;i<10;i++){closed=await (await mf.dispatchFetch(base+'/api/smoke/status',{headers})).json();if(closed.phase==='closed')break;await new Promise(r=>setTimeout(r,5));}
  assert.equal(closed.phase,'closed');assert.equal(closed.syntheticGuestStopped,true);
  assert.equal((await (await action('open')).json() as any).phase,'closed','Closed one-shot smoke must not recreate a guest');
 }finally{await mf.dispose()}
});
