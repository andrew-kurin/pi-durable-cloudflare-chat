import {xaiProvider} from '@earendil-works/pi-ai/providers/xai';
import {xaiOAuth} from '../node_modules/@earendil-works/pi-ai/dist/auth/oauth/xai.js';
import {Type,type Models,type CredentialStore,type Message,type AssistantMessage} from '@earendil-works/pi-ai';
import type {CredentialStorage} from './credentials';

/** Explicit bundle of the pinned device flow. This provider has no API-key fallback. */
export function createWorkerGrokProvider(){const provider=xaiProvider();return {...provider,auth:{oauth:xaiOAuth}};}
/** Static pinned catalog, not an entitlement claim; no network discovery is performed. */
export function grokCatalog(){return createWorkerGrokProvider().getModels().map(model=>({id:model.id,api:model.api}));}
export type GrokLoginStatus={status:'disabled'|'starting'|'connected'|'cancelled'|'failed'|'busy'}|{status:'device_code';userCode:string;verificationUri:string};
const active=new WeakSet<CredentialStorage>();
function verificationUri(raw:string){const uri=new URL(raw);if(!['https://auth.x.ai','https://accounts.x.ai'].includes(uri.origin)||uri.username||uri.password||uri.hash||uri.href.length>1500)throw Error('Unexpected xAI verification destination');for(const key of uri.searchParams.keys())if(/token|device_code|secret|credential/i.test(key))throw Error('Unexpected verification data');return uri.href;}
/** Call only behind existing owner Access+CSRF checks and explicit connection approval. */
export async function startGrokSubscriptionLogin(models:Pick<Models,'login'>,storage:CredentialStorage,notify:(status:GrokLoginStatus)=>void,options:{enabled?:boolean;signal?:AbortSignal}={}):Promise<GrokLoginStatus>{
 const emit=(status:GrokLoginStatus)=>{notify(status);return status;};if(options.enabled!==true)return emit({status:'disabled'});if(active.has(storage))return emit({status:'busy'});active.add(storage);
 const controller=new AbortController(),abort=()=>controller.abort();options.signal?.addEventListener('abort',abort,{once:true});if(options.signal?.aborted)abort();const timer=setTimeout(abort,15*60*1000);
 try{controller.signal.throwIfAborted();emit({status:'starting'});await models.login('xai','oauth',{signal:controller.signal,prompt:async()=>{throw Error('Unexpected interactive prompt');},notify:event=>{if(event.type!=='device_code')return;if(!/^[A-Za-z0-9-]{4,64}$/.test(event.userCode))throw Error('Unexpected user code');emit({status:'device_code',userCode:event.userCode,verificationUri:verificationUri(event.verificationUri)});}});return emit({status:'connected'});}
 catch{return emit({status:options.signal?.aborted?'cancelled':'failed'});}finally{clearTimeout(timer);options.signal?.removeEventListener('abort',abort);active.delete(storage);}
}
export const GROK_CHECK_BUDGET={providerRequests:2,maxOutputTokensPerRequest:128,timeoutMs:120000,maxResponseBytes:65536} as const;
const checking=new WeakSet<CredentialStorage>();
const CHECK_KEY='grok-tool-check:v1';
type HttpEvidence={request:number;status:number;timestamp:number;contentType?:string;cfRay?:string;requestId?:string};
export type GrokCheckResult={status:'disabled'|'not_connected'|'unsupported_model'|'passed'|'failed'|'busy';providerRequests:number;toolCalls:number;http:HttpEvidence[]};
/** Fixed fresh-context probe. No harness, workspace, history, shell, retries, or auto-login. */
export async function runGrokToolCheck(models:Pick<Models,'getModel'|'streamSimple'>,credentials:Pick<CredentialStore,'read'>,modelId:string,options:{approved?:boolean;signal?:AbortSignal;storage?:CredentialStorage}={}):Promise<GrokCheckResult>{
 const report:GrokCheckResult={status:'disabled',providerRequests:0,toolCalls:0,http:[]};if(options.approved!==true||!options.storage)return report;
 const model=models.getModel('xai',modelId);if(!grokCatalog().some(m=>m.id===modelId)||!model||model.provider!=='xai'||model.api!=='openai-responses'||model.baseUrl!=='https://api.x.ai/v1'){report.status='unsupported_model';return report;}
 if((await credentials.read('xai'))?.type!=='oauth'){report.status='not_connected';return report;}
 const storage=options.storage;if(checking.has(storage)){report.status='busy';return report;}checking.add(storage);
 try{const prior=await storage.get<{state:'running'|'done';report:GrokCheckResult}>(CHECK_KEY);if(prior){checking.delete(storage);return prior.state==='done'?prior.report:{...prior.report,status:'failed'};}await storage.put(CHECK_KEY,{state:'running',report});}catch{checking.delete(storage);throw Error('Could not reserve fixed check');}
 const controller=new AbortController(),abort=()=>controller.abort();options.signal?.addEventListener('abort',abort,{once:true});if(options.signal?.aborted)abort();const timer=setTimeout(abort,GROK_CHECK_BUDGET.timeoutMs);
 const tool={name:'test_status',description:'Return a fixed test marker; no environment access.',parameters:Type.Object({}, {additionalProperties:false})};
 const messages:Message[]=[{role:'user',content:'Call test_status exactly once, then confirm its marker in one short sentence.',timestamp:Date.now()}];
 const limitedFetch:typeof fetch=async(input,init)=>{
  const url=new URL(typeof input==='string'?input:input instanceof URL?input.href:input.url);if(url.href!=='https://api.x.ai/v1/responses'||(init?.method??(input instanceof Request?input.method:'GET'))!=='POST'||report.providerRequests>=2)throw Error('Outside fixed test budget');report.providerRequests++;await storage.put(CHECK_KEY,{state:'running',report});const supplied=init?.signal??(input instanceof Request?input.signal:undefined);const requestSignal=supplied?AbortSignal.any([supplied,controller.signal]):controller.signal;const response=await fetch(input,{...init,redirect:'manual',signal:requestSignal});
  const evidence:HttpEvidence={request:report.providerRequests,status:response.status,timestamp:Date.now()};for(const [header,key] of [['content-type','contentType'],['cf-ray','cfRay'],['x-request-id','requestId']] as const){const value=response.headers.get(header);if(value&&value.length<=200&&!/[\x00-\x1f\x7f]/.test(value))evidence[key]=value;}report.http.push(evidence);if(response.status>=300&&response.status<400){await response.body?.cancel();throw Error('Redirect not allowed');}
  if(!response.body)return response;let bytes=0;const stream=response.body.pipeThrough(new TransformStream<Uint8Array,Uint8Array>({transform(chunk,output){bytes+=chunk.byteLength;if(bytes>GROK_CHECK_BUDGET.maxResponseBytes){controller.abort();throw Error('Response exceeds fixed budget');}output.enqueue(chunk);}}));return new Response(stream,{status:response.status,statusText:response.statusText,headers:response.headers});
 };
 const request=async(round:number):Promise<AssistantMessage>=>{const stream=models.streamSimple(model,{systemPrompt:'This is a private fixed tool-transport check. Use only the supplied test tool.',tools:[tool],messages},{maxTokens:128,maxRetries:0,timeoutMs:60000,signal:controller.signal,fetch:limitedFetch,onPayload:payload=>{const body=payload as Record<string,unknown>;body.store=false;body.max_output_tokens=GROK_CHECK_BUDGET.maxOutputTokensPerRequest;body.parallel_tool_calls=false;body.tool_choice=round===1?{type:'function',name:'test_status'}:'none';return body;}});for await(const _event of stream){/* Consume streamed frames without publishing content. */}return stream.result();};
 try{controller.signal.throwIfAborted();const first=await request(1);if(first.stopReason!=='toolUse')throw Error('Expected one tool round');const calls=first.content.filter(c=>c.type==='toolCall');if(calls.length!==1||calls[0].name!=='test_status'||Object.keys(calls[0].arguments).length!==0)throw Error('Unexpected tool call');report.toolCalls=1;messages.push(first,{role:'toolResult',toolCallId:calls[0].id,toolName:'test_status',content:[{type:'text',text:'{"ok":true,"marker":"grok-tool-test-v1"}'}],isError:false,timestamp:Date.now()});const last=await request(2);if(last.stopReason!=='stop'||last.content.some(c=>c.type==='toolCall')||!last.content.some(c=>c.type==='text'&&c.text.includes('grok-tool-test-v1')))throw Error('Continuation did not confirm marker');report.status='passed';}
 catch{report.status='failed';}finally{clearTimeout(timer);options.signal?.removeEventListener('abort',abort);try{await storage.put(CHECK_KEY,{state:'done',report});}finally{checking.delete(storage);}}return report;
}
