import { Type, type Models, type CredentialStore, type Message, type AssistantMessage } from '@earendil-works/pi-ai';
import type { CredentialStorage } from './credentials';
export const OPENAI_CHECK_MODELS = ['gpt-6.1-sol', 'gpt-6-luna'] as const;
export const OPENAI_CHECK_BUDGET = { requestsPerModel: 2, timeoutMsPerModel: 120000, maxResponseBytes: 65536 } as const;
export type OpenAICheckModel = typeof OPENAI_CHECK_MODELS[number];
export type OpenAICheckReport = {
  model: OpenAICheckModel;
  status: 'running' | 'not_connected' | 'unsupported_model' | 'passed' | 'failed';
  providerRequests: number; toolCalls: number;
  http: { round: number; status: number; contentType?: string }[];
  responses: { round: number; stopReason: string; responseId?: string; textObserved: boolean }[];
};
const key = (model: OpenAICheckModel) => 'openai-compat-check:v1:' + model;
export async function openaiCheckReports(storage: CredentialStorage) {
  return Promise.all(OPENAI_CHECK_MODELS.map(async model => (await storage.get<OpenAICheckReport>(key(model))) ?? null));
}
const active = new WeakSet<CredentialStorage>();
/** Fixed owner-approved diagnostics only. No harness, history, retries, login,
 * arbitrary tool execution or API-key fallback. Each model has a durable one-shot
 * journal. A running/failed record is never replayed after interruption.
 * Codex's pinned transport does not send maxTokens, so bounds are requests,
 * wall time and received bytes, not a claimed provider-side token ceiling.
 */
