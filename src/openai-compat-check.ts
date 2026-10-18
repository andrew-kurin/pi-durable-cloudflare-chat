import { redactDiagnosticCredentials } from "./diagnostic-credentials";
import { Type, type Models, type CredentialStore, type Message, type AssistantMessage } from '@earendil-works/pi-ai';
import type { CredentialStorage } from './credentials';
export const OPENAI_CHECK_MODELS = ['gpt-6.1-sol', 'gpt-6-luna'] as const;
export const OPENAI_CHECK_BUDGET = { requestsPerModel: 2, timeoutMsPerModel: 120000, maxResponseBytes: 65536 } as const;
export type OpenAICheckModel = typeof OPENAI_CHECK_MODELS[number];
export type OpenAICheckReport = {
  model: OpenAICheckModel;
  attempt?: 'failure-v2';
  error?: string;
  status: 'running' | 'not_connected' | 'unsupported_model' | 'passed' | 'failed';
  providerRequests: number; toolCalls: number;
  http: { round: number; status: number; contentType?: string; cfRay?: string; requestId?: string; cfMitigated?: string; bodyExcerpt?: string; bodyTruncated?: boolean; bodyReadError?: string; errorCode?: string; errorType?: string; errorMessage?: string }[];
  responses: { round: number; stopReason: string; responseId?: string; textObserved: boolean; sdkErrorMessage?: string }[];
};
const key = (model: OpenAICheckModel, failureCapture = false) => (failureCapture ? 'openai-compat-check:failure-v2:' : 'openai-compat-check:v1:') + model;
export async function openaiFailureReport(storage: CredentialStorage) {
  return (await storage.get<OpenAICheckReport>(key('gpt-6.1-sol', true))) ?? null;
}
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
  options: { approved: boolean; signal: AbortSignal; failureCapture?: boolean },
): Promise<(OpenAICheckReport | null)[]> {
  if (!options.approved) throw Error('Explicit approval required');
  const selected = options.failureCapture ? ['gpt-6.1-sol'] as const : OPENAI_CHECK_MODELS;
  const reports = () => options.failureCapture ? Promise.all([openaiFailureReport(storage)]) : openaiCheckReports(storage);
  const journal = (model: OpenAICheckModel) => key(model, options.failureCapture);
  if (active.has(storage)) return reports();
  active.add(storage);
  try {
    for (const modelId of selected) {
      if (await storage.get(journal(modelId))) continue;
      const report: OpenAICheckReport = { model: modelId, ...(options.failureCapture ? { attempt: 'failure-v2' as const } : {}), status: 'running', providerRequests: 0, toolCalls: 0, http: [], responses: [] };
      const model = models.getModel('openai-codex', modelId);
      if (!model || model.id !== modelId || model.provider !== 'openai-codex' || model.api !== 'openai-codex-responses' || model.baseUrl !== 'https://chatgpt.com/backend-api') {
        report.status = 'unsupported_model'; await storage.put(journal(modelId), report); continue;
      }
      const credential = await credentials.read('openai-codex');
      const secrets = credential?.type === 'oauth' ? [credential.access, credential.refresh] : [];
      const clean = (value: string, limit = 4096) => redactDiagnosticCredentials(value, secrets).slice(0, limit);
      if (credential?.type !== 'oauth') {
        report.status = 'not_connected';
        // No budget consumed; reconnection requires the existing approved flow.
        const saved = await reports();
        saved[selected.indexOf(modelId as never)] = report;
        return saved;
      }
      // Reserve BEFORE any provider dispatch. A crash must not repeat a probe.
      await storage.put(journal(modelId), report);
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
        await storage.put(journal(modelId), report);
        const supplied = init?.signal ?? (input instanceof Request ? input.signal : undefined);
        const signal = supplied ? AbortSignal.any([supplied, controller.signal]) : controller.signal;
        const response = await fetch(input, { ...init, redirect: 'manual', signal });
        const evidence: OpenAICheckReport['http'][number] = { round, status: response.status };
        const contentType = response.headers.get('content-type');
        if (options.failureCapture) {
          for (const [header, field] of [['content-type', 'contentType'], ['cf-ray', 'cfRay'], ['x-request-id', 'requestId'], ['cf-mitigated', 'cfMitigated']] as const) {
            const value = response.headers.get(header);
            if (value !== null) evidence[field] = clean(value, 1024);
          }
        } else if (['text/event-stream', 'application/json'].includes(contentType?.split(';')[0].trim() ?? '')) evidence.contentType = contentType!.split(';')[0].trim();
        report.http.push(evidence);
        if (options.failureCapture && !response.ok) {
          // Read the error body once, bounded; retain its original bytes for the SDK,
          // and redact the captured text before taking the smaller display excerpt.
          const reader = response.body?.getReader(), chunks: Uint8Array[] = [];
          let size = 0, truncated = false;
          try {
            if (reader) while (true) {
              const part = await reader.read(); if (part.done) break;
              const remaining = OPENAI_CHECK_BUDGET.maxResponseBytes - size;
              chunks.push(part.value.slice(0, remaining)); size += Math.min(part.value.byteLength, remaining);
              if (part.value.byteLength > remaining) { truncated = true; controller.abort(); await reader.cancel(); break; }
            }
          } catch (error) { evidence.bodyReadError = clean(error instanceof Error ? error.message : String(error)); }
          finally { reader?.releaseLock(); }
          const bytes = new Uint8Array(size); let offset = 0;
          for (const chunk of chunks) { bytes.set(chunk, offset); offset += chunk.byteLength; }
          const raw = new TextDecoder().decode(bytes), redacted = redactDiagnosticCredentials(raw, secrets);
          evidence.bodyExcerpt = redacted.slice(0, 4096); evidence.bodyTruncated = truncated || redacted.length > 4096 || !!evidence.bodyReadError;
          try {
            const parsed = JSON.parse(raw), upstream = parsed?.error ?? parsed;
            for (const [field, target] of [['code', 'errorCode'], ['type', 'errorType'], ['message', 'errorMessage']] as const) {
              if (typeof upstream?.[field] === 'string') evidence[target] = clean(upstream[field]);
            }
          } catch { /* Keep exact bounded text; no guessed HTML/auth classification. */ }
          await storage.put(journal(modelId), report);
          if (response.status >= 300 && response.status < 400) throw Error('Redirect rejected');
          if (truncated) throw Error('Response byte limit');
          return new Response(bytes, { status: response.status, statusText: response.statusText, headers: response.headers });
        }
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
          ...(options.failureCapture && typeof result.errorMessage === 'string' ? { sdkErrorMessage: clean(result.errorMessage) } : {}),
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
      } catch (error) { report.status = 'failed'; if (options.failureCapture) report.error = clean(error instanceof Error ? error.message : String(error)); }
      finally { clearTimeout(timer); options.signal.removeEventListener('abort', abort); await storage.put(journal(modelId), report); }
      if (options.signal.aborted) break;
    }
    return await reports();
  } finally { active.delete(storage); }
}
