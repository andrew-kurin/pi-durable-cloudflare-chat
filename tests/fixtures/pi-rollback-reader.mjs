// Child process deliberately loads the separately installed 1.1.0 runtime.
import assert from 'node:assert/strict';
import {pathToFileURL} from 'node:url';
import {DatabaseSync} from 'node:sqlite';
const [runtime,file,mode]=process.argv.slice(2);
const load=(pkg,path)=>import(pathToFileURL(`${runtime}/node_modules/@earendil-works/${pkg}/dist/${path}`));
const {BACKGROUND_CONTEXT:context}=await load('chord','context/index.js');
const {Harness,createRegistry,defineExtension,defineTool}=await load('pi-durable','index.js');
const {openNodeSqliteStorage}=await load('pi-durable','storage/sqlite/node.js');
const {createModels}=await load('pi-ai','models.js');
const {Type}=await load('pi-ai','index.js');
const {fauxProvider,fauxAssistantMessage}=await load('pi-ai','providers/faux.js');
const faux=fauxProvider();faux.setResponses(Array.from({length:8},()=>fauxAssistantMessage('Offline 1.1 restore answer')));const models=createModels();models.setProvider(faux.provider);
const registry=createRegistry();registry.install(defineExtension({name:'restore',tools:[
 defineTool({name:'github_read',description:'Synthetic legacy read',parameters:Type.Object({}),replay:'safe',execute:async(_args,api,ctx)=>await api.memo('read-result',ctx)??{content:[{type:'text',text:'safe restore'}]}}),
 defineTool({name:'workspace_exec',description:'Synthetic legacy operation',parameters:Type.Object({}),replay:'unsafe',executionMode:'sequential',execute:async()=>({content:[{type:'text',text:'new queued call'}]})})
]}));
const h=await Harness.open(await openNodeSqliteStorage(file),{models,registry,settings:{retry:{enabled:false}}},context);
try{
 const inspected=await h.inspect(context),tooNew=inspected.tasks.filter(t=>t.state.kind==='blocked'&&t.state.reason==='task_too_old');
 if(mode==='upgraded'){assert.ok(tooNew.length>0);console.log(JSON.stringify({mode,tooNew:tooNew.length,reason:'task_too_old'}));}
 else{
  assert.equal(tooNew.length,0);const root=await h.root(context);const result=await(await root.submit({type:'input',content:'Deduplicate restored request',requestId:'legacy-operation'},context)).wait(context);assert.equal(result.status,'done');
  const entries=await root.entries({order:'ascending'},100,undefined,context);assert.ok(JSON.stringify(entries).includes('Retain the original migration history.'));
  const db=new DatabaseSync(file);const request=db.prepare('SELECT record FROM submissions WHERE request_id=?').get(JSON.stringify('legacy-operation'));assert.ok(request);assert.notEqual(JSON.parse(request.record).entry,undefined);assert.equal(db.prepare('SELECT dispatches FROM app_operation_receipts').get().dispatches,1);db.close();
  console.log(JSON.stringify({mode,history:true,receipt:true,preUpgradeFence:1}));
 }
}finally{await h.close(context);}
