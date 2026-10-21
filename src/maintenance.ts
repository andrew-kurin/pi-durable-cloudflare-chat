import {RequestError,jsonObject,readBodyText} from './http-input';

const KEY='maintenance:v1',MAX_ITEMS=100;
export interface MaintenanceEnv {
 MAINTENANCE_MODE?:string;SOURCE_REVISION?:string;WORKER_VERSION?:{id:string};
 Workspaces?:{getByName(id:string):{
  maintenanceReport():Promise<{phase:string;running:boolean|null}>;maintenanceBookmark():Promise<string>;
  maintenancePause(epoch:string):Promise<void>;maintenanceResume(epoch:string):Promise<void>;
  request(request:{action:'cancel';workspaceId:string;operationId:string}):Promise<unknown>;
 }};
}
interface Checkpoint {id:string;revision:string;bookmark:string;capturedAt:number;history:{entries:number;tail:number;conversations:number};workspaces:{id:string;bookmark:string}[]}
interface State {version:1;epoch:string;phase:'paused'|'validating'|'active';checkpoint?:Checkpoint}
type Store=Pick<DurableObjectStorage,'get'|'put'|'list'|'sql'|'getCurrentBookmark'>;
export class Maintenance {
 private tail:Promise<unknown>=Promise.resolve();
 private validation=false;
 private inFlight=0;
 async withActive<T>(work:()=>Promise<T>,epoch?:string){this.inFlight++;try{await this.assertActive(epoch);return await work();}finally{this.inFlight--;}}
 private async bounded<T>(fn:()=>Promise<T>){let timer:ReturnType<typeof setTimeout>|undefined;try{return await Promise.race([fn(),new Promise<never>((_,reject)=>{timer=setTimeout(()=>reject(Error('Maintenance RPC unavailable')),2000);})]);}finally{clearTimeout(timer);}}
 constructor(private store:Store,readonly env:MaintenanceEnv){}
 private serial<T>(fn:()=>Promise<T>){const next=this.tail.then(fn);this.tail=next.catch(()=>{});return next;}
 async state(){const s=await this.store.get<State>(KEY);if(s&&(s.version!==1||!['paused','validating','active'].includes(s.phase)||!s.epoch))throw Error('Invalid maintenance state');return s;}
 private blocked(s:State|undefined){return this.env.MAINTENANCE_MODE==='frozen'||!!this.env.MAINTENANCE_MODE&&(!s||s.phase!=='active'||s.checkpoint?.revision!==(this.env.SOURCE_REVISION??'local'))||!!s&&s.phase!=='active';}
 async paused(){return this.blocked(await this.state());}
 async arrival(){const s=await this.state();return s?.epoch??'initial';}
 async assertActive(epoch?:string){const s=await this.state();if(this.blocked(s)||epoch!==undefined&&epoch!==(s?.epoch??'initial'))throw new RequestError(423,'Maintenance is paused. Saved work and operation reservations are retained.','maintenance_paused');}
 async assertCanOpen(){if(this.validation)return;await this.assertActive();}
 private inspectPi(){
  const names=new Set(this.store.sql.exec<{name:string}>("SELECT name FROM sqlite_master WHERE type='table' AND name IN ('pi_tasks','pi_submissions','pi_entries','pi_conversations','pi_durable_schema')").toArray().map(r=>r.name));
  if(names.size!==5)return {initialized:false,activities:[],pending:[],history:{entries:0,tail:0,conversations:0},truncated:false};
  if(this.store.sql.exec<{version:number}>('SELECT version FROM pi_durable_schema').one().version!==1)throw Error('Unsupported Pi schema');
  const activities=this.store.sql.exec<{id:number;conversation:number;kind:string;status:string}>("SELECT id,conversation_id AS conversation,json_extract(record,'$.kind') AS kind,status FROM pi_tasks WHERE status<>'terminal' ORDER BY id LIMIT 101").toArray();
  const pending=this.store.sql.exec<{id:number;conversation:number;status:string}>("SELECT id,conversation_id AS conversation,status FROM pi_submissions WHERE status IN ('queued','placed') ORDER BY id LIMIT 101").toArray();
  const {entries,tail}=this.store.sql.exec<{entries:number;tail:number}>("SELECT COUNT(*) AS entries,COALESCE(MAX(id),0) AS tail FROM pi_entries").one();
  const {conversations}=this.store.sql.exec<{conversations:number}>("SELECT COUNT(*) AS conversations FROM pi_conversations").one();
  return {initialized:true,activities:activities.slice(0,MAX_ITEMS),pending:pending.slice(0,MAX_ITEMS),history:{entries,tail,conversations},truncated:activities.length>MAX_ITEMS||pending.length>MAX_ITEMS};
 }
 private async inspectWorkspaces(){
  const owners=await this.store.list<string>({prefix:'workspace-owner:',limit:MAX_ITEMS+1});
  const rows=await Promise.all([...owners].slice(0,MAX_ITEMS).map(async([key])=>{
   const id=key.slice('workspace-owner:'.length);
   try{if(!/^[a-f0-9-]{36}$/.test(id)||!this.env.Workspaces)throw Error();const r=await this.bounded(()=>this.env.Workspaces!.getByName(id).maintenanceReport());return {id,phase:r.phase,running:r.running};}
   catch{return {id,phase:'unavailable',running:null};}
  }));
  return {rows,truncated:owners.size>MAX_ITEMS};
 }
 async report(){
  const s=await this.state(),pi=this.inspectPi(),workspaces=await this.inspectWorkspaces();
  const blockers=[...(s?.phase==='active'&&this.blocked(s)?['Active checkpoint does not authorize this deployment; pause a new window.']:[]),...(this.inFlight?['Previously admitted work is still settling.']:[]),...(!pi.initialized?['Pi storage is not initialized.']:[]),...(pi.activities.length||pi.pending.length?['Unsettled Pi work remains; frozen mode cannot open Pi to Stop it.']:[]),...(pi.truncated||workspaces.truncated?['Inspection limit reached.']:[]),...(workspaces.rows.some(r=>r.phase!=='closed'||r.running!==false)?['A workspace is not confirmed closed and stopped.']:[])];
  return {mode:this.env.MAINTENANCE_MODE??'active',revision:this.env.SOURCE_REVISION??'local',workerVersion:this.env.WORKER_VERSION?.id??'local',phase:s?.phase??(this.env.MAINTENANCE_MODE?'paused':'active'),epoch:s?.epoch??'initial',pi,workspaces:workspaces.rows,blockers,checkpoint:s?.checkpoint??null};
 }
 pause(epoch:string){return this.serial(async()=>{if(!/^[a-zA-Z0-9-]{8,80}$/.test(epoch))throw new RequestError(400,'Invalid maintenance operation');const prior=await this.state();if(prior?.phase==='active'&&prior.epoch===epoch)return this.report();if(prior?.phase!=='paused'||prior.epoch!==epoch)await this.store.put(KEY,{version:1,epoch,phase:'paused'} satisfies State);const owners=await this.store.list({prefix:'workspace-owner:',limit:MAX_ITEMS+1});if(owners.size>MAX_ITEMS)throw new RequestError(409,'Workspace inspection limit reached; remain paused');await Promise.all([...owners].map(([key])=>this.bounded(async()=>{if(!this.env.Workspaces)throw Error('Workspace namespace unavailable');await this.env.Workspaces.getByName(key.slice('workspace-owner:'.length)).maintenancePause(epoch);})));return this.report();});}
 checkpoint(epoch:string){return this.serial(async()=>{
  const s=await this.state();if(!s||s.phase!=='paused'||s.epoch!==epoch)throw new RequestError(409,'Pause this maintenance operation before checkpointing');
  const r=await this.report();if(r.blockers.length)throw new RequestError(409,r.blockers.join(' '));
  if(s.checkpoint)return r;
  const workspaces=await Promise.all(r.workspaces.map(w=>this.bounded(async()=>{const bookmark=await this.env.Workspaces!.getByName(w.id).maintenanceBookmark();if(typeof bookmark!=='string'||!bookmark)throw Error('Native workspace checkpoint unavailable');return {id:w.id,bookmark};})));
  const bookmark=await this.store.getCurrentBookmark();if(typeof bookmark!=='string'||!bookmark)throw Error('Native checkpoint unavailable');
  s.checkpoint={id:crypto.randomUUID(),revision:r.revision,bookmark,capturedAt:Date.now(),history:r.pi.history,workspaces};await this.store.put('maintenance-checkpoint:v1:'+s.checkpoint.id,s.checkpoint);await this.store.put(KEY,s);return this.report();
 });}
 private matchesCheckpoint(r:Awaited<ReturnType<Maintenance['report']>>,c:Checkpoint){return JSON.stringify(r.pi.history)===JSON.stringify(c.history)&&JSON.stringify(r.workspaces.map(w=>w.id).sort())===JSON.stringify(c.workspaces.map(w=>w.id).sort());}
 resume(epoch:string,checkpointId:string,workerVersion:string,validate:()=>Promise<void>){return this.serial(async()=>{
  const s=await this.state();if(this.env.MAINTENANCE_MODE==='frozen')throw new RequestError(409,'Deploy the active entrypoint before explicit resume; frozen mode never opens Pi');
  if(s?.phase==='active'&&s.epoch===epoch&&s.checkpoint?.id===checkpointId&&workerVersion===(this.env.WORKER_VERSION?.id??'local')&&s.checkpoint.revision===(this.env.SOURCE_REVISION??'local'))return this.report();
  if(!s||s.phase!=='paused'||s.epoch!==epoch||s.checkpoint?.id!==checkpointId||s.checkpoint.revision!==(this.env.SOURCE_REVISION??'local')||workerVersion!==(this.env.WORKER_VERSION?.id??'local'))throw new RequestError(409,'Maintenance checkpoint, revision or serving version changed');
  const report=await this.report();if(report.blockers.length||!this.matchesCheckpoint(report,s.checkpoint))throw new RequestError(409,'Saved work changed or remains unsettled; remain paused for review');
  s.phase='validating';await this.store.put(KEY,s);
  try{this.validation=true;await validate();const checked=await this.report();if(checked.blockers.length||!this.matchesCheckpoint(checked,s.checkpoint))throw Error('Read-only validation changed saved work');await Promise.all(checked.workspaces.map(w=>this.bounded(()=>this.env.Workspaces!.getByName(w.id).maintenanceResume(epoch))));s.phase='active';await this.store.put(KEY,s);return this.report();}
  catch(error){s.phase='paused';await this.store.put(KEY,s);throw error;}finally{this.validation=false;}
 });}
 async handle(request:Request,callbacks:{validate:()=>Promise<void>;stop?:(sessions:string[])=>Promise<void>}){
  if(request.method==='GET')return Response.json(await this.report());
  if(request.method!=='POST')return new Response('Method not allowed',{status:405});
  const raw=await readBodyText(request,2000,{maxBytes:2000,message:'Maintenance request too large'});const b=jsonObject(raw);
  if(b.action==='pause'&&typeof b.operationId==='string')return Response.json(await this.pause(b.operationId));
  if(b.action==='checkpoint'&&typeof b.epoch==='string')return Response.json(await this.checkpoint(b.epoch));
  if(b.action==='resume'&&typeof b.epoch==='string'&&typeof b.checkpointId==='string'&&typeof b.workerVersion==='string')return Response.json(await this.resume(b.epoch,b.checkpointId,b.workerVersion,callbacks.validate));
  if(b.action==='stop'){
   if(!callbacks.stop)throw new RequestError(409,'Pi is not already open. Frozen maintenance cannot open it to Stop; remain paused for a compatible drain release.');
   return this.serial(async()=>{const s=await this.state();if(s?.phase!=='paused'||s.epoch!==b.epoch)throw new RequestError(409,'Maintenance window changed; refresh before draining');
    const r=await this.report();this.inFlight++;try{await callbacks.stop!([...new Set([...r.pi.activities,...r.pi.pending].map(a=>String(a.conversation)))]);}finally{this.inFlight--;}return Response.json(await this.report());});
  }
  if(b.action==='cancel_workspace'&&typeof b.workspaceId==='string'&&typeof b.operationId==='string'){
   if(!await this.store.get('workspace-owner:'+b.workspaceId)||!/^[a-f0-9-]{36}$/.test(b.workspaceId)||!/^[a-f0-9]{64}$/.test(b.operationId)||!this.env.Workspaces)throw new RequestError(400,'Invalid owned workspace cancellation');
   const {workspaceId,operationId}=b;return this.serial(async()=>{const s=await this.state();if(s?.phase!=='paused'||s.epoch!==b.epoch)throw new RequestError(409,'Maintenance window changed; refresh before cancellation');await this.bounded(()=>this.env.Workspaces!.getByName(workspaceId).request({action:'cancel',workspaceId,operationId}));return Response.json(await this.report());});
  }
  throw new RequestError(400,'Invalid maintenance action');
 }
}
