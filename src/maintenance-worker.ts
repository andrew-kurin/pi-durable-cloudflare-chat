import {DurableObject} from 'cloudflare:workers';
import {authorize,secured,type AccessConfig} from './auth';
import {Maintenance,type MaintenanceEnv} from './maintenance';
import {RequestError} from './http-input';
export {TaskWorkspace} from './workspace-container';
declare const PI_DEPLOYMENT_MODE:string;
const deploymentMode=typeof PI_DEPLOYMENT_MODE==='undefined'?'local':PI_DEPLOYMENT_MODE;
interface Env extends AccessConfig,MaintenanceEnv {Assistant:DurableObjectNamespace<Assistant>;ASSETS:Fetcher}
/** Intentionally no Pi, Agents, credential or provider import. This is safe to
 * deploy before the first 1.3 task migration, including on alarm wake. */
export class Assistant extends DurableObject<Env>{
 private maintenance=new Maintenance(this.ctx.storage,this.env);
 async alarm(){} // Retain durable jobs; never open/resume Pi in frozen mode.
 async fetch(request:Request){
  try{await authorize(request,this.env);}catch{return new Response('Forbidden',{status:403});}
  if(new URL(request.url).pathname!=='/api/maintenance')return Response.json({error:'Maintenance is frozen. Saved work is retained.'},{status:423});
  try{const response=await this.maintenance.handle(request,{validate:async()=>{throw Error('Frozen mode never opens Pi');}});response.headers.set('X-Pi-Deployment-Mode',deploymentMode);return response;}catch(error){return Response.json({error:error instanceof RequestError?error.message:'Maintenance request unavailable; remain paused.'},{status:error instanceof RequestError?error.status:503});}
 }
}
export default {async fetch(request:Request,env:Env){
 try{await authorize(request,env);}catch{return secured(new Response('Forbidden',{status:403}));}
 const u=new URL(request.url);
 if(u.pathname.startsWith('/api/'))return secured(await env.Assistant.getByName('private-owner-v1').fetch(request));
 if(!['/maintenance','/maintenance.html','/maintenance.js'].includes(u.pathname)||request.method!=='GET')return secured(new Response('Maintenance is frozen. Open /maintenance.',{status:423}));
 return secured(await env.ASSETS.fetch(new Request(u,request)));
}};
