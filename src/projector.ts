import type { AgentEvent, EntryRecord } from '@earendil-works/pi-durable';
import { toolLabel, stateDetail, resultSummary, type ToolActivity, type ToolState } from './tool-activity';
export function entryText(entry: EntryRecord) {
 return (entry.model ?? []).flatMap(m => typeof m.content === 'string' ? [m.content] : m.content.flatMap(p => p.type === 'text' ? [p.text] : [])).join('\n');
}
export class ChatProjection {
 messages: {id:string; role:string; text:string}[] = []; partial: Record<number,string> = {}; busy = false; activity = '';
 private tools = new Map<string,ToolActivity & {messageId?:string; name:string}>();
 private tool(id:string,name:string,state:ToolState,messageId?:string) {
  if(typeof id!=='string'||!id||id.length>200) return;
  const prior=this.tools.get(id);
  if(prior) { if(messageId) prior.messageId=messageId; return prior; }
  const row={id,name,label:toolLabel(name),state,detail:stateDetail(state),messageId};this.tools.set(id,row);return row;
 }
 private calls(entry:EntryRecord) {
  for(const m of entry.model??[]) if(m.role==='assistant') for(const block of m.content) if(block.type==='toolCall') this.tool(block.id,block.name,'pending',String(entry.id));
 }
 entry(entry: EntryRecord) {
  if(entry.kind==='pi.tool-result') {
   for(const m of entry.model??[]) if(m.role==='toolResult') {const row=this.tool(m.toolCallId,m.toolName,'unavailable');const summary=resultSummary(entry,m.toolName);if(row&&summary)Object.assign(row,summary);}
   return;
  }
  this.calls(entry);
  if (!['pi.user','pi.assistant'].includes(entry.kind)) return;
  const item = {id:String(entry.id),role:entry.kind==='pi.user'?'user':'assistant',text:entryText(entry)};
  const at = this.messages.findIndex(m=>m.id===item.id); if(at<0)this.messages.push(item);else this.messages[at]=item;
 }
 apply(e: AgentEvent) {
  if(e.type==='snapshot') {this.messages=[];this.tools.clear();e.entries.forEach(x=>this.entry(x));this.partial={};e.generation?.message?.content.forEach((p,i)=>{if(p.type==='text')this.partial[i]=p.text;});this.busy=!!e.run;for(const row of this.tools.values())if(row.state==='pending'){row.state='unavailable';row.detail=stateDetail(row.state);}for(const slot of e.tools){const row=this.tool(slot.callId,slot.name,'unavailable');if(row&&slot.status!=='done'){row.state=slot.status;row.detail=stateDetail(row.state);}}this.activity=e.tools.some(t=>t.status==='pending'||t.status==='running')?'Reading sources or working with Luna…':'';}
  if(e.type==='run_start')this.busy=true;
  if(e.type==='run_end'){for(const row of this.tools.values())if(row.state==='pending'||row.state==='running'){row.state='unavailable';row.detail=stateDetail(row.state);}this.busy=false;this.partial={};this.activity='';}
  if(e.type==='message_start'){this.partial={};e.message.content && Array.isArray(e.message.content) && e.message.content.forEach((p,i)=>{if(p.type==='text')this.partial[i]=p.text;});}
  if(e.type==='message_update')for(const c of e.changes){if(c.type==='text_delta')this.partial[c.contentIndex]=(this.partial[c.contentIndex]??'')+c.delta;else if((c.type==='text_start'||c.type==='block')&&c.block.type==='text')this.partial[c.contentIndex]=c.block.text;else if(c.type==='message'){this.partial={};c.message.content.forEach((p,i)=>{if(p.type==='text')this.partial[i]=p.text;});}}
  if(e.type==='message_end'){this.entry(e.entry);this.partial={};}
  if(e.type==='entry_appended')this.entry(e.entry);
  if(e.type==='tool_execution_start'){const row=this.tool(e.toolCallId,e.toolName,'running');if(row&&!['success','error','interrupted'].includes(row.state)){row.state='running';row.detail=stateDetail(row.state);}}
  if(e.type==='tool_execution_start')this.activity=e.toolName==='ask_luna'?'Working with Luna…':e.toolName==='web_search'?'Searching the public web…':e.toolName==='fetch_page'?'Reading a public page…':['github_read','github_search'].includes(e.toolName)?'Reading public GitHub…':'Working with a tool…';
  if(e.type==='tool_execution_end'){if(e.entry)this.entry(e.entry);else{const row=this.tool(e.toolCallId,e.toolName,'unavailable');if(row&&!['success','error','interrupted'].includes(row.state)){row.state='unavailable';row.detail=stateDetail(row.state);}}this.activity=[...this.tools.values()].some(t=>t.state==='running'||t.state==='pending')?'Reading sources or working with Luna…':'';}
  if(e.type==='task_failed')this.activity='The request failed. Check connection settings and try again.';
 }
 view(){const publicRow=({id,label,state,detail}:ToolActivity)=>({id,label,state,detail});const messages=this.messages.map(m=>({...m,tools:[...this.tools.values()].filter(t=>t.messageId===m.id).map(publicRow)}));const unattached=[...this.tools.values()].filter(t=>!t.messageId).map(publicRow);if(unattached.length)messages.push({id:'tool-activity',role:'assistant',text:'',tools:unattached});return {messages,partial:Object.values(this.partial).join(''),busy:this.busy,activity:this.activity};}
}
