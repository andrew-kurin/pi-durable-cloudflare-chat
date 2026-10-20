import { createProvider } from '@earendil-works/pi-ai/models';
import { siwcRunnerModels } from './model-runner-models';
import { stream, streamSimple } from '@earendil-works/pi-ai/api/openai-responses';
import { createAssistantMessageEventStream } from '@earendil-works/pi-ai/utils/event-stream';
import { appendAssistantMessageDiagnostic } from '@earendil-works/pi-ai/utils/diagnostics';
import type { ProviderStreams } from '@earendil-works/pi-ai';
import { technicalError,redactErrorText } from './error-log';
import { MAX_REQUEST_BYTES, ROUND_ID, RUNNER_PATH, signRound, siwcPayload } from './model-runner-protocol';
import { RUNNER_SERVICE_CODES, providerFailureInfo, type ProviderFailureInfo } from './model-runner-error';
/** Explicit per-round provider. Caller MUST durably reserve roundId before use,
 * restore the same ID after interruption, and create a distinct ID for tool continuation.
 * No environment defaults and no OpenAI credentials ever enter this Worker. */
export function createSiwcRunnerProvider(connection: { endpoint: string; key: CryptoKey; roundId: string; fetch: typeof fetch; now?: () => number; telemetry?: {workerVersion?:string;kind?:'generation'|'compaction';conversation?:string}; beforeDispatch?: (body: string) => Promise<'new' | 'duplicate' | 'conflict'> }) {
  const target = new URL(connection.endpoint);
  if (target.protocol !== 'https:' || target.username || target.password || target.search || target.hash || target.pathname !== RUNNER_PATH || !ROUND_ID.test(connection.roundId)) throw Error('Explicit HTTPS runner and durable round ID required');
  const id = connection.roundId;
  const started=Date.now();
  const log=(phase:string,fields:Record<string,unknown>={})=>{try{console.info(JSON.stringify({event:'pi_model_round',roundId:id,phase,...connection.telemetry,durationMs:Date.now()-started,...fields}));}catch{}};
  const wrap = (implementation: ProviderStreams['stream']) => ((model, context, options) => {
    let code = 'runner_transport_interrupted', bodyBytes: number | undefined, httpStatus: number | undefined, transportError: ReturnType<typeof technicalError> | undefined, provider: ProviderFailureInfo | undefined;
    const validate = (raw: unknown) => { try { return siwcPayload(raw); } catch (error) { code='unsupported_siwc_request';throw error; } };
    const source = implementation(model, context, { ...options, apiKey: 'runner-transport-only', maxRetries: 0,
      fetch: async (input, init) => {
        if (String(input) !== 'https://model-runner.invalid/v1/responses' || init?.method !== 'POST' || typeof init.body !== 'string') { code='runner_contract_rejected';throw Error('Outside runner contract'); }
        const body = JSON.stringify(validate(JSON.parse(init.body)));
        bodyBytes=new TextEncoder().encode(body).length;
        log('prepared',{bodyBytes});
        if (bodyBytes > MAX_REQUEST_BYTES) { code='runner_input_limit';throw Error('Runner input limit'); }
        init.signal?.throwIfAborted();
        let reservation;try{reservation=await connection.beforeDispatch?.(body);}catch(error){code='worker_round_reservation_failed';transportError=technicalError(error);throw error;}
        if (reservation && reservation !== 'new') { code = reservation === 'conflict' ? 'worker_round_conflict' : 'worker_round_already_reserved'; throw Error('Worker round fenced'); }
        init.signal?.throwIfAborted();
        // Caller auth/cookie/custom-fetch options cannot cross this boundary.
        let response: Response;
        log('dispatch',{bodyBytes});
        try { response = await connection.fetch(new Request(target, { method: 'POST', body, signal: init.signal, redirect: 'manual', headers: { ...await signRound(connection.key, body, id, connection.now?.()), ...(connection.telemetry?.workerVersion?{'x-pi-worker-version':connection.telemetry.workerVersion}:{}), ...(connection.telemetry?.kind?{'x-pi-task-kind':connection.telemetry.kind}:{}), 'user-agent': 'Pi-Durable-Model-Runner/1.0' } })); }
        catch (error) { transportError=technicalError(error);throw error; }
        httpStatus=response.status;log('response',{bodyBytes,httpStatus,requestId:response.headers.get('x-request-id')?redactErrorText(response.headers.get('x-request-id')!,200):undefined});
        if (response.redirected || (response.status >= 300 && response.status < 400)) { code = 'runner_redirect_rejected'; void response.body?.cancel().catch(() => {}); throw Error('Unexpected redirect'); }
        if (!response.ok) {
          code='runner_http_rejected';
          // Read only bounded, allowlisted service codes; never preserve upstream text.
          const reader = response.body?.getReader();
          if (reader) { try { let size = 0, text = ''; while (true) { const p = await reader.read(); if (p.done) break; size += p.value.length; if (size > 2048) break; text += new TextDecoder().decode(p.value); } if (response.status === 403 && /^error code:\s*1010\s*$/.test(text.trim())) code = 'runner_gateway_browser_integrity_blocked'; else if (size <= 2048) { const error = JSON.parse(text)?.error; if ((RUNNER_SERVICE_CODES as readonly unknown[]).includes(error?.code)) { code = error.code; if (['siwc_provider_rejected', 'siwc_reauthorization_required', 'siwc_access_denied', 'siwc_usage_limited'].includes(code)) provider = providerFailureInfo(error.provider?.httpStatus, error.provider); } } } catch {} finally { void reader.cancel().catch(() => {}); } }
          log('rejected_response',{httpStatus,bodyBytes,code,...(provider?{provider}:{})});
          throw Error('Runner rejected round');
        }
        if (response.headers.get('x-pi-round-id') !== id) { void response.body?.cancel().catch(() => {}); code='runner_round_mismatch';throw Error('Round response mismatch'); }
        // Own the underlying reader so Stop cancels the body even when the
        // runtime/SDK has already resolved fetch and only cancels its parser.
        if (!response.body) {code='runner_body_missing';throw Error('Missing runner stream');}
        const reader = response.body.getReader(), signal = options?.signal ?? init.signal;
        const stop = () => { void reader.cancel().catch(() => {}); };
        const finish = () => signal?.removeEventListener('abort', stop);
        signal?.addEventListener('abort', stop, { once: true });
        if (signal?.aborted) stop();
        return new Response(new ReadableStream<Uint8Array>({
          async pull(output) {
            try { signal?.throwIfAborted(); const part = await reader.read(); signal?.throwIfAborted(); if (part.done) { finish(); output.close(); } else output.enqueue(part.value); }
            catch(error) { transportError=technicalError(error);code='runner_stream_interrupted';finish(); stop(); output.error(Error('Runner stream interrupted')); }
          },
          async cancel() { finish(); await reader.cancel().catch(() => {}); },
        }), { status: response.status, headers: response.headers });
      },
      onPayload: async (payload, selected) => validate(await options?.onPayload?.(payload, selected) ?? payload),
    });
    const output = createAssistantMessageEventStream();
    void (async () => {
      for await (const event of source) {
        if (event.type === 'done') log('completed',{bodyBytes,httpStatus,stopReason:event.message.stopReason,usage:event.message.usage});
        if (event.type === 'error') {
          // Fixed classifier-facing text prevents the harness retrying ambiguous work.
          appendAssistantMessageDiagnostic(event.error, { type: 'model_runner_round_failure', timestamp: Date.now(), details: { roundId: id, code, ...(bodyBytes===undefined?{}:{bodyBytes}), ...(httpStatus===undefined?{}:{httpStatus}), ...(provider?{provider}:{}) } });
          try { console.warn(JSON.stringify({event:'pi_error',stage:'model_runner_transport',roundId:id,...connection.telemetry,durationMs:Date.now()-started,error:transportError??technicalError(event.error.errorMessage),code,...(bodyBytes===undefined?{}:{bodyBytes}),...(httpStatus===undefined?{}:{httpStatus}),cancelled:options?.signal?.aborted===true,...(transportError?{transportError}:{})})); } catch {}
          event.error.errorMessage = `Model round failed (${code.replaceAll('_', ' ')}); automatic replay disabled.`;
        }
        output.push(event);
      }
      output.end(await source.result());
    })();
    return output;
  }) as ProviderStreams['stream'];
  return createProvider({ id: 'model-runner-siwc', name: 'SIWC model runner', baseUrl: 'https://model-runner.invalid/v1',
    auth: { apiKey: { name: 'Runner transport', resolve: async () => ({ auth: { apiKey: 'runner-transport-only' } }) } },
    models: siwcRunnerModels(),
    api: { stream: wrap(stream), streamSimple: wrap(streamSimple) },
  });
}