export async function runOpenAIChecks(
  models: Pick<Models, 'getModel' | 'streamSimple'>,
  credentials: Pick<CredentialStore, 'read'>,
  storage: CredentialStorage,
  options: { approved: boolean; signal: AbortSignal },
): Promise<(OpenAICheckReport | null)[]> {
  if (!options.approved) throw Error('Explicit approval required');
  if (active.has(storage)) return openaiCheckReports(storage);
  active.add(storage);
  try {
    for (const modelId of OPENAI_CHECK_MODELS) {
      if (await storage.get(key(modelId))) continue;
      const report: OpenAICheckReport = { model: modelId, status: 'running', providerRequests: 0, toolCalls: 0, http: [], responses: [] };
      const model = models.getModel('openai-codex', modelId);
      if (!model || model.id !== modelId || model.provider !== 'openai-codex' || model.api !== 'openai-codex-responses' || model.baseUrl !== 'https://chatgpt.com/backend-api') {
        report.status = 'unsupported_model'; await storage.put(key(modelId), report); continue;
      }
      if ((await credentials.read('openai-codex'))?.type !== 'oauth') {
        report.status = 'not_connected';
        // No budget consumed; reconnection requires the existing approved flow.
        const saved = await openaiCheckReports(storage);
        saved[OPENAI_CHECK_MODELS.indexOf(modelId)] = report;
        return saved;
      }
      // Reserve BEFORE any provider dispatch. A crash must not repeat a probe.
      await storage.put(key(modelId), report);
      const controller = new AbortController(), abort = () => controller.abort();
      options.signal.addEventListener('abort', abort, { once: true });
      if (options.signal.aborted) abort();
      const timer = setTimeout(abort, OPENAI_CHECK_BUDGET.timeoutMsPerModel);
      const messages: Message[] = [{ role: 'user', content: 'Say compatibility start, call test_status exactly once, then confirm its marker in one short sentence.', timestamp: Date.now() }];
      const tool = { name: 'test_status', description: 'Return a fixed test marker. No environment access.', parameters: Type.Object({}, { additionalProperties: false }) };
      let round = 0;
      const limitedFetch: typeof fetch = async (input, init) => {
        const url = new URL(typeof input === 'string' ? input : input instanceof URL ? input.href : input.url);
        if (url.href !== 'https://chatgpt.com/backend-api/codex/responses' || (init?.method ?? (input instanceof Request ? input.method : 'GET')) !== 'POST' || report.providerRequests >= 2) throw Error('Outside fixed diagnostic budget');
        controller.signal.throwIfAborted();
        report.providerRequests++;
        await storage.put(key(modelId), report);
        const supplied = init?.signal ?? (input instanceof Request ? input.signal : undefined);
        const signal = supplied ? AbortSignal.any([supplied, controller.signal]) : controller.signal;
        const response = await fetch(input, { ...init, redirect: 'manual', signal });
        const contentType = response.headers.get('content-type')?.split(';')[0].trim();
        report.http.push({ round, status: response.status, ...(['text/event-stream', 'application/json'].includes(contentType ?? '') ? { contentType } : {}) });
        if (response.status >= 300 && response.status < 400) { await response.body?.cancel(); throw Error('Redirect rejected'); }
        if (!response.body) return response;
        let bytes = 0;
        const body = response.body.pipeThrough(new TransformStream<Uint8Array, Uint8Array>({ transform(chunk, output) {
          bytes += chunk.byteLength;
          if (bytes > OPENAI_CHECK_BUDGET.maxResponseBytes) { controller.abort(); throw Error('Response byte limit'); }
          output.enqueue(chunk);
        } }));
        return new Response(body, { status: response.status, statusText: response.statusText, headers: response.headers });
      };
      const request = async (): Promise<AssistantMessage> => {
        round++;
        const stream = models.streamSimple(model, { systemPrompt: 'Fixed harmless compatibility check. Use only test_status. Keep all text very short.', tools: [tool], messages }, {
          reasoning: 'low', maxRetries: 0, transport: 'sse', timeoutMs: 60000, signal: controller.signal, fetch: limitedFetch,
          onPayload: payload => { const body = payload as Record<string, unknown>; body.store = false; body.parallel_tool_calls = false; body.tool_choice = round === 1 ? { type: 'function', name: 'test_status' } : 'none'; return body; },
        });
        for await (const _event of stream) { /* Never publish generated content. */ }
        const result = await stream.result();
        report.responses.push({ round, stopReason: ['stop', 'toolUse', 'error', 'aborted', 'length'].includes(result.stopReason) ? result.stopReason : 'other',
          ...(typeof result.responseId === 'string' && /^resp_[a-f0-9]{8,128}$/.test(result.responseId) ? { responseId: result.responseId } : {}),
          textObserved: result.content.some(c => c.type === 'text' && !!c.text.trim()) });
        return result;
      };
      try {
        controller.signal.throwIfAborted();
        const first = await request();
        const calls = first.content.filter(c => c.type === 'toolCall');
        if (first.stopReason !== 'toolUse' || calls.length !== 1 || calls[0].name !== 'test_status' || !calls[0].arguments || typeof calls[0].arguments !== 'object' || Array.isArray(calls[0].arguments) || Object.keys(calls[0].arguments).length) throw Error('Expected fixed tool');
        report.toolCalls = 1;
        messages.push(first, { role: 'toolResult', toolCallId: calls[0].id, toolName: 'test_status', content: [{ type: 'text', text: '{"ok":true,"marker":"openai-compat-v1"}' }], isError: false, timestamp: Date.now() });
        const last = await request();
        if (last.stopReason !== 'stop' || last.content.some(c => c.type === 'toolCall') || !last.content.some(c => c.type === 'text' && c.text.includes('openai-compat-v1'))) throw Error('Expected marker confirmation');
        report.status = 'passed';
      } catch { report.status = 'failed'; }
      finally { clearTimeout(timer); options.signal.removeEventListener('abort', abort); await storage.put(key(modelId), report); }
      if (options.signal.aborted) break;
    }
    return await openaiCheckReports(storage);
  } finally { active.delete(storage); }
}
