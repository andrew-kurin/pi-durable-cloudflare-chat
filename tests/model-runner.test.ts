import { once } from 'node:events';
import { createRunnerServer } from '../services/model-runner/http';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm, writeFile, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { isRetryableAssistantError } from '@earendil-works/pi-ai/utils/retry';
import { Type, type Message } from '@earendil-works/pi-ai';
import { MAX_REQUEST_BYTES, createOfflineRunner, MemoryRoundJournal, serializedCredentials, type OfflineRunnerOptions } from '../services/model-runner/core';
import { fileRoundJournal } from '../services/model-runner/journal';
import { fakeBackend } from '../services/model-runner/fake-backend';
import { createOfflineRunnerProvider } from '../src/model-runner-client';
import { createChatModels } from '../src/provider-sessions';
const payload = { model: 'gpt-6.1-sol', input: [{ role: 'user', content: 'offline fixture' }], store: false, stream: true };
const request = (id = crypto.randomUUID(), body: unknown = payload, signal?: AbortSignal) => new Request('http://model-runner.invalid/v1/responses', { method: 'POST', signal, headers: { 'x-pi-prototype': 'offline-v1', 'x-pi-round-id': id }, body: JSON.stringify(body) });
const deferred = <T>() => { let resolve!: (value: T) => void; const promise = new Promise<T>(r => { resolve = r; }); return { promise, resolve }; };
function fixture(overrides: Partial<OfflineRunnerOptions> = {}) {
 const calls: any[] = [], journal = new MemoryRoundJournal();
 const runner = createOfflineRunner({ journal, credentials: { access: async () => 'FAKE-secret' }, backend: async (body, access, signal) => { calls.push({ body, access, signal }); return fakeBackend(body, access, signal); }, ...overrides });
 return { runner, calls, journal };
}
const collect = async (stream: any) => { const events = []; for await (const event of stream) events.push(event); return { events, result: await stream.result() }; };
test('opt-in provider seam streams two rounds; tools stay caller-owned and old messages stay unchanged', async () => {
 const f = fixture(), ids: string[] = [], wireHeaders: Headers[] = [];
 const provider = createOfflineRunnerProvider({ roundId: () => { const id = crypto.randomUUID(); ids.push(id); return id; }, fetch: async input => { const req = input as Request; wireHeaders.push(req.headers); return f.runner(req); } });
 const store = { read: async () => undefined, list: async () => [], modify: async () => { throw Error('No credentials may be written'); } } as any;
 const models = createChatModels(store, provider), model = models.getModel(provider.id, 'gpt-6.1-sol')!;
 const messages: Message[] = [{ role: 'user', content: 'offline fixture', timestamp: 1 }];
 const tools = [{ name: 'test_status', description: 'fixed local marker', parameters: Type.Object({}) }];
 const first = await collect(models.streamSimple(model, { messages, tools }, { headers: { authorization: 'Bearer SHOULD-NOT-CROSS' }, maxRetries: 9 }));
 assert.equal(first.result.stopReason, 'toolUse'); assert.ok(first.events.some(e => e.type === 'toolcall_end'));
 assert.equal(f.calls.length, 1, 'service must not execute tools or start follow-up itself');
 const call = first.result.content.find((x: any) => x.type === 'toolCall'); assert.equal(call.name, 'test_status');
 messages.push(first.result, { role: 'toolResult', toolCallId: call.id, toolName: call.name, content: [{ type: 'text', text: 'offline-marker' }], isError: false, timestamp: 2 });
 const saved = structuredClone(messages);
 const last = await collect(models.streamSimple(model, { messages, tools }));
 assert.equal(last.result.stopReason, 'stop'); assert.match(last.result.content[0].text, /offline-marker/); assert.equal(f.calls.length, 2);
 assert.deepEqual(messages, saved, 'conversion must not rewrite stored history');
 assert.equal(new Set(ids).size, 2); assert.ok(wireHeaders.every(h => !h.has('authorization')));
 assert.ok(f.calls.every(c => c.access === 'FAKE-secret' && c.body.store === false && c.body.stream === true));
 assert.ok(f.calls[1].body.input.some((item: any) => item.type === 'function_call_output'));
 assert.equal((await f.runner(request(ids[0], f.calls[0].body))).status, 409); assert.equal(f.calls.length, 2);
 const production = createChatModels(store); assert.equal(production.getModel(provider.id, model.id), undefined); assert.ok(production.getModel('openai-codex', 'gpt-6-sol'));
});
for (const mode of ['failed', 'incomplete', 'missing-terminal', 'http-error']) test('terminal handling '+mode+' never retries', async () => {
 let calls = 0;
 const event = mode === 'failed' ? { type: 'response.failed', response: { status: 'failed', error: { code: 'subscription_sharing_usage_limit_exceeded', message: 'fixture limit' } } } : mode === 'incomplete' ? { type: 'response.incomplete', response: { status: 'incomplete', incomplete_details: { reason: 'max_output_tokens' }, output: [] } } : { type: 'response.created', response: { id: 'resp_aaaaaaaa' } };
 const f = fixture({ backend: async () => { calls++; return mode === 'http-error' ? new Response('PRIVATE TOKEN', { status: 403 }) : new Response('data: '+JSON.stringify(event)+'\n\n', { headers: { 'content-type': 'text/event-stream' } }); } });
 const provider = createOfflineRunnerProvider({ roundId: () => crypto.randomUUID(), fetch: async input => f.runner(input as Request) });
 const model = provider.getModels()[0];
 const result = await collect(provider.streamSimple(model, { messages: [{ role: 'user', content: 'fixture', timestamp: 1 }] }, { maxRetries: 3 }));
 assert.equal(calls, 1); assert.notEqual(result.result.stopReason, 'stop');
 assert.equal(isRetryableAssistantError(result.result), false, 'harness must not mint another round after failure');
 const original = JSON.stringify(result.result.diagnostics);
 if (mode === 'failed') assert.match(original, /subscription_sharing_usage_limit_exceeded/);
 if (mode === 'missing-terminal') assert.match(original, /terminal/);
 assert.ok(!JSON.stringify(result).includes('PRIVATE TOKEN'));
});
test('duplicate/conflicting ID never dispatches again, including an ambiguous dropped stream', async () => {
 const f = fixture(), id = crypto.randomUUID();
 const response = await f.runner(request(id)); await response.body!.cancel();
 assert.equal((await f.runner(request(id))).status, 409);
 const conflict = await f.runner(request(id, { ...payload, input: [] })); assert.equal(conflict.status, 409); assert.match(await conflict.text(), /round_conflict/);
 assert.equal(f.calls.length, 1);
});
test('dispatch fence persists across reconstruction; journal stores hashes, not prompts or credentials', async () => {
 const dir = await mkdtemp(join(tmpdir(), 'pi-runner-')); const path = join(dir, 'rounds.jsonl');
 try {
  let journal = await fileRoundJournal(path); const f = fixture({ journal }), id = crypto.randomUUID(); await (await f.runner(request(id))).body!.cancel(); await journal.close();
  const disk = await readFile(path, 'utf8'); assert.ok(!disk.includes('offline fixture')); assert.ok(!disk.includes('FAKE-secret'));
  journal = await fileRoundJournal(path); const restarted = fixture({ journal }); assert.equal((await restarted.runner(request(id))).status, 409); assert.equal(restarted.calls.length, 0); await journal.close();
  await writeFile(path, '{broken'); await assert.rejects(fileRoundJournal(path));
 } finally { await rm(dir, { recursive: true, force: true }); }
});
test('Stop before dispatch, while waiting for credentials, and after headers propagates without replay', async () => {
 const early = new AbortController(); early.abort(); const a = fixture(); assert.equal((await a.runner(request(crypto.randomUUID(), payload, early.signal))).status, 502); assert.equal(a.calls.length, 0);
 const gate = deferred<string>(), entered = deferred<void>(), mid = new AbortController(), b = fixture({ credentials: { access: async () => { entered.resolve(); return gate.promise; } } });
 const id = crypto.randomUUID(), pending = b.runner(request(id, payload, mid.signal)); await entered.promise; mid.abort(); assert.equal((await pending).status, 502); gate.resolve('FAKE'); await Promise.resolve(); assert.equal(b.calls.length, 0); assert.equal((await b.runner(request(id))).status, 409);
 const late = new AbortController(), c = fixture(); const response = await c.runner(request(crypto.randomUUID(), payload, late.signal)); late.abort(); await assert.rejects(response.text()); assert.equal(c.calls[0].signal.aborted, true);
});
test('Stop during backend wait and stream disconnect cancel the upstream signal', async () => {
 const entered = deferred<void>(); let upstream: AbortSignal | undefined;
 const f = fixture({ backend: async (_body, _access, signal) => { upstream = signal; entered.resolve(); return new Promise((_resolve, reject) => signal.addEventListener('abort', () => reject(Error('Stopped')), { once: true })); } });
 const controller = new AbortController(), pending = f.runner(request(crypto.randomUUID(), payload, controller.signal)); await entered.promise; controller.abort(); assert.equal((await pending).status, 502); assert.equal(upstream!.aborted, true);
 const g = fixture(); const response = await g.runner(request()); await response.body!.cancel(); assert.equal(g.calls[0].signal.aborted, true);
});
test('deadline fences an accepted round; no replay after credential failure or timeout', async () => {
 const f = fixture({ timeoutMs: 10, credentials: { access: () => new Promise(() => {}) } }), id = crypto.randomUUID(); assert.equal((await f.runner(request(id))).status, 502); assert.equal((await f.runner(request(id))).status, 409); assert.equal(f.calls.length, 0);
});
test('concurrent rounds share one serialized fake refresh and never receive its token', async () => {
 let stored = { access: 'EXPIRED-FAKE', expires: 0 }, refreshes = 0; const gate = deferred<void>(), refreshing = deferred<void>();
 const credentials = serializedCredentials({ read: async () => stored, write: async value => { stored = value; } }, async () => { refreshes++; refreshing.resolve(); await gate.promise; return { access: 'NEW-FAKE', expires: Date.now()+60000 }; });
 const f = fixture({ credentials }); const requests = [f.runner(request()), f.runner(request())]; await refreshing.promise; try { assert.equal(refreshes, 1); } finally { gate.resolve(); }
 const responses = await Promise.all(requests); for (const r of responses) { assert.ok(!(await r.text()).includes('NEW-FAKE')); }
 assert.equal(refreshes, 1); assert.ok(f.calls.every(x => x.access === 'NEW-FAKE'));
});
test('failed refresh leaves rounds fenced; a later distinct round may explicitly retry refresh', async () => {
 let refreshes = 0; const credentials = serializedCredentials({ read: async () => ({ access: 'EXPIRED', expires: 0 }), write: async () => { throw Error('Should not persist failure'); } }, async () => { refreshes++; throw Error('FAKE refresh failed'); });
 const f = fixture({ credentials }), id = crypto.randomUUID(); assert.equal((await f.runner(request(id))).status, 502); assert.equal((await f.runner(request(id))).status, 409); assert.equal(refreshes, 1); assert.equal(f.calls.length, 0);
 assert.equal((await f.runner(request())).status, 502); assert.equal(refreshes, 2);
});
test('invalid envelopes, wrong endpoints and oversized requests do not consume provider work', async () => {
 const f = fixture(); for (const body of [null, [], { ...payload, model: 'arbitrary' }, { ...payload, stream: false }, { ...payload, store: true }, { ...payload, input: ['x'.repeat(MAX_REQUEST_BYTES)] }]) assert.equal((await f.runner(request(crypto.randomUUID(), body))).status, 400);
 assert.equal((await f.runner(new Request('http://model-runner.invalid/elsewhere'))).status, 404);
 const denied = request(); denied.headers.delete('x-pi-prototype'); assert.equal((await f.runner(denied)).status, 403); assert.equal(f.calls.length, 0);
});

