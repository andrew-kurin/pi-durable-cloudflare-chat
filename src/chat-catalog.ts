import type {PiHarness} from 'agents/harness/pi';
import {BACKGROUND_CONTEXT} from '@earendil-works/chord/context';
import {conversationTitle} from './conversation-title';
import {RequestError} from './http-input';
type Store=Pick<DurableObjectStorage,'get'|'put'|'delete'>;
type Harness=Pick<PiHarness,'storage'|'sessions'|'pi'|'pending'>;
/** Owns user-chat membership and metadata. Pi remains transcript authority.
 * Mutation callers must retain the Assistant admission queue. Restore is uncapped.
 */
export class ChatCatalog {
 constructor(private store:Store,private harness:Harness,private newModel:()=>Promise<{provider:string;modelId:string}>,private canTrash:(id:string)=>Promise<void>){}
 async sessions(){
  const ids=new Set<string>();const storage=await this.harness.storage();let cursor;
  do{const page=await storage.scanConversations({},100,cursor,BACKGROUND_CONTEXT);for(const row of page.items)if(!row.owner&&!row.parent)ids.add(String(row.id));cursor=page.next;}while(cursor);
  return(await this.harness.sessions.list()).filter(row=>ids.has(row.id));
 }
 isDeleted(id:string){return this.store.get<number>('chat-deleted:'+id).then(Boolean);}
 async requireActive(id:string){
  if(await this.isDeleted(id))throw new RequestError(410,'Chat is in Recently deleted. Restore it before opening.');
  const row=(await this.sessions()).find(row=>row.id===id);if(!row)throw new RequestError(404,'Conversation not found');return row;
 }
 async title(id:string,fallback?:string){return await this.store.get<string>('chat-title:'+id)??await this.store.get<string>('chat-auto-title:'+id)??conversationTitle(fallback);}
 async list(deleted=false){
  const rows=await Promise.all((await this.sessions()).map(async row=>({...row,title:await this.title(row.id)??'',deletedAt:await this.store.get<number>('chat-deleted:'+row.id)})));
  return rows.filter(row=>!!row.deletedAt===deleted).sort((a,b)=>Number(b.id)-Number(a.id));
 }
 async create(){
  if((await this.list()).length>=100)throw new RequestError(429,'Active chat limit of 100 reached');
  const model=await this.newModel();const row=await(await this.harness.pi()).createConversation({ownership:{kind:'ownerless'},agent:{model,thinkingLevel:'low'}},BACKGROUND_CONTEXT);
  return {id:String(row.id),model};
 }
 async rename(id:string,title:string){await this.requireActive(id);await this.store.put('chat-title:'+id,title);return {title};}
 async autoTitle(id:string,text:string){if(!await this.store.get('chat-auto-title:'+id)){const title=conversationTitle(text);if(title)await this.store.put('chat-auto-title:'+id,title);}}
 async trash(id:string){
  const row=(await this.sessions()).find(row=>row.id===id);if(!row)throw new RequestError(404,'Chat not found');
  if(row.busy||(await this.harness.pending({session:id})).length)throw new RequestError(409,'Wait for the response to finish before deleting this chat');
  await this.canTrash(id);const key='chat-deleted:'+id;if(!await this.store.get<number>(key))await this.store.put(key,Date.now());return {id,deleted:true};
 }
 async restore(id:string){if(!(await this.sessions()).some(row=>row.id===id))throw new RequestError(404,'Chat not found');await this.store.delete('chat-deleted:'+id);return {id,deleted:false};}
}
