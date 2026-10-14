import {grokCatalog} from './grok-subscription';
export const DEFAULT_GROK_MODEL='grok-4.7';
export function newChatModel(selected=DEFAULT_GROK_MODEL){if(!grokCatalog().some(m=>m.id===selected))throw Error('Unsupported Grok chat model');return {provider:'xai',modelId:selected};}
