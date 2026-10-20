import {technicalError} from './error-log';
import { createProvider } from '@earendil-works/pi-ai/models';
import { siwcRunnerModels } from './model-runner-models';
import { createAssistantMessageEventStream } from '@earendil-works/pi-ai/utils/event-stream';
import type { AssistantMessage, ProviderStreams } from '@earendil-works/pi-ai';
import { sha256, transportKey } from './model-runner-protocol';
import { createSiwcRunnerProvider } from './model-runner-siwc-client';
export interface RunnerConfig {
 ENABLE_MODEL_RUNNER?: string;
 MODEL_RUNNER_ENDPOINT?: string;
 MODEL_RUNNER_TRANSPORT_KEY?: string;
 WORKER_VERSION?: {id:string};
}
export function runnerConfigured(config: RunnerConfig) {
 if (config.ENABLE_MODEL_RUNNER !== 'true') return false;
 let url: URL; try { url = new URL(config.MODEL_RUNNER_ENDPOINT ?? ''); } catch { throw Error('Invalid runner configuration'); }
 if (url.protocol !== 'https:' || url.pathname !== '/v1/responses' || url.username || url.password || url.search || url.hash || !/^[a-f0-9]{64}$/.test(config.MODEL_RUNNER_TRANSPORT_KEY ?? '')) throw Error('Invalid runner configuration');
 return true;
}
type Store = Pick<DurableObjectStorage, 'transaction'>;
export interface WorkerRound { version: 1; digest: string; task: string; conversation: string }
/** IDs derive from already-committed Pi task identity plus this durable object's
 * namespace. Retry/recovery reuse the ID; each tool successor has its own task.
 * Never delete these reservations or roll them back with source deployments. */
export function workerRoundFence(store: Store, namespace: string) {
 if (!namespace) throw Error('Durable object namespace required');
 return {
  async identity(task: string, conversation: string) {
   if (!/^[a-zA-Z0-9_-]{1,100}$/.test(task) || !/^[a-zA-Z0-9_-]{1,100}$/.test(conversation)) throw Error('Durable generation identity required');
   return sha256(JSON.stringify(['pi-worker-round-v1', namespace, conversation, task]));
  },
  async reserve(id: string, body: string, task: string, conversation: string, signal?: AbortSignal): Promise<'new' | 'duplicate' | 'conflict'> {
   const digest = await sha256(body);
   signal?.throwIfAborted();
   return store.transaction(async tx => {
    signal?.throwIfAborted();
    const key = 'runner-round:v1:' + id, prior = await tx.get<WorkerRound>(key);
    if (prior) return prior.version === 1 && prior.digest === digest && prior.task === task && prior.conversation === conversation ? 'duplicate' : 'conflict';
    await tx.put(key, { version: 1, digest, task, conversation } satisfies WorkerRound);
    return 'new';
   });
  },
 };
}
/** Concrete opt-in Models provider used by Assistant. Internal headers come from
 * the pinned generation boundary, never request headers. They are not forwarded.
 * No hook, global active-operation map or reconstructed prompt chooses identity. */
export function createWorkerRunnerProvider(config: RunnerConfig, store: Store, namespace: string, fetcher: typeof fetch) {
 if (!runnerConfigured(config)) throw Error('Runner disabled');
 const key = transportKey(Uint8Array.from(config.MODEL_RUNNER_TRANSPORT_KEY!.match(/../g)!, x => parseInt(x, 16)));
 const fence = workerRoundFence(store, namespace);
 const wrap = (method: 'stream' | 'streamSimple'): ProviderStreams['stream'] => (model, context, options) => {
  const output = createAssistantMessageEventStream();
  void (async () => {
   try {
    const headers = new Headers(); for (const [name, value] of Object.entries(options?.headers ?? {})) if (typeof value === 'string') headers.set(name, value);
    const task = headers.get('x-pi-generation-task') ?? '', conversation = headers.get('x-pi-conversation') ?? '';
    options?.signal?.throwIfAborted();
    const id = await fence.identity(task, conversation), signingKey = await key;
    options?.signal?.throwIfAborted();
    const provider = createSiwcRunnerProvider({ endpoint: config.MODEL_RUNNER_ENDPOINT!, key: signingKey, roundId: id, fetch: fetcher,
     telemetry:{workerVersion:config.WORKER_VERSION?.id,kind:headers.get('x-pi-task-kind')==='compaction'?'compaction':'generation',conversation},
     beforeDispatch: body => fence.reserve(id, body, task, conversation, options?.signal),
    });
    const selected = provider.getModels().find(m => m.id === model.id);
    if (!selected) throw Error('Unsupported runner model');
    const source = provider[method](selected, context, options);
    for await (const event of source) output.push(event);
    output.end(await source.result());
   } catch (cause) {
    try { console.warn(JSON.stringify({event:'pi_error',stage:'worker_round_prepare',workerVersion:config.WORKER_VERSION?.id,...technicalError(cause)})); } catch {}
    const error: AssistantMessage = { role: 'assistant', content: [], api: model.api, provider: model.provider, model: model.id, stopReason: 'error', errorMessage: 'Durable model round unavailable; automatic replay disabled.', timestamp: Date.now(), usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } } };
    output.push({ type: 'error', reason: 'error', error }); output.end(error);
   }
  })();
  return output;
 };
 return createProvider({ id: 'model-runner-siwc', name: 'SIWC model runner', baseUrl: 'https://model-runner.invalid/v1',
  auth: { apiKey: { name: 'Runner transport', resolve: async () => ({ auth: { apiKey: 'runner-transport-only' } }) } },
  models: siwcRunnerModels(),
  api: { stream: wrap('stream'), streamSimple: wrap('streamSimple') },
 });
}
