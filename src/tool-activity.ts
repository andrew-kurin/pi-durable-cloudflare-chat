import type { EntryRecord } from '@earendil-works/pi-durable';
import { publicUrl } from './read-tools';
export type ToolState = 'pending' | 'running' | 'success' | 'error' | 'interrupted' | 'unavailable';
export type ToolLinkage = 'following_response' | 'streaming_response' | 'user_boundary' | 'turn_unavailable' | 'result_unavailable' | 'order_unavailable' | 'no_following_response' | 'unlinked';
export interface ToolSource { title: string; url: string }
export interface ToolActivity { id: string; label: string; state: ToolState; detail: string; summary?: string; sources?: ToolSource[]; linkage?: ToolLinkage; }
// Display only selected source metadata from our own public-read envelopes.
// Never publish arguments, page bodies, excerpts, Luna output or diagnostics.
export function safeMetadata(value: unknown, max=140): string {
 if(typeof value!=='string'||/bearer\s|-----BEGIN|\b(?:gh[pousr]_|github_pat_|sk-|tvly-)[A-Za-z0-9_-]+|\b(?:api[_-]?key|access[_-]?token|password|secret|token)\s*[:=]|https?:\/\/|[<>\x00-\x1f\x7f]/i.test(value))return '';
 return value.replace(/\s+/g,' ').trim().slice(0,max);
}
function source(value:unknown):ToolSource|null {
 if(!value||typeof value!=='object')return null;
 const item=value as Record<string,unknown>;
 if(typeof item.url!=='string')return null;
 try{const u=new URL(publicUrl(item.url));u.search='';u.hash='';return {url:u.href,title:safeMetadata(item.title)||safeMetadata(u.hostname+decodeURIComponent(u.pathname))||u.hostname};}catch{return null;}
}
const labels: Record<string,string> = {web_search:'Web search',fetch_page:'Read web page',github_search:'Search GitHub',github_read:'Read GitHub',ask_luna:'Ask Luna',workspace_read:'Workspace · Read file',workspace_edit:'Workspace · Edit file',workspace_exec:'Workspace · Start command',workspace_status:'Workspace · Process status',workspace_logs:'Workspace · Read logs',workspace_cancel:'Workspace · Cancel',workspace_export:'Workspace · Export patch'};
export const toolLabel = (name: string) => Object.hasOwn(labels,name) ? labels[name] : 'Tool';
export const stateDetail = (state: ToolState) => ({pending:'Waiting to start.',running:'Working. Arguments and live output are kept private.',success:'Completed. Raw output is kept private.',error:'Failed. Raw error details are kept private.',interrupted:'Interrupted before completion.',unavailable:'No recorded result is available.'})[state];
export function resultSummary(entry: EntryRecord, name: string): Pick<ToolActivity,'state'|'detail'|'summary'|'sources'> | null {
 const message = entry.model?.find(m=>m.role==='toolResult');
 if (!message || message.role !== 'toolResult') return null;
 let state: ToolState = message.isError ? 'error' : 'success';
 const diagnostics = (entry.data as {diagnostics?:{code?:string}[]}|undefined)?.diagnostics;
 if (diagnostics?.some(d=>d.code==='interrupted'||d.code==='aborted')) state='interrupted';
 let data: Record<string,unknown> | undefined;
 // Only inspect our bounded public-read JSON envelope. Never forward its strings.
 if (['web_search','fetch_page','github_search','github_read'].includes(name)) {
  const text = message.content.find(p=>p.type==='text');
  if (text?.type==='text' && text.text.length<=16000) try {
   const parsed=JSON.parse(text.text); if(parsed && typeof parsed.data==='object' && parsed.data && !Array.isArray(parsed.data)) data=parsed.data;
  } catch {}
  if (typeof data?.error==='string') state='error';
 }
 const details=[stateDetail(state)];
 let sources:ToolSource[]=[],summary='';
 if (state==='success') {
  if(Array.isArray(data?.results)) details.push(`${Math.min(data.results.length,5)} ${data.results.length===1?'result':'results'} returned.`);
  if(Array.isArray(data?.entries)) details.push(`${Math.min(data.entries.length,50)} ${data.entries.length===1?'entry':'entries'} returned.`);
  if(data?.truncated===true) details.push('Result was truncated.');
  if(data?.incomplete===true) details.push('Search results may be incomplete.');
  if(Array.isArray(data?.results)){
   sources=data.results.slice(0,5).map(source).filter((s):s is ToolSource=>!!s);
   summary=`${Math.min(data.results.length,5)} ${data.results.length===1?'source':'sources'} returned${sources[0]?' · '+sources[0].title:''}`;
  }else if(Array.isArray(data?.entries)){
   sources=data.entries.slice(0,5).map(source).filter((s):s is ToolSource=>!!s);
   summary=`${Math.min(data.entries.length,50)} directory ${data.entries.length===1?'entry':'entries'} returned`;
  }else if(data){
   const s=source(data);if(s)sources=[s];
   summary=safeMetadata(data.title)||safeMetadata(data.description,180)||(s?'Read '+s.title:'');
  }
 }
 if(Number.isFinite(message.durationMs) && message.durationMs!>=0) details.push(`Duration: ${Math.round(Math.min(message.durationMs!,86400000))/1000}s.`);
 return {state,detail:details.join(' '),...(summary?{summary}:{}),...(sources.length?{sources}:{})};
}
