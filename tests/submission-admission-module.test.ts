import {test} from 'node:test';
import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';
import {SubmissionAdmission} from '../src/submission-admission';
const send=(owner:SubmissionAdmission<any>,value:typeof input)=>owner.atArrival(value.sessionId)(value);
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
 const make=()=>new SubmissionAdmission(s as any,{isBusy:async()=>{busyChecks++;return false;},abort:async()=>true,submit:async(value)=>{
  dispatches++;assert.deepEqual(value,input);const record=s.data.get('admission:1:module-operation');assert.equal(record.digest,createHash('sha256').update(input.text).digest('hex'));assert.equal(record.receipt,undefined);assert.equal(s.data.get('quota').count,1);return receipt;
 }});
 assert.equal(await send(make(),input),receipt);assert.deepEqual(await send(make(),input),receipt);
 await assert.rejects(send(make(),{...input,text:input.text.trim()}),{status:409,message:'Operation ID already used'});
 assert.equal(dispatches,1);assert.equal(busyChecks,1);assert.deepEqual([...s.data.keys()].sort(),['admission:1:module-operation','quota']);
});
test('receipt-write failure leaves a recoverable reserved operation; new instance dispatches the same identity without another busy/quota check',async()=>{
 const s=store();s.failNextReceipt();let calls=0;
 const dispatch=async(value:typeof input)=>{assert.deepEqual(value,input);calls++;return {accepted:calls===1,operationId:value.operationId};};
 await assert.rejects(send(new SubmissionAdmission(s as any,{isBusy:async()=>false,submit:dispatch,abort:async()=>true}),input),/Receipt write failed/);
 assert.equal(s.data.get('quota').count,1);assert.equal(s.data.get('admission:1:module-operation').receipt,undefined);
 s.data.get('quota').count=50;
 const recovered=new SubmissionAdmission(s as any,{isBusy:async()=>{throw Error('Reserved retry must skip busy checks');},submit:dispatch,abort:async()=>true});
 assert.deepEqual(await send(recovered,input),{accepted:false,operationId:input.operationId});assert.equal(s.data.get('quota').count,50);assert.equal(calls,2);
 assert.deepEqual(await send(recovered,input),{accepted:false,operationId:input.operationId});assert.equal(calls,2);
});
test('new admission remains bounded by the existing global busy gate and 50/day quota, with UTC rollover',async t=>{
 t.mock.timers.enable({apis:['Date'],now:Date.UTC(2026,9,17,23,59,59)});
 const s=store();let busy=true,dispatches=0;
 const admission=new SubmissionAdmission(s as any,{isBusy:async()=>busy,submit:async()=>({accepted:!!++dispatches}),abort:async()=>true});
 await assert.rejects(send(admission,input),{status:409,message:'Wait for the current request to finish'});assert.equal(s.data.size,0);
 busy=false;s.data.set('quota',{day:'2026-10-17',count:50});
 await assert.rejects(send(admission,input),{status:429,message:'Daily limit of 50 messages reached'});assert.equal(s.data.size,1);assert.equal(dispatches,0);
 t.mock.timers.tick(2000);await send(admission,input);assert.deepEqual(s.data.get('quota'),{day:'2026-10-18',count:1});
});
test('dispatch failure consumes one conservative reservation and retries remain bound to the original text',async()=>{
 const s=store();let fail=true;
 const admission=new SubmissionAdmission(s as any,{isBusy:async()=>false,submit:async()=>{if(fail)throw Error('Dispatch failed before response');return {accepted:true};},abort:async()=>true});
 await assert.rejects(send(admission,input),/Dispatch failed/);assert.equal(s.data.get('quota').count,1);
 await assert.rejects(send(admission,{...input,text:'changed'}),{status:409});fail=false;await send(admission,input);assert.equal(s.data.get('quota').count,1);
});

