import { createProvider } from '@earendil-works/pi-ai/models';
import { openaiProvider } from '@earendil-works/pi-ai/providers/openai';
import { stream, streamSimple } from '@earendil-works/pi-ai/api/openai-responses';
import { createAssistantMessageEventStream } from '@earendil-works/pi-ai/utils/event-stream';
import { appendAssistantMessageDiagnostic } from '@earendil-works/pi-ai/utils/diagnostics';
import type { ProviderStreams } from '@earendil-works/pi-ai';
export interface OfflineRunnerConnection {
  /** Explicit fake/loopback transport only. Never defaults to global fetch. */
  fetch: typeof fetch;
  /** Caller supplies one stable ID per MODEL ROUND, distinct from submit ID. */
  roundId: () => string;
}
/** Opt-in test seam. No environment flag, real credential or production default. */
export function createOfflineRunnerProvider(connection: OfflineRunnerConnection) {
  const base = openaiProvider().getModels().find(model => model.id === 'gpt-6.1-sol');
  if (!base) throw Error('Pinned prototype model missing');
  const wrap = (implementation: ProviderStreams['stream']) => ((model, context, options) => {
    const id = connection.roundId();
    const source = implementation(model, context, { ...options, apiKey: 'offline-placeholder', maxRetries: 0,
      fetch: async (input, init) => {
        const target = new URL(typeof input === 'string' ? input : input instanceof URL ? input.href : input.url);
        if (target.href !== 'http://model-runner.invalid/v1/responses' || init?.method !== 'POST') throw Error('Outside offline runner contract');
        // Do not forward credentials/headers supplied by Models or the caller.
        return connection.fetch(new Request(target, { method: 'POST', body: init.body, signal: init.signal,
          headers: { 'content-type': 'application/json', 'x-pi-prototype': 'offline-v1', 'x-pi-round-id': id } }));
      },
      onPayload: async (payload, selected) => { const value = await options?.onPayload?.(payload, selected) ?? payload; return { ...value as object, store: false, stream: true }; },
    });
    const output = createAssistantMessageEventStream();
    void (async () => {
      for await (const event of source) {
        if (event.type === 'error') {
          appendAssistantMessageDiagnostic(event.error, { type: 'model_runner_round_failure', timestamp: Date.now(), details: { roundId: id, sdkErrorMessage: event.error.errorMessage ?? '' } });
          // This fake prototype cannot safely re-dispatch an ambiguous round.
          // Preserve the cause in diagnostics, away from Pi's text retry matcher.
          event.error.errorMessage = 'Offline model round failed; automatic replay disabled.';
        }
        output.push(event);
      }
      output.end(await source.result());
    })();
    return output;
  }) as ProviderStreams['stream'];
  return createProvider({ id: 'model-runner-prototype', name: 'Offline model runner prototype', baseUrl: 'http://model-runner.invalid/v1',
    auth: { apiKey: { name: 'Offline fixture', resolve: async () => ({ auth: { apiKey: 'offline-placeholder' } }) } },
    models: [{ ...base, provider: 'model-runner-prototype', baseUrl: 'http://model-runner.invalid/v1' }],
    api: { stream: wrap(stream), streamSimple: wrap(streamSimple) },
  });
}