test('an aborted headers wait cancels a late backend response body', async () => {
 const gate = deferred<Response>(), entered = deferred<void>(); let cancelled = 0;
 const f = fixture({ backend: async () => { entered.resolve(); return gate.promise; } });
 const controller = new AbortController(), pending = f.runner(request(crypto.randomUUID(), payload, controller.signal));
 await entered.promise; controller.abort(); assert.equal((await pending).status, 502);
 gate.resolve(new Response(new ReadableStream({ cancel() { cancelled++; } }), { headers: { 'content-type': 'text/event-stream' } }));
 await new Promise(resolve => setImmediate(resolve)); assert.equal(cancelled, 1);
});
test('historical Codex tool call IDs are re-encoded without rewriting saved messages', async () => {
 const f = fixture(), provider = createOfflineRunnerProvider({ roundId: () => crypto.randomUUID(), fetch: async input => f.runner(input as Request) }), model = provider.getModels()[0];
 const first = (await collect(provider.streamSimple(model, { messages: [{ role: 'user', content: 'fixture', timestamp: 1 }] }))).result;
 const legacy = { ...structuredClone(first), api: 'openai-codex-responses', provider: 'openai-codex', model: 'gpt-6-sol' };
 const call = legacy.content.find((x: any) => x.type === 'toolCall');
 const messages: Message[] = [{ role: 'user', content: 'legacy request', timestamp: 1 }, legacy, { role: 'toolResult', toolName: call.name, toolCallId: call.id, content: [{ type: 'text', text: 'offline-marker' }], isError: false, timestamp: 2 }, { role: 'user', content: 'continue', timestamp: 3 }];
 const saved = structuredClone(messages); const result = await collect(provider.streamSimple(model, { messages }));
 assert.equal(result.result.stopReason, 'stop'); assert.deepEqual(messages, saved);
 const wire = f.calls.at(-1).body.input, invocation = wire.find((x: any) => x.type === 'function_call'), output = wire.find((x: any) => x.type === 'function_call_output');
 assert.ok(invocation); assert.equal(invocation.call_id, output.call_id);
});

