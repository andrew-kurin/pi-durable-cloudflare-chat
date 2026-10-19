import { MAX_REQUEST_BYTES, type RoundJournal } from './core';
import { RUNNER_PATH, sha256, siwcPayload, verifyRound } from '../../src/model-runner-protocol';
import { validatedStream } from './live-stream';
export class RunnerFailure extends Error { constructor(readonly code: string) { super(code); } }
export interface LiveRunnerOptions {
  key: CryptoKey;
  journal: RoundJournal;
  credentials: { access(): Promise<string> };
  /** Explicit transport, only ever called for the fixed official inference URL. */
  fetch: typeof fetch;
  timeoutMs?: number;
  now?: () => number;
}
const failure = (status: number, code: string) => Response.json({ error: { code, message: code } }, { status, headers: { 'cache-control': 'no-store' } });
export async function interrupted<T>(pending: Promise<T>, signal: AbortSignal): Promise<T> {
  return new Promise((resolve, reject) => {
    const stop = () => reject(new RunnerFailure('round_cancelled'));
    signal.addEventListener('abort', stop, { once: true });
    pending.then(resolve, reject).finally(() => signal.removeEventListener('abort', stop));
    if (signal.aborted) stop();
  });
}
/** Real backend, never installed by the fake entrypoint or production Worker. */
export function createSiwcRunner(options: LiveRunnerOptions) {
 return async (request: Request): Promise<Response> => {
  const url = new URL(request.url);
  if (request.method !== 'POST' || url.pathname !== RUNNER_PATH || url.search) return failure(404, 'not_found');
  const controller = new AbortController(), abort = () => controller.abort();
  request.signal.addEventListener('abort', abort, { once: true }); if (request.signal.aborted) abort();
  const timer = setTimeout(abort, options.timeoutMs ?? 120000);
  const finish = () => { clearTimeout(timer); request.signal.removeEventListener('abort', abort); };
  try {
    const reader = request.body?.getReader(); if (!reader) throw new RunnerFailure('invalid_body');
    const chunks: Uint8Array[] = []; let bytes = 0;
    try { while (true) { const p = await interrupted(reader.read(), controller.signal); if (p.done) break; bytes += p.value.length; if (bytes > MAX_REQUEST_BYTES) throw new RunnerFailure('invalid_body'); chunks.push(p.value); } }
    finally { void reader.cancel().catch(() => {}); }
    const all = new Uint8Array(bytes); let offset = 0; for (const chunk of chunks) { all.set(chunk, offset); offset += chunk.length; }
    const raw = new TextDecoder('utf-8', { fatal: true }).decode(all);
    if (!await verifyRound(options.key, request, raw, options.now?.())) { finish(); return failure(403, 'transport_auth_failed'); }
    let payload: Record<string, unknown>;
    try { const input = JSON.parse(raw); if (input.store !== false || input.stream !== true) throw Error(); payload = siwcPayload(input); }
    catch { finish(); return failure(400, 'unsupported_siwc_request'); }
    controller.signal.throwIfAborted();
    const id = request.headers.get('x-pi-round-id')!, reserved = await options.journal.reserve(id, await sha256(raw));
    if (reserved !== 'new') { finish(); return failure(409, reserved === 'conflict' ? 'round_conflict' : 'round_already_reserved'); }
    // Permanent fence precedes refresh and inference. No automatic replay ever.
    controller.signal.throwIfAborted();
    const access = await interrupted(options.credentials.access(), controller.signal);
    controller.signal.throwIfAborted();
    const pending = options.fetch('https://api.openai.com/v1/responses', { method: 'POST', redirect: 'error', signal: controller.signal,
      headers: { authorization: `Bearer ${access}`, 'content-type': 'application/json', accept: 'text/event-stream' }, body: JSON.stringify(payload) });
    void pending.then(r => { if (controller.signal.aborted) void r.body?.cancel().catch(() => {}); }, () => {});
    const response = await interrupted(pending, controller.signal);
    const media = response.headers.get('content-type')?.split(';')[0].trim().toLowerCase();
    if (!response.ok || !response.body || (media && media !== 'text/event-stream')) {
      void response.body?.cancel().catch(() => {}); finish();
      const code = response.status === 401 ? 'siwc_reauthorization_required' : response.status === 403 ? 'siwc_access_denied' : response.status === 429 ? 'siwc_usage_limited' : 'siwc_provider_rejected';
      return failure(502, code);
    }
    return new Response(validatedStream(response.body, controller.signal, finish, abort), { headers: { 'content-type': 'text/event-stream', 'cache-control': 'no-store', 'x-pi-round-id': id } });
  } catch (error) {
    abort(); finish();
    return failure(502, error instanceof RunnerFailure ? error.code : 'siwc_round_interrupted');
  }
 };
}
