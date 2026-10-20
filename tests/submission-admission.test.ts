import {test} from 'node:test';
import assert from 'node:assert/strict';
import {fixture} from './fixtures/submission-worker';
test('exact fingerprints and cached receipts: duplicates reserve once, changed raw text conflicts, sessions scope IDs',async()=>{
 const f=await fixture();try{
  const a=await f.submit('same-operation');assert.equal(a.status,200);const receipt=await a.json();assert.equal((receipt as any).accepted,true);
  const evidence=await f.control('evidence?op=same-operation');assert.ok(evidence.reservedAtDispatch.digest);assert.equal(evidence.quota.count,1);
  const b=await f.submit('same-operation');assert.equal(b.status,200);assert.deepEqual(await b.json(),receipt);
  assert.equal((await f.submit('same-operation','Hello ')).status,409);
  const after=await f.control('evidence?op=same-operation');assert.equal(after.dispatches,1);assert.equal(after.effects,1);assert.equal(after.quota.count,1);
  assert.equal((await f.submit('same-operation','Hello','2')).status,200);assert.equal((await f.control('evidence?op=same-operation&session=2')).quota.count,2);
 }finally{await f.dispose();}
});
test('busy and daily caps reject new operations without a reservation; UTC day rollover reserves anew',async()=>{
 const f=await fixture();try{
  await f.control('config',{busy:true});assert.equal((await f.submit('busy-operation')).status,409);let e=await f.control('evidence?op=busy-operation');assert.equal(e.admission,undefined);assert.equal(e.quota,undefined);
  await f.control('config',{});await f.control('quota?count=50');assert.equal((await f.submit('quota-operation')).status,429);e=await f.control('evidence?op=quota-operation');assert.equal(e.admission,undefined);assert.equal(e.dispatches,0);
  await f.control('quota?count=50&day=2000-01-01');assert.equal((await f.submit('next-day-operation')).status,200);assert.equal((await f.control('evidence?op=next-day-operation')).quota.count,1);
 }finally{await f.dispose();}
});
for(const failure of ['failBefore','failAfter','failReceipt'])test('reserved submission recovery after '+failure+' retains fingerprint and quota',async()=>{
 const f=await fixture();try{
  await f.control('config',{[failure]:true});assert.equal((await f.submit('recovery-operation')).status,500);
  const before=await f.control('evidence?op=recovery-operation');assert.ok(before.admission.digest);assert.equal(before.admission.receipt,undefined);assert.equal(before.quota.count,1);assert.equal(before.effects,failure==='failBefore'?0:1);
  await f.control('config',{busy:true});await f.control('quota?count=50');assert.equal((await f.submit('recovery-operation','Different')).status,409);assert.equal((await f.submit('recovery-operation')).status,200);
  const after=await f.control('evidence?op=recovery-operation');assert.equal(after.quota.count,50);assert.equal(after.dispatches,2);assert.equal(after.effects,1);assert.ok(after.admission.receipt);
 }finally{await f.dispose();}
});
test('title failure returns the accepted receipt and replay repairs metadata without redispatch; provider gate remains',async()=>{
 const f=await fixture();try{
  await f.control('config',{failAutoTitle:true});assert.equal((await f.submit('title-operation')).status,200);let e=await f.control('evidence?op=title-operation');assert.ok(e.admission.receipt);assert.equal(e.title,undefined);
  await f.control('config',{blockedProvider:true});assert.equal((await f.submit('title-operation')).status,503);
  await f.control('config',{});assert.equal((await f.submit('title-operation')).status,200);e=await f.control('evidence?op=title-operation');assert.equal(e.dispatches,1);assert.equal(e.title,'Hello');assert.equal(e.quota.count,1);
 }finally{await f.dispose();}
});
for(const hold of ['rename','submit'])test('abort and close/workspace control bypass a slow '+hold, {timeout:10000},async()=>{
 const f=await fixture();let blocked:Promise<Response>|undefined,abort:Promise<Response>|undefined;try{
  await f.control('config',{hold});blocked=hold==='rename'?f.post('/api/session-title?session=1',{title:'Slow rename'}):f.submit('held-operation');
  await f.control('wait?name='+hold+':entered');abort=f.post('/api/abort?session=1',{});await f.control('wait?name=abort:arrived');
  assert.equal((await f.post('/api/events/close?stream=aaaaaaaa-aaaa-4aaa-aaaa-aaaaaaaaaaaa',{})).status,200);
  assert.equal((await f.post('/api/workspaces/aaaaaaaa-aaaa-4aaa-aaaa-aaaaaaaaaaaa?session=1',{action:'cancel',operationId:'test-operation'})).status,200);
  let e=await f.control('evidence?op=held-operation');assert.equal((await abort).status,200);assert.ok(e.trace.includes('abort:called'));assert.ok(!e.trace.includes(hold+':returned'));assert.ok(e.trace.includes('close:called'));assert.ok(e.trace.includes('workspace:called'));
  await f.control('release?name='+hold);assert.equal((await blocked).status,hold==='submit'?409:200);assert.equal((await abort).status,200);e=await f.control('evidence?op=held-operation');assert.ok(e.trace.indexOf('abort:called')<e.trace.indexOf(hold+':returned'));
 }finally{await f.control('release?name='+hold);await Promise.allSettled([blocked,abort].filter(Boolean) as Promise<Response>[]);await f.dispose();}
});
test('a failed queued mutation does not poison subsequent abort admission',async()=>{
 const f=await fixture();try{await f.control('config',{failRename:true});assert.equal((await f.post('/api/session-title?session=1',{title:'fails'})).status,500);assert.equal((await f.post('/api/abort?session=1',{})).status,200);assert.ok((await f.control('evidence')).trace.includes('abort:called'));}finally{await f.dispose();}
});

