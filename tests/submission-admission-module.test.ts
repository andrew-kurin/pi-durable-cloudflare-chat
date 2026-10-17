import {test} from 'node:test';
import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';
import {SubmissionAdmission} from '../src/submission-admission';
const input={sessionId:'1',operationId:'module-operation',text:' Exact raw text 🙂 '};
function store() {
 const data=new Map<string,any>();let failReceipt=false;
 const target={
  data,
  get:async<T>(key:string)=>structuredClone(data.get(key)) as T|undefined,
  put:async(key:string,value:any)=>{if(failReceipt&&key.startsWith('admission:')&&value.receipt){failReceipt=false;throw Error('Receipt write failed');}data.set(key,structuredClone(value));},
  transaction:async<T>(work:(tx:any)=>Promise<T>)=>{
   const staged=new Map(data);const result=await work({get:async(key:string)=>structuredClone(staged.get(key)),put:async(key:string,value:any)=>staged.set(key,structuredClone(value))});
   data.clear();for(const pair of staged)data.set(...pair);return result;
  },
  failNextReceipt:()=>{failReceipt=true;},
 };
 return target;
}
test('one-method module preserves raw input, exact digest and receipt cache across instances without hidden harness/HTTP dependencies',async()=>{
 const s=store();let busyChecks=0,dispatches=0;
 const receipt={operationId:input.operationId,session:input.sessionId,accepted:true};
 const make=()=>new SubmissionAdmission(s as any,async()=>{busyChecks++;return false;},async(value)=>{
  dispatches++;assert.deepEqual(value,input);const record=s.data.get('admission:1:module-operation');assert.equal(record.digest,createHash('sha256').update(input.text).digest('hex'));assert.equal(record.receipt,undefined);assert.equal(s.data.get('quota').count,1);return receipt;
 });
 assert.equal(await make().submit(input),receipt);assert.deepEqual(await make().submit(input),receipt);
 await assert.rejects(make().submit({...input,text:input.text.trim()}),{status:409,message:'Operation ID already used'});
 assert.equal(dispatches,1);assert.equal(busyChecks,1);assert.deepEqual([...s.data.keys()].sort(),['admission:1:module-operation','quota']);
});
test('receipt-write failure leaves a recoverable reserved operation; new instance dispatches the same identity without another busy/quota check',async()=>{
 const s=store();s.failNextReceipt();let calls=0;
 const dispatch=async(value:typeof input)=>{assert.deepEqual(value,input);calls++;return {accepted:calls===1,operationId:value.operationId};};
 await assert.rejects(new SubmissionAdmission(s as any,async()=>false,dispatch).submit(input),/Receipt write failed/);
 assert.equal(s.data.get('quota').count,1);assert.equal(s.data.get('admission:1:module-operation').receipt,undefined);
 s.data.get('quota').count=50;
 const recovered=new SubmissionAdmission(s as any,async()=>{throw Error('Reserved retry must skip busy checks');},dispatch);
 assert.deepEqual(await recovered.submit(input),{accepted:false,operationId:input.operationId});assert.equal(s.data.get('quota').count,50);assert.equal(calls,2);
 assert.deepEqual(await recovered.submit(input),{accepted:false,operationId:input.operationId});assert.equal(calls,2);
});
test('new admission remains bounded by the existing global busy gate and 50/day quota, with UTC rollover',async t=>{
 t.mock.timers.enable({apis:['Date'],now:Date.UTC(2026,9,17,23,59,59)});
 const s=store();let busy=true,dispatches=0;
 const admission=new SubmissionAdmission(s as any,async()=>busy,async()=>({accepted:!!++dispatches}));
 await assert.rejects(admission.submit(input),{status:409,message:'Wait for the current request to finish'});assert.equal(s.data.size,0);
 busy=false;s.data.set('quota',{day:'2026-10-17',count:50});
 await assert.rejects(admission.submit(input),{status:429,message:'Daily limit of 50 messages reached'});assert.equal(s.data.size,1);assert.equal(dispatches,0);
 t.mock.timers.tick(2000);await admission.submit(input);assert.deepEqual(s.data.get('quota'),{day:'2026-10-18',count:1});
});
test('dispatch failure consumes one conservative reservation and retries remain bound to the original text',async()=>{
 const s=store();let fail=true;
 const admission=new SubmissionAdmission(s as any,async()=>false,async()=>{if(fail)throw Error('Dispatch failed before response');return {accepted:true};});
 await assert.rejects(admission.submit(input),/Dispatch failed/);assert.equal(s.data.get('quota').count,1);
 await assert.rejects(admission.submit({...input,text:'changed'}),{status:409});fail=false;await admission.submit(input);assert.equal(s.data.get('quota').count,1);
});

test('durable cancellation survives admission reconstruction, preserves completed receipts, and isolates sessions',async()=>{
 const s=store();let calls=0,aborts=0;
 const make=()=>new SubmissionAdmission(s as any,async()=>false,async()=>({accepted:!!++calls}),async()=>{aborts++;});
 const receipt=await make().submit(input);
 await s.put('submission-cancel:1','stop-1');
 assert.deepEqual(await make().submit(input,'stop-1'),receipt);
 const queued={...input,operationId:'queued-before-stop'};
 await assert.rejects(make().submit(queued),{status:409});
 assert.equal(s.data.get('quota').count,1);
 await assert.rejects(make().submit(queued,'stop-1'),{status:409});
 await s.put('submission-cancel:1','stop-2');
 await assert.rejects(make().submit(queued,'stop-2'),{status:409});
 await make().submit({...input,operationId:'new-after-stop'},'stop-2');
 await make().submit({...input,sessionId:'2'});
 assert.equal(calls,3);assert.equal(aborts,0);assert.equal(s.data.get('quota').count,3);
});

test('Stop racing a failed dispatch still performs late acceptance cleanup; cancelled replay never aborts newer work',async()=>{
 const s=store();let aborts=0;
 const first=new SubmissionAdmission(s as any,async()=>false,async()=>{await s.put('submission-cancel:1','stop');throw Error('Lost accepted SDK response');},async()=>{aborts++;});
 await assert.rejects(first.submit(input),{status:409});assert.equal(aborts,1);
 assert.equal(s.data.get('quota').count,1);
 const recovered=new SubmissionAdmission(s as any,async()=>false,async()=>{throw Error('Cancelled operation must not dispatch');},async()=>{aborts++;});
 await assert.rejects(recovered.submit(input,'stop'),{status:409});assert.equal(aborts,1);
});
