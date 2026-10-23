import {test} from 'node:test';import assert from 'node:assert/strict';import {WorkspaceController,DEFAULT_WORKSPACE_LIMITS,type WorkspaceAdapter} from '../src/workspace';import {CHECK_COMMANDS} from '../src/change-contract';
import {WorkspaceCoordinator} from '../src/workspace-coordinator';
const id='aaaaaaaa-aaaa-4aaa-aaaa-aaaaaaaaaaaa',op=(n:number)=>n.toString(16).padStart(64,'0');
test('exports bind the latest successful canonical checks to the exact unchanged tree; later failure invalidates earlier success',async()=>{
 const data=new Map<string,any>();let tree='c'.repeat(40),exitCode=0,clock=0,pinned:string|undefined;const store={get:async<T>(k:string)=>structuredClone(data.get(k)) as T,put:async(k:string,v:any)=>{data.set(k,structuredClone(v));},setAlarm:async()=>{},deleteAlarm:async()=>{}};
 const adapter:WorkspaceAdapter={open:async(_r,_s,revision)=>{pinned=revision;return 'b'.repeat(40);},snapshot:async()=>tree,read:async()=>'',edit:async()=>{},dispatch:async()=>{},status:async()=>({state:'exited',exitCode}),logs:async()=>'',terminate:async()=>{},collect:async(base)=>({base,treeSha:tree,patch:'patch',logs:{},gaps:[]}),stop:async()=>{},keepAlive:async()=>{}};
 const c=new WorkspaceController(store,adapter,DEFAULT_WORKSPACE_LIMITS,()=>clock++);await c.open(id,'1','andrew-kurin/pi-durable-cloudflare-chat',async()=>{},'b'.repeat(40));assert.equal(pinned,'b'.repeat(40));
 let n=0;const call=(r:any)=>c.request({...r,workspaceId:id,operationId:op(++n)});for(const argv of Object.values(CHECK_COMMANDS)){await call({action:'exec',argv});await call({action:'status'});}
 const first=await call({action:'export'}) as any;assert.equal((await c.artifact(first.artifactId)).source?.checks.length,3);
 exitCode=1;await call({action:'exec',argv:['npm','test']});await call({action:'status'});const second=await call({action:'export'}) as any;assert.deepEqual((await c.artifact(second.artifactId)).source?.checks.map(x=>x.check),['typecheck','build']);
 exitCode=0;await call({action:'exec',argv:['npm','test']});tree='d'.repeat(40);await call({action:'status'});const changed=await call({action:'export'}) as any;assert.equal((await c.artifact(changed.artifactId)).source?.checks.length,0);assert.equal((await c.artifact(first.artifactId)).source?.checks.length,3,'old immutable receipts remain unchanged');
});
test('new harness activation pins the serving source revision without retargeting other projects',async()=>{
 for(const repo of ['andrew-kurin/pi-durable-cloudflare-chat','owner/other']){
  const data=new Map<string,any>(),calls:any[]=[];const store={get:async<T>(k:string)=>structuredClone(data.get(k)) as T,put:async(k:string,v:any)=>{data.set(k,structuredClone(v));},transaction:async(fn:any)=>fn(store)};
  const coordinator=new WorkspaceCoordinator(store as any,{ENABLE_WORKSPACE:'true',WORKSPACE_IMAGE:'workspace',WORKSPACE_REPOSITORY:repo,SOURCE_REVISION:'f'.repeat(40),Workspaces:{getByName:()=>({open:async(...args:any[])=>{calls.push(args);return {id:args[0],phase:'ready'};}})} as any},async()=>{});
  await coordinator.open('1',id);assert.equal(calls.length,1);assert.equal(calls[0][3],repo.startsWith('andrew-kurin/')?'f'.repeat(40):undefined);
 }
});
