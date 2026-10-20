// Opt-in offline rehearsal. Argument: isolated install with exact Pi 1.1.0 pins.
// The ordinary app/CI dependency tree remains deduplicated at 1.3.0.
import {mkdtemp,readFile,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';import {join} from 'node:path';import {execFileSync} from 'node:child_process';import {DatabaseSync} from 'node:sqlite';
import {BACKGROUND_CONTEXT as context} from '@earendil-works/chord/context';
import {Harness,createRegistry,defineExtension,defineTool} from '@earendil-works/pi-durable';
import {openNodeSqliteStorage} from '@earendil-works/pi-durable/storage/sqlite/node';
import {createModels} from '@earendil-works/pi-ai/models';import {Type} from '@earendil-works/pi-ai';import {fauxProvider,fauxAssistantMessage} from '@earendil-works/pi-ai/providers/faux';
const runtime=process.argv[2];if(!runtime)throw Error('Pass a separate exact Pi 1.1.0 installation directory');
const directory=await mkdtemp(join(tmpdir(),'pi55-rollback-'));let h;
function restore(file,tables){const db=new DatabaseSync(file);for(const t of tables){db.exec(t.sql);for(const row of t.rows){const keys=Object.keys(row);db.prepare(`INSERT INTO ${t.name} (${keys.join(',')}) VALUES (${keys.map(()=>'?')})`).run(...Object.values(row));}}return db;}
try{
 const image=JSON.parse(await readFile(new URL('./fixtures/pi-1.1-storage.json',import.meta.url),'utf8'));
 const before=join(directory,'restored.sqlite'),upgrading=join(directory,'upgrading.sqlite'),after=join(directory,'upgraded-crash.sqlite');restore(before,image.tables).close();const db=restore(upgrading,image.tables);
 let entered;const ready=new Promise(r=>entered=r),registry=createRegistry();registry.install(defineExtension({name:'migration-crash',tools:[
  defineTool({name:'github_read',description:'Held synthetic read',parameters:Type.Object({}),replay:'safe',execute:async(_a,_api,ctx)=>{entered();await new Promise(r=>ctx.abortSignal.addEventListener('abort',r,{once:true}));return {output:[]};}}),
  defineTool({name:'workspace_exec',description:'Synthetic operation',parameters:Type.Object({}),replay:'unsafe',execute:async()=>({output:[]})})
 ]}));const faux=fauxProvider();faux.setResponses(Array.from({length:8},()=>fauxAssistantMessage('Offline answer')));const models=createModels();models.setProvider(faux.provider);
 h=await Harness.open(await openNodeSqliteStorage(upgrading),{models,registry},context);h.resume();await ready;
 const tables=db.prepare("SELECT name,sql FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%'").all().map(({name,sql})=>({name,sql,rows:db.prepare(`SELECT * FROM ${name}`).all()}));restore(after,tables).close();db.close();await h.close(context);h=undefined;
 const run=(file,mode)=>execFileSync(process.execPath,[new URL('./fixtures/pi-rollback-reader.mjs',import.meta.url).pathname,runtime,file,mode],{encoding:'utf8'}).trim();
 console.log(run(after,'upgraded'));console.log(run(before,'restored'));
 console.log('PASS: code rollback cannot resume new v2 tasks; restoring the pre-upgrade synthetic snapshot reopens history/receipts under 1.1.0.');
}finally{await h?.close(context);await rm(directory,{recursive:true,force:true});}
