import {logTechnicalError} from './error-log';
import type { MutableModels } from '@earendil-works/pi-ai/models';
import type { AssistantMessage } from '@earendil-works/pi-ai';
import {appendAssistantMessageDiagnostic} from '@earendil-works/pi-ai/utils/diagnostics';
import type {AssistantMessageDiagnostic} from '@earendil-works/pi-ai/utils/diagnostics';
import { createAssistantMessageEventStream } from '@earendil-works/pi-ai/utils/event-stream';
/** Enforce before Models resolves OAuth or dispatches any network request.
 * Extension hooks are intentionally NOT used: Pi reports and swallows their errors.
 */
export function guardModels(models:MutableModels,reserve:()=>Promise<void>,beforeFetch:()=>Promise<void>=async()=>{}){
 const original=models.streamSimple.bind(models);
 models.streamSimple=(model,context,options)=>{
  const output=createAssistantMessageEventStream();
  void (async()=>{try{await reserve();options?.signal?.throwIfAborted();const turnId=crypto.randomUUID();
   const responses:AssistantMessageDiagnostic[]=[];
   let requestEndpoint:string|undefined;
   const recorded=new WeakSet<AssistantMessage>();
   const attach=(message:AssistantMessage)=>{if(recorded.has(message))return;recorded.add(message);for(const response of responses)appendAssistantMessageDiagnostic(message,response);};
   const fetcher=options?.fetch??globalThis.fetch;
   const source=original(model,context,{...options,
    fetch:async(input,init)=>{await beforeFetch();requestEndpoint=undefined;try{const url=new URL(typeof input==='string'?input:input instanceof URL?input.href:input.url);if(url.origin==='https://chatgpt.com'&&url.pathname==='/backend-api/codex/responses')requestEndpoint=url.origin+url.pathname;}catch{}return fetcher(input,init);},
    onResponse:async(response,responseModel)=>{
     if(Number.isInteger(response.status)&&response.status>=100&&response.status<=599&&responses.length<8){
      const details:Record<string,string|number>={status:response.status,turnId,responseIndex:responses.length+1};
      if(requestEndpoint)details.endpoint=requestEndpoint;
      const headers=new Headers(response.headers);
      const fields=[['content-type','contentType',200],['cf-ray','cfRay',100],['cf-mitigated','cfMitigated',64],['x-request-id','requestId',200],['retry-after','retryAfter',100]] as const;
      for(const [header,key,max] of fields){const value=headers.get(header);if(value&&value.length<=max&&!/[\x00-\x1f\x7f]/.test(value))details[key]=value;}
      responses.push({type:'provider_http_response',timestamp:Date.now(),details});
     }
     await options?.onResponse?.(response,responseModel);
    }});
   for await(const event of source){if(event.type==='error')attach(event.error);if(event.type==='done')attach(event.message);output.push(event);}
   const result=await source.result();attach(result);output.end(result);}
  catch(cause){logTechnicalError('model_dispatch',cause,crypto.randomUUID());const error:AssistantMessage={role:'assistant',content:[],api:model.api,provider:model.provider,model:model.id,stopReason:'error',errorMessage:'Model access unavailable or daily request limit reached.',timestamp:Date.now(),usage:{input:0,output:0,cacheRead:0,cacheWrite:0,totalTokens:0,cost:{input:0,output:0,cacheRead:0,cacheWrite:0,total:0}}};output.push({type:'error',reason:'error',error});output.end(error);}})();
  return output;
 };
 return models;
}
