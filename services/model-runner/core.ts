/** Offline service boundary. No OAuth, ambient credentials or external fetch. */
export const PROTOTYPE_MODEL = 'gpt-6.1-sol';
import { MAX_REQUEST_BYTES } from '../../src/model-runner-protocol';
export { MAX_REQUEST_BYTES };
export interface RoundJournal { reserve(id: string, fingerprint: string): Promise<'new' | 'duplicate' | 'conflict'> }
export class MemoryRoundJournal implements RoundJournal {
  readonly rounds = new Map<string, string>();
  async reserve(id: string, fingerprint: string) {
    const prior = this.rounds.get(id);
    if (prior !== undefined) return prior === fingerprint ? 'duplicate' : 'conflict';
    if (this.rounds.size >= 10000) throw Error('Journal full');
    this.rounds.set(id, fingerprint);
    return 'new' as const;
  }
}
export interface FakeCredential { access: string; expires: number }
/** One refresh owner, including concurrent rounds. Storage is deliberately injected. */
export function serializedCredentials(store: { read(): Promise<FakeCredential>; write(value: FakeCredential): Promise<void> }, refresh: (current: FakeCredential) => Promise<FakeCredential>, now = Date.now) {
  let pending: Promise<string> | undefined;
  return { access(): Promise<string> {
    if (!pending) pending = (async () => {
      let value = await store.read();
      if (value.expires <= now()) { value = await refresh(value); await store.write(value); }
      if (!value.access || value.expires <= now()) throw Error('Credential unavailable');
      return value.access;
    })().finally(() => { pending = undefined; });
    return pending;
  } };
}
export interface OfflineRunnerOptions {
  journal: RoundJournal;
  credentials: { access(): Promise<string> };
  backend: (payload: Record<string, unknown>, access: string, signal: AbortSignal) => Promise<Response>;
  timeoutMs?: number;
}
const failure = (status: number, code: string) => Response.json({ error: { code, message: code } }, { status });
async function boundedJson(request: Request) {
  const reader = request.body?.getReader(); if (!reader) throw Error('Missing body');
  const chunks: Uint8Array[] = []; let size = 0;
  try { while (true) { const part = await reader.read(); if (part.done) break; size += part.value.length; if (size > MAX_REQUEST_BYTES) { await reader.cancel(); throw Error('Body too large'); } chunks.push(part.value); } }
  finally { reader.releaseLock(); }
  const all = new Uint8Array(size); let offset = 0; for (const chunk of chunks) { all.set(chunk, offset); offset += chunk.length; }
  return JSON.parse(new TextDecoder().decode(all));
}
function abortable<T>(promise: Promise<T>, signal: AbortSignal): Promise<T> {
  return new Promise((resolve, reject) => {
    const abort = () => reject(new Error('Aborted'));
    signal.addEventListener('abort', abort, { once: true });
    if (signal.aborted) abort();
    promise.then(resolve, reject).finally(() => signal.removeEventListener('abort', abort));
  });
}
export function createOfflineRunner(options: OfflineRunnerOptions) {
  return async (request: Request): Promise<Response> => {
    const url = new URL(request.url);
    if (url.pathname === '/health' && request.method === 'GET') return Response.json({ mode: 'offline-fake-only', contract: 1 });
    if (url.pathname !== '/v1/responses' || request.method !== 'POST') return failure(404, 'not_found');
    if (request.headers.get('x-pi-prototype') !== 'offline-v1') return failure(403, 'offline_prototype_only');
    const id = request.headers.get('x-pi-round-id');
    if (!id || !/^[a-zA-Z0-9_-]{8,80}$/.test(id)) return failure(400, 'invalid_round_id');
    let payload: Record<string, unknown>;
    try { payload = await boundedJson(request); }
    catch { return failure(400, 'invalid_or_oversized_body'); }
    if (!payload || typeof payload !== 'object' || Array.isArray(payload) || payload.model !== PROTOTYPE_MODEL || !Array.isArray(payload.input) || payload.store !== false || payload.stream !== true) return failure(400, 'invalid_round');
    // This is a fake-only contract, NOT an assertion that all Pi fields/tools are
    // SIWC compatible. A live adapter must validate the documented SIWC subset.
    const controller = new AbortController(), abort = () => controller.abort();
    request.signal.addEventListener('abort', abort, { once: true }); if (request.signal.aborted) abort();
    const timer = setTimeout(abort, options.timeoutMs ?? 120000);
    const finish = () => { clearTimeout(timer); request.signal.removeEventListener('abort', abort); };
    try {
      controller.signal.throwIfAborted();
      const fingerprint = [...new Uint8Array(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(JSON.stringify(payload))))].map(x => x.toString(16).padStart(2, '0')).join('');
      const reserved = await options.journal.reserve(id, fingerprint);
      if (reserved !== 'new') { finish(); return failure(409, reserved === 'conflict' ? 'round_conflict' : 'round_already_reserved'); }
      controller.signal.throwIfAborted();
      const access = await abortable(options.credentials.access(), controller.signal);
      controller.signal.throwIfAborted();
      // Reservation is permanent even on failure/disconnect. Never retry here.
      const pendingResponse = options.backend(payload, access, controller.signal);
      void pendingResponse.then(response => { if (controller.signal.aborted) void response.body?.cancel().catch(() => {}); }, () => {});
      const response = await abortable(pendingResponse, controller.signal);
      if (!response.ok || !response.headers.get('content-type')?.includes('text/event-stream') || !response.body) {
        await response.body?.cancel(); finish(); return failure(502, 'fake_backend_rejected');
      }
      const reader = response.body.getReader();
      const stop = () => { void reader.cancel().catch(() => {}); };
      controller.signal.addEventListener('abort', stop, { once: true });
      const cleanup = () => { controller.signal.removeEventListener('abort', stop); finish(); };
      return new Response(new ReadableStream<Uint8Array>({
        async pull(output) {
          try { controller.signal.throwIfAborted(); const part = await reader.read(); controller.signal.throwIfAborted(); if (part.done) { cleanup(); output.close(); } else output.enqueue(part.value); }
          catch { cleanup(); output.error(new Error('Prototype stream interrupted')); }
        },
        async cancel() { controller.abort(); cleanup(); await reader.cancel().catch(() => {}); },
      }), { headers: { 'content-type': 'text/event-stream', 'cache-control': 'no-store', 'x-pi-round-id': id } });
    } catch { controller.abort(); finish(); return failure(502, 'prototype_round_interrupted'); }
  };
}
