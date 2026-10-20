import {test} from 'node:test';
import assert from 'node:assert/strict';
import {readFile,mkdtemp,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {DatabaseSync} from 'node:sqlite';
import {BACKGROUND_CONTEXT as context} from '@earendil-works/chord/context';
import {Harness,createRegistry,defineExtension,defineTool} from '@earendil-works/pi-durable';
import {openNodeSqliteStorage} from '@earendil-works/pi-durable/storage/sqlite/node';
import {createModels} from '@earendil-works/pi-ai/models';
import {Type} from '@earendil-works/pi-ai';
import {fauxProvider,fauxAssistantMessage} from '@earendil-works/pi-ai/providers/faux';
import {readTools} from '../src/read-tools';
import {ChatProjection} from '../src/projector';

test('real 1.1 SQLite crash image migrates to 1.3 without replaying unsafe intent or losing legacy read memos and receipts',{timeout:10000},async()=>{
 const directory=await mkdtemp(join(tmpdir(),'pi55-migration-')),file=join(directory,'migration.sqlite');
 const image=JSON.parse(await readFile(new URL('./fixtures/pi-1.1-storage.json',import.meta.url),'utf8'));
 assert.equal(image.version,'1.1.0');
 const db=new DatabaseSync(file);
 for(const table of image.tables){db.exec(table.sql);for(const row of table.rows){const keys=Object.keys(row);db.prepare(`INSERT INTO ${table.name} (${keys.join(',')}) VALUES (${keys.map(()=>'?').join(',')})`).run(...Object.values(row) as any[]);}}
 const baselineEntries=db.prepare('SELECT record FROM entries ORDER BY id').all().map((r:any)=>JSON.parse(r.record));
 const baselineReceipts=db.prepare('SELECT record FROM submissions ORDER BY id').all().map((r:any)=>JSON.parse(r.record));
 assert.equal(db.prepare('SELECT dispatches FROM app_operation_receipts').get()!.dispatches,1);
 const legacyTools=db.prepare('SELECT record FROM tasks').all().map((r:any)=>JSON.parse(r.record)).filter(t=>t.kind==='pi.tool');
 assert.deepEqual(legacyTools.map(t=>[t.version,t.state.status,t.state.checkpoint.replay]),[[1,'running','unsafe'],[1,'running','safe'],[1,'pending',undefined]]);
 const registry=createRegistry();let newUnsafe=0,reads=0;
 registry.install(defineExtension({name:'migration-workspace',tools:[defineTool({name:'legacy_pending',description:'Pending v1 task',parameters:Type.Object({}),replay:'safe',execute:async()=>({output:[{type:'text',text:'pending v1 task migrated'}]})}),defineTool({name:'workspace_exec',description:'Synthetic operation',parameters:Type.Object({}),replay:'unsafe',executionMode:'sequential',execute:async()=>{newUnsafe++;db.exec('UPDATE app_operation_receipts SET dispatches=dispatches+1');return {output:[{type:'text',text:'new queued call ran once'}]};}})]}));
 const toolStore={get:async()=>undefined,put:async()=>{},transaction:async(fn:any)=>fn(toolStore)};
 registry.install(readTools(toolStore as any,{},async()=>{reads++;throw Error('No external reads allowed');}));
 const faux=fauxProvider();faux.setResponses(Array.from({length:8},()=>fauxAssistantMessage('Offline resumed answer.')));
 const models=createModels({authContext:{env:async()=>undefined,fileExists:async()=>false}});models.setProvider(faux.provider);
 const open=async()=>Harness.open(await openNodeSqliteStorage(file),{models,registry,settings:{retry:{enabled:false}}},context);
 let h=await open();
 try{
  const root=await h.root(context),child=await h.conversation(15 as any,context);assert.ok(child);
  for(const [conversation,id] of [[root,'legacy-operation'],[child,'legacy-read'],[root,'legacy-queued']] as const){
   const old=baselineReceipts.find((r:any)=>r.requestId===id);assert.ok(old);
   const result=await(await conversation.submit({type:'input',content:'Must deduplicate',requestId:id},context)).wait(context);
   assert.equal(result.status,'done',JSON.stringify(result));
   assert.equal(db.prepare('SELECT id FROM submissions WHERE request_id=?').get(JSON.stringify(id))!.id,old.id);
  }
  assert.equal(reads,0,'safe read replay must use the old durable memo');
  assert.equal(newUnsafe,1,'only the previously queued call executes; the old unsafe intent is interrupted');
  assert.equal(db.prepare('SELECT dispatches FROM app_operation_receipts').get()!.dispatches,2);
  for(const old of legacyTools){const task=await h.getTask(old.id,context);assert.equal(task!.version,2);assert.equal((task!.input as any).kind,'model');assert.equal(task!.state.status,'terminal');assert.equal((task!.state as any).outcome.result.kind,'model');}
  const safeEntries=await child.entries({order:'ascending'},100,undefined,context);
  assert.ok(JSON.stringify(safeEntries.items).includes('retained legacy memo output'));
  const all=db.prepare('SELECT record FROM entries ORDER BY id').all().map((r:any)=>JSON.parse(r.record));
  for(const old of baselineEntries)assert.deepEqual(all.find(e=>e.id===old.id),old,'retained original entry and metadata');
  const p=new ChatProjection();all.filter(e=>e.conversationId===1).forEach(e=>p.entry(e));assert.ok(p.view().messages.some(m=>m.text==='Retain the original migration history.'));
  const before=db.prepare('SELECT COUNT(*) AS n FROM submissions').get()!.n;
  await h.close(context);h=await open();await(await(await h.root(context)).submit({type:'input',content:'Must deduplicate again',requestId:'legacy-operation'},context)).wait(context);
  assert.equal(db.prepare('SELECT COUNT(*) AS n FROM submissions').get()!.n,before);assert.equal(newUnsafe,1);assert.equal(reads,0);
 }finally{await h.close(context);db.close();await rm(directory,{recursive:true,force:true});}
});
