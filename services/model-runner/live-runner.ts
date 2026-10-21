import {technicalError} from '../../src/error-log';
import { type RoundJournal } from './core';
import { RUNNER_PATH, sha256, siwcPayload, validRoundEnvelope, verifyRound } from '../../src/model-runner-protocol';
import { BodyReadError, bodyLength, readRunnerBody, RequestAdmission, type RequestAdmissionLimits } from './admission';
import { validatedStream } from './live-stream';
import { diagnosticText, emitDiagnostic, providerError, type Diagnostic } from './diagnostics';
import { providerFailureInfo, type ProviderFailureInfo } from '../../src/model-runner-error';
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
  admission?: Partial<RequestAdmissionLimits>;
}
const failure = (status: number, code: string, provider?: ProviderFailureInfo) => Response.json({ error: { code, message: code, ...(provider ? { provider } : {}) } }, { status, headers: { 'cache-control': 'no-store' } });
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
 const admission = new RequestAdmission(options.admission);
 return async (request: Request): Promise<Response> => {
  const url = new URL(request.url);
  if (request.method !== 'POST' || url.pathname !== RUNNER_PATH || url.search) return failure(404, 'not_found');
  const controller = new AbortController(), abort = () => controller.abort(), requestSignal = request.signal;
  requestSignal.addEventListener('abort', abort, { once: true }); if (requestSignal.aborted) abort();
  const reportedRound=request.headers.get('x-pi-round-id')??'';
  let roundId: string | undefined=/^[a-zA-Z0-9_-]{8,80}$/.test(reportedRound)?reportedRound:undefined, stage='request';const started=Date.now();let bodyBytes=0;
  const workerVersion=request.headers.get('x-pi-worker-version')??undefined;
  const kind=request.headers.get('x-pi-task-kind')==='compaction'?'compaction':'generation';
  const log=(record:Record<string,unknown>)=>emitDiagnostic(options.diagnostic,{event:'pi_runner',roundId,stage,kind,runnerVersion:options.version,workerVersion:workerVersion&&/^[a-f0-9-]{36}$/.test(workerVersion)?workerVersion:undefined,bodyBytes,durationMs:Date.now()-started,...record});
  const timer = setTimeout(abort, options.timeoutMs ?? 120000);
  const finish = () => { clearTimeout(timer); requestSignal.removeEventListener('abort', abort); };
  let release: (() => void) | undefined;
  try {
    if (!validRoundEnvelope(request, options.now?.())) { log({outcome:'rejected',httpStatus:403,code:'transport_auth_failed'});finish();void request.body?.cancel().catch(()=>{});return failure(403, 'transport_auth_failed'); }
    let length: number | undefined;
    try { length = bodyLength(request.headers); } catch { void request.body?.cancel().catch(()=>{});throw new RunnerFailure('invalid_body'); }
    release = admission.reserve(length);
    if (!release) { log({outcome:'rejected',httpStatus:503,code:'runner_admission_limit'});finish();void request.body?.cancel().catch(()=>{});return failure(503, 'runner_admission_limit'); }
    let raw: string;
    try { raw = await readRunnerBody(request, controller.signal, admission.limits.readTimeoutMs, length, bytes => { bodyBytes = bytes; }); }
    catch (error) { throw error instanceof BodyReadError ? new RunnerFailure(error.message) : error; }
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
      let provider = providerFailureInfo(response.status, undefined);
      // Only bounded technical error fields; never log an inference success body.
      if (!response.ok && response.body) {
        const reader=response.body.getReader();let text='',size=0;
        try { while(size<=8192) {const p=await interrupted(reader.read(),controller.signal);if(p.done)break;size+=p.value.length;if(size>8192)break;text+=new TextDecoder().decode(p.value);}if(size<=8192){try{const parsed=JSON.parse(text);provider=providerFailureInfo(response.status,parsed.error);log({outcome:'provider_error',httpStatus:response.status,error:providerError(parsed.error)});}catch{log({outcome:'provider_error',httpStatus:response.status,errorBody:diagnosticText(text)});}} }
        catch { log({outcome:'provider_error_unavailable',httpStatus:response.status}); }
        finally { void reader.cancel().catch(()=>{}); }
      } else void response.body?.cancel().catch(() => {}); finish();
      const code = response.status === 401 ? 'siwc_reauthorization_required' : response.status === 403 ? 'siwc_access_denied' : response.status === 429 ? 'siwc_usage_limited' : 'siwc_provider_rejected';
      // Preserve definitive input rejections as an application 400 response;
      // wrapping them in 502 can lose the JSON envelope at the gateway.
      return failure(response.status === 400 ? 400 : 502, code, provider);
    }
    stage='stream';
    return new Response(validatedStream(response.body, controller.signal, finish, abort,log), { headers: { 'content-type': 'text/event-stream', 'cache-control': 'no-store', 'x-pi-round-id': id } });
  } catch (error) {
    log({outcome:'failure',code:error instanceof RunnerFailure?error.code:'siwc_round_interrupted',message:diagnosticText(error instanceof Error?error.message:undefined),error:technicalError(error),aborted:controller.signal.aborted});
    abort(); finish();
    return failure(502, error instanceof RunnerFailure ? error.code : 'siwc_round_interrupted');
  } finally { release?.(); }
 };
}
