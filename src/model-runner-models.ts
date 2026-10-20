import { openaiProvider } from '@earendil-works/pi-ai/providers/openai';
import { RUNNER_MODELS } from './model-runner-protocol';

/** Subscription sharing rejects configuration_update input items. The SDK's
 * direct-OpenAI credential detection does not recognize our transport provider.
 * Disable the capability before serialization so requested effort stays in the
 * top-level reasoning field. Never mutate the upstream API-key model catalog. */
export function siwcRunnerModels() {
  return openaiProvider().getModels().filter(m => RUNNER_MODELS.includes(m.id as any)).map(m => ({
    ...m, api: 'openai-responses' as const, provider: 'model-runner-siwc', baseUrl: 'https://model-runner.invalid/v1',
    compat: { ...m.compat, supportsMidConvoEffort: false },
  }));
}
