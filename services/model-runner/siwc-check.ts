import { redactDiagnosticCredentials } from '../../src/diagnostic-credentials';
import { readSiwcCatalog, type CatalogEvidence } from './siwc-catalog';
import { normalizeContext } from '@earendil-works/pi-ai/utils/transcript';
import { Type, type Message } from '@earendil-works/pi-ai';
import { openaiProvider } from '@earendil-works/pi-ai/providers/openai';
import { streamSimple } from '@earendil-works/pi-ai/api/openai-responses';
import type { LocalSiwcCredential } from './siwc-auth';
import type { RoundJournal } from './core';
const TARGETS = ['gpt-6.1-sol', 'gpt-6-luna'] as const;
export interface SiwcReport { catalogEvidence?: CatalogEvidence; catalog: { slug: string; display_name: string; visibility?: string }[]; checks: { model: string; status: string; requests: number; toolCalls: number; http: number[]; terminal: string[]; eventCounts?:Record<string,number>; textObserved?:boolean; textByRound?:{round:number;text:string}[]; toolEvidence?:{callId:string;name:string;arguments:object;result:string}; error?: string; sdkError?: string; evidence?: {status:number;contentType?:string;requestId?:string;cfRay?:string;bodyExcerpt?:string;bodyPresent?:boolean;headersCapturedAt?:'transport-return';bytesRead?:number;readError?:string;formatNote?:string;bodyKind?:string}[] }[] }
/** A fixed one-shot LOCAL diagnostic, independent of pi-chat and its credentials.
 * Explicit transport/credential injection; no ambient fetch, OAuth or billing fallback. */
