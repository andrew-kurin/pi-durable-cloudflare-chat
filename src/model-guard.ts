import type { MutableModels } from '@earendil-works/pi-ai/models';
import type { AssistantMessage } from '@earendil-works/pi-ai';
import { createAssistantMessageEventStream } from '@earendil-works/pi-ai/utils/event-stream';
/** Enforce before Models resolves OAuth or dispatches any network request.
 * Extension hooks are intentionally NOT used: Pi reports and swallows their errors.
 */
export function guardModels(models:MutableModels,reserve:()=>Promise<void>){
 const original=models.streamSimple.bind(models);
 models.streamSimple=(model,context,options)=>{
  const output=createAssistantMessageEventStream();
  void (async()=>{try{await reserve();options?.signal?.throwIfAborted();const source=original(model,context,options);for await(const event of source)output.push(event);output.end(await source.result());}
  catch{const error:AssistantMessage={role:'assistant',content:[],api:model.api,provider:model.provider,model:model.id,stopReason:'error',errorMessage:'Model access unavailable or daily request limit reached.',timestamp:Date.now(),usage:{input:0,output:0,cacheRead:0,cacheWrite:0,totalTokens:0,cost:{input:0,output:0,cacheRead:0,cacheWrite:0,total:0}}};output.push({type:'error',reason:'error',error});output.end(error);}})();
  return output;
 };
 return models;
}
