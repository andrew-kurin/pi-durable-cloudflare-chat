import type { AgentEvent, EntryRecord } from '@earendil-works/pi-durable';
export function entryText(entry: EntryRecord) {
 return (entry.model ?? []).flatMap(m => typeof m.content === 'string' ? [m.content] : m.content.flatMap(p => p.type === 'text' ? [p.text] : [])).join('\n');
}
export class ChatProjection {
 messages: {id:string; role:string; text:string}[] = []; partial: Record<number,string> = {}; busy = false; activity = '';
 entry(entry: EntryRecord) {
  if (!['pi.user','pi.assistant'].includes(entry.kind)) return;
  const item = {id:String(entry.id),role:entry.kind==='pi.user'?'user':'assistant',text:entryText(entry)};
  const at = this.messages.findIndex(m=>m.id===item.id); if(at<0)this.messages.push(item);else this.messages[at]=item;
 }
 apply(e: AgentEvent) {
  if(e.type==='snapshot') {this.messages=[];e.entries.forEach(x=>this.entry(x));this.partial={};e.generation?.message?.content.forEach((p,i)=>{if(p.type==='text')this.partial[i]=p.text;});this.busy=!!e.run;this.activity=e.tools.length?'Reading sources or working with Luna…':'';}
  if(e.type==='run_start')this.busy=true;
  if(e.type==='run_end'){this.busy=false;this.partial={};this.activity='';}
  if(e.type==='message_start'){this.partial={};e.message.content && Array.isArray(e.message.content) && e.message.content.forEach((p,i)=>{if(p.type==='text')this.partial[i]=p.text;});}
  if(e.type==='message_update')for(const c of e.changes){if(c.type==='text_delta')this.partial[c.contentIndex]=(this.partial[c.contentIndex]??'')+c.delta;else if((c.type==='text_start'||c.type==='block')&&c.block.type==='text')this.partial[c.contentIndex]=c.block.text;else if(c.type==='message'){this.partial={};c.message.content.forEach((p,i)=>{if(p.type==='text')this.partial[i]=p.text;});}}
  if(e.type==='message_end'){this.entry(e.entry);this.partial={};}
  if(e.type==='entry_appended')this.entry(e.entry);
  if(e.type==='tool_execution_start')this.activity=e.toolName==='ask_luna'?'Working with Luna…':e.toolName==='web_search'?'Searching the public web…':e.toolName==='fetch_page'?'Reading a public page…':'Reading public GitHub…';
  if(e.type==='tool_execution_end')this.activity='';
  if(e.type==='task_failed')this.activity='The request failed. Check connection settings and try again.';
 }
 view(){return {messages:this.messages,partial:Object.values(this.partial).join(''),busy:this.busy,activity:this.activity};}
}
