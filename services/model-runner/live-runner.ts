import {technicalError} from '../../src/error-log';
import { MAX_REQUEST_BYTES, type RoundJournal } from './core';
import { RUNNER_PATH, sha256, siwcPayload, verifyRound } from '../../src/model-runner-protocol';
import { validatedStream } from './live-stream';
import { diagnosticText, emitDiagnostic, providerError, type Diagnostic } from './diagnostics';
export class RunnerFailure extends Error { constructor(readonly code: string) { super(code); } }
export interface LiveRunnerOptions {
  key: CryptoKey;
  journal: RoundJournal;
  credentials: { access(): Promise<string> };
  /** Explicit transport, only ever called for the fixed official inference URL. */
  fetch: typeof fetch;
  timeoutMs?: number;
  now?: () => number;
  diagnostic?: Diagnostic;
  version?: string;
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
  const reportedRound=request.headers.get('x-pi-round-id')??'';
  let roundId: string | undefined=/^[a-zA-Z0-9_-]{8,80}$/.test(reportedRound)?reportedRound:undefined, stage='request';const started=Date.now();let bodyBytes=0;
  const workerVersion=request.headers.get('x-pi-worker-version')??undefined;
  const kind=request.headers.get('x-pi-task-kind')==='compaction'?'compaction':'generation';
  const log=(record:Record<string,unknown>)=>emitDiagnostic(options.diagnostic,{event:'pi_runner',roundId,stage,kind,runnerVersion:options.version,workerVersion:workerVersion&&/^[a-f0-9-]{36}$/.test(workerVersion)?workerVersion:undefined,bodyBytes,durationMs:Date.now()-started,...record});
  const timer = setTimeout(abort, options.timeoutMs ?? 120000);
  const finish = () => { clearTimeout(timer); request.signal.removeEventListener('abort', abort); };
  try {
    const reader = request.body?.getReader(); if (!reader) throw new RunnerFailure('invalid_body');
    const chunks: Uint8Array[] = []; let bytes = 0;
    try { while (true) { const p = await interrupted(reader.read(), controller.signal); if (p.done) break; bytes += p.value.length; bodyBytes=bytes; if (bytes > MAX_REQUEST_BYTES) throw new RunnerFailure('invalid_body'); chunks.push(p.value); } }
    finally { void reader.cancel().catch(() => {}); }
    bodyBytes=bytes;
    const all = new Uint8Array(bytes); let offset = 0; for (const chunk of chunks) { all.set(chunk, offset); offset += chunk.length; }
    const raw = new TextDecoder('utf-8', { fatal: true }).decode(all);
    if (!await verifyRound(options.key, request, raw, options.now?.())) { log({outcome:'rejected',httpStatus:403,code:'transport_auth_failed'});finish(); return failure(403, 'transport_auth_failed'); }
    let payload: Record<string, unknown>;
    try { const input = JSON.parse(raw); if (input.store !== false || input.stream !== true) throw Error(); payload = siwcPayload(input); }
    catch { log({outcome:'rejected',httpStatus:400,code:'unsupported_siwc_request'});finish(); return failure(400, 'unsupported_siwc_request'); }
    controller.signal.throwIfAborted();
    const id = request.headers.get('x-pi-round-id')!; roundId=id; stage='reservation'; log({outcome:'authenticated',model:payload.model});
    const reserved = await options.journal.reserve(id, await sha256(raw));
    if (reserved !== 'new') { log({outcome:'rejected',httpStatus:409,code:reserved==='conflict'?'round_conflict':'round_already_reserved'});finish(); return failure(409, reserved === 'conflict' ? 'round_conflict' : 'round_already_reserved'); }
    // Permanent fence precedes refresh and inference. No automatic replay ever.
    controller.signal.throwIfAborted();
    stage='credentials';
    const access = await interrupted(options.credentials.access(), controller.signal);
    controller.signal.throwIfAborted();
    stage='provider';log({outcome:'dispatch'});
    const pending = options.fetch('https://api.openai.com/v1/responses', { method: 'POST', redirect: 'error', signal: controller.signal,
      headers: { authorization: `Bearer ${access}`, 'content-type': 'application/json', accept: 'text/event-stream' }, body: JSON.stringify(payload) });
    void pending.then(r => { if (controller.signal.aborted) void r.body?.cancel().catch(() => {}); }, () => {});
    const response = await interrupted(pending, controller.signal);
    log({outcome:'response',httpStatus:response.status,requestId:diagnosticText(response.headers.get('x-request-id')),contentType:diagnosticText(response.headers.get('content-type'))});
    const media = response.headers.get('content-type')?.split(';')[0].trim().toLowerCase();
    if (!response.ok || !response.body || (media && media !== 'text/event-stream')) {
      // Only bounded technical error fields; never log an inference success body.
      if (!response.ok && response.body) {
        const reader=response.body.getReader();let text='',size=0;
        try { while(size<=8192) {const p=await interrupted(reader.read(),controller.signal);if(p.done)break;size+=p.value.length;if(size>8192)break;text+=new TextDecoder().decode(p.value);}if(size<=8192){try{const parsed=JSON.parse(text);log({outcome:'provider_error',httpStatus:response.status,error:providerError(parsed.error)});}catch{log({outcome:'provider_error',httpStatus:response.status,errorBody:diagnosticText(text)});}} }
        catch { log({outcome:'provider_error_unavailable',httpStatus:response.status}); }
        finally { void reader.cancel().catch(()=>{}); }
      } else void response.body?.cancel().catch(() => {}); finish();
      const code = response.status === 401 ? 'siwc_reauthorization_required' : response.status === 403 ? 'siwc_access_denied' : response.status === 429 ? 'siwc_usage_limited' : 'siwc_provider_rejected';
      return failure(502, code);
    }
    stage='stream';
    return new Response(validatedStream(response.body, controller.signal, finish, abort,log), { headers: { 'content-type': 'text/event-stream', 'cache-control': 'no-store', 'x-pi-round-id': id } });
  } catch (error) {
    log({outcome:'failure',code:error instanceof RunnerFailure?error.code:'siwc_round_interrupted',message:diagnosticText(error instanceof Error?error.message:undefined),error:technicalError(error),aborted:controller.signal.aborted});
    abort(); finish();
    return failure(502, error instanceof RunnerFailure ? error.code : 'siwc_round_interrupted');
  }
 };
}
