import {test} from 'node:test';
import assert from 'node:assert/strict';
import {SubmissionAdmission} from '../src/submission-admission';
import {WorkspaceCoordinator} from '../src/workspace-coordinator';

test('submission arrival fences workspace Stop, persisted retry intent, and successful receipt replay',async()=>{
 const data=new Map<string,any>();const store:any={get:async(k:string)=>structuredClone(data.get(k)),put:async(k:string,v:any)=>{data.set(k,structuredClone(v));},transaction:async(fn:any)=>fn(store)};
 const coordinator=new WorkspaceCoordinator(store,{ENABLE_WORKSPACE:'true',WORKSPACE_IMAGE:'image',WORKSPACE_REPOSITORY:'owner/repo',Workspaces:{} as any},async()=>{});
 let calls=0,fail=false;
 const runtime={isBusy:async()=>false,captureIntent:(sid:string)=>coordinator.submissionEpoch(sid),submit:async(input:any,intent?:string)=>{await coordinator.admitNewWork(input.sessionId,input.operationId,intent);calls++;if(fail){fail=false;throw Error('lost response');}return {accepted:true};},abort:async()=>true};
 const admission=new SubmissionAdmission(store,runtime);
 const queued=admission.atArrival('1');await Promise.resolve();await store.put('workspace-auto-stop:1',{epoch:'stop-1',blocked:true});
 await assert.rejects(queued({operationId:'queued-message',text:'new work'}),{status:409,code:'submission_cancelled'});assert.equal(calls,0);
 // Reconstruct admission: retrying a pre-Stop operation must retain its old intent.
 const restored=new SubmissionAdmission(store,runtime);await assert.rejects(restored.atArrival('1')({operationId:'queued-message',text:'new work'}),/stopped after this request/);
 const receipt=await restored.atArrival('1')({operationId:'fresh-message',text:'new work'});assert.equal(data.get('workspace-auto-stop:1').blocked,false);assert.equal(calls,1);
 await store.put('workspace-auto-stop:1',{epoch:'stop-2',blocked:true});
 assert.deepEqual(await restored.atArrival('1')({operationId:'fresh-message',text:'new work'}),receipt);assert.equal(data.get('workspace-auto-stop:1').blocked,true);assert.equal(calls,1);
 fail=true;await assert.rejects(restored.atArrival('1')({operationId:'lost-response',text:'new work'}),/lost response/);
 await store.put('workspace-auto-stop:1',{epoch:'stop-3',blocked:true});
 await assert.rejects(new SubmissionAdmission(store,runtime).atArrival('1')({operationId:'lost-response',text:'new work'}),/stopped after this request/);assert.equal(data.get('workspace-auto-stop:1').blocked,true);
});
