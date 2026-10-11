import { DurableObject } from 'cloudflare:workers';
import { PiHarness } from 'agents/harness/pi';
import { Lifecycle } from 'agents/lifecycle';
import { createModels } from '@earendil-works/pi-ai/models';
import { createWorkerCodexProvider } from './oauth-loader';
import { createRegistry, Harness } from '@earendil-works/pi-durable';
import { authorize, secured, type AccessConfig } from './auth';
import { ChatProjection } from './projector';
import { guardModels } from './model-guard';
import { delegation } from './delegate';
import { createCredentialStore, startSubscriptionLogin, type SubscriptionLoginStatus } from './credentials';
interface Env extends AccessConfig { ASSETS: Fetcher; Assistant: DurableObjectNamespace<Assistant>; CREDENTIAL_ENCRYPTION_KEY: string; ENABLE_MODEL: string; ENABLE_SUBSCRIPTION_LOGIN: string }
export class Assistant extends DurableObject<Env> {
 private credentials = createCredentialStore(this.ctx.storage,this.env.CREDENTIAL_ENCRYPTION_KEY);
 private models = guardModels(createModels({credentials:this.credentials,authContext:{env:async()=>undefined,fileExists:async()=>false}}),async()=>{if(this.env.ENABLE_MODEL!=='true')throw new Error('Model disabled');await this.ctx.storage.transaction(async tx=>{const day=new Date().toISOString().slice(0,10);const count=await tx.get<{day:string,count:number}>('model-quota');const used=count?.day===day?count.count:0;if(used>=150)throw new Error('Daily model request limit');await tx.put('model-quota',{day,count:used+1});});});
 private loginStatus: SubscriptionLoginStatus = {status:'disabled'};
 private loginActive = false;
 private activeStreams = 0;
 private admission: Promise<unknown> = Promise.resolve();
 harness = new PiHarness({harness:({storage,context})=>{const registry=createRegistry();registry.install(delegation());const provider=createWorkerCodexProvider();this.models.setProvider(provider);return Harness.open(storage,{models:this.models,registry,settings:{compaction:{enabled:false},progress:{partialIntervalMs:250,outputIntervalMs:500},retry:{enabled:true,maxRetries:1,baseDelayMs:1000},stream:{transport:'sse',timeoutMs:120000,maxRetries:0}}},context);},defaults:{model:{provider:'openai-codex',id:'gpt-6-sol'},thinkingLevel:'low'}});
 lifecycle = Lifecycle.install(this).use(this.harness);
 async fetch(request:Request):Promise<Response>{
  try{await authorize(request,this.env);}catch{return new Response('Forbidden',{status:403});}
  if(request.method==='POST'){const work=this.admission.then(()=>this.handle(request));this.admission=work.then(()=>undefined,()=>undefined);return work;}
  return this.handle(request);
 }
 private async handle(request:Request):Promise<Response>{
  const url=new URL(request.url);const path=url.pathname;const sid=url.searchParams.get('session')??'1';
  if(!/^\d{1,12}$/.test(sid))return Response.json({error:'Invalid session'},{status:400});
  try{
   if(path==='/api/status'&&request.method==='GET')return Response.json({modelEnabled:this.env.ENABLE_MODEL==='true',canLogin:this.env.ENABLE_SUBSCRIPTION_LOGIN==='true',connected:(await this.credentials.list()).some(x=>x.providerId==='openai-codex'),login:this.loginStatus});
   if(path==='/api/login'&&request.method==='POST'){
    if(this.env.ENABLE_SUBSCRIPTION_LOGIN!=='true')return Response.json({error:'Subscription setup is not enabled'},{status:403});
    if((await this.credentials.list()).some(x=>x.providerId==='openai-codex'))return Response.json({error:'Subscription is already connected.'},{status:409});
    if(this.loginActive)return Response.json(this.loginStatus);
    await this.harness.pi();this.loginActive=true;
    const abort=new AbortController();const timer=setTimeout(()=>abort.abort(),5*60*1000);
    request.signal.addEventListener('abort',()=>abort.abort(),{once:true});
    const body=new ReadableStream<Uint8Array>({start:controller=>{
     const job=startSubscriptionLogin(this.models,this.ctx.storage,s=>{this.loginStatus=s;try{controller.enqueue(new TextEncoder().encode(JSON.stringify(s)+'\n'));}catch{abort.abort();}},{enabled:true,runtimeSupported:true,signal:abort.signal}).finally(()=>{clearTimeout(timer);this.loginActive=false;try{controller.close();}catch{}});
     this.ctx.waitUntil(job);
    },cancel:()=>{abort.abort();}});
    return new Response(body,{headers:{'Content-Type':'application/x-ndjson','Cache-Control':'no-store'}});
   }
   if(path==='/api/sessions'&&request.method==='GET')return Response.json((await this.harness.sessions.list()).filter(x=>!x.parent));
   if(path==='/api/sessions'&&request.method==='POST'){
    if((await this.harness.sessions.list()).length>=100)return Response.json({error:'Session limit reached'},{status:429});
    const s=await this.harness.sessions.create();return Response.json({id:s.id});
   }
   if(path==='/api/submit'&&request.method==='POST'){
    if(this.env.ENABLE_MODEL!=='true')return Response.json({error:'Model access is not enabled yet'},{status:503});
    if(!(await this.credentials.list()).some(x=>x.providerId==='openai-codex'))return Response.json({error:'Connect your subscription first'},{status:503});
    const raw=await request.text();if(raw.length>20000)return Response.json({error:'Message too long'},{status:413});
    const b=JSON.parse(raw);if(typeof b.text!=='string'||!b.text.trim()||b.text.length>12000||typeof b.operationId!=='string'||!/^[-a-zA-Z0-9]{8,80}$/.test(b.operationId))return Response.json({error:'Invalid message'},{status:400});
    const key=`admission:${sid}:${b.operationId}`;
    const digest=Array.from(new Uint8Array(await crypto.subtle.digest('SHA-256',new TextEncoder().encode(b.text)))).map(x=>x.toString(16).padStart(2,'0')).join('');
    const prior=await this.ctx.storage.get<{digest:string,receipt?:unknown}>(key);
    if(prior&&prior.digest!==digest)return Response.json({error:'Operation ID already used'},{status:409});
    if(prior?.receipt)return Response.json(prior.receipt);
    if(!prior){
     if((await this.harness.sessions.list()).some(s=>s.busy))return Response.json({error:'Wait for the current request to finish'},{status:409});
     const reserved=await this.ctx.storage.transaction(async tx=>{
      const today=new Date().toISOString().slice(0,10);const daily=await tx.get<{day:string,count:number}>('quota');const count=daily?.day===today?daily.count:0;
      if(count>=50)return false;await tx.put('quota',{day:today,count:count+1});await tx.put(key,{digest});return true;
     });
     if(!reserved)return Response.json({error:'Daily limit of 50 messages reached'},{status:429});
    }
    const receipt=await this.harness.submit(b.text,{session:sid,operationId:b.operationId});await this.ctx.storage.put(key,{digest,receipt});return Response.json(receipt);
   }
   if(path==='/api/abort'&&request.method==='POST')return Response.json({aborted:await this.harness.abort({session:sid})});
   if(path==='/api/events'&&request.method==='GET'){
    if(this.activeStreams>=3)return Response.json({error:'Too many open chats'},{status:429});
    this.activeStreams++;let events;try{events=await this.harness.session(sid).events();}catch(error){this.activeStreams--;throw error;}const projection=new ChatProjection();projection.apply(events.snapshot);
    const encoder=new TextEncoder();let ended=false;let timer:ReturnType<typeof setTimeout>;
    const stop=async()=>{if(ended)return;ended=true;clearTimeout(timer);this.activeStreams--;await events.stop();};
    const body=new ReadableStream<Uint8Array>({start:controller=>{
     const send=()=>{if(!ended)controller.enqueue(encoder.encode(`data: ${JSON.stringify(projection.view())}\n\n`));};send();
     events.start(async batch=>{batch.forEach(e=>projection.apply(e));send();});
     timer=setTimeout(()=>{if(!ended){controller.close();void stop();}},55000);
     request.signal.addEventListener('abort',()=>{void stop();},{once:true});
    },cancel:()=>stop()});
    return new Response(body,{headers:{'Content-Type':'text/event-stream','Cache-Control':'no-store'}});
   }
   return Response.json({error:'Not found'},{status:404});
  }catch{return Response.json({error:'Request unavailable. Your saved chat is unchanged.'},{status:500});}
 }
}
export default {async fetch(request:Request,env:Env):Promise<Response>{
 try{await authorize(request,env);}catch{return secured(new Response('Private chat. Cloudflare Access sign-in and owner configuration are required.',{status:403}));}
 const url=new URL(request.url);
 if(url.pathname.startsWith('/api/')){try{return secured(await env.Assistant.getByName('private-owner-v1').fetch(request));}catch{return secured(Response.json({error:'Private chat configuration is incomplete.'},{status:503}));}}
 if(!['GET','HEAD'].includes(request.method))return secured(new Response('Method not allowed',{status:405}));
 return secured(await env.ASSETS.fetch(request));
}};
