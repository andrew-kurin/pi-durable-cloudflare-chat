import { test } from 'node:test';
import assert from 'node:assert/strict';
import { once } from 'node:events';
import { Type, type Message } from '@earendil-works/pi-ai';
import { isRetryableAssistantError } from '@earendil-works/pi-ai/utils/retry';
import { createSiwcRunner, type LiveRunnerOptions } from '../services/model-runner/live-runner';
import { fakeBackend } from '../services/model-runner/fake-backend';
import { MemoryRoundJournal } from '../services/model-runner/core';
import { createRunnerServer } from '../services/model-runner/http';
import { transportKey, signRound, siwcPayload } from '../src/model-runner-protocol';
import { createSiwcRunnerProvider } from '../src/model-runner-siwc-client';
import { createChatModels } from '../src/provider-sessions';
const key = await transportKey(new Uint8Array(32).fill(7)); // synthetic fixture only
const payload = { model: 'gpt-6.1-sol', input: [{ role: 'user', content: 'fixture' }], store: false, stream: true };
const collect = async (stream: any) => { const events = []; for await (const event of stream) events.push(event); return { events, result: await stream.result() }; };
const deferred = <T>() => { let resolve!: (value: T) => void; const promise = new Promise<T>(r => { resolve = r; }); return { promise, resolve }; };
async function request(id = 'round-fixture-1', body = JSON.stringify(payload), signal?: AbortSignal) {
 return new Request('https://runner.example/v1/responses', { method: 'POST', body, signal, headers: await signRound(key, body, id) });
}
function fixture(extra: Partial<LiveRunnerOptions> = {}) {
 const calls: { body: any; signal: AbortSignal; headers: Headers }[] = [], journal = new MemoryRoundJournal(); let accesses = 0;
 const runner = createSiwcRunner({ key, journal, credentials: { access: async () => { accesses++; return 'SYNTHETIC-ACCESS'; } }, fetch: async (url, init) => {
  assert.equal(url, 'https://api.openai.com/v1/responses'); assert.equal(init!.redirect, 'error');
  const body = JSON.parse(init!.body as string), signal = init!.signal!; calls.push({ body, signal, headers: new Headers(init!.headers) });
  return fakeBackend(body, '', signal);
 }, ...extra });
 return { runner, calls, journal, accesses: () => accesses };
}
function provider(f: ReturnType<typeof fixture>, id = 'round-fixture-1') {
 return createSiwcRunnerProvider({ endpoint: 'https://runner.example/v1/responses', key, roundId: id, fetch: async input => f.runner(input as Request) });
}
test('HMAC binds exact body, method, path, timestamp and durable ID before credential access', async () => {
 const f = fixture();
 for (const change of [ (r: Request) => r.headers.set('x-pi-round-id', 'round-different'), (r: Request) => r.headers.set('x-pi-timestamp', String(Date.now()-31000)), (r: Request) => r.headers.delete('x-pi-signature') ]) { const r = await request(); change(r); assert.equal((await f.runner(r)).status, 403); }
 const signed = await request(); assert.equal((await f.runner(new Request(signed.url, { method: 'POST', headers: signed.headers, body: JSON.stringify({ ...payload, input: [] }) }))).status, 403);
 for (const url of ['https://runner.example/elsewhere', 'https://runner.example/v1/responses?x=1']) { assert.equal((await f.runner(new Request(url, { method: 'POST', headers: (await request()).headers, body: JSON.stringify(payload) }))).status, 404); }
 assert.equal(f.accesses(), 0); assert.equal(f.journal.rounds.size, 0); assert.equal(f.calls.length, 0);
 const response = await f.runner(await request()); await response.text(); assert.equal((await f.runner(await request())).status, 409);
 assert.equal((await f.runner(await request('round-fixture-1', JSON.stringify({ ...payload, input: [] })))).status, 409); assert.equal(f.calls.length, 1);
});
test('native HTTP authenticated provider tool roundtrip preserves full context and strips caller auth', { timeout: 5000 }, async () => {
 const f = fixture(), server = createRunnerServer(f.runner); server.listen(0, '127.0.0.1'); await once(server, 'listening');
 const port = (server.address() as import('node:net').AddressInfo).port;
 try {
  const transport = (async (input: any) => { const req = input as Request; assert.equal(req.redirect, 'error'); assert.equal(req.headers.has('authorization'), false); assert.equal(req.headers.has('cookie'), false); return fetch(`http://127.0.0.1:${port}/v1/responses`, { method: req.method, body: await req.text(), headers: req.headers, signal: req.signal }); }) as typeof fetch;
  const messages: Message[] = [{ role: 'user', content: 'fixture', timestamp: 1 }], tools = [{ name: 'test_status', description: 'fixed marker', parameters: Type.Object({}) }];
  const store = { read: async () => undefined, list: async () => [], modify: async () => { throw Error(); } } as any;
  let round = 0;
  const run = async () => { const p = createSiwcRunnerProvider({ endpoint: 'https://runner.example/v1/responses', key, roundId: `durable-round-${++round}`, fetch: transport }); const models = createChatModels(store, p); return collect(models.streamSimple(models.getModel(p.id, 'gpt-6.1-sol')!, { messages, tools }, { headers: { authorization: 'PRIVATE-CALLER', cookie: 'PRIVATE-COOKIE' }, maxRetries: 9 })); };
  const first = await run(); assert.equal(first.result.stopReason, 'toolUse'); assert.equal(f.calls.length, 1);
  const call = first.result.content.find((x: any) => x.type === 'toolCall'); messages.push(first.result, { role: 'toolResult', toolCallId: call.id, toolName: call.name, content: [{ type: 'text', text: 'offline-marker' }], isError: false, timestamp: 2 });
  const saved = structuredClone(messages), last = await run(); assert.equal(last.result.stopReason, 'stop'); assert.deepEqual(messages, saved); assert.match(last.result.content[0].text, /offline-marker/);
  assert.equal(f.calls.length, 2); const wire = f.calls[1].body;
  assert.ok(wire.input.some((x: any) => x.type === 'additional_tools')); assert.ok(wire.input.some((x: any) => x.type === 'function_call_output')); assert.equal(wire.tools, undefined); assert.equal(wire.previous_response_id, undefined); assert.equal(wire.max_output_tokens, undefined);
  assert.ok(f.calls.every(c => c.headers.get('authorization') === 'Bearer SYNTHETIC-ACCESS' && !c.headers.has('cookie')));
  assert.equal(createChatModels(store).getModel('model-runner-siwc', 'gpt-6.1-sol'), undefined);
 } finally { server.closeAllConnections(); await new Promise<void>(ok => server.close(() => ok())); }
});
for (const type of ['absent', 'mixed']) test('fragmented UTF8/CRLF SSE with '+type+' media type is accepted', async () => {
 const f = fixture({ fetch: async (_u, init) => { const base = await fakeBackend(JSON.parse(init!.body as string), '', init!.signal!); const data = new TextEncoder().encode(': heartbeat\r\n\r\n'+(await base.text()).replaceAll('\n','\r\n')); let offset=0; return new Response(new ReadableStream({ pull(out) { if(offset===data.length) out.close(); else {out.enqueue(data.slice(offset,offset+7));offset=Math.min(offset+7,data.length);} } }), {headers:type==='mixed'?{'content-type':'Text/Event-Stream; charset=UTF-8'}:{}}); } });
 const p = provider(f), r = await collect(p.streamSimple(p.getModels()[0], { messages: [{ role: 'user', content: 'fixture', timestamp: 1 }] })); assert.equal(r.result.stopReason, 'toolUse');
});
for (const mode of ['html', 'missing-terminal', 'failed', 'incomplete', 'http401', 'http403', 'http429', 'drop']) test('clear nonretryable error '+mode+' retains permanent fence and hides provider body', async () => {
 let calls = 0;
 const f = fixture({ fetch: async () => { calls++; if (mode.startsWith('http')) return new Response('SENSITIVE-UPSTREAM-TEXT', {status:Number(mode.slice(4))}); if(mode==='drop') throw Error('SENSITIVE-UPSTREAM-TEXT');
 const text = mode==='html'?'<html>PRIVATE</html>':mode==='missing-terminal'?'data: {"type":"response.created"}\n\n':'data: '+JSON.stringify({type:'response.'+mode,response:{status:mode,error:{message:'SENSITIVE-UPSTREAM-TEXT'}}})+'\n\n'; return new Response(new TextEncoder().encode(text)); } });
 const p = provider(f), r = await collect(p.streamSimple(p.getModels()[0], {messages:[{role:'user',content:'fixture',timestamp:1}]}, {maxRetries:9}));
 assert.equal(r.result.stopReason,'error'); assert.equal(isRetryableAssistantError(r.result), false); assert.ok(!JSON.stringify(r).includes('SENSITIVE-UPSTREAM-TEXT')); assert.equal(calls,1);
 if(mode==='http401')assert.match(r.result.errorMessage,/reauthorization required/); if(mode==='http429')assert.match(r.result.errorMessage,/usage limited/);
 assert.equal((await f.runner(await request('round-fixture-1'))).status,409); assert.equal(calls,1);
});
test('SIWC subset omits unsupported fields, rejects system and hosted tools, preserves opaque history', () => {
 const p = siwcPayload({...payload,previous_response_id:'resp_old',max_output_tokens:999,temperature:1,input:[{type:'reasoning',encrypted_content:'opaque'},{type:'function_call_output',call_id:'call_exact',output:'result'}]}); assert.equal(p.previous_response_id,undefined);assert.equal(p.max_output_tokens,undefined);assert.equal(p.temperature,undefined);assert.deepEqual(p.input,[{type:'reasoning',encrypted_content:'opaque'},{type:'function_call_output',call_id:'call_exact',output:'result'}]);
 for(const bad of [{...payload,input:[{type:'message',role:'system',content:'no'}]},{...payload,tools:[{type:'tool_search'}]},{...payload,input:[{type:'additional_tools',tools:[{type:'web_search'}]}]}])assert.throws(()=>siwcPayload(bad));
 for(const endpoint of ['http://runner.example/v1/responses','https://runner.example/v1/responses?key=x','https://user:secret@runner.example/v1/responses'])assert.throws(()=>createSiwcRunnerProvider({endpoint,key,roundId:'round-fixture-1',fetch}));
});
test('cancellation during credential wait never dispatches; late inference body is canceled', async () => {
 const gate=deferred<string>(),entered=deferred<void>(),abort=new AbortController();const f=fixture({credentials:{access:async()=>{entered.resolve();return gate.promise;}}});const pending=f.runner(await request('round-fixture-1',JSON.stringify(payload),abort.signal));await entered.promise;abort.abort();assert.equal((await pending).status,502);gate.resolve('SYNTHETIC');assert.equal(f.calls.length,0);assert.equal((await f.runner(await request())).status,409);
 const late=deferred<Response>(),called=deferred<void>(),stop=new AbortController();let canceled=0,signal:AbortSignal|undefined;
 const g=fixture({fetch:async(_u,init)=>{signal=init!.signal!;called.resolve();return late.promise;}});const wait=g.runner(await request('round-fixture-2',JSON.stringify(payload),stop.signal));await called.promise;stop.abort();assert.equal((await wait).status,502);late.resolve(new Response(new ReadableStream({cancel(){canceled++;}})));await new Promise(ok=>setImmediate(ok));assert.equal(signal!.aborted,true);assert.equal(canceled,1);
});
test('stream cancellation and deadline abort upstream and fence work',async()=>{
 let signal:AbortSignal|undefined,canceled=0;
 const f=fixture({timeoutMs:30,fetch:async(_u,init)=>{signal=init!.signal!;return new Response(new ReadableStream({start(out){out.enqueue(new TextEncoder().encode('data: {"type":"response.created"}\n\n'));},cancel(){canceled++;}}));}});
 const r=await f.runner(await request());const reader=r.body!.getReader();await reader.read();await assert.rejects(reader.read());assert.equal(signal!.aborted,true);assert.equal(canceled,1);assert.equal((await f.runner(await request())).status,409);
 const g=fixture();const response=await g.runner(await request());await response.body!.cancel();assert.equal(g.calls[0].signal.aborted,true);
});
test('Stop during durable reservation never starts credential refresh',async()=>{
 const entered=deferred<void>(),gate=deferred<void>(),abort=new AbortController();let accesses=0;
 const f=fixture({journal:{reserve:async()=>{entered.resolve();await gate.promise;return 'new';}},credentials:{access:async()=>{accesses++;return 'SYNTHETIC';}}});
 const wait=f.runner(await request('round-fsync-stop',JSON.stringify(payload),abort.signal));await entered.promise;abort.abort();gate.resolve();assert.equal((await wait).status,502);assert.equal(accesses,0);assert.equal(f.calls.length,0);
});
