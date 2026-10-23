import {DurableObject} from 'cloudflare:workers';
import {WorkspaceController,workspaceLimits} from './workspace';
import {ContainerWorkspaceAdapter} from './workspace-adapter';
import type {WorkspaceRequest} from './workspace-tools';
export interface WorkspaceEnv {ENABLE_WORKSPACE?:string;ENABLE_WORKSPACE_SMOKE?:string;WORKSPACE_IMAGE?:string;WORKSPACE_LIMITS?:string;MAINTENANCE_MODE?:string}
export class TaskWorkspace extends DurableObject<WorkspaceEnv>{
 private controller?:WorkspaceController;
 private enabled(){return this.env.ENABLE_WORKSPACE==='true'||this.env.ENABLE_WORKSPACE_SMOKE==='true'}
 constructor(ctx:DurableObjectState,env:WorkspaceEnv){super(ctx,env);if(ctx.container?.running)void ctx.blockConcurrencyWhile(async()=>{if(!this.enabled()){await ctx.container!.destroy();await ctx.storage.deleteAlarm();return}await ctx.container!.setInactivityTimeout(workspaceLimits(env.WORKSPACE_LIMITS).idleMs);await ctx.storage.setAlarm(Date.now()+1000)});}
 private get controllerInstance(){if(!this.enabled()||!this.ctx.container||!this.env.WORKSPACE_IMAGE)throw Error('Workspace is disabled or unconfigured');if(!this.controller){const limits=workspaceLimits(this.env.WORKSPACE_LIMITS);this.controller=new WorkspaceController(this.ctx.storage,new ContainerWorkspaceAdapter(this.ctx.container,this.ctx.container.images[this.env.WORKSPACE_IMAGE]??this.env.WORKSPACE_IMAGE),limits)}return this.controller}
 async nativeState(){return {configured:!!this.ctx.container,running:this.ctx.container?.running??null,checkedAt:Date.now()}}
 private async admit(epoch?:string){const m=await this.ctx.storage.get<{phase:string;epoch:string}>('maintenance:v1');if(this.env.MAINTENANCE_MODE==='frozen'||m&&m.phase!=='active'||epoch!==undefined&&epoch!==(m?.epoch??'initial'))throw Error('Workspace maintenance is paused');}
 async maintenancePause(epoch:string){await this.ctx.storage.put('maintenance:v1',{phase:'paused',epoch});}
 async maintenanceResume(epoch:string){const m=await this.ctx.storage.get<{epoch:string}>('maintenance:v1');if(m?.epoch!==epoch||this.env.MAINTENANCE_MODE==='frozen')throw Error('Workspace maintenance changed');await this.ctx.storage.put('maintenance:v1',{phase:'active',epoch});}
 async maintenanceReport(){const s=await this.ctx.storage.get<{phase:string}>('state');return {phase:s?.phase??'absent',running:this.ctx.container?.running??null};}
 async maintenanceBookmark(){const m=await this.ctx.storage.get<{phase:string}>('maintenance:v1');if(m?.phase!=='paused')throw Error('Workspace is not paused');const r=await this.maintenanceReport();if(r.phase!=='closed'||r.running)throw Error('Workspace is not stopped');return this.ctx.storage.getCurrentBookmark();}
 async open(id:string,session:string,repo:string,revision?:string){const m=await this.ctx.storage.get<{epoch:string}>('maintenance:v1'),epoch=m?.epoch??'initial';await this.admit(epoch);return this.controllerInstance.open(id,session,repo,()=>this.admit(epoch),revision)}
 async request(request:WorkspaceRequest){const m=await this.ctx.storage.get<{epoch:string}>('maintenance:v1'),epoch=m?.epoch??'initial';if(!['status','logs','cancel'].includes(request.action))await this.admit(epoch);return this.controllerInstance.request(request,()=>this.admit(epoch))}
 async extend(target:'task'|'command',minutes:number){const m=await this.ctx.storage.get<{epoch:string}>('maintenance:v1'),epoch=m?.epoch??'initial';await this.admit(epoch);return this.controllerInstance.extend(target,minutes,()=>this.admit(epoch))}
 artifact(id?:string){return this.controllerInstance.artifact(id)}
 async alarm(){if(!this.enabled()){if(this.ctx.container?.running)await this.ctx.container.destroy();await this.ctx.storage.deleteAlarm();return}await this.controllerInstance.tick()}
}
