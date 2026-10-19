import { createProvider } from '@earendil-works/pi-ai/models';
import { openaiProvider } from '@earendil-works/pi-ai/providers/openai';
import { stream, streamSimple } from '@earendil-works/pi-ai/api/openai-responses';
import { createAssistantMessageEventStream } from '@earendil-works/pi-ai/utils/event-stream';
import { appendAssistantMessageDiagnostic } from '@earendil-works/pi-ai/utils/diagnostics';
import type { ProviderStreams } from '@earendil-works/pi-ai';
import { ROUND_ID, RUNNER_MODELS, RUNNER_PATH, signRound, siwcPayload } from './model-runner-protocol';
/** Explicit per-round provider. Caller MUST durably reserve roundId before use,
 * restore the same ID after interruption, and create a distinct ID for tool continuation.
 * No environment defaults and no OpenAI credentials ever enter this Worker. */
export function createSiwcRunnerProvider(connection: { endpoint: string; key: CryptoKey; roundId: string; fetch: typeof fetch; now?: () => number; beforeDispatch?: (body: string) => Promise<'new' | 'duplicate' | 'conflict'> }) {
  const target = new URL(connection.endpoint);
  if (target.protocol !== 'https:' || target.username || target.password || target.search || target.hash || target.pathname !== RUNNER_PATH || !ROUND_ID.test(connection.roundId)) throw Error('Explicit HTTPS runner and durable round ID required');
  const id = connection.roundId;
  const wrap = (implementation: ProviderStreams['stream']) => ((model, context, options) => {
    let code = 'runner_transport_interrupted';
    const source = implementation(model, context, { ...options, apiKey: 'runner-transport-only', maxRetries: 0,
      fetch: async (input, init) => {
        if (String(input) !== 'https://model-runner.invalid/v1/responses' || init?.method !== 'POST' || typeof init.body !== 'string') throw Error('Outside runner contract');
        const body = JSON.stringify(siwcPayload(JSON.parse(init.body)));
        if (new TextEncoder().encode(body).length > 131072) throw Error('Runner input limit');
        init.signal?.throwIfAborted();
        const reservation = await connection.beforeDispatch?.(body);
        if (reservation && reservation !== 'new') { code = reservation === 'conflict' ? 'worker_round_conflict' : 'worker_round_already_reserved'; throw Error('Worker round fenced'); }
        init.signal?.throwIfAborted();
        // Caller auth/cookie/custom-fetch options cannot cross this boundary.
        const response = await connection.fetch(new Request(target, { method: 'POST', body, signal: init.signal, redirect: 'manual', headers: await signRound(connection.key, body, id, connection.now?.()) }));
        if (response.redirected || (response.status >= 300 && response.status < 400)) { code = 'runner_redirect_rejected'; void response.body?.cancel().catch(() => {}); throw Error('Unexpected redirect'); }
        if (!response.ok) {
          // Read only bounded, allowlisted service codes; never preserve upstream text.
          const known = ['transport_auth_failed', 'round_conflict', 'round_already_reserved', 'unsupported_siwc_request', 'siwc_reauthorization_required', 'siwc_access_denied', 'siwc_usage_limited', 'siwc_provider_rejected', 'siwc_refresh_resolution_required', 'siwc_refresh_deferred', 'siwc_credential_invalid', 'siwc_round_interrupted', 'round_cancelled'];
          const reader = response.body?.getReader();
          if (reader) { try { let size = 0, text = ''; while (true) { const p = await reader.read(); if (p.done) break; size += p.value.length; if (size > 2048) break; text += new TextDecoder().decode(p.value); } const c = JSON.parse(text)?.error?.code; if (known.includes(c)) code = c; } catch {} finally { void reader.cancel().catch(() => {}); } }
          throw Error('Runner rejected round');
        }
        if (response.headers.get('x-pi-round-id') !== id) { void response.body?.cancel().catch(() => {}); throw Error('Round response mismatch'); }
        // Own the underlying reader so Stop cancels the body even when the
        // runtime/SDK has already resolved fetch and only cancels its parser.
        if (!response.body) throw Error('Missing runner stream');
        const reader = response.body.getReader(), signal = options?.signal ?? init.signal;
        const stop = () => { void reader.cancel().catch(() => {}); };
        const finish = () => signal?.removeEventListener('abort', stop);
        signal?.addEventListener('abort', stop, { once: true });
        if (signal?.aborted) stop();
        return new Response(new ReadableStream<Uint8Array>({
          async pull(output) {
            try { signal?.throwIfAborted(); const part = await reader.read(); signal?.throwIfAborted(); if (part.done) { finish(); output.close(); } else output.enqueue(part.value); }
            catch { finish(); stop(); output.error(Error('Runner stream interrupted')); }
          },
          async cancel() { finish(); await reader.cancel().catch(() => {}); },
        }), { status: response.status, headers: response.headers });
      },
      onPayload: async (payload, selected) => siwcPayload(await options?.onPayload?.(payload, selected) ?? payload),
    });
    const output = createAssistantMessageEventStream();
    void (async () => {
      for await (const event of source) {
        if (event.type === 'error') {
          // Fixed classifier-facing text prevents the harness retrying ambiguous work.
          appendAssistantMessageDiagnostic(event.error, { type: 'model_runner_round_failure', timestamp: Date.now(), details: { roundId: id, code } });
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
    models: openaiProvider().getModels().filter(m => RUNNER_MODELS.includes(m.id as any)).map(m => ({ ...m, api: 'openai-responses', provider: 'model-runner-siwc', baseUrl: 'https://model-runner.invalid/v1' })),
    api: { stream: wrap(stream), streamSimple: wrap(streamSimple) },
  });
}
