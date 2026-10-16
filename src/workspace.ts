import type {WorkspaceRequest} from './workspace-tools';
export interface WorkspaceLimits {taskMs:number;commandMs:number;idleMs:number;warningMs:number;graceMs:number;artifactMs:number;operationMs:number;setupMs:number}
export const DEFAULT_WORKSPACE_LIMITS:WorkspaceLimits={taskMs:90*60000,commandMs:30*60000,idleMs:15*60000,warningMs:5*60000,graceMs:10000,artifactMs:20000,operationMs:30000,setupMs:5*60000};
export function workspaceLimits(raw?:string):WorkspaceLimits{const limits={...DEFAULT_WORKSPACE_LIMITS};if(!raw)return limits;const config=JSON.parse(raw);const maxima:WorkspaceLimits={taskMs:6*3600000,commandMs:2*3600000,idleMs:3600000,warningMs:15*60000,graceMs:30000,artifactMs:60000,operationMs:60000,setupMs:10*60000};for(const key of Object.keys(config) as (keyof WorkspaceLimits)[]){if(!(key in limits)||!Number.isInteger(config[key])||config[key]<=0||config[key]>maxima[key])throw Error('Invalid workspace limit');limits[key]=config[key]}return limits}
export type RunState='dispatching'|'running'|'done'|'interrupted';
export interface WorkspaceRun {id:string;state:RunState;command:string;startedAt:number;deadline:number;exitCode?:number;reason?:string}
export interface WorkspaceState {id:string;session:string;repo:string;createdAt?:number;phase:'initializing'|'ready'|'stopping'|'closed';base?:string;deadline:number;lastUsed:number;active?:string;runs:Record<string,WorkspaceRun>;gaps:string[];stopAt?:number;cleanupAttempted?:boolean;untouched?:boolean;stopReason?:'expired'|'cancelled'|'interrupted'|'initialization-failed'}
export interface WorkspaceExport {base:string;patch:string;logs:Record<string,string>;gaps:string[]}
export interface WorkspaceAdapter {
 open(repo:string,signal:AbortSignal):Promise<string>;
 read(path:string,signal:AbortSignal):Promise<string>;
 edit(path:string,oldText:string,newText:string,signal:AbortSignal):Promise<void>;
 dispatch(runId:string,argv:string[],cwd:string,signal:AbortSignal):Promise<void>;
 status(runId:string,signal:AbortSignal):Promise<{state:'running'|'starting'|'exited'|'lost';exitCode?:number}>;
 logs(runId:string,stream:'stdout'|'stderr',signal:AbortSignal):Promise<string>;
 terminate(runId:string,signal:AbortSignal):Promise<void>;
 collect(base:string,runIds:string[],signal:AbortSignal):Promise<WorkspaceExport>;
 stop():Promise<void>;
 keepAlive(idleMs:number):Promise<void>;
}
export interface WorkspaceStore {get<T>(key:string):Promise<T|undefined>;put<T>(key:string,value:T):Promise<void>;setAlarm(time:number):Promise<void>;deleteAlarm():Promise<void>}
export function projectPath(path:string){if(typeof path!=='string'||path.length>300||path.startsWith('/')||path.includes('\\')||/[\x00-\x1f]/.test(path)||path.split('/').some(x=>x==='..'||x==='.git'))throw Error('Use a relative project path outside .git');return path||'.'}
async function bounded<T>(fn:(signal:AbortSignal)=>Promise<T>,ms:number,c=new AbortController()):Promise<T>{let timer:ReturnType<typeof setTimeout>;let abort:()=>void;try{return await Promise.race([fn(c.signal),new Promise<never>((_,reject)=>{abort=()=>reject(Error('Workspace operation interrupted'));c.signal.addEventListener('abort',abort,{once:true});timer=setTimeout(()=>{c.abort();reject(Error('Workspace operation timed out'))},ms)})])}finally{clearTimeout(timer!);c.signal.removeEventListener('abort',abort!);}}
export class WorkspaceController {
 private tail:Promise<unknown>=Promise.resolve();
 private activeAbort?:AbortController;
 constructor(private store:WorkspaceStore,private adapter:WorkspaceAdapter,readonly limits=DEFAULT_WORKSPACE_LIMITS,private now=()=>Date.now()){}
 private serial<T>(fn:()=>Promise<T>):Promise<T>{const p=this.tail.then(fn);this.tail=p.catch(()=>{});return p}
 private async state(){const s=await this.store.get<WorkspaceState>('state');if(!s)throw Error('Workspace not opened');return s}
 private async save(s:WorkspaceState){s.gaps=s.gaps.slice(-100);await this.store.put('state',s);if(s.phase==='closed')await this.store.deleteAlarm();else await this.store.setAlarm(Math.min(this.now()+30000,s.stopAt??s.deadline));}
 private async io<T>(fn:(signal:AbortSignal)=>Promise<T>,ms=this.limits.operationMs){const c=new AbortController();this.activeAbort=c;try{return await bounded(fn,ms,c)}finally{if(this.activeAbort===c)this.activeAbort=undefined}}
 open(id:string,session:string,repo:string){return this.serial(async()=>{
  const prior=await this.store.get<WorkspaceState>('state');if(prior){if(prior.id!==id||prior.repo!==repo||prior.session!==session)throw Error('Workspace identity conflict');if(prior.phase==='initializing'){prior.gaps.push('Initialization was interrupted; workspace was not recreated.');await this.finish(prior);}return this.summary(prior)}
  const s:WorkspaceState={id,session,repo,createdAt:this.now(),phase:'initializing',untouched:true,deadline:this.now()+this.limits.taskMs,lastUsed:this.now(),runs:{},gaps:[]};await this.save(s);
  try{s.base=await this.io(signal=>this.adapter.open(repo,signal),this.limits.setupMs);s.phase='ready';await this.adapter.keepAlive(this.limits.idleMs);s.lastUsed=this.now();await this.save(s)}catch{s.stopReason='initialization-failed';s.gaps.push('Initialization failed or was interrupted.');await this.finish(s)}return this.summary(s);
 })}
 private summary(s:WorkspaceState){const r=s.active?s.runs[s.active]:undefined;return {...s,canAutoReplace:s.phase==='closed'&&s.untouched===true&&s.stopReason==='expired',warning:s.phase==='ready'&&Math.min(s.deadline,r?.deadline??Infinity)-this.now()<=this.limits.warningMs?'Deadline approaching. The owner can explicitly extend the task or active command.':undefined,artifactUrl:`/api/workspaces/${s.id}/artifact?session=${s.session}`}}
 private async poll(s:WorkspaceState){if(!s.active||(s.phase==='stopping'&&s.cleanupAttempted))return;const r=s.runs[s.active];let result;try{result=await this.io(signal=>this.adapter.status(r.id,signal))}catch{result={state:'lost' as const}}if(result.state==='exited'){r.state='done';r.exitCode=result.exitCode;s.active=undefined;s.lastUsed=this.now();await this.captureLogs(s,r)}else if(result.state==='lost'||(result.state==='starting'&&this.now()-r.startedAt>this.limits.operationMs)){r.state='interrupted';r.reason='Process state was lost or ambiguous. Not restarted.';s.gaps.push(r.reason);await this.beginStop(s);}else r.state='running';}
 private async captureLogs(s:WorkspaceState,r:WorkspaceRun){for(const stream of ['stdout','stderr'] as const)try{const text=await this.io(signal=>this.adapter.logs(r.id,stream,signal));await this.store.put(`log:${r.id}:${stream}`,text)}catch{s.gaps.push(`Log unavailable: ${r.id}/${stream}`)}}
 async request(request:WorkspaceRequest){if(request.action==='status'&&this.activeAbort){const current=await this.state();if(current.id!==request.workspaceId)throw Error('Workspace identity mismatch');return this.summary(current)}if(request.action==='cancel'){const current=await this.store.get<WorkspaceState>('state');const prior=await this.store.get('operation:'+request.operationId);if(current?.id===request.workspaceId&&(!request.runId||request.runId===current.active)&&/^[a-f0-9]{64}$/.test(request.operationId)&&!prior)this.activeAbort?.abort();}return this.serial(async()=>{
  const s=await this.state();if(s.id!==request.workspaceId)throw Error('Workspace identity mismatch');
  if(!/^[a-f0-9]{64}$/.test(request.operationId))throw Error('Invalid operation ID');
  const encoded=new TextEncoder().encode(JSON.stringify(request));const digest=await crypto.subtle.digest('SHA-256',encoded);const fingerprint=Array.from(new Uint8Array(digest)).map(x=>x.toString(16).padStart(2,'0')).join(''),key='operation:'+request.operationId;const prior=await this.store.get<{fingerprint:string;result?:unknown}>(key);
  if(prior){if(prior.fingerprint!==fingerprint)throw Error('Operation ID already used');if(request.action==='exec'){await this.poll(s);await this.enforce(s);await this.save(s);return this.summary(s)}if(prior.result!==undefined)return prior.result;throw Error('Previous operation is interrupted; it was not replayed')}
  if(request.action==='status'){await this.poll(s);await this.enforce(s);await this.save(s);return this.summary(s)}
  if(request.action==='logs'){if(!s.runs[request.runId])throw Error('Unknown run');return {runId:request.runId,stream:request.stream,text:await this.store.get<string>(`log:${request.runId}:${request.stream}`)??(s.phase==='ready'?await this.io(signal=>this.adapter.logs(request.runId,request.stream,signal)):'Log unavailable after container stop.')}}
  await this.store.put(key,{fingerprint});
  if(request.action==='cancel'){if(request.runId&&request.runId!==s.active)throw Error('Run is not active');s.stopReason='cancelled';await this.save(s);await this.beginStop(s);const result=this.summary(s);await this.store.put(key,{fingerprint,result});return result}
  if(s.phase!=='ready')throw Error('Workspace is not active; create a new task explicitly');await this.poll(s);await this.enforce(s);if(s.phase!=='ready')throw Error('Workspace deadline reached');
  if(s.active&&request.action!=='export')throw Error('Wait for the active serial command before reading/editing/running');
  s.lastUsed=this.now();let result:unknown;
  try{
   if(request.action==='read')result={path:projectPath(request.path),text:await this.io(signal=>this.adapter.read(projectPath(request.path),signal))};
   if(request.action==='edit'){s.untouched=false;await this.save(s);await this.io(signal=>this.adapter.edit(projectPath(request.path),request.oldText,request.newText,signal));result={edited:request.path}}
   if(request.action==='exec'){
    if(!Array.isArray(request.argv)||!request.argv.length||request.argv.length>64||JSON.stringify(request.argv).length>8000||request.argv.some(v=>typeof v!=='string'||v.length>8000||v.includes('\0')))throw Error('Invalid argv');
    const limit=request.limitMs??this.limits.commandMs;if(!Number.isInteger(limit)||limit<60000||limit>2*3600000)throw Error('Command limit must be 1–120 minutes');
    if(Object.keys(s.runs).length>=100)throw Error('Task command limit reached');
    const run:WorkspaceRun={id:request.operationId,state:'dispatching',command:request.argv[0].slice(0,80),startedAt:this.now(),deadline:Math.min(s.deadline,this.now()+limit)};s.untouched=false;s.runs[run.id]=run;s.active=run.id;await this.save(s); // durable ID BEFORE dispatch
    try{await this.io(signal=>this.adapter.dispatch(run.id,request.argv,projectPath(request.cwd??'.'),signal));run.state='running'}catch{run.state='interrupted';run.reason='Dispatch was ambiguous; command was not replayed.';s.gaps.push(run.reason);await this.beginStop(s)}result=this.summary(s);
   }
   if(request.action==='export'){if(s.active)throw Error('Wait for the command before exporting a consistent patch');result=await this.export(s,request.operationId);}
  }catch(error){await this.save(s);throw error}
  await this.save(s);await this.store.put(key,{fingerprint,result});return result;
 })}
 private async export(s:WorkspaceState,id:string){return this.io(async signal=>{const prior=await this.store.get<{chunks:number;gaps:string[]}>('artifact:'+id);if(prior)return {artifactId:id,url:`/api/workspaces/${s.id}/artifact?export=${id}&session=${s.session}`,gaps:prior.gaps};if(!s.base)throw Error('No base available');const artifact=await this.adapter.collect(s.base,Object.keys(s.runs),signal);if(s.active)artifact.gaps.push('Patch captured while an interrupted command may still be stopping.');const text=JSON.stringify(artifact),chunks=Math.ceil(text.length/16000);for(let i=0;i<chunks;i++){signal.throwIfAborted();await this.store.put(`artifact:${id}:${i}`,text.slice(i*16000,(i+1)*16000));}signal.throwIfAborted();await this.store.put('artifact:'+id,{chunks,gaps:artifact.gaps});await this.store.put('latestArtifact',id);return {artifactId:id,url:`/api/workspaces/${s.id}/artifact?export=${id}&session=${s.session}`,gaps:artifact.gaps}},this.limits.artifactMs)}
 private async beginStop(s:WorkspaceState,reason:WorkspaceState['stopReason']='interrupted'){if(s.phase==='closed'||s.phase==='stopping')return;s.stopReason??=reason;s.phase='stopping';s.stopAt=this.now()+this.limits.graceMs;await this.save(s);if(s.active)try{await this.io(signal=>this.adapter.terminate(s.active!,signal),3000)}catch{s.gaps.push('Graceful process cancellation could not be confirmed.')}}
 private async finish(s:WorkspaceState){s.phase='stopping';s.stopAt=this.now()+this.limits.artifactMs;const capture=!s.cleanupAttempted;s.cleanupAttempted=true;await this.save(s);try{if(capture&&s.base)await this.export(s,'final')}catch{s.gaps.push('Final patch/log capture incomplete. Available prior artifacts remain saved.')}finally{try{await this.io(()=>this.adapter.stop(),5000)}catch{s.gaps.push('Container stop not confirmed; forced stop retry scheduled.');await this.save(s);return}}
  for(const r of Object.values(s.runs))if(r.state==='running'||r.state==='dispatching'){r.state='interrupted';r.reason='Workspace stopped; no automatic restart.'}s.active=undefined;s.phase='closed';await this.save(s);
 }
 private async enforce(s:WorkspaceState){if(s.phase==='initializing'){s.gaps.push('Initialization interrupted.');await this.finish(s);return}if(s.phase==='stopping'){if(this.now()>=(s.stopAt??0))await this.finish(s);return}if(s.phase==='ready'&&(this.now()>=s.deadline||(s.active&&this.now()>=s.runs[s.active].deadline)||(!s.active&&this.now()-s.lastUsed>=this.limits.idleMs)))await this.beginStop(s,'expired')}
 tick(){return this.serial(async()=>{const s=await this.state();if(s.phase==='closed')return;await this.poll(s);await this.enforce(s);if(s.phase==='ready')await this.adapter.keepAlive(this.limits.idleMs);await this.save(s)})}
 extend(target:'task'|'command',minutes:number){return this.serial(async()=>{const s=await this.state();if(s.phase!=='ready'||!Number.isInteger(minutes)||minutes<1||minutes>90)throw Error('Extend an active task by 1–90 minutes');if(target==='task'){const next=Math.min(s.deadline+minutes*60000,(s.createdAt??s.lastUsed)+6*3600000);if(next<=s.deadline)throw Error('Task extension cap reached');s.deadline=next;}else{if(!s.active)throw Error('No active command');const next=Math.min(s.runs[s.active].deadline+minutes*60000,s.deadline,s.runs[s.active].startedAt+2*3600000);if(next<=s.runs[s.active].deadline)throw Error('Extend the task first, or command extension cap reached');s.runs[s.active].deadline=next}await this.save(s);return this.summary(s)})}
 artifact(id?:string){return this.serial(async()=>{const key=id??await this.store.get<string>('latestArtifact');if(!key||!/^([a-f0-9]{64}|final)$/.test(key))throw Error('Artifact unavailable');const manifest=await this.store.get<{chunks:number}>('artifact:'+key);if(!manifest)throw Error('Artifact unavailable');let text='';for(let i=0;i<manifest.chunks;i++){const chunk=await this.store.get<string>(`artifact:${key}:${i}`);if(chunk===undefined)throw Error('Artifact incomplete');text+=chunk;}return JSON.parse(text) as WorkspaceExport})}
}
