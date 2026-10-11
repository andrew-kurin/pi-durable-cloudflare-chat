import {BACKGROUND_CONTEXT as context} from '@earendil-works/chord/context';
import {readTools,type ToolStorage} from './read-tools';
export type SearchCheck = {status:'running'|'passed'|'failed'; attempts:string[]; search?:{count:number;url:string;credits:number|null}; extract?:{url:string;characters:number;truncated:boolean;credits:number|null};error?:string};
const CHECK_KEY='tools:approved-search-check:v1';
export type SearchCheckEnv={ENABLE_WEB_SEARCH_TEST?:string;ENABLE_WEB_SEARCH?:string;TAVILY_API_KEY?:string};
export function searchCheckStatus(storage:ToolStorage){return storage.get<SearchCheck>(CHECK_KEY);}
// Owner-only, fixed public inputs, no model invocation, no automatic retries.
// The durable claim precedes either network call. An interrupted test stays claimed.
export async function runSearchCheck(storage:ToolStorage,env:SearchCheckEnv,http:typeof fetch=fetch):Promise<SearchCheck>{
 if(env.ENABLE_WEB_SEARCH_TEST!=='true'||env.ENABLE_WEB_SEARCH==='true'||!env.TAVILY_API_KEY)throw new Error('Search check is not enabled');
 const claimed=await storage.transaction(async tx=>{if(await tx.get(CHECK_KEY))return false;await tx.put(CHECK_KEY,{status:'running',attempts:[]} satisfies SearchCheck);return true;});
 if(!claimed)return (await searchCheckStatus(storage))!;
 const state:SearchCheck={status:'running',attempts:[]};
 const tools=readTools(storage,{...env,ENABLE_WEB_SEARCH:'true'},http,()=>Date.now(),false).tools!;
 const api={memo:async(name:string,valueOrContext:unknown,maybeContext?:unknown)=>{
  const key=CHECK_KEY+':memo:'+state.attempts.at(-1)+':'+name;
  if(maybeContext!==undefined){await storage.put(key,valueOrContext);return valueOrContext;}
  return storage.get(key);
 }};
 try{
  state.attempts.push('web_search');await storage.put(CHECK_KEY,state);
  const search=await tools.find(t=>t.name==='web_search')!.execute({query:'Cloudflare PiHarness official documentation'} as never,api as never,context);
  const searchData=JSON.parse(search.content![0].type==='text'?search.content![0].text:'{}').data;
  if(searchData?.error||!Array.isArray(searchData?.results)||!searchData.results.length)throw new Error('Basic search failed or returned no sources; no fallback was attempted');
  state.search={count:searchData.results.length,url:searchData.results[0].url,credits:searchData.credits};await storage.put(CHECK_KEY,state);
  state.attempts.push('fetch_page');await storage.put(CHECK_KEY,state);
  const extract=await tools.find(t=>t.name==='fetch_page')!.execute({url:'https://developers.cloudflare.com/agents/harnesses/pi/'} as never,api as never,context);
  const extractData=JSON.parse(extract.content![0].type==='text'?extract.content![0].text:'{}').data;
  if(extractData?.error||typeof extractData?.text!=='string'||!extractData.text.trim())throw new Error('Basic extraction failed; no fallback was attempted');
  state.extract={url:extractData.url,characters:extractData.text.length,truncated:!!extractData.truncated,credits:extractData.credits};state.status='passed';
 }catch(error){state.status='failed';state.error=error instanceof Error&&error.message.startsWith('Basic ')?error.message:'Search check interrupted or unavailable; no retry was attempted';}
 await storage.put(CHECK_KEY,state);return state;
}
