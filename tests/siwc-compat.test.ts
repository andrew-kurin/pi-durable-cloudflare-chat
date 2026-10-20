import { test } from 'node:test';
import assert from 'node:assert/strict';
import { openaiProvider } from '@earendil-works/pi-ai/providers/openai';
import { streamSimple } from '@earendil-works/pi-ai/api/openai-responses';
import { isRetryableAssistantError } from '@earendil-works/pi-ai/utils/retry';
import { createSiwcRunnerProvider } from '../src/model-runner-siwc-client';
import { createWorkerRunnerProvider } from '../src/model-runner-worker';
import { siwcPayload, transportKey, signRound } from '../src/model-runner-protocol';
import { createSiwcRunner } from '../services/model-runner/live-runner';
import { MemoryRoundJournal } from '../services/model-runner/core';
import { fakeBackend } from '../services/model-runner/fake-backend';
import { ChatProjection } from '../src/projector';

const key = await transportKey(new Uint8Array(32).fill(7));
const collect = async (stream: any) => { for await (const _ of stream) {} return stream.result(); };
const usage = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } };
function history(model: string): any {
  return { messages: [
    { role: 'system', content: 'Offline instruction', timestamp: 0, toolsAdded: [{ name: 'test_status', description: 'Offline fixture', parameters: { type: 'object', properties: {} } }] },
    { role: 'user', content: 'Offline input', timestamp: 1 },
    { role: 'assistant', api: 'openai-responses', provider: 'model-runner-siwc', model, providerThinkingLevel: 'high', usage, timestamp: 2, stopReason: 'toolUse', content: [
      { type: 'thinking', thinking: 'Synthetic summary', thinkingSignature: JSON.stringify({ type: 'reasoning', id: 'rs_fixture', summary: [], encrypted_content: 'SYNTHETIC-OPAQUE' }) },
      { type: 'toolCall', id: 'call_fixture|fc_fixture', name: 'test_status', arguments: {} },
    ] },
    { role: 'toolResult', toolCallId: 'call_fixture|fc_fixture', toolName: 'test_status', content: [{ type: 'text', text: 'Exact saved fixture output' }], isError: false, timestamp: 3 },
    { role: 'user', content: 'Offline continuation', timestamp: 4 },
  ] };
}
for (const id of ['gpt-6.1-sol', 'gpt-6-luna']) for (const effort of ['low', 'high', 'xhigh', 'max'] as const) for (const method of ['stream', 'streamSimple'] as const) {
  test(`actual SIWC ${method} preserves ${id}/${effort}, opaque history and tools without configuration_update`, async () => {
    let calls = 0, reserved: string | undefined;
    const p = createSiwcRunnerProvider({ endpoint: 'https://runner.example/v1/responses', key, roundId: 'offline-compat-fixture',
      beforeDispatch: async body => { assert.equal(reserved, undefined); reserved = body; return 'new'; },
      fetch: async input => {
        calls++; const request = input as Request, raw = await request.text(), body = JSON.parse(raw);
        assert.equal(raw, reserved); assert.equal(request.headers.has('authorization'), false);
        assert.equal(body.reasoning.effort, effort);
        assert.ok(!body.input.some((x: any) => x.type === 'configuration_update'));
        assert.ok(body.input.some((x: any) => x.type === 'reasoning' && x.id === 'rs_fixture' && x.encrypted_content === 'SYNTHETIC-OPAQUE'));
        assert.ok(body.input.some((x: any) => x.type === 'additional_tools'));
        const call = body.input.find((x: any) => x.type === 'function_call'), result = body.input.find((x: any) => x.type === 'function_call_output');
        assert.equal(call.call_id, result.call_id); assert.equal(result.output, 'Exact saved fixture output');
        const response = await fakeBackend(body, '', request.signal); response.headers.set('x-pi-round-id', 'offline-compat-fixture'); return response;
      },
    });
    const model = p.getModels().find(m => m.id === id)!, context = history(id), saved = structuredClone(context);
    const result = await collect(p[method](model, context, method === 'stream' ? { reasoningEffort: effort } : { reasoning: effort }));
    assert.equal(result.stopReason, 'stop', result.errorMessage); assert.equal(calls, 1); assert.deepEqual(context, saved);
  });
}

