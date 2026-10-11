import {test} from 'node:test';import assert from 'node:assert/strict';
import {runSearchCheck,searchCheckStatus} from '../src/search-check';import type {ToolStorage} from '../src/read-tools';
class Storage implements ToolStorage {
 values=new Map<string,unknown>();queue=Promise.resolve();
 async get<T>(key:string){return structuredClone(this.values.get(key)) as T|undefined;}
 async put<T>(key:string,value:T){this.values.set(key,structuredClone(value));}
 async transaction<T>(fn:(tx:Storage)=>Promise<T>){const prior=this.queue;let release!:()=>void;this.queue=new Promise(r=>release=r);await prior;const before=new Map(this.values);try{return await fn(this);}catch(e){this.values=before;throw e;}finally{release();}}
}
const env={ENABLE_WEB_SEARCH_TEST:'true',ENABLE_WEB_SEARCH:'false',TAVILY_API_KEY:'synthetic-test-key'};
function fixture(storage=new Storage()){
 const calls:{url:string;body:any}[]=[];
 const http=(async(url:any,init:any)=>{assert.equal((await searchCheckStatus(storage))?.status,'running');const body=JSON.parse(init.body);calls.push({url:String(url),body});return Response.json({usage:{credits:url.endsWith('/search')?1:0.2},results:url.endsWith('/search')?[{title:'Pi',url:'https://developers.cloudflare.com/agents/harnesses/pi/',content:'Public docs'}]:[{url:'https://developers.cloudflare.com/agents/harnesses/pi/',raw_content:'Public PiHarness reference'}]});}) as typeof fetch;
 return {storage,calls,http};
}
test('one-shot check uses saved secret in exactly one basic search and extract, reports usage, never calls model',async()=>{
 const f=fixture();const state=await runSearchCheck(f.storage,env,f.http);assert.equal(state.status,'passed');assert.deepEqual(state.attempts,['web_search','fetch_page']);assert.equal(state.search?.credits,1);assert.equal(state.extract?.credits,0.2);assert.equal(f.calls.length,2);assert.equal(f.calls[0].body.query,'Cloudflare PiHarness official documentation');assert.equal(f.calls[0].body.search_depth,'basic');assert.equal(f.calls[1].body.extract_depth,'basic');assert.deepEqual(f.calls[1].body.urls,['https://developers.cloudflare.com/agents/harnesses/pi/']);assert.ok(f.calls.every(c=>c.body.include_usage===true));assert.ok(!JSON.stringify(state).includes('synthetic'));
});
test('repeated and concurrent owner requests cannot repeat the two external calls',async()=>{
 const f=fixture();await Promise.all(Array.from({length:6},()=>runSearchCheck(f.storage,env,f.http)));const result=await runSearchCheck(f.storage,env,f.http);assert.equal(result.status,'passed');assert.equal(f.calls.length,2);
});
test('disabled, missing-key and normal-web mode deny check without claim or network',async()=>{
 for(const settings of [{},{...env,TAVILY_API_KEY:''},{...env,ENABLE_WEB_SEARCH_TEST:'false'},{...env,ENABLE_WEB_SEARCH:'true'}]){const f=fixture();await assert.rejects(runSearchCheck(f.storage,settings,f.http));assert.equal(f.calls.length,0);assert.equal(await searchCheckStatus(f.storage),undefined);}
});
test('credit-limit/basic search failure prevents extraction and retry',async()=>{
 const storage=new Storage();let calls=0;const http=(async()=>{calls++;return new Response('credit limit secret-like body',{status:429});}) as typeof fetch;const first=await runSearchCheck(storage,env,http);assert.equal(first.status,'failed');assert.deepEqual(first.attempts,['web_search']);assert.ok(!JSON.stringify(first).includes('secret-like'));await runSearchCheck(storage,env,http);assert.equal(calls,1);
});
test('an interrupted claimed check never repeats; failed extraction has no fallback',async()=>{
 const f=fixture();await f.storage.put('tools:approved-search-check:v1',{status:'running',attempts:['web_search']});assert.equal((await runSearchCheck(f.storage,env,f.http)).status,'running');assert.equal(f.calls.length,0);
 const other=fixture();let n=0;const http=(async(url:any,init:any)=>{n++;return n===1?other.http(url,init):new Response('failure',{status:429});}) as typeof fetch;assert.equal((await runSearchCheck(other.storage,env,http)).status,'failed');await runSearchCheck(other.storage,env,http);assert.equal(n,2);
});