test('ambiguous network disconnect retains round identity and is not harness-retryable', async () => {
 const f = fixture(), id = '00000503-0429-4000-8000-000000000000'; let dispatches = 0;
 const provider = createOfflineRunnerProvider({ roundId: () => id, fetch: async input => { dispatches++; const response = await f.runner(input as Request); await response.body!.cancel(); throw Error('Connection error; 503'); } });
 const model = provider.getModels()[0];
 const result = await collect(provider.streamSimple(model, { messages: [{ role: 'user', content: 'fixture', timestamp: 1 }] }, { maxRetries: 9 }));
 assert.equal(dispatches, 1); assert.equal(f.calls.length, 1); assert.equal(isRetryableAssistantError(result.result), false); assert.ok(JSON.stringify(result.result.diagnostics).includes(id));
 assert.equal((await f.runner(request(id, f.calls[0].body))).status, 409);
});

test('real loopback HTTP streams before EOF and client Stop reaches backend cancellation', { timeout: 5000 }, async () => {
 const stopped = deferred<void>(); let backendSignal: AbortSignal | undefined;
 const f = fixture({ backend: async (_body, _access, signal) => { backendSignal = signal; signal.addEventListener('abort', () => stopped.resolve(), { once: true }); return new Response(new ReadableStream({ start(output) { output.enqueue(new TextEncoder().encode('data: {"type":"response.created"}\n\n')); } }), { headers: { 'content-type': 'text/event-stream' } }); } });
 const server = createRunnerServer(f.runner); server.listen(0, '127.0.0.1'); await once(server, 'listening');
 const port = (server.address() as import('node:net').AddressInfo).port, controller = new AbortController();
 try {
  const req = request(crypto.randomUUID(), payload, controller.signal);
  const response = await fetch(`http://127.0.0.1:${port}/v1/responses`, { method: 'POST', headers: req.headers, body: await req.text(), signal: controller.signal });
  const reader = response.body!.getReader(); const first = await reader.read(); assert.match(new TextDecoder().decode(first.value), /response.created/); assert.equal(first.done, false); assert.equal(backendSignal!.aborted, false);
  controller.abort(); await stopped.promise; assert.equal(backendSignal!.aborted, true); await reader.cancel().catch(() => {});
 } finally { controller.abort(); server.closeAllConnections(); await new Promise<void>(resolve => server.close(() => resolve())); }
});