test('both runner catalogs disable mid-conversation effort without mutating API-key provider capabilities', async () => {
  const before = structuredClone(openaiProvider().getModels());
  const inner = createSiwcRunnerProvider({ endpoint: 'https://runner.example/v1/responses', key, roundId: 'offline-catalog', fetch: async () => { throw Error('No transport'); } });
  const outer = createWorkerRunnerProvider({ ENABLE_MODEL_RUNNER: 'true', MODEL_RUNNER_ENDPOINT: 'https://runner.example/v1/responses', MODEL_RUNNER_TRANSPORT_KEY: '07'.repeat(32) }, {} as any, 'offline', async () => { throw Error('No transport'); });
  assert.deepEqual(outer.getModels(), inner.getModels());
  assert.ok(inner.getModels().every(m => m.compat?.supportsMidConvoEffort === false));
  assert.deepEqual(openaiProvider().getModels(), before);
  const apiModel = openaiProvider().getModels().find(m => m.id === 'gpt-6.1-sol')!;
  assert.equal(apiModel.compat?.supportsMidConvoEffort, true);
  let captured: any;
  await collect(streamSimple(apiModel, { messages: [{ role: 'user', content: 'Offline input', timestamp: 1 }] }, {
    apiKey: 'sk-SYNTHETIC', reasoning: 'low', maxRetries: 0,
    fetch: async () => { throw Error('No provider calls'); },
    onPayload: raw => { captured = raw; throw Error('Offline capture before HTTP'); },
  }));
  assert.ok(captured.input.some((x: any) => x.type === 'configuration_update'));
});

test('injected unsupported updates fail before Worker reservation or transport', async () => {
  let reservations = 0, dispatches = 0;
  const p = createSiwcRunnerProvider({ endpoint: 'https://runner.example/v1/responses', key, roundId: 'offline-invalid-input', beforeDispatch: async () => { reservations++; return 'new'; }, fetch: async () => { dispatches++; throw Error('No dispatch'); } });
  const result = await collect(p.streamSimple(p.getModels()[0], { messages: [{ role: 'user', content: 'fixture', timestamp: 1 }] }, { reasoning: 'low', onPayload: raw => ({ ...(raw as any), input: [...(raw as any).input, { type: 'configuration_update', reasoning: { effort: 'low' } }] }) }));
  assert.match(result.errorMessage, /unsupported siwc request/); assert.equal(isRetryableAssistantError(result), false);
  assert.equal(reservations, 0); assert.equal(dispatches, 0);
});

test('provider input rejection travels through runner, Worker and live/reconnected projection with the permanent fence intact', async () => {
  const journal = new MemoryRoundJournal(); let calls = 0;
  const runner = createSiwcRunner({ key, journal, credentials: { access: async () => 'SYNTHETIC-ACCESS' }, fetch: async () => {
    calls++; return Response.json({ error: { code: 'subscription_sharing_unsupported_capability', type: 'invalid_request_error', param: 'input', message: 'PRIVATE-RESPONSE SYNTHETIC-ACCESS', payload: 'PRIVATE-PAYLOAD' } }, { status: 400 });
  } });
  let wire: Request | undefined, envelope: any;
  const p = createSiwcRunnerProvider({ endpoint: 'https://runner.example/v1/responses', key, roundId: 'offline-rejected-round', fetch: async input => { wire = (input as Request).clone(); const response = await runner(input as Request); assert.equal(response.status, 400); envelope = await response.clone().json(); return response; } });
  const result = await collect(p.streamSimple(p.getModels()[0], { messages: [{ role: 'user', content: 'PRIVATE-PROMPT', timestamp: 1 }] }, { reasoning: 'low', maxRetries: 9 }));
  assert.equal(calls, 1); assert.equal(journal.rounds.size, 1); assert.equal(isRetryableAssistantError(result), false);
  assert.deepEqual(envelope.error.provider, { httpStatus: 400, code: 'subscription_sharing_unsupported_capability', param: 'input' });
  const entry = { id: 1, kind: 'pi.assistant', model: [result] } as any, projection = new ChatProjection();
  projection.apply({ type: 'entry_appended', entry }); const live = projection.view().messages[0];
  assert.deepEqual(live.failure?.diagnostic, { category: 'subscription input capability rejected', httpStatus: '400', code: 'siwc_provider_rejected', providerHttpStatus: '400', providerCode: 'subscription_sharing_unsupported_capability', providerParam: 'input' });
  projection.apply({ type: 'snapshot', entries: [entry], tools: [], inbox: [], agent: {}, usage: {}, compactions: [] } as any);
  assert.deepEqual(projection.view().messages[0], live);
  for (const value of [envelope, result, live]) assert.doesNotMatch(JSON.stringify(value), /PRIVATE-|SYNTHETIC-ACCESS/);
  assert.equal((await runner(wire!)).status, 409); assert.equal(calls, 1); assert.equal(journal.rounds.size, 1);
});