export async function runLocalSiwcCheck(credential: LocalSiwcCredential, transport: typeof fetch, journal: RoundJournal, approved: boolean): Promise<SiwcReport> {
 if (!approved) throw Error('Explicit local diagnostic approval required');
 if (!credential.scopes.includes('chatgpt.tokens.use.direct') || credential.expires <= Date.now() || !credential.access || credential.access.startsWith('sk-')) throw Error('Valid SIWC consent required; no refresh or API-key fallback');
 if (await journal.reserve('local-siwc-check-v1', '0'.repeat(64)) !== 'new') throw Error('Diagnostic already reserved; do not replay');
 return runLocalSiwcRounds(credential, transport, await readSiwcCatalog(credential, transport));
}
export async function runLocalSiwcRounds(credential: LocalSiwcCredential, transport: typeof fetch, catalogEvidence: CatalogEvidence, beforeRequest?: (model: string, round: number) => Promise<void>, progress?: (report: SiwcReport) => Promise<void>, mode: 'original' | 'sol-text-only' = 'original', captureText = false): Promise<SiwcReport> {
 if (credential.expires <= Date.now() || !credential.scopes.includes('chatgpt.tokens.use.direct') || credential.access.startsWith('sk-')) throw Error('Valid SIWC session required; no refresh');
 const clean=(value:string)=>redactDiagnosticCredentials(value,[credential.access,credential.refresh,credential.idToken]).slice(0,4096);
 const report: SiwcReport = { catalog: [], checks: [] };
 const controller = new AbortController(), timer = setTimeout(() => controller.abort(), 240000);
 async function bounded(response: Response, max: number, evidence?: NonNullable<SiwcReport['checks'][number]['evidence']>[number]) {
  const reader = response.body!.getReader(); let size = 0; const sample:Uint8Array[]=[];let sampled=0;
  const diagnose=()=>{if(!evidence)return;const bytes=new Uint8Array(sampled);let offset=0;for(const chunk of sample){bytes.set(chunk,offset);offset+=chunk.length;}const prefix=new TextDecoder().decode(bytes),trim=prefix.trimStart();evidence.bodyKind=!size?'empty':/(?:^|\n)(?:data|event):/.test(prefix)?'sse-framing':trim.startsWith('<')?'html':/^[{[]/.test(trim)?'json':'other';if(evidence.bodyKind==='html')evidence.bodyExcerpt=clean(prefix);if(evidence.bodyKind==='json'){try{const parsed=JSON.parse(prefix);if(parsed?.error)evidence.bodyExcerpt=clean(JSON.stringify(parsed.error));}catch{/* No arbitrary generated/opaque body persistence. */}}};
  return new Response(new ReadableStream<Uint8Array>({ async pull(output) { try { const p = await reader.read(); if (p.done) {diagnose();output.close();} else {if(sampled<4096){const part=p.value.slice(0,4096-sampled);sample.push(part);sampled+=part.length;} size += p.value.length; if(evidence)evidence.bytesRead=size; if (size > max) { controller.abort(); await reader.cancel(); throw Error('Receive limit'); } output.enqueue(p.value); } } catch(error) { diagnose(); if(evidence)evidence.readError=clean(error instanceof Error?error.message:String(error)); output.error(Error('Bounded stream interrupted')); } }, cancel: () => reader.cancel() }), { status: response.status, headers: response.headers });
 }
 try {
  report.catalogEvidence = catalogEvidence; report.catalog = catalogEvidence.catalog;
  if (catalogEvidence.outcome !== 'available') return report;
  for (const id of (mode==='sol-text-only' ? [TARGETS[0]] : TARGETS)) {
   const useTool=mode==='original'&&id===TARGETS[0];
   const check: SiwcReport['checks'][number] = { model: id, status: 'unavailable', requests: 0, toolCalls: 0, http: [], terminal: [] }; report.checks.push(check);
   if (!report.catalog.some(model => model.slug === id)) continue;
   const base = openaiProvider().getModels().find(model => model.id === id); if (!base) { check.status = 'unsupported_by_pin'; continue; }
   const model = { ...base, api: 'openai-responses' as const, provider: 'openai', baseUrl: 'https://api.openai.com/v1' };
   const messages: Message[] = [{ role: 'user', content: useTool ? 'Call test_status once, then confirm offline-marker in one short sentence.' : 'Say compatibility ok in one short sentence.', timestamp: 1 }];
   let round = 0; const abort = new AbortController(), abortOuter = () => abort.abort(); controller.signal.addEventListener('abort', abortOuter); if (controller.signal.aborted) abort.abort(); const deadline = setTimeout(() => abort.abort(), 120000);
   const request = async () => {
    round++; let completed = false;
    const stream = streamSimple(model, normalizeContext({ messages, ...(useTool ? { tools: [{ name: 'test_status', description: 'Fixed marker; no environment access.', parameters: Type.Object({}, { additionalProperties: false }) }] } : {}) }), { apiKey: credential.access, reasoning: 'low', maxRetries: 0, timeoutMs: 60000, signal: abort.signal,
     fetch: async (input, init) => {
      if (String(input) !== 'https://api.openai.com/v1/responses' || init?.method !== 'POST' || check.requests >= (useTool ? 2 : 1)) throw Error('Outside fixed diagnostic');
      await beforeRequest?.(id, round); check.requests++; await progress?.(report); const response = await transport(input, { ...init, redirect: 'error', signal: init?.signal ? AbortSignal.any([init.signal,abort.signal]) : abort.signal }); check.http.push(response.status);
      const evidence: NonNullable<SiwcReport['checks'][number]['evidence']>[number]={status:response.status,bodyPresent:!!response.body,headersCapturedAt:'transport-return'};
      for(const [header,key] of [['content-type','contentType'],['x-request-id','requestId'],['cf-ray','cfRay']] as const){const v=response.headers.get(header);if(v!==null)evidence[key]=clean(v);}
      (check.evidence??=[]).push(evidence);
      if (!response.ok) { const body=response.body?await (await bounded(response,65536)).text():''; evidence.bodyExcerpt=clean(body); await progress?.(report); return new Response(body,{status:response.status,headers:response.headers}); }
      const mediaType=response.headers.get('content-type')?.split(';')[0].trim().toLowerCase();
      if (!response.body || (mediaType && mediaType!=='text/event-stream')) { check.error='Expected SSE; content-type: '+(evidence.contentType??'absent')+'; body present: '+!!response.body; if(response.body)evidence.bodyExcerpt=clean(await (await bounded(response,65536)).text()); await progress?.(report); throw Error(check.error); }
      if(!mediaType)evidence.formatNote='Content-Type absent; require valid SSE and response.completed';
      return bounded(response, 65536, evidence);
     },
     onPayload: raw => {
      const p = raw as Record<string, any>, tools = p.tools;
      // additional_tools is documented and preserves native function names/IDs.
      return { model: id, input: [...(tools?.length ? [{ type: 'additional_tools', role: 'developer', tools }] : []), ...p.input], store: false, stream: true, ...(p.reasoning ? { reasoning: p.reasoning } : {}), ...(p.include ? { include: p.include } : {}), ...(useTool ? { tool_choice: round === 1 ? 'required' : 'none' } : {}) };
     },
     onProviderStreamEvent: event => { const type = (event as { type?: string }).type; if(type&&/^response\.[a-z_.]{1,100}$/.test(type)){check.eventCounts??={};check.eventCounts[type]=(check.eventCounts[type]??0)+1;} if (type === 'response.completed') completed = true; if (['response.completed','response.failed','response.incomplete'].includes(type ?? '')) check.terminal.push(type!); },
    });
    for await (const _event of stream) { /* Raw events and hidden reasoning never logged; final text capture is opt-in below. */ }
    const result = await stream.result(); if(captureText)(check.textByRound??=[]).push({round,text:clean(result.content.filter(c=>c.type==='text').map(c=>c.text).join(''))}); check.textObserved=result.content.some(c=>c.type==='text'&&!!c.text.trim()); if(result.errorMessage)check.sdkError=clean(result.errorMessage); await progress?.(report); if (!completed || !['stop','toolUse'].includes(result.stopReason)) throw Error('Incomplete or failed inference'); return result;
   };
   try {
    const first = await request();
    if (useTool) {
     const calls = first.content.filter(c => c.type === 'toolCall');
     if (first.stopReason !== 'toolUse' || calls.length !== 1 || calls[0].name !== 'test_status' || !calls[0].arguments || typeof calls[0].arguments !== 'object' || Array.isArray(calls[0].arguments) || Object.keys(calls[0].arguments).length) throw Error('Unexpected tool');
     check.toolCalls = 1; if(captureText)check.toolEvidence={callId:clean(calls[0].id),name:'test_status',arguments:{},result:'offline-marker'}; messages.push(first, { role: 'toolResult', toolCallId: calls[0].id, toolName: 'test_status', content: [{ type: 'text', text: 'offline-marker' }], isError: false, timestamp: 2 });
     const last = await request(); if (last.stopReason !== 'stop' || !last.content.some(c => c.type === 'text' && c.text.includes('offline-marker'))) throw Error('Marker not confirmed');
    } else if (first.stopReason !== 'stop' || !first.content.some(c => c.type === 'text' && c.text.trim())) throw Error('No Luna text');
    check.status = 'passed';
   } catch (error) { check.status = 'failed'; check.error??=clean(error instanceof Error?error.message:String(error)); }
   finally { clearTimeout(deadline); controller.signal.removeEventListener('abort', abortOuter); await progress?.(report); }
  }
  return report;
 } finally { clearTimeout(timer); controller.abort(); }
}
