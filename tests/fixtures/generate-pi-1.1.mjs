// Run only against 1.1.0, with synthetic data and an offline faux provider.
// Captures a crash image while tools are running; does not gracefully close it.
import {readFileSync,writeFileSync,mkdtempSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {DatabaseSync} from 'node:sqlite';
import {BACKGROUND_CONTEXT as context} from '@earendil-works/chord/context';
import {Harness,createRegistry,defineExtension,defineTool,configure,ToolTask} from '@earendil-works/pi-durable';
import {openNodeSqliteStorage} from '@earendil-works/pi-durable/storage/sqlite/node';
import {createModels} from '@earendil-works/pi-ai/models';
import {Type} from '@earendil-works/pi-ai';
import {fauxProvider,fauxAssistantMessage,fauxToolCall} from '@earendil-works/pi-ai/providers/faux';
if(JSON.parse(readFileSync(new URL('../../node_modules/@earendil-works/pi-durable/package.json',import.meta.url))).version!=='1.1.0')throw Error('Generate only with the baseline 1.1.0 dependency tree');
const directory=mkdtempSync(join(tmpdir(),'pi55-legacy-')),file=join(directory,'legacy.sqlite');
const db=new DatabaseSync(file);db.exec('CREATE TABLE app_operation_receipts (operation TEXT PRIMARY KEY, dispatches INTEGER NOT NULL); INSERT INTO app_operation_receipts VALUES (\'legacy-unsafe\',0)');
let entered=0,wake;const ready=new Promise(r=>wake=r),hold=()=>{if(++entered===2)wake();return new Promise(()=>{});};
const registry=createRegistry();registry.install(defineExtension({name:'migration-fixture',tools:[
 defineTool({name:'workspace_exec',parameters:Type.Object({}),description:'Synthetic unsafe operation',replay:'unsafe',executionMode:'sequential',execute:async()=>{db.exec("UPDATE app_operation_receipts SET dispatches=dispatches+1");return hold();}}),
 defineTool({name:'github_read',parameters:Type.Object({}),description:'Synthetic public read',replay:'safe',execute:async(_args,api,ctx)=>{await api.memo('read-result',{content:[{type:'text',text:'retained legacy memo output'}]},ctx);return hold();}})
]}));
const faux=fauxProvider();faux.setResponses([
 fauxAssistantMessage([fauxToolCall('workspace_exec',{}, {id:'legacy-unsafe-running'}),fauxToolCall('workspace_exec',{}, {id:'legacy-unsafe-queued'})],{stopReason:'toolUse'}),
 fauxAssistantMessage([fauxToolCall('github_read',{}, {id:'legacy-safe-running'})],{stopReason:'toolUse'})
]);const models=createModels();models.setProvider(faux.provider);
const h=await Harness.open(await openNodeSqliteStorage(file),{models,registry,settings:{retry:{enabled:false}}},context);
const root=await h.root(context,{agent:{model:{provider:'faux',modelId:'faux-1'},instructions:'Retain the legacy system baseline.'}});
await(await root.submit({type:'write',requestId:'legacy-history',entry:{kind:'pi.user',model:[{role:'user',content:'Retain the original migration history.',timestamp:1}],data:{migration:'1.1.0'}}},context)).wait(context);
await root.submit({type:'input',content:'Synthetic unsafe task',requestId:'legacy-operation'},context);
// Wait for the first held tool before assigning the second provider response.
while(entered<1)await new Promise(r=>setTimeout(r,1));
const child=await h.createConversation({ownership:{kind:'conversation',conversationId:root.id}},context);
await h.commit(tx=>configure(tx,child.id,{model:{provider:'faux',modelId:'faux-1'}}),context);
await child.submit({type:'input',content:'Synthetic safe read',requestId:'legacy-read'},context);await ready;
await root.submit({type:'input',content:'Queued before upgrade',requestId:'legacy-queued'},context);
// Capture one genuinely pending v1 task on the commit publication boundary,
// before the scheduler can reserve it. It is independent of the held run.
const pendingConversation=await h.createConversation({ownership:{kind:'session'}},context);
await h.commit(tx=>configure(tx,pendingConversation.id,{model:{provider:'faux',modelId:'faux-1'}}),context);
const pendingEntry=await(await pendingConversation.submit({type:'write',requestId:'legacy-pending-entry',entry:{kind:'pi.assistant',model:[fauxAssistantMessage([fauxToolCall('legacy_pending',{}, {id:'legacy-pending-call'})],{stopReason:'toolUse'})]}},context)).wait(context);
let capture=false;
h.subscribeCommits(()=>{if(!capture)return;
 const tables=db.prepare("SELECT name,sql FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%' ORDER BY name").all().map(({name,sql})=>({name,sql,rows:db.prepare(`SELECT * FROM ${name}`).all()}));
 const image={version:'1.1.0',description:'Real 1.1.0 crash snapshot: unsafe execute intent, sequential queued call, safe read-result memo, queued submission, pending v1 tool task, retained history and receipts.',tables};
 writeFileSync(new URL('./pi-1.1-storage.json',import.meta.url),JSON.stringify(image,null,2)+'\n');
 console.log(JSON.stringify({tables:tables.map(t=>[t.name,t.rows.length]),tools:tables.find(t=>t.name==='tasks').rows.map(t=>JSON.parse(t.record)).filter(t=>t.kind==='pi.tool')},null,2));
 rmSync(directory,{recursive:true,force:true});process.exit(0);
});
capture=true;
await pendingConversation.commit(tx=>tx.createTask(ToolTask,{assistant:pendingEntry.entry,callId:'legacy-pending-call'},{ownership:{kind:'conversation'}}),context);