test('durable cancellation survives owner reconstruction; completed receipts replay and sessions stay isolated',async()=>{
 const s=store();let calls=0,sessionStops=0,targetedStops=0;
 const make=()=>new SubmissionAdmission(s as any,{isBusy:async()=>false,submit:async()=>({accepted:!!++calls}),abort:async input=>{input.operationId?targetedStops++:sessionStops++;return true;}});
 const first=make(),receipt=await send(first,input),queued=first.atArrival('1');
 await first.stop('1');assert.deepEqual(await send(make(),input),receipt);
 const message={operationId:'queued-before-stop',text:input.text};await assert.rejects(queued(message),{status:409,code:'submission_cancelled'});
 assert.equal(s.data.get('quota').count,1);
 await assert.rejects(make().atArrival('1')(message),{status:409});
 await make().stop('1');await assert.rejects(make().atArrival('1')(message),{status:409});
 await send(make(),{...input,operationId:'new-after-stop'});await send(make(),{...input,sessionId:'2'});
 assert.equal(calls,3);assert.equal(targetedStops,0);assert.equal(sessionStops,2);assert.equal(s.data.get('quota').count,3);
});

test('Stop racing a lost SDK response performs live cleanup; cancelled replay cannot abort newer intent',async()=>{
 const s=store();let targets=0;let owner:SubmissionAdmission;
 owner=new SubmissionAdmission(s as any,{isBusy:async()=>false,submit:async()=>{await owner.stop('1');throw Error('Lost accepted SDK response');},abort:async input=>{if(input.operationId)targets++;return true;}});
 await assert.rejects(send(owner,input),{status:409,code:'submission_cancelled'});assert.equal(targets,1);assert.equal(s.data.get('quota').count,1);
 const recovered=new SubmissionAdmission(s as any,{isBusy:async()=>false,submit:async()=>{throw Error('Cancelled operation must not dispatch');},abort:async()=>{targets++;}});
 await assert.rejects(send(recovered,input),{status:409});assert.equal(targets,1);
});

function deferred<T=void>(){let resolve!:(value:T)=>void,reject!:(error:Error)=>void;const promise=new Promise<T>((yes,no)=>{resolve=yes;reject=no});return {promise,resolve,reject};}
test('overlapping Stops serialize SDK aborts and fence newer intent until the last Stop completes',async()=>{
 const s=store(),first=deferred(),second=deferred(),entered=deferred();let stops=0,dispatches=0;
 const owner=new SubmissionAdmission(s as any,{isBusy:async()=>false,submit:async()=>({accepted:!!++dispatches}),abort:async()=>{stops++;if(stops===1){entered.resolve();await first.promise;}else await second.promise;return true;}});
 const a=owner.stop('1');await entered.promise;const b=owner.stop('1');
 // Wait for the second Stop's durable epoch write without depending on its value.
 await new Promise(r=>setImmediate(r));const submit=send(owner,input);await new Promise(r=>setImmediate(r));assert.equal(stops,1);assert.equal(dispatches,0);
 first.resolve();await a;await new Promise(r=>setImmediate(r));assert.equal(stops,2);assert.equal(dispatches,0);
 second.resolve();await b;await submit;assert.equal(dispatches,1);
});
test('failed Stop does not poison a later Stop or permanently fence new requests',async()=>{
 const s=store();let fail=true,calls=0;
 const owner=new SubmissionAdmission(s as any,{isBusy:async()=>false,submit:async()=>({accepted:!!++calls}),abort:async()=>{if(fail){fail=false;throw Error('SDK abort failed');}return true;}});
 await assert.rejects(owner.stop('1'),/SDK abort failed/);assert.equal(await owner.stop('1'),true);await send(owner,input);assert.equal(calls,1);
});
test('an arrival is session-bound and one-shot; generation read errors surface when the queued caller consumes it',async()=>{
 const s=store();let calls=0;
 const owner=new SubmissionAdmission(s as any,{isBusy:async()=>false,submit:async input=>({session:input.sessionId,accepted:!!++calls}),abort:async()=>true});
 const arrived=owner.atArrival('2');assert.equal((await arrived(input)).session,'2');await assert.rejects(arrived(input),/already consumed/);assert.equal(calls,1);
 const broken=new SubmissionAdmission({...s,get:async()=>{throw Error('Generation read failed')}} as any,{isBusy:async()=>false,submit:async()=>{throw Error('Must not dispatch')},abort:async()=>true});
 const waiting=broken.atArrival('1');await new Promise(r=>setImmediate(r));await assert.rejects(waiting(input),/Generation read failed/);
});
