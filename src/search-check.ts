import {BACKGROUND_CONTEXT as context} from '@earendil-works/chord/context';
import {readTools,type ToolStorage} from './read-tools';
export type SearchCheck = {status:'running'|'passed'|'failed'; attempts:string[]; search?:{count:number;url:string;credits:number|null}; extract?:{url:string;characters:number;truncated:boolean;credits:number|null};error?:string;reason?:string};
// Distinct claim authorized after the v1 runtime failure; v1 is never overwritten.
const CHECK_KEY='tools:approved-search-check:v2';
export type SearchCheckEnv={ENABLE_WEB_SEARCH_TEST?:string;ENABLE_WEB_SEARCH?:string;TAVILY_API_KEY?:string};
export async function searchCheckStatus(storage:ToolStorage){
 const state=await storage.get<SearchCheck>(CHECK_KEY);
 if(state?.status==='failed'){
  const memo=await storage.get<{content:{type:string;text:string}[]}>(CHECK_KEY+':memo:'+state.attempts.at(-1)+':read-result');
  // Only expose the read tool's already-sanitized error category, never response bodies.
  try{const error=JSON.parse(memo?.content?.[0]?.text??'{}').data?.error;if(typeof error==='string'&&/^(Read provider unavailable|Read provider authentication rejected|Read provider transport failed|Read provider redirect rejected|Read provider request aborted or timed out|Search key configuration invalid|Provider rate limit or access restriction|Read unavailable or interrupted|Read-tool budget reached|Provider response too large|Unexpected provider|Web search is not configured)/.test(error))state.reason=error.slice(0,200);}catch{}
 }
 return state;
}
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
  if(typeof searchData.credits==='number'&&(!Number.isFinite(searchData.credits)||searchData.credits<0||searchData.credits>1))throw new Error('Basic search usage exceeds the remaining approved cap; extraction skipped');
  state.search={count:searchData.results.length,url:searchData.results[0].url,credits:searchData.credits};await storage.put(CHECK_KEY,state);
  state.attempts.push('fetch_page');await storage.put(CHECK_KEY,state);
  const extract=await tools.find(t=>t.name==='fetch_page')!.execute({url:'https://developers.cloudflare.com/agents/harnesses/pi/'} as never,api as never,context);
  const extractData=JSON.parse(extract.content![0].type==='text'?extract.content![0].text:'{}').data;
  if(extractData?.error||typeof extractData?.text!=='string'||!extractData.text.trim())throw new Error('Basic extraction failed; no fallback was attempted');
  if(typeof extractData.credits==='number'&&(!Number.isFinite(extractData.credits)||extractData.credits<0||extractData.credits>1||(state.search?.credits??1)+extractData.credits>2))throw new Error('Basic extraction usage exceeds the approved cap');
  state.extract={url:extractData.url,characters:extractData.text.length,truncated:!!extractData.truncated,credits:extractData.credits};state.status='passed';
 }catch(error){state.status='failed';state.error=error instanceof Error&&error.message.startsWith('Basic ')?error.message:'Search check interrupted or unavailable; no retry was attempted';}
 await storage.put(CHECK_KEY,state);return state;
}

export async function previousSearchCheckStatus(storage:ToolStorage){return storage.get<SearchCheck>('tools:approved-search-check:v1');}
export type GithubCheck={status:'running'|'passed'|'failed';attempts:string[];repository?:string;count?:number;error?:string};
export async function githubCheckStatus(storage:ToolStorage){return storage.get<GithubCheck>(CHECK_KEY+':github');}
export async function runGithubCheck(storage:ToolStorage,http:typeof fetch=fetch):Promise<GithubCheck>{
 const key=CHECK_KEY+':github';const claimed=await storage.transaction(async tx=>{if(await tx.get(key))return false;await tx.put(key,{status:'running',attempts:[]} satisfies GithubCheck);return true;});
 if(!claimed)return (await githubCheckStatus(storage))!;
 const state:GithubCheck={status:'running',attempts:[]};const tools=readTools(storage,{},http,Date.now,false).tools!;
 const api={memo:async(name:string,value:unknown,write?:unknown)=>{const memo=key+':'+state.attempts.at(-1)+':'+name;if(write!==undefined){await storage.put(memo,value);return value;}return storage.get(memo);}};
 try{for(const [name,args] of [['github_read',{repo:'andrew-kurin/pi-durable-cloudflare-chat',kind:'repository'}],['github_search',{kind:'repositories',query:'pi-durable-cloudflare-chat'}]] as const){
  state.attempts.push(name);await storage.put(key,state);const result=await tools.find(t=>t.name===name)!.execute(args as never,api as never,context);const data=JSON.parse(result.content![0].type==='text'?result.content![0].text:'{}').data;
  if(data.error)throw new Error('Public GitHub read unavailable');if(name==='github_read'){if(data.url!=='https://github.com/andrew-kurin/pi-durable-cloudflare-chat')throw new Error('Public GitHub repository mismatch');state.repository=data.url;}else{if(!Array.isArray(data.results)||!data.results.some((r:any)=>r.url===state.repository))throw new Error('Public GitHub search returned no matching repository');state.count=data.results.length;}
 }state.status='passed';}catch{state.status='failed';state.error='Public GitHub verification failed; no retry attempted';}await storage.put(key,state);return state;
}
