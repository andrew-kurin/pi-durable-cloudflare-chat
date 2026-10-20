import assert from 'node:assert/strict';
import {build} from 'esbuild';
import {Miniflare,convertV4MiniflareOptions} from 'miniflare';
import {generateKeyPair,SignJWT,exportJWK} from 'jose';
import path from 'node:path';
// Actual signed-owner HTTP admission/submit routes and SQLite storage. Chat/provider
// eligibility and downstream submit/abort/control effects are simulated. This
// fixture does NOT prove SDK deduplication or production latency.
export async function fixture() {
 const origin='https://chat.example.test', {privateKey,publicKey}=await generateKeyPair('RS256');
 const jwks={keys:[{...await exportJWK(publicKey),kid:'local'}]};
 const token=await new SignJWT({email:'owner@example.test'}).setProtectedHeader({alg:'RS256',kid:'local'}).setIssuer('https://owner.cloudflareaccess.com').setAudience('app').setSubject('owner').setIssuedAt().setExpirationTime('10m').sign(privateKey);
 const source=`import worker,{Assistant as Original} from '../src/index.ts';import {RequestError} from '../src/http-input.ts';
 globalThis.fetch=async input=>{if(String(input)==='https://owner.cloudflareaccess.com/cdn-cgi/access/certs')return Response.json(${JSON.stringify(jwks)});throw Error('No external provider network')};
 export class Assistant extends Original {
  trace=[];mode={};waiters=new Map();releases=new Map();
  signal(name){this.trace.push(name);this.waiters.get(name)?.();}
  async wait(name){if(this.trace.includes(name))return;await new Promise(resolve=>this.waiters.set(name,resolve));}
  async configure(mode){this.mode=mode;this.trace=[];const put=this.ctx.storage.put.bind(this.ctx.storage);
   if(!this.installed){this.installed=true;this.originalPut=put;const transaction=this.ctx.storage.transaction.bind(this.ctx.storage);this.ctx.storage.transaction=work=>transaction(async tx=>{const txPut=tx.put.bind(tx);tx.put=async(key,value)=>{if(this.mode.failReservation&&String(key).startsWith('admission:')){this.mode.failReservation=false;throw Error('Synthetic reservation write failure');}return txPut(key,value);};return work(tx);});this.ctx.storage.put=async(key,value)=>{if(this.mode.failReceipt&&String(key).startsWith('admission:')&&value.receipt){this.mode.failReceipt=false;throw Error('Synthetic receipt write failure');}return put(key,value);};
    this.providers.assertCanSubmit=async()=>{if(this.mode.blockedProvider)throw new RequestError(503,'Synthetic provider disabled');};
    this.harness.sessions.list=async()=>[{id:'1',busy:!!this.mode.busy},{id:'2',busy:false}];
    this.chatCatalog.list=async()=>[{id:'1',title:'First'},{id:'2',title:'Second'}];
    this.chatCatalog.requireActive=async id=>{if(!['1','2'].includes(id))throw new RequestError(404,'Conversation not found');};
    this.harness.submit=async(text,options)=>{this.dispatches=(this.dispatches||0)+1;this.reservedAtDispatch=await this.ctx.storage.get('admission:'+options.session+':'+options.operationId);
     if(this.mode.hold==='submit')await new Promise(resolve=>{this.releases.set('submit',resolve);this.signal('submit:entered');});else this.signal('submit:entered');
     if(this.mode.failBefore){this.mode.failBefore=false;throw Error('Synthetic before SDK acceptance');}
     const key='fixture-sdk:'+options.session+':'+options.operationId;const prior=await this.ctx.storage.get(key);const receipt={operationId:options.operationId,session:options.session,accepted:!prior};
     if(!prior){await put(key,receipt);await put('fixture-effects',((await this.ctx.storage.get('fixture-effects'))||0)+1);}
     if(this.mode.hold==='accepted')await new Promise(resolve=>{this.releases.set('accepted',resolve);this.signal('accepted:entered');});
     if(this.mode.failAfter){this.mode.failAfter=false;throw Error('Synthetic lost SDK response');}
     this.signal('submit:returned');return receipt;
    };
    this.harness.abort=async({session,operationId})=>{this.signal('abort:called');this.signal('abort:'+session+':'+(operationId||'session'));if(!operationId&&this.mode.hold==='abort')await new Promise(resolve=>{this.releases.set('abort',resolve);this.signal('abort:entered');});this.signal('abort:finished');return session==='1';};
    const rename=this.chatCatalog.rename.bind(this.chatCatalog);this.chatCatalog.rename=async(id,title)=>{this.signal('rename:entered');if(this.mode.hold==='rename')await new Promise(resolve=>this.releases.set('rename',resolve));this.signal('rename:returned');if(this.mode.failRename)throw Error('Synthetic rename failure');return rename(id,title);};
    const autoTitle=this.chatCatalog.autoTitle.bind(this.chatCatalog);this.chatCatalog.autoTitle=async(...args)=>{if(this.mode.failAutoTitle){if(this.mode.failAutoTitle!=='always')this.mode.failAutoTitle=false;throw Error('Synthetic auto-title failure');}return autoTitle(...args);};
    this.history.close=async()=>{this.signal('close:called');return Response.json({closed:true});};
    this.workspaces.enabled=()=>true;this.workspaces.ownerAction=async(session)=>{await put('workspace-auto-stop:'+session,{epoch:crypto.randomUUID(),blocked:true});this.signal('workspace:called');return {phase:'stopping'};};
   }
  }
  async fetch(request){const path=new URL(request.url).pathname;if(path==='/api/abort')this.signal('abort:arrived');if(path==='/api/submit')this.signal('submit-request:'+ (this.submitRequests=(this.submitRequests||0)+1));return super.fetch(request);}
  async release(name){this.releases.get(name)?.();}
  async quota(count,day){await this.originalPut('quota',{day:day||new Date().toISOString().slice(0,10),count});}
  async evidence(sid,op){return {workspaceIntent:await this.ctx.storage.get('workspace-auto-stop:'+sid),trace:this.trace,quota:await this.ctx.storage.get('quota'),admission:await this.ctx.storage.get('admission:'+sid+':'+op),effects:(await this.ctx.storage.get('fixture-effects'))||0,dispatches:this.dispatches||0,reservedAtDispatch:this.reservedAtDispatch,title:await this.ctx.storage.get('chat-auto-title:'+sid),manualTitle:await this.ctx.storage.get('chat-title:'+sid)};}
 }
 export default {async fetch(request,env){const u=new URL(request.url),stub=env.Assistant.getByName('private-owner-v1');if(u.pathname==='/fixture/config'){await stub.configure(await request.json());return Response.json({ok:true});}if(u.pathname==='/fixture/wait'){await stub.wait(u.searchParams.get('name'));return Response.json({ok:true});}if(u.pathname==='/fixture/release'){await stub.release(u.searchParams.get('name'));return Response.json({ok:true});}if(u.pathname==='/fixture/quota'){await stub.quota(Number(u.searchParams.get('count')),u.searchParams.get('day'));return Response.json({ok:true});}if(u.pathname==='/fixture/evidence')return Response.json(await stub.evidence(u.searchParams.get('session')||'1',u.searchParams.get('op')));return worker.fetch(request,env);}};`;
 const bundle=await build({stdin:{contents:source,resolveDir:path.resolve('tests'),loader:'ts'},bundle:true,write:false,format:'esm',platform:'browser',target:'es2022',external:['node:*','cloudflare:*'],logLevel:'silent'});
 let outbound=0;
 const mf=new Miniflare(convertV4MiniflareOptions({cf:false,modules:true,script:bundle.outputFiles[0].text,compatibilityDate:'2026-10-11',compatibilityFlags:['nodejs_compat'],durableObjects:{Assistant:{className:'Assistant',useSQLite:true}},bindings:{ACCESS_TEAM_DOMAIN:'https://owner.cloudflareaccess.com',ACCESS_AUD:'app',OWNER_EMAILS:'owner@example.test',APP_ORIGIN:origin,ENABLE_MODEL:'false',ENABLE_SUBSCRIPTION_LOGIN:'false',CREDENTIAL_ENCRYPTION_KEY:Buffer.alloc(32,42).toString('base64')},outboundService:async(request:any)=>{outbound++;assert.equal(request.url,'https://owner.cloudflareaccess.com/cdn-cgi/access/certs');return Response.json(jwks);}}));
 const headers={'Cf-Access-Jwt-Assertion':token,origin,'Content-Type':'application/json'};
 const post=(url:string,body:any)=>mf.dispatchFetch(origin+url,{method:'POST',headers,body:JSON.stringify(body),signal:AbortSignal.timeout(5000)});
 const control=async(url:string,body?:any)=>{const response=body===undefined?await mf.dispatchFetch(origin+'/fixture/'+url,{signal:AbortSignal.timeout(5000)}):await post('/fixture/'+url,body);assert.equal(response.status,200);return response.json() as Promise<any>;};
 const submit=(operationId:string,text='Hello',session='1')=>post('/api/submit?session='+session,{operationId,text});
 await control('config',{});
 return {post,control,submit,browserFetch:(url:string,init:any={})=>mf.dispatchFetch(origin+url,{...init,headers:{...headers,...init.headers}}),unauthorized:()=>mf.dispatchFetch(origin+'/api/abort?session=1',{method:'POST',headers:{origin,'Content-Type':'application/json'},body:'{}'}),dispose:async()=>{assert.ok(outbound<=1,'Only generated JWKS is allowed; no provider requests');await mf.dispose();}};
}