test('quota and fingerprint reservation roll back together if the transaction fails before dispatch',async()=>{
 const f=await fixture();try{await f.control('quota?count=49');await f.control('config',{failReservation:true});assert.equal((await f.submit('rollback-operation')).status,500);let e=await f.control('evidence?op=rollback-operation');assert.equal(e.quota.count,49);assert.equal(e.admission,undefined);assert.equal(e.dispatches,0);assert.equal((await f.submit('rollback-operation')).status,200);e=await f.control('evidence?op=rollback-operation');assert.equal(e.quota.count,50);assert.equal(e.effects,1);}finally{await f.dispose();}
});

test('simultaneous duplicate/conflicting submits queue behind first acceptance and produce one effect/quota charge',{timeout:10000},async()=>{
 const f=await fixture();let first:Promise<Response>|undefined,duplicate:Promise<Response>|undefined,conflict:Promise<Response>|undefined;
 try{
  await f.control('config',{hold:'submit'});first=f.submit('simultaneous-operation');await f.control('wait?name=submit:entered');
  duplicate=f.submit('simultaneous-operation');await f.control('wait?name=submit-request:2');conflict=f.submit('simultaneous-operation','Changed text');await f.control('wait?name=submit-request:3');
  let e=await f.control('evidence?op=simultaneous-operation');assert.equal(e.dispatches,1);assert.equal(e.quota.count,1);
  await f.control('release?name=submit');const responses=await Promise.all([first,duplicate,conflict]);assert.deepEqual(responses.map(r=>r.status),[200,200,409]);assert.deepEqual(await responses[0].json(),await responses[1].json());
  e=await f.control('evidence?op=simultaneous-operation');assert.equal(e.dispatches,1);assert.equal(e.effects,1);assert.equal(e.quota.count,1);
 }finally{await f.control('release?name=submit');await Promise.allSettled([first,duplicate,conflict].filter(Boolean) as Promise<Response>[]);await f.dispose();}
});

test('abort retains authentication/session validation and is scoped to the selected session',async()=>{
 const f=await fixture();try{
  assert.equal((await f.unauthorized()).status,403);
  assert.equal((await f.post('/api/abort?session=invalid',{})).status,400);
  assert.ok(!(await f.control('evidence')).trace.includes('abort:called'));
  assert.equal((await f.post('/api/abort?session=2',{})).status,200);
  assert.equal((await f.submit('other-session-operation')).status,200);
  const e=await f.control('evidence?op=other-session-operation');assert.ok(e.trace.includes('abort:2:session'));assert.ok(!e.trace.includes('abort:1:session'));assert.equal(e.effects,1);
 }finally{await f.dispose();}
});

test('Stop cancels a submit queued behind rename; same-ID retry cannot revive it and a new ID can proceed',{timeout:10000},async()=>{
 const f=await fixture();let rename:Promise<Response>|undefined,submit:Promise<Response>|undefined;
 try{
  await f.control('config',{hold:'rename'});rename=f.post('/api/session-title?session=1',{title:'Manual title'});await f.control('wait?name=rename:entered');
  submit=f.submit('queued-cancel-operation');await f.control('wait?name=submit-request:1');
  assert.equal((await f.post('/api/abort?session=1',{})).status,200);
  await f.control('release?name=rename');assert.equal((await rename).status,200);assert.equal((await submit).status,409);
  assert.equal((await f.submit('queued-cancel-operation')).status,409);
  let e=await f.control('evidence?op=queued-cancel-operation');assert.equal(e.dispatches,0);assert.equal(e.quota,undefined);assert.ok(e.admission.digest);
  assert.equal((await f.submit('new-after-stop-operation')).status,200);e=await f.control('evidence?op=new-after-stop-operation');assert.equal(e.effects,1);assert.equal(e.quota.count,1);
 }finally{await f.control('release?name=rename');await Promise.allSettled([rename,submit].filter(Boolean) as Promise<Response>[]);await f.dispose();}
});

