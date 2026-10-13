// Isolated staging entrypoint. No chat, provider, credential store or production namespace.
import {authorize,secured,type AccessConfig} from './auth';
import {TaskWorkspace} from './workspace-container';
import type {WorkspaceRequest,WorkspaceAction} from './workspace-tools';
export {TaskWorkspace};
interface SmokeEnv extends AccessConfig {
 Workspaces?:DurableObjectNamespace<TaskWorkspace>;
 ENABLE_WORKSPACE?:string;ENABLE_WORKSPACE_SMOKE?:string;WORKSPACE_IMAGE?:string;WORKSPACE_REPOSITORY?:string;
}
// One newly authorized retry; the old v1 Durable Object stays closed and untouched.
const ID='00000000-0000-4000-8000-000000000002',SESSION='native-shell-smoke-v2';
const FILE='.pi-cloudflare-native-smoke.txt';
const steps={
 create:{action:'edit',path:FILE,oldText:'',newText:'native staging fixture\n'},
 edit:{action:'edit',path:FILE,oldText:'native staging fixture',newText:'native staging edited'},
 read:{action:'read',path:FILE},
 run:{action:'exec',argv:['node','-e',"console.log('PASS native shell smoke'); console.error('stderr captured');"],cwd:'.',limitMs:60000},
 slow:{action:'exec',argv:['sh','-c','sleep 120 & wait'],cwd:'.',limitMs:60000},
 cancel:{action:'cancel'},
 export:{action:'export'},
} satisfies Record<string,WorkspaceAction>;
async function operationId(label:string){const bytes=await crypto.subtle.digest('SHA-256',new TextEncoder().encode(SESSION+':'+label));return Array.from(new Uint8Array(bytes)).map(x=>x.toString(16).padStart(2,'0')).join('')}
const PAGE=`<!doctype html><html><head><meta name="viewport" content="width=device-width,initial-scale=1"><title>Native workspace smoke</title></head><body><h1>Native workspace smoke</h1><p>One fixed disposable task. No model, chat or subscription storage. Run once; reruns read durable operation records. Cancel stops the task permanently.</p><button id="run">Run fixed smoke</button> <button id="cancel">Cancel / stop guest</button> <button id="status">Status</button> <a href="/api/smoke/artifact">Download latest artifact</a><pre id="result" aria-live="polite"></pre><script src="/smoke.js"></script></body></html>`;
const CLIENT=`
const out=document.querySelector('#result');
async function get(path){const r=await fetch(path),d=await r.json();if(!r.ok)throw Error(d.error||'Read failed');return d}
async function call(action){const r=await fetch('/api/smoke',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({action})}),d=await r.json();if(!r.ok)throw Error(d.error||'Smoke operation failed');out.textContent=JSON.stringify(d,null,2);return d}
async function status(){const d=await get('/api/smoke/status');out.textContent=JSON.stringify(d,null,2);return d}
async function wait(phase){const end=Date.now()+75000;while(Date.now()<end){const s=await status();if(phase==='closed'&&s.phase==='closed')return s;if(phase==='ready'){if(s.phase!=='ready')throw Error('Workspace stopped; review status');if(!s.active)return s}await new Promise(r=>setTimeout(r,500))}throw Error('Timed out; cancel and confirm guest stop')}
document.querySelector('#run').onclick=async()=>{
 const b=document.querySelector('#run');b.disabled=true;
 try{
  const s=await call('open');if(s.phase!=='ready')throw Error('Task unavailable; review status');
  await call('create');await call('edit');const file=await call('read');if(file.text!=='native staging edited\\n')throw Error('File edit verification failed');
  await call('run');const done=await wait('ready'),run=Object.values(done.runs).find(r=>r.command==='node');if(!run||run.state!=='done'||run.exitCode!==0)throw Error('Command failed');
  const logs=await get('/api/smoke/logs');if(!logs.stdout.text.includes('PASS native shell smoke')||!logs.stderr.text.includes('stderr captured'))throw Error('Log verification failed');
  await call('export');const artifact=await get('/api/smoke/artifact');if(!artifact.patch.includes('.pi-cloudflare-native-smoke.txt')||!artifact.patch.includes('native staging edited'))throw Error('Patch verification failed');
  await call('slow');await call('cancel');const closed=await wait('closed');
  if(closed.native?.running!==false||closed.native?.configured!==true||closed.gaps?.some(g=>/stop.*confirm|capture.*(?:fail|incomplete)|initializ/i.test(g)))throw Error('Native cleanup or artifacts not confirmed; inspect Containers');
  out.textContent='PASS fixed native shell smoke: files, command, logs, patch and cancellation; container reports not running. Review/download artifact and confirm cleanup in Containers. Gaps: '+JSON.stringify(closed.gaps||[]);
 }catch(e){const reason=e.message;let cleanup='';try{await call('cancel');await wait('closed')}catch{cleanup=' Cancellation/stop unconfirmed; inspect Containers immediately.'}out.textContent=reason+cleanup}
 finally{b.disabled=false}
};
document.querySelector('#cancel').onclick=()=>call('cancel').catch(e=>out.textContent=e.message);
document.querySelector('#status').onclick=()=>status().catch(e=>out.textContent=e.message);
`;
export default {async fetch(request:Request,env:SmokeEnv){
 try{await authorize(request,env)}catch{return secured(new Response('Forbidden',{status:403}))}
 const path=new URL(request.url).pathname;
 try{
  if(!['GET','POST'].includes(request.method))return secured(new Response('Method not allowed',{status:405}));
  if(request.method==='GET'&&path==='/')return secured(new Response(PAGE,{headers:{'Content-Type':'text/html; charset=utf-8'}}));
  if(request.method==='GET'&&path==='/smoke.js')return secured(new Response(CLIENT,{headers:{'Content-Type':'text/javascript; charset=utf-8'}}));
  if(!['/api/smoke','/api/smoke/status','/api/smoke/logs','/api/smoke/artifact'].includes(path))return secured(new Response('Not found',{status:404}));
  if((env.ENABLE_WORKSPACE_SMOKE??env.ENABLE_WORKSPACE)!=='true'||!env.Workspaces||!env.WORKSPACE_IMAGE||!env.WORKSPACE_REPOSITORY||! /^[A-Za-z0-9_.-]{1,100}\/[A-Za-z0-9_.-]{1,100}$/.test(env.WORKSPACE_REPOSITORY)||env.WORKSPACE_REPOSITORY.split('/').some(x=>x==='.'||x==='..'))return secured(Response.json({error:'Smoke workspace is disabled or unconfigured'},{status:503}));
  const stub=env.Workspaces.getByName(ID);
  const dispatch=async(label:string,input:WorkspaceAction)=>stub.request({...input,workspaceId:ID,operationId:await operationId(label)} as WorkspaceRequest);
  if(request.method==='GET'&&path==='/api/smoke/status')return secured(Response.json({...await dispatch('status',{action:'status'}) as object,native:await stub.nativeState()}));
  if(request.method==='GET'&&path==='/api/smoke/logs')return secured(Response.json({stdout:await dispatch('stdout',{action:'logs',runId:await operationId('run'),stream:'stdout'}),stderr:await dispatch('stderr',{action:'logs',runId:await operationId('run'),stream:'stderr'})}));
  if(request.method==='GET'&&path==='/api/smoke/artifact')return secured(Response.json(await stub.artifact(),{headers:{'Content-Disposition':'attachment; filename="native-workspace-smoke.json"'}}));
  if(request.method!=='POST'||path!=='/api/smoke')return secured(new Response('Method not allowed',{status:405}));
  const raw=await request.text();if(raw.length>100)return secured(Response.json({error:'Invalid smoke action'},{status:400}));
  let body;try{body=JSON.parse(raw)}catch{return secured(Response.json({error:'Invalid smoke action'},{status:400}))}
  if(!body||Array.isArray(body)||Object.keys(body).length!==1||typeof body.action!=='string')return secured(Response.json({error:'Invalid smoke action'},{status:400}));
  if(body.action==='open')return secured(Response.json(await stub.open(ID,SESSION,env.WORKSPACE_REPOSITORY)));
  if(!Object.hasOwn(steps,body.action))return secured(Response.json({error:'Unknown fixed smoke action'},{status:400}));
  return secured(Response.json(await dispatch(body.action,steps[body.action as keyof typeof steps])));
 }catch{return secured(Response.json({error:'Smoke operation unavailable; review state and cancel if needed'},{status:503}))}
}};
