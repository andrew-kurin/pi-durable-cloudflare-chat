import {test} from 'node:test';
import assert from 'node:assert/strict';
import {DatabaseSync} from 'node:sqlite';
import {Maintenance,type MaintenanceEnv} from '../src/maintenance';

const epoch='maintenance-window-1',revision='a'.repeat(40),version='serving-version-1';
function fixture(){
 const db=new DatabaseSync(':memory:'),data=new Map<string,any>();let bookmarks=0,failBookmark=false;
 db.exec(`CREATE TABLE pi_tasks(id INTEGER,conversation_id INTEGER,status TEXT,record TEXT);CREATE TABLE pi_submissions(id INTEGER,conversation_id INTEGER,status TEXT);CREATE TABLE pi_entries(id INTEGER);CREATE TABLE pi_conversations(id INTEGER);CREATE TABLE pi_durable_schema(version INTEGER);INSERT INTO pi_durable_schema VALUES(1);INSERT INTO pi_conversations VALUES(1);INSERT INTO pi_entries VALUES(10);`);
 const sql={exec(query:string,...args:any[]){const rows=db.prepare(query).all(...args);return {toArray:()=>rows,one:()=>{assert.equal(rows.length,1);return rows[0];}};}};
 const store={sql,get:async(key:string)=>structuredClone(data.get(key)),put:async(key:string,value:any)=>{data.set(key,structuredClone(value));},list:async({prefix,limit}:any)=>new Map([...data].filter(([key])=>key.startsWith(prefix)).slice(0,limit)),getCurrentBookmark:async()=>{bookmarks++;if(failBookmark)throw Error('Native PITR unavailable');return 'native-bookmark-stub';}} as any;
 const env:MaintenanceEnv={MAINTENANCE_MODE:'active',SOURCE_REVISION:revision,WORKER_VERSION:{id:version}};
 const gate=new Maintenance(store,env);
 data.set('runner-round:v1:retained',{digest:'do not clear'});data.set('admission:1:retained',{receipt:'keep receipt'});
 return {gate,env,data,db,store,failBookmark:()=>{failBookmark=true;},bookmarks:()=>bookmarks};
}
async function ready(f:ReturnType<typeof fixture>){await f.gate.pause(epoch);return (await f.gate.checkpoint(epoch)).checkpoint!;}
test('explicit active deployment fails closed before the first checkpoint and freezes across reconstruction',async t=>{
 const f=fixture();t.after(()=>f.db.close());assert.equal(await f.gate.paused(),true);await assert.rejects(f.gate.assertCanOpen(),/Maintenance/);
 await f.gate.pause(epoch);const rebuilt=new Maintenance(f.store,f.env);assert.equal(await rebuilt.paused(),true);await assert.rejects(rebuilt.assertCanOpen(),/Maintenance/);assert.equal(f.bookmarks(),0);
});
test('native checkpoint retains immutable metadata, receipts and fences; capture is idempotent',async t=>{
 const f=fixture();t.after(()=>f.db.close());const checkpoint=await ready(f);assert.equal(f.bookmarks(),1);assert.equal(checkpoint.bookmark,'native-bookmark-stub');assert.equal((await f.gate.checkpoint(epoch)).checkpoint!.id,checkpoint.id);assert.equal(f.bookmarks(),1);
 assert.deepEqual(f.data.get('maintenance-checkpoint:v1:'+checkpoint.id),checkpoint);assert.deepEqual(f.data.get('runner-round:v1:retained'),{digest:'do not clear'});assert.deepEqual(f.data.get('admission:1:retained'),{receipt:'keep receipt'});
 await f.gate.pause('maintenance-window-2');assert.deepEqual(f.data.get('maintenance-checkpoint:v1:'+checkpoint.id),checkpoint);
});
test('unfinished generations, compaction, tools and queued input block checkpoints without leaking input',async t=>{
 const f=fixture();t.after(()=>f.db.close());for(const [id,kind] of [[1,'pi.generation'],[2,'pi.compaction'],[3,'pi.tool']] as const)f.db.prepare('INSERT INTO pi_tasks VALUES(?,?,?,?)').run(id,1,'waiting',JSON.stringify({kind,input:'SECRET_PROMPT'}));f.db.exec("INSERT INTO pi_submissions VALUES(4,1,'queued')");
 await f.gate.pause(epoch);const r=await f.gate.report();assert.equal(r.pi.activities.length,3);assert.equal(r.pi.pending.length,1);assert.doesNotMatch(JSON.stringify(r),/SECRET_PROMPT/);await assert.rejects(f.gate.checkpoint(epoch),/Unsettled Pi/);assert.equal(f.bookmarks(),0);
 await assert.rejects(f.gate.handle(new Request('https://chat.test/api/maintenance',{method:'POST',body:JSON.stringify({action:'stop'})}),{validate:async()=>{throw Error('must not open');}}),/cannot open/);
});
test('checkpoint failures and failed read-only activation stay paused',async t=>{
 const f=fixture();t.after(()=>f.db.close());await f.gate.pause(epoch);f.failBookmark();await assert.rejects(f.gate.checkpoint(epoch),/PITR unavailable/);assert.equal((await f.gate.state())!.phase,'paused');
 const g=fixture();t.after(()=>g.db.close());const c=await ready(g);await assert.rejects(g.gate.resume(epoch,c.id,version,async()=>{throw Error('Pi validation failed');}),/validation failed/);assert.equal((await g.gate.state())!.phase,'paused');await assert.rejects(g.gate.assertCanOpen(),/Maintenance/);
});
test('resume is bound to checkpoint, source and serving version; concurrent retries validate once',async t=>{
 const f=fixture();t.after(()=>f.db.close());const c=await ready(f);let checks=0;
 await assert.rejects(f.gate.resume(epoch,c.id,'stale-version',async()=>{checks++;}),/changed/);f.env.SOURCE_REVISION='b'.repeat(40);await assert.rejects(f.gate.resume(epoch,c.id,version,async()=>{checks++;}),/changed/);f.env.SOURCE_REVISION=revision;
 const validate=async()=>{checks++;await f.gate.assertCanOpen();await assert.rejects(f.gate.assertActive(),/Maintenance/);};
 const [a,b]=await Promise.all([f.gate.resume(epoch,c.id,version,validate),f.gate.resume(epoch,c.id,version,validate)]);assert.equal(a.phase,'active');assert.equal(b.phase,'active');assert.equal(checks,1);await f.gate.pause(epoch);assert.equal((await f.gate.state())!.phase,'active','replaying the old Pause cannot undo successful resume');
});
test('pre-pause arrivals stay rejected after resume; interrupted validation never resumes on restart',async t=>{
 const f=fixture();t.after(()=>f.db.close());const arrival=await f.gate.arrival(),c=await ready(f);await f.gate.resume(epoch,c.id,version,async()=>{});await assert.rejects(f.gate.assertActive(arrival),/Maintenance/);await f.gate.assertActive(await f.gate.arrival());
 const s=await f.gate.state();f.data.set('maintenance:v1',{...s,phase:'validating'});const rebuilt=new Maintenance(f.store,f.env);assert.equal(await rebuilt.paused(),true);await assert.rejects(rebuilt.assertCanOpen(),/Maintenance/);
});
test('unknown/running workspaces and bounded incomplete inspections refuse activation',async t=>{
 const f=fixture();t.after(()=>f.db.close());const id='a'.repeat(36);f.data.set('workspace-owner:'+id,'1');let phase='ready',running=true,pauses=0,resumes=0;
 f.env.Workspaces={getByName:()=>({maintenanceReport:async()=>({phase,running}),maintenancePause:async()=>{pauses++;},maintenanceResume:async()=>{resumes++;},maintenanceBookmark:async()=> 'workspace-bookmark-stub',request:async()=>({})})};await f.gate.pause(epoch);await assert.rejects(f.gate.checkpoint(epoch),/not confirmed/);assert.equal(pauses,1);
 phase='closed';running=false;const c=(await f.gate.checkpoint(epoch)).checkpoint!;assert.deepEqual(c.workspaces,[{id,bookmark:'workspace-bookmark-stub'}]);await f.gate.resume(epoch,c.id,version,async()=>{});assert.equal(resumes,1);
 for(let i=0;i<101;i++)f.db.prepare('INSERT INTO pi_tasks VALUES(?,?,?,?)').run(i+1,1,'pending',JSON.stringify({kind:'pi.tool'}));await f.gate.pause('maintenance-window-2');const r=await f.gate.report();assert.equal(r.pi.activities.length,100);assert.equal(r.pi.truncated,true);await assert.rejects(f.gate.checkpoint('maintenance-window-2'),/Inspection limit/);
});
test('frozen mode can inspect and capture but never open Pi or resume',async t=>{
 const f=fixture();t.after(()=>f.db.close());f.env.MAINTENANCE_MODE='frozen';const c=await ready(f);await assert.rejects(f.gate.assertCanOpen(),/Maintenance/);await assert.rejects(f.gate.resume(epoch,c.id,version,async()=>{throw Error('Must never run');}),/frozen mode never opens/i);
});
test('checkpoint metadata rejects changed history and request input is bounded',async t=>{
 const f=fixture();t.after(()=>f.db.close());const c=await ready(f);f.db.exec('INSERT INTO pi_entries VALUES(11)');await assert.rejects(f.gate.resume(epoch,c.id,version,async()=>{}),/Saved work changed/);let canceled=false;
 const body=new ReadableStream({start(controller){controller.enqueue(new Uint8Array(2001));},cancel(){canceled=true;}});await assert.rejects(f.gate.handle(new Request('https://chat.test/api/maintenance',{method:'POST',body,duplex:'half'} as any),{validate:async()=>{}}),/too large/);assert.equal(canceled,true);assert.equal(body.locked,false);
});
test('pause blocks new admission and checkpoint waits for admitted late callbacks to settle',async t=>{
 const f=fixture();t.after(()=>f.db.close());f.env.MAINTENANCE_MODE=undefined;let release!:()=>void;const held=new Promise<void>(resolve=>release=resolve);const job=f.gate.withActive(async()=>{await held;f.db.exec('INSERT INTO pi_entries VALUES(11)');});await new Promise(resolve=>setImmediate(resolve));
 await f.gate.pause(epoch);await assert.rejects(f.gate.withActive(async()=>{throw Error('must never dispatch');}),/Maintenance/);await assert.rejects(f.gate.checkpoint(epoch),/still settling/);assert.equal(f.bookmarks(),0);release();await job;const c=(await f.gate.checkpoint(epoch)).checkpoint!;assert.equal(c.history.tail,11);
});
test('stale maintenance Stop and cleanup cannot cancel work after successful resume or in another window',async t=>{
 const f=fixture();t.after(()=>f.db.close());let stops=0,cancels=0;const id='a'.repeat(36);f.data.set('workspace-owner:'+id,'1');f.env.Workspaces={getByName:()=>({maintenanceReport:async()=>({phase:'closed',running:false}),maintenancePause:async()=>{},maintenanceResume:async()=>{},maintenanceBookmark:async()=>'native-stub',request:async()=>{cancels++;}})};const c=await ready(f);
 const request=(body:any)=>f.gate.handle(new Request('https://chat.test/api/maintenance',{method:'POST',body:JSON.stringify(body)}),{validate:async()=>{},stop:async()=>{stops++;}});
 await assert.rejects(request({action:'stop',epoch:'older-window'}),/window changed/);await assert.rejects(request({action:'cancel_workspace',epoch:'older-window',workspaceId:id,operationId:'a'.repeat(64)}),/window changed/);
 await f.gate.resume(epoch,c.id,version,async()=>{});await assert.rejects(request({action:'stop',epoch}),/window changed/);await assert.rejects(request({action:'cancel_workspace',epoch,workspaceId:id,operationId:'a'.repeat(64)}),/window changed/);assert.equal(stops,0);assert.equal(cancels,0);
});
test('resume refuses a workspace inventory added after capture without discarding its old checkpoint',async t=>{
 const f=fixture();t.after(()=>f.db.close());const c=await ready(f),id='b'.repeat(36);f.data.set('workspace-owner:'+id,'1');f.env.Workspaces={getByName:()=>({maintenanceReport:async()=>({phase:'closed',running:false}),maintenancePause:async()=>{},maintenanceResume:async()=>{throw Error('must not activate');},maintenanceBookmark:async()=>'native-stub',request:async()=>{}})};
 await assert.rejects(f.gate.resume(epoch,c.id,version,async()=>{throw Error('must not open');}),/Saved work changed/);assert.deepEqual(f.data.get('maintenance-checkpoint:v1:'+c.id),c);assert.equal((await f.gate.state())!.phase,'paused');
});
