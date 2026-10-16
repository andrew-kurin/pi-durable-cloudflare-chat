import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createHistoryClient } from '../public/history-client.js';
const view = (text: string) => ({ historyProtocol: 2, messages: [{ role: 'user', text }], busy: false });
const flush = () => new Promise<void>(resolve => setImmediate(resolve));
function fixture(fetchSnapshot: (url: string, options: any) => Promise<any> = async () => Response.json(view('snapshot')), beacon = false) {
  const sources: any[] = [], views: any[] = [], states: any[] = [], closes: any[] = [], requests: any[] = [];
  const lifecycle = new EventTarget();
  const platform = {
    crypto,
    EventSource: class {
      closed = 0;
      constructor(public url: string) { sources.push(this); }
      close() { this.closed++; }
    },
    navigator: { sendBeacon: (url: string) => { if (beacon) closes.push(url); return beacon; } },
    fetch: async (url: string, options: any) => {
      if (options?.method === 'POST') { closes.push({ url, ...options }); return Response.json({ closed: true }); }
      requests.push({ url, ...options });
      return fetchSnapshot(url, options);
    },
    setTimeout: (fn: () => void, ms: number) => setTimeout(fn, ms),
    clearTimeout: (timer: any) => clearTimeout(timer),
    addEventListener: lifecycle.addEventListener.bind(lifecycle),
  };
  const client = createHistoryClient({ platform, onView: (v: any) => views.push(v), onState: (s: any) => states.push(s) });
  const emit = (source: any, value: any) => source.onmessage({ data: JSON.stringify(value) });
  const page = (type: string, persisted = true) => lifecycle.dispatchEvent(Object.assign(new Event(type), { persisted }));
  return { client, sources, views, states, closes, requests, emit, page };
}
test('rapid switching suppresses stale open/message/error callbacks and targets fallback to the new chat', async () => {
  const f = fixture();
  f.client.connect({ sessionId: '1' });
  const first = f.sources[0];
  f.emit(first, view('first'));
  f.client.connect({ sessionId: '2' });
  const count = f.states.length;
  first.onopen(); f.emit(first, view('stale')); await first.onerror();
  assert.equal(f.states.length, count);
  assert.deepEqual(f.views.map(v => v.messages[0].text), ['first']);
  await f.sources[1].onerror();
  assert.match(f.requests[0].url, /session=2&snapshot=1/);
  assert.equal(first.closed, 1);
  f.client.close();
});
test('delayed fallback cannot overwrite newer live data and its request is aborted', async () => {
  let resolve!: (response: Response) => void;
  const f = fixture(async () => new Promise<Response>(r => { resolve = r; }));
  f.client.connect({ sessionId: '1' });
  const pending = f.sources[0].onerror();
  f.emit(f.sources[0], view('live'));
  assert.equal(f.requests[0].signal.aborted, true);
  resolve(Response.json(view('old')));
  await pending;
  assert.deepEqual(f.views.map(v => v.messages[0].text), ['live']);
  assert.equal(f.states.at(-1).phase, 'live');
  f.client.close();
});
test('switching aborts a pending fallback; rejection cannot mark the new connection failed', async () => {
  const f = fixture(async () => new Promise(() => {}));
  f.client.connect({ sessionId: '1' });
  const pending = f.sources[0].onerror();
  f.client.connect({ sessionId: '2' });
  await pending;
  assert.equal(f.requests[0].signal.aborted, true);
  assert.equal(f.states.at(-1).phase, 'loading');
  f.client.close();
});
for (const type of ['application/json', 'text/event-stream']) {
  test('snapshot accepts bounded chunked ' + type + ' without waiting for a legacy SSE connection to end', async () => {
    const text = type === 'application/json' ? JSON.stringify(view('saved')) : ': ping\r\n\r\ndata: ' + JSON.stringify(view('saved')) + '\r\n\r\n';
    let cancelled = 0;
    const f = fixture(async () => new Response(new ReadableStream({
      start(c) {
        const bytes = new TextEncoder().encode(text);
        c.enqueue(bytes.slice(0, 17)); c.enqueue(bytes.slice(17));
        if (type === 'application/json') c.close();
      }, cancel() { cancelled++; },
    }), { headers: { 'Content-Type': type } }));
    f.client.connect({ sessionId: '1' });
    await f.sources[0].onerror();
    assert.equal(f.views[0].messages[0].text, 'saved');
    assert.equal(f.states.at(-1).phase, 'snapshot');
    if (type === 'text/event-stream') assert.equal(cancelled, 1);
    f.client.close();
  });
  test('snapshot rejects cumulative byte overflow in ' + type, async () => {
    let reads = 0, cancelled = 0;
    const f = fixture(async () => ({ ok: true, headers: new Headers({ 'Content-Type': type }), body: { getReader: () => ({
      read: async () => { reads++; return { value: new Uint8Array(1024 * 1024 + 1), done: false }; },
      cancel: async () => { cancelled++; },
    }) } }));
    f.client.connect({ sessionId: '1' });
    await f.sources[0].onerror();
    assert.equal(reads, 2); assert.equal(cancelled, 1);
    assert.equal(f.views.length, 0); assert.equal(f.states.at(-1).phase, 'failed');
    f.client.close();
  });
}
for (const phase of ['fetch', 'read']) test('ten-second bound cancels a stalled ' + phase + ' even if it ignores the signal', async t => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  let cancelled = 0;
  const f = fixture(async () => phase === 'fetch' ? new Promise(() => {}) : {
    ok: true, headers: new Headers({ 'Content-Type': 'application/json' }), body: { getReader: () => ({
      read: () => new Promise(() => {}), cancel: async () => { cancelled++; },
    }) },
  });
  f.client.connect({ sessionId: '1' });
  const pending = f.sources[0].onerror();
  await flush();
  t.mock.timers.tick(10000);
  await pending;
  assert.equal(f.requests[0].signal.aborted, true);
  assert.equal(f.states.at(-1).phase, 'failed');
  assert.equal(cancelled, phase === 'read' ? 1 : 0);
  f.client.close();
});
test('close is idempotent; pagehide releases once, BFCache restores once, explicit close prevents restoration', () => {
  const f = fixture();
  f.client.connect({ sessionId: '1' });
  f.page('pagehide'); f.page('pagehide');
  assert.equal(f.sources[0].closed, 1); assert.equal(f.closes.length, 1);
  assert.equal(f.closes[0].keepalive, true);
  f.page('pageshow'); f.page('pageshow');
  assert.equal(f.sources.length, 2);
  f.client.close(); f.client.close();
  f.page('pagehide'); f.page('pageshow');
  assert.equal(f.sources.length, 2); assert.equal(f.closes.length, 2);
});
test('retry replaces only the active lease, carries validated diagnostics and leaves native reconnect on that source', async () => {
  const f = fixture(undefined, true);
  f.client.connect({ sessionId: '1', diagnostic: { kind: 'saved-error', capture: 'aaaaaaaa-aaaa-4aaa-aaaa-aaaaaaaaaaaa' } });
  assert.match(f.sources[0].url, /diagnostic=saved-error&capture=/);
  f.emit(f.sources[0], view('saved'));
  await f.sources[0].onerror(); f.sources[0].onopen();
  assert.equal(f.sources.length, 1); assert.equal(f.requests.length, 0);
  f.client.retry();
  assert.equal(f.sources.length, 2); assert.equal(f.closes.length, 1);
  assert.match(f.sources[1].url, /diagnostic=saved-error&capture=/);
  f.client.close();
});
test('malformed live frames are ignored; a valid legacy view disables protocol-2 close notification', async () => {
  const f = fixture();
  f.client.connect({ sessionId: '1', diagnostic: { kind: 'saved-error', capture: 'invalid' } });
  assert.doesNotMatch(f.sources[0].url, /diagnostic=/);
  f.sources[0].onmessage({ data: '{' }); f.emit(f.sources[0], null); f.emit(f.sources[0], {});
  assert.equal(f.views.length, 0);
  f.emit(f.sources[0], { messages: [], busy: false });
  f.client.close();
  assert.equal(f.closes.length, 0); assert.equal(f.sources[0].closed, 1);
});

test('a response arriving after a cancelled fetch has its unread body cancelled', async () => {
  let resolve!: (response: Response) => void, cancelled = 0;
  const f = fixture(async () => new Promise<Response>(r => { resolve = r; }));
  f.client.connect({ sessionId: '1' });
  const pending = f.sources[0].onerror();
  f.client.close();
  await pending;
  resolve(new Response(new ReadableStream({ cancel() { cancelled++; } }), { headers: { 'Content-Type': 'application/json' } }));
  await flush();
  assert.equal(cancelled, 1);
  assert.equal(f.views.length, 0);
});
for (const status of [200, 403]) test('rejected response bodies are cancelled (HTTP ' + status + ')', async () => {
  let cancelled = 0;
  const f = fixture(async () => new Response(new ReadableStream({ cancel() { cancelled++; } }), {
    status, headers: { 'Content-Type': status === 200 ? 'text/html' : 'application/json' },
  }));
  f.client.connect({ sessionId: '1' });
  await f.sources[0].onerror();
  assert.equal(cancelled, 1);
  assert.equal(f.states.at(-1).phase, 'failed');
  f.client.close();
});
