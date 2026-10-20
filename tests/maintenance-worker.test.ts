import {test} from 'node:test';
import assert from 'node:assert/strict';
import {build} from 'esbuild';
import {Miniflare,convertV4MiniflareOptions} from 'miniflare';
import {generateKeyPair,SignJWT,exportJWK} from 'jose';
import {readFile,mkdtemp,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import path from 'node:path';

async function authentication(){const {privateKey,publicKey}=await generateKeyPair('RS256');return {jwks:{keys:[{...await exportJWK(publicKey),kid:'local'}]},token:await new SignJWT({email:'owner@example.test'}).setProtectedHeader({alg:'RS256',kid:'local'}).setIssuer('https://owner.cloudflareaccess.com').setAudience('app').setSubject('owner').setIssuedAt().setExpirationTime('5m').sign(privateKey)};}
const origin='https://chat.example.test',revision='a'.repeat(40);
async function bundle(mode:string,jwks:unknown,fixture:string){return build({stdin:{contents:`import worker,{Assistant as Original} from '../src/${mode==='frozen'?'maintenance-worker':'index'}.ts';import {BACKGROUND_CONTEXT as context} from '@earendil-works/chord/context';
globalThis.fetch=async input=>{if(String(input)==='https://owner.cloudflareaccess.com/cdn-cgi/access/certs')return Response.json(${JSON.stringify(jwks)});throw Error('No external network allowed')};
export class Assistant extends Original {${fixture}}
export default {async fetch(request,env){const p=new URL(request.url).pathname,stub=env.Assistant.getByName('private-owner-v1');if(p==='/fixture-seed'){await stub.seed();return Response.json(true)}if(p==='/fixture-read')return Response.json(await stub.read());if(p==='/fixture-alarm'){await stub.alarm();return Response.json(true)}if(p==='/fixture-checkpoint'){await stub.checkpoint();return Response.json(true)}return worker.fetch(request,env)}};`,resolveDir:path.resolve('tests'),loader:'ts'},bundle:true,write:false,format:'esm',platform:'browser',target:'es2022',external:['node:*','cloudflare:*'],logLevel:'silent'});}
function options(script:string,mode:string,persist:string){return convertV4MiniflareOptions({cf:false,modules:true,script,compatibilityDate:'2026-10-11',compatibilityFlags:['nodejs_compat'],durableObjects:{Assistant:{className:'Assistant',useSQLite:true}},resourcePersistencePath:persist,bindings:{ACCESS_TEAM_DOMAIN:'https://owner.cloudflareaccess.com',ACCESS_AUD:'app',OWNER_EMAILS:'owner@example.test',APP_ORIGIN:origin,ENABLE_MODEL:'false',ENABLE_SUBSCRIPTION_LOGIN:'false',CREDENTIAL_ENCRYPTION_KEY:Buffer.alloc(32,42).toString('base64'),MAINTENANCE_MODE:mode,SOURCE_REVISION:revision,WORKER_VERSION:{id:'test-version'}},outboundService:()=>{throw Error('No external network allowed')}});}
const sentinel=`await this.ctx.storage.put('runner-round:v1:preserved',{digest:'reserved-before-dispatch'});await this.ctx.storage.put('admission:1:preserved',{receipt:'accepted-id'});`;
const read=`async read(){return {tasks:this.ctx.storage.sql.exec('SELECT record FROM pi_tasks ORDER BY id').toArray(),entries:this.ctx.storage.sql.exec('SELECT record FROM pi_entries ORDER BY id').toArray(),receipts:this.ctx.storage.sql.exec('SELECT record FROM pi_submissions ORDER BY id').toArray(),fence:await this.ctx.storage.get('runner-round:v1:preserved'),receipt:await this.ctx.storage.get('admission:1:preserved')}}`;

test('frozen production entrypoint contains no Pi/Agents engine or credential/provider code',async()=>{
 const built=await build({entryPoints:['src/maintenance-worker.ts'],define:{PI_DEPLOYMENT_MODE:JSON.stringify('frozen:revision-bound')},bundle:true,write:false,metafile:true,format:'esm',platform:'browser',external:['node:*','cloudflare:*'],logLevel:'silent'});
 assert.ok(built.outputFiles[0].text.includes('frozen:revision-bound'),'frozen artifact retains the revision marker so code updates refresh DO bindings');
 assert.deepEqual(Object.keys(built.metafile!.inputs).filter(p=>/node_modules\/(?:agents|@earendil-works)|src\/(?:credentials|provider-sessions|model-runner)/.test(p)),[]);
});
test('actual frozen Worker auth, alarm/restart and stale requests never migrate/resume the real Pi 1.1 crash image',{timeout:30000},async()=>{
 const auth=await authentication(),dir=await mkdtemp(path.join(tmpdir(),'pi-maint-frozen-'));
 const image=JSON.parse(await readFile(new URL('./fixtures/pi-1.1-storage.json',import.meta.url),'utf8'));
 const fixture=`async seed(){const image=${JSON.stringify(image)};for(const t of image.tables){const name='pi_'+t.name;this.ctx.storage.sql.exec(t.sql.replace('CREATE TABLE '+t.name,'CREATE TABLE '+name));for(const row of t.rows){const keys=Object.keys(row);this.ctx.storage.sql.exec('INSERT INTO '+name+' ('+keys.join(',')+') VALUES ('+keys.map(()=>'?').join(',')+')',...Object.values(row));}}${sentinel}}${read}`;
 const built=await bundle('frozen',auth.jwks,fixture),opts=options(built.outputFiles[0].text,'frozen',dir);let mf=new Miniflare(opts);
 const headers={'Cf-Access-Jwt-Assertion':auth.token,origin,'Content-Type':'application/json'};
 const call=(p:string,body?:any)=>mf.dispatchFetch(origin+p,{headers,...(body?{method:'POST',body:JSON.stringify(body)}:{})});
 try{
  {const seeded=await call('/fixture-seed');assert.equal(seeded.status,200,await seeded.text());}const readResponse=await call('/fixture-read');assert.equal(readResponse.status,200,await readResponse.clone().text());const before=await readResponse.json();assert.equal((await mf.dispatchFetch(origin+'/api/maintenance')).status,403);
  assert.equal((await mf.dispatchFetch(origin+'/api/maintenance',{method:'POST',headers:{...headers,origin:'https://other.test'},body:'{"action":"pause","operationId":"window-1"}'})).status,403);
  const pause=await call('/api/maintenance',{action:'pause',operationId:'window-1'});assert.equal(pause.status,200);const report=await pause.json() as any;assert.ok(report.pi.activities.length);assert.ok(report.pi.pending.length);assert.equal(report.phase,'paused');
  for(const p of ['/api/submit','/api/abort','/api/sessions','/api/events'])assert.equal((await call(p,{text:'stale UI',operationId:'preserved'})).status,423);
  assert.equal((await call('/api/maintenance',{action:'stop'})).status,409);assert.equal((await call('/api/maintenance',{action:'checkpoint',epoch:'window-1'})).status,409);
  await(await call('/fixture-alarm')).text();await mf.dispose();mf=new Miniflare(opts);
  assert.equal((await call('/api/sessions')).status,423);assert.equal((await(await call('/api/maintenance')).json() as any).phase,'paused');
  assert.deepEqual(await(await call('/fixture-read')).json(),before,'no migration, task rewrite, dispatch fence or receipt mutation');
 }finally{await mf.dispose();await rm(dir,{recursive:true,force:true});}
});
test('actual active Assistant stays paused across lifecycle/alarm/restart and validates idle history before explicit resume',{timeout:30000},async()=>{
 const auth=await authentication(),dir=await mkdtemp(path.join(tmpdir(),'pi-maint-active-'));
 const fixture=`async seed(){await this.ctx.storage.put('maintenance:v1',{version:1,epoch:'fixture-active',phase:'active',checkpoint:{revision:'a'.repeat(40)}});const root=await(await this.harness.pi()).root(context);await(await root.submit({type:'write',requestId:'saved-history',entry:{kind:'pi.user',model:[{role:'user',content:'Retained history',timestamp:1}]}},context)).wait(context);${sentinel}}${read}
 async checkpoint(){const r=await this.maintenance.report(),s=await this.maintenance.state();const c={id:'test-native-stub',revision:r.revision,bookmark:'STUB-NOT-PRODUCTION-PITR',capturedAt:Date.now(),history:r.pi.history,workspaces:[]};await this.ctx.storage.put('maintenance-checkpoint:v1:'+c.id,c);await this.ctx.storage.put('maintenance:v1',{...s,checkpoint:c});}`;
 const built=await bundle('active',auth.jwks,fixture),opts=options(built.outputFiles[0].text,'active',dir);let mf=new Miniflare(opts);
 const headers={'Cf-Access-Jwt-Assertion':auth.token,origin,'Content-Type':'application/json'},call=(p:string,body?:any)=>mf.dispatchFetch(origin+p,{headers,...(body?{method:'POST',body:JSON.stringify(body)}:{})});
 try{
  assert.equal((await call('/api/sessions')).status,423,'initial startup cannot open Pi');{const seeded=await call('/fixture-seed');assert.equal(seeded.status,200,await seeded.text());}const readResponse=await call('/fixture-read');assert.equal(readResponse.status,200,await readResponse.clone().text());const before=await readResponse.json();
  assert.equal((await call('/api/maintenance',{action:'pause',operationId:'window-active-1'})).status,200);assert.equal((await call('/api/sessions')).status,423);
  await(await call('/fixture-alarm')).text();await(await call('/fixture-checkpoint')).text();await mf.dispose();mf=new Miniflare(opts);
  assert.equal((await call('/api/sessions')).status,423);assert.deepEqual(await(await call('/fixture-read')).json(),before);
  const stale=await call('/api/maintenance',{action:'resume',epoch:'window-active-1',checkpointId:'test-native-stub',workerVersion:'stale'});assert.equal(stale.status,409);
  const resumed=await call('/api/maintenance',{action:'resume',epoch:'window-active-1',checkpointId:'test-native-stub',workerVersion:'test-version'});assert.equal(resumed.status,200,await resumed.clone().text());assert.equal((await resumed.json() as any).phase,'active');
  assert.equal((await call('/api/sessions')).status,200);assert.deepEqual(await(await call('/fixture-read')).json(),before,'read-only activation preserves history, tasks, request receipts and dispatch reservations');
 }finally{await mf.dispose();await rm(dir,{recursive:true,force:true});}
});
