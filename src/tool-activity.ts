import type { EntryRecord } from '@earendil-works/pi-durable';
export type ToolState = 'pending' | 'running' | 'success' | 'error' | 'interrupted' | 'unavailable';
export type ToolLinkage = 'following_response' | 'streaming_response' | 'user_boundary' | 'turn_unavailable' | 'result_unavailable' | 'order_unavailable' | 'no_following_response' | 'unlinked';
export interface ToolActivity { id: string; label: string; state: ToolState; detail: string; linkage?: ToolLinkage; }
const labels: Record<string,string> = {web_search:'Web search',fetch_page:'Read web page',github_search:'Search GitHub',github_read:'Read GitHub',ask_luna:'Ask Luna'};
export const toolLabel = (name: string) => Object.hasOwn(labels,name) ? labels[name] : 'Tool';
export const stateDetail = (state: ToolState) => ({pending:'Waiting to start.',running:'Working. Arguments and live output are kept private.',success:'Completed. Raw output is kept private.',error:'Failed. Raw error details are kept private.',interrupted:'Interrupted before completion.',unavailable:'No recorded result is available.'})[state];
export function resultSummary(entry: EntryRecord, name: string): Pick<ToolActivity,'state'|'detail'> | null {
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
 if (state==='success') {
  if(Array.isArray(data?.results)) details.push(`${Math.min(data.results.length,5)} ${data.results.length===1?'result':'results'} returned.`);
  if(Array.isArray(data?.entries)) details.push(`${Math.min(data.entries.length,50)} ${data.entries.length===1?'entry':'entries'} returned.`);
  if(data?.truncated===true) details.push('Result was truncated.');
  if(data?.incomplete===true) details.push('Search results may be incomplete.');
 }
 if(Number.isFinite(message.durationMs) && message.durationMs!>=0) details.push(`Duration: ${Math.round(Math.min(message.durationMs!,86400000))/1000}s.`);
 return {state,detail:details.join(' ')};
}
