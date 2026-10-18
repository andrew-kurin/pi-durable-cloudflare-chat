import { normalizeContext } from '@earendil-works/pi-ai/utils/transcript';
import { Type, type Message } from '@earendil-works/pi-ai';
import { openaiProvider } from '@earendil-works/pi-ai/providers/openai';
import { streamSimple } from '@earendil-works/pi-ai/api/openai-responses';
import type { LocalSiwcCredential } from './siwc-auth';
import type { RoundJournal } from './core';
const TARGETS = ['gpt-6.1-sol', 'gpt-6-luna'] as const;
export interface SiwcReport { catalog: { slug: string; display_name: string; visibility?: string }[]; checks: { model: string; status: string; requests: number; toolCalls: number; http: number[]; terminal: string[] }[] }
/** A fixed one-shot LOCAL diagnostic, independent of pi-chat and its credentials.
 * Explicit transport/credential injection; no ambient fetch, OAuth or billing fallback. */
export async function runLocalSiwcCheck(credential: LocalSiwcCredential, transport: typeof fetch, journal: RoundJournal, approved: boolean): Promise<SiwcReport> {
 if (!approved) throw Error('Explicit local diagnostic approval required');
 if (!credential.scopes.includes('chatgpt.tokens.use.direct') || credential.expires <= Date.now() || !credential.access || credential.access.startsWith('sk-')) throw Error('Valid SIWC consent required; no refresh or API-key fallback');
 if (await journal.reserve('local-siwc-check-v1', '0'.repeat(64)) !== 'new') throw Error('Diagnostic already reserved; do not replay');
 const report: SiwcReport = { catalog: [], checks: [] };
 const controller = new AbortController(), timer = setTimeout(() => controller.abort(), 240000);
 async function bounded(response: Response, max: number) {
  const reader = response.body!.getReader(); let size = 0;
  return new Response(new ReadableStream<Uint8Array>({ async pull(output) { try { const p = await reader.read(); if (p.done) output.close(); else { size += p.value.length; if (size > max) { controller.abort(); await reader.cancel(); throw Error('Receive limit'); } output.enqueue(p.value); } } catch { output.error(Error('Bounded stream interrupted')); } }, cancel: () => reader.cancel() }), { status: response.status, headers: response.headers });
 }
 try {
  const catalog = await transport('https://api.openai.com/v1/models', { headers: { authorization: `Bearer ${credential.access}` }, redirect: 'error', signal: controller.signal });
  if (!catalog.ok || !catalog.headers.get('content-type')?.includes('json') || !catalog.body) { await catalog.body?.cancel(); throw Error('Model catalog unavailable'); }
  const data = await (await bounded(catalog, 262144)).json() as { models?: unknown };
  if (!Array.isArray(data.models) || data.models.length > 1000) throw Error('Invalid model catalog');
  report.catalog = data.models.map((m: any) => { if ([credential.access, credential.refresh, credential.idToken].filter(Boolean).some(secret => String(m.slug).includes(secret) || String(m.display_name).includes(secret))) throw Error('Unsafe catalog'); if (typeof m.slug !== 'string' || !/^[\w.-]{1,128}$/.test(m.slug) || typeof m.display_name !== 'string' || m.display_name.length > 200 || /[\x00-\x1f]/.test(m.display_name)) throw Error('Invalid model catalog entry'); return { slug: m.slug, display_name: m.display_name, ...(m.visibility === 'list' ? { visibility: 'list' } : {}) }; });
  for (const id of TARGETS) {
   const check: SiwcReport['checks'][number] = { model: id, status: 'unavailable', requests: 0, toolCalls: 0, http: [], terminal: [] }; report.checks.push(check);
   if (!report.catalog.some(model => model.slug === id)) continue;
   const base = openaiProvider().getModels().find(model => model.id === id); if (!base) { check.status = 'unsupported_by_pin'; continue; }
   const model = { ...base, api: 'openai-responses' as const, provider: 'openai', baseUrl: 'https://api.openai.com/v1' };
   const messages: Message[] = [{ role: 'user', content: id === TARGETS[0] ? 'Call test_status once, then confirm offline-marker in one short sentence.' : 'Say compatibility ok in one short sentence.', timestamp: 1 }];
   let round = 0; const abort = new AbortController(), abortOuter = () => abort.abort(); controller.signal.addEventListener('abort', abortOuter); if (controller.signal.aborted) abort.abort(); const deadline = setTimeout(() => abort.abort(), 120000);
   const request = async () => {
    round++; let completed = false;
    const stream = streamSimple(model, normalizeContext({ messages, ...(id === TARGETS[0] ? { tools: [{ name: 'test_status', description: 'Fixed marker; no environment access.', parameters: Type.Object({}, { additionalProperties: false }) }] } : {}) }), { apiKey: credential.access, reasoning: 'low', maxRetries: 0, timeoutMs: 60000, signal: abort.signal,
     fetch: async (input, init) => {
      if (String(input) !== 'https://api.openai.com/v1/responses' || init?.method !== 'POST' || check.requests >= (id === TARGETS[0] ? 2 : 1)) throw Error('Outside fixed diagnostic');
      check.requests++; const response = await transport(input, { ...init, redirect: 'error', signal: abort.signal }); check.http.push(response.status);
      if (!response.ok) { await response.body?.cancel(); return Response.json({ error: { code: 'siwc_http_rejected', message: 'SIWC request rejected' } }, { status: response.status }); }
      if (!response.body || !response.headers.get('content-type')?.includes('text/event-stream')) { await response.body?.cancel(); throw Error('Expected SSE'); }
      return bounded(response, 65536);
     },
     onPayload: raw => {
      const p = raw as Record<string, any>, tools = p.tools;
      // additional_tools is documented and preserves native function names/IDs.
      return { model: id, input: [...(tools?.length ? [{ type: 'additional_tools', role: 'developer', tools }] : []), ...p.input], store: false, stream: true, ...(p.reasoning ? { reasoning: p.reasoning } : {}), ...(p.include ? { include: p.include } : {}), ...(id === TARGETS[0] ? { tool_choice: round === 1 ? 'required' : 'none' } : {}) };
     },
     onProviderStreamEvent: event => { const type = (event as { type?: string }).type; if (type === 'response.completed') completed = true; if (['response.completed','response.failed','response.incomplete'].includes(type ?? '')) check.terminal.push(type!); },
    });
    for await (const _event of stream) { /* Generated text/reasoning never logged. */ }
    const result = await stream.result(); if (!completed || !['stop','toolUse'].includes(result.stopReason)) throw Error('Incomplete or failed inference'); return result;
   };
   try {
    const first = await request();
    if (id === TARGETS[0]) {
     const calls = first.content.filter(c => c.type === 'toolCall');
     if (first.stopReason !== 'toolUse' || calls.length !== 1 || calls[0].name !== 'test_status' || !calls[0].arguments || typeof calls[0].arguments !== 'object' || Array.isArray(calls[0].arguments) || Object.keys(calls[0].arguments).length) throw Error('Unexpected tool');
     check.toolCalls = 1; messages.push(first, { role: 'toolResult', toolCallId: calls[0].id, toolName: 'test_status', content: [{ type: 'text', text: 'offline-marker' }], isError: false, timestamp: 2 });
     const last = await request(); if (last.stopReason !== 'stop' || !last.content.some(c => c.type === 'text' && c.text.includes('offline-marker'))) throw Error('Marker not confirmed');
    } else if (first.stopReason !== 'stop' || !first.content.some(c => c.type === 'text' && c.text.trim())) throw Error('No Luna text');
    check.status = 'passed';
   } catch { check.status = 'failed'; }
   finally { clearTimeout(deadline); controller.signal.removeEventListener('abort', abortOuter); }
  }
  return report;
 } finally { clearTimeout(timer); controller.abort(); }
}