for(const hold of ['submit','accepted'])test('Stop during '+hold+' withdraws late acceptance by operation ID and does not replay on retry',{timeout:10000},async()=>{
 const f=await fixture();let submit:Promise<Response>|undefined;
 try{
  await f.control('config',{hold});submit=f.submit('late-accept-operation');await f.control('wait?name='+hold+':entered');
  assert.equal((await f.post('/api/abort?session=1',{})).status,200);
  await f.control('release?name='+hold);assert.equal((await submit).status,409);
  let e=await f.control('evidence?op=late-accept-operation');assert.ok(e.trace.includes('abort:1:late-accept-operation'));assert.equal(e.effects,1);assert.equal(e.quota.count,1);
  await f.control('config',{});assert.equal((await f.submit('late-accept-operation')).status,409);assert.equal((await f.submit('new-intent-operation')).status,200);
  e=await f.control('evidence?op=new-intent-operation');assert.equal(e.dispatches,2);assert.equal(e.effects,2);assert.equal(e.quota.count,2);
  await f.control('config',{});assert.equal((await f.submit('late-accept-operation')).status,409);assert.ok(!(await f.control('evidence')).trace.includes('abort:called'));
 }finally{await f.control('release?name='+hold);await Promise.allSettled([submit].filter(Boolean) as Promise<Response>[]);await f.dispose();}
});

test('persistent title errors preserve receipt success; repaired replay keeps existing automatic and manual titles',async()=>{
 const f=await fixture();try{
  await f.control('config',{failAutoTitle:'always'});
  const first=await f.submit('metadata-operation','First title');assert.equal(first.status,200);const receipt=await first.json();
  assert.deepEqual(await (await f.submit('metadata-operation','First title')).json(),receipt);
  assert.equal((await f.control('evidence?op=metadata-operation')).title,undefined);
  await f.control('config',{});assert.equal((await f.post('/api/session-title?session=1',{title:'My manual title'})).status,200);
  assert.equal((await f.submit('metadata-operation','First title')).status,200);
  assert.equal((await f.submit('later-title-operation','A later message')).status,200);
  const e=await f.control('evidence?op=metadata-operation');assert.equal(e.title,'First title');assert.equal(e.manualTitle,'My manual title');assert.equal(e.effects,2);assert.equal(e.dispatches,2);assert.equal(e.quota.count,2);
 }finally{await f.dispose();}
});

test('new intent waits for a delayed session-wide Stop to finish before dispatch',{timeout:10000},async()=>{
 const f=await fixture();let stop:Promise<Response>|undefined,submit:Promise<Response>|undefined;
 try{
  await f.control('config',{hold:'abort'});stop=f.post('/api/abort?session=1',{});await f.control('wait?name=abort:entered');
  submit=f.submit('intent-during-stop');await f.control('wait?name=submit-request:1');
  let e=await f.control('evidence?op=intent-during-stop');assert.equal(e.dispatches,0);assert.ok(!e.trace.includes('submit:entered'));
  await f.control('release?name=abort');assert.equal((await stop).status,200);assert.equal((await submit).status,200);
  e=await f.control('evidence?op=intent-during-stop');assert.ok(e.trace.indexOf('abort:finished')<e.trace.indexOf('submit:entered'));assert.equal(e.effects,1);assert.equal(e.quota.count,1);
 }finally{await f.control('release?name=abort');await Promise.allSettled([stop,submit].filter(Boolean) as Promise<Response>[]);await f.dispose();}
});

test('actual owner submit route re-enables workspace after Stop once; receipt replay preserves later Stop',async()=>{
 const f=await fixture();try{
  const stop=()=>f.post('/api/workspaces/aaaaaaaa-aaaa-4aaa-aaaa-aaaaaaaaaaaa?session=1',{action:'cancel',operationId:'a'.repeat(64)});
  assert.equal((await stop()).status,200);
  assert.equal((await f.submit('workspace-new-request','Review the project')).status,200);
  const first=await f.control('evidence?op=workspace-new-request');assert.equal(first.workspaceIntent.blocked,false);
  assert.equal((await stop()).status,200);
  assert.equal((await f.submit('workspace-new-request','Review the project')).status,200);
  assert.equal((await f.control('evidence?op=workspace-new-request')).workspaceIntent.blocked,true);
  assert.equal((await f.submit('workspace-next-request','Continue the project review')).status,200);
  assert.equal((await f.control('evidence?op=workspace-next-request')).workspaceIntent.blocked,false);
 }finally{await f.dispose();}
});
