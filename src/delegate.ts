import { Type } from '@earendil-works/pi-ai';
import { AssistantEntry, configure, defineExtension, defineTool } from '@earendil-works/pi-durable';
import { entryText } from './projector';
export function delegation(provider='openai-codex', modelId='gpt-6-luna') {
 return defineExtension({name:'luna-delegation',sections:[{key:'preamble',tag:false,render:()=> 'You are Sol, the owner’s private assistant. Answer directly. For a small bounded task you may ask Luna once, then verify its result. Do not claim access to browsing, files, or external services; none are installed. Never request passwords or tokens.'}],tools:[defineTool({name:'ask_luna',description:'Ask Luna one bounded, self-contained subtask. Luna has no tools.',parameters:Type.Object({task:Type.String({maxLength:12000})}),replay:'safe',execute:async(args,api,context)=>{
 const id=await api.commit(async tx=>{const prior=(await tx.scanConversations({ownerTaskId:api.taskId},1)).items[0];if(prior)return prior.id;const child=await tx.createConversation({ownership:{kind:'task',taskId:api.taskId}});await configure(tx,child.id,{model:{provider,modelId},thinkingLevel:'low',tools:[],instructions:'Complete the supplied bounded subtask concisely. You have no tools.'});return child.id;},context);
 const child=await api.conversation(id,context);if(!child)throw new Error('Missing worker');const result=await(await child.submit({type:'input',content:args.task,requestId:`luna:${api.taskId}`},context)).wait(context);
 if(result.status!=='done'||result.type!=='input')throw new Error('Luna did not complete');
 const answer=await api.commit(tx=>tx.entry(AssistantEntry,result.answer),context);
 return {content:[{type:'text',text:answer?entryText(answer):''}]};
 }})]});
}
