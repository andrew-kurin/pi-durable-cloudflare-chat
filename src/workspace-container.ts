import {DurableObject} from 'cloudflare:workers';
import {WorkspaceController,workspaceLimits} from './workspace';
import {ContainerWorkspaceAdapter} from './workspace-adapter';
import type {WorkspaceRequest} from './workspace-tools';
export interface WorkspaceEnv {ENABLE_WORKSPACE?:string;ENABLE_WORKSPACE_SMOKE?:string;WORKSPACE_IMAGE?:string;WORKSPACE_LIMITS?:string}
export class TaskWorkspace extends DurableObject<WorkspaceEnv>{
 private controller?:WorkspaceController;
 private enabled(){return this.env.ENABLE_WORKSPACE==='true'||this.env.ENABLE_WORKSPACE_SMOKE==='true'}
 constructor(ctx:DurableObjectState,env:WorkspaceEnv){super(ctx,env);if(ctx.container?.running)void ctx.blockConcurrencyWhile(async()=>{if(!this.enabled()){await ctx.container!.destroy();await ctx.storage.deleteAlarm();return}await ctx.container!.setInactivityTimeout(workspaceLimits(env.WORKSPACE_LIMITS).idleMs);await ctx.storage.setAlarm(Date.now()+1000)});}
 private get controllerInstance(){if(!this.enabled()||!this.ctx.container||!this.env.WORKSPACE_IMAGE)throw Error('Workspace is disabled or unconfigured');if(!this.controller){const limits=workspaceLimits(this.env.WORKSPACE_LIMITS);this.controller=new WorkspaceController(this.ctx.storage,new ContainerWorkspaceAdapter(this.ctx.container,this.ctx.container.images[this.env.WORKSPACE_IMAGE]??this.env.WORKSPACE_IMAGE),limits)}return this.controller}
 async nativeState(){return {configured:!!this.ctx.container,running:this.ctx.container?.running??null,checkedAt:Date.now()}}
 open(id:string,session:string,repo:string){return this.controllerInstance.open(id,session,repo)}
 request(request:WorkspaceRequest){return this.controllerInstance.request(request)}
 extend(target:'task'|'command',minutes:number){return this.controllerInstance.extend(target,minutes)}
 artifact(id?:string){return this.controllerInstance.artifact(id)}
 async alarm(){if(!this.enabled()){if(this.ctx.container?.running)await this.ctx.container.destroy();await this.ctx.storage.deleteAlarm();return}await this.controllerInstance.tick()}
}