for (const mode of ['unknown', 'html', 'oversized'] as const) test(`untrusted ${mode} provider errors preserve only an allowlisted status`, async () => {
  const journal = new MemoryRoundJournal(); let calls = 0;
  const runner = createSiwcRunner({ key, journal, credentials: { access: async () => 'SYNTHETIC' }, fetch: async () => {
    calls++; return mode === 'html' ? new Response('<html>PRIVATE</html>', { status: 400 }) : Response.json({ error: { code: mode === 'oversized' ? 'subscription_sharing_unsupported_capability' : 'PRIVATE-CODE', param: 'PRIVATE-PARAM', message: 'PRIVATE' + (mode === 'oversized' ? 'x'.repeat(9000) : '') } }, { status: 400 });
  } });
  const body = JSON.stringify(siwcPayload({ model: 'gpt-6.1-sol', input: [{ role: 'user', content: 'fixture' }] }));
  const response = await runner(new Request('https://runner.example/v1/responses', { method: 'POST', body, headers: await signRound(key, body, 'offline-error-' + mode) }));
  assert.equal(response.status, 400); const value = await response.json() as any;
  assert.deepEqual(value.error.provider, { httpStatus: 400 }); assert.doesNotMatch(JSON.stringify(value), /PRIVATE/); assert.equal(calls, 1); assert.equal(journal.rounds.size, 1);
});

for (const mode of ['legacy-json', 'gateway', 'oversized-envelope', 'unknown-code'] as const) test(`Worker safely classifies ${mode} runner failure without inventing provider evidence`, async () => {
  let calls = 0;
  const value = { error: { code: mode === 'unknown-code' ? 'PRIVATE-CODE' : 'siwc_provider_rejected', message: 'PRIVATE-MESSAGE', provider: { httpStatus: 400, code: 'subscription_sharing_unsupported_capability', param: 'input' } } };
  if (mode === 'legacy-json') delete (value.error as any).provider;
  const p = createSiwcRunnerProvider({ endpoint: 'https://runner.example/v1/responses', key, roundId: 'offline-' + mode, fetch: async () => { calls++; return new Response(mode === 'gateway' ? 'error code: 502' : JSON.stringify(value) + (mode === 'oversized-envelope' ? ' '.repeat(3000) : ''), { status: 502 }); } });
  const result = await collect(p.streamSimple(p.getModels()[0], { messages: [{ role: 'user', content: 'fixture', timestamp: 1 }] }, { reasoning: 'low', maxRetries: 9 }));
  const projection = new ChatProjection(); projection.entry({ id: 1, kind: 'pi.assistant', model: [result] } as any);
  const diagnostic = projection.view().messages[0].failure?.diagnostic;
  assert.equal(diagnostic?.category, mode === 'legacy-json' ? 'provider request rejected' : 'runner HTTP rejection');
  assert.equal(diagnostic?.httpStatus, '502'); assert.equal(diagnostic?.providerCode, undefined); assert.equal(diagnostic?.providerHttpStatus, undefined);
  assert.doesNotMatch(JSON.stringify(projection.view()), /PRIVATE/); assert.equal(calls, 1); assert.equal(isRetryableAssistantError(result), false);
});
