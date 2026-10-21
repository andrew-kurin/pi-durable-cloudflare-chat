import { test, type TestContext } from 'node:test';
import assert from 'node:assert/strict';
import { HistoryFeed } from '../src/history-feed';

const entry = (id = '1', text = 'Saved answer') => ({
  id, kind: 'pi.assistant', model: [{ role: 'assistant', content: [{ type: 'text', text }] }],
});
const tick = () => new Promise<void>(resolve => setImmediate(resolve));
function fixture(t: TestContext) {
  let snapshot: any = { type: 'snapshot', entries: [entry()], tools: [], inbox: [], agent: {}, usage: {}, compactions: [] };
  let title = 'Saved chat', scans = 0, stops = 0, starts = 0;
  let receive!: (batch: any[]) => Promise<void>;
  let end!: (value: any) => void;
  const feed = new HistoryFeed({
    session: () => ({ events: async () => ({
      snapshot,
      closed: new Promise(resolve => { end = resolve; }),
      start: (callback: typeof receive) => { starts++; receive = callback; },
      stop: async () => { stops++; },
    }) }),
    conversation: async () => ({ entries: async () => { scans++; return { items: snapshot.entries }; } }),
  } as any, { title: async () => title });
  const readers: ReadableStreamDefaultReader<Uint8Array>[] = [];
  const open = async (lastId?: string, sid = '1', signal?: AbortSignal) => {
    const response = await feed.subscribe(new Request('https://chat.example.test/api/events?stream=' + crypto.randomUUID(), {
      signal, headers: lastId === undefined ? {} : { 'Last-Event-ID': lastId },
    }), sid);
    const reader = response.body?.getReader();
    if (reader) readers.push(reader);
    return { response, reader: reader! };
  };
  const first = async (lastId?: string, sid = '1') => {
    const { response, reader } = await open(lastId, sid);
    const bytes = (await reader.read()).value!;
    const text = new TextDecoder().decode(bytes);
    await reader.cancel();
    return { response, text, bytes: bytes.byteLength, id: /^id: (.*)$/m.exec(text)![1] };
  };
  t.after(async () => { for (const reader of readers) await reader.cancel().catch(() => {}); });
  return {
    feed, open, first, emit: (batch: any[]) => receive(batch),
    end: async () => { end({ reason: 'session_failed' }); await tick(); },
    snapshot: () => snapshot,
    update: (value: any) => { snapshot = value; },
    title: (value: string) => { title = value; },
    inspect: () => ({ scans, stops, starts, active: (feed as any).activeStreams }),
  };
}

test('idle renewals send a tiny named event but still read the authoritative history and title', async t => {
  const f = fixture(t);
  f.update({ ...f.snapshot(), entries: [entry('1', 'x'.repeat(847000))] });
  const full = await f.first();
  assert.match(full.id, /^hv1-[a-f0-9]{64}$/);
  assert.match(full.text, /^data: /);
  for (let i = 0; i < 3; i++) {
    const renewal = await f.first(full.id);
    assert.equal(renewal.response.status, 200);
    assert.equal(renewal.response.headers.get('Content-Type'), 'text/event-stream');
    assert.equal(renewal.response.headers.get('Cache-Control'), 'no-store');
    assert.equal(renewal.text, `event: unchanged\ndata: {}\nid: ${full.id}\n\n`);
    assert.ok(renewal.bytes < 128);
    assert.ok(1 - renewal.bytes / full.bytes > 0.999);
    t.diagnostic(`${full.bytes} full SSE payload bytes -> ${renewal.bytes} unchanged bytes (${((1 - renewal.bytes / full.bytes) * 100).toFixed(4)}% reduction); no server scan saving`);
  }
  assert.deepEqual(f.inspect(), { scans: 4, stops: 4, starts: 4, active: 0 });
});

for (const change of ['entry', 'rename', 'partial', 'busy', 'tool', 'compaction failure', 'reset'] as const) {
  test(`reconnect resynchronizes a changed ${change}, including state outside the entry tail`, async t => {
    const f = fixture(t);
    if (change === 'tool') f.update({ ...f.snapshot(), tools: [{ callId: 'call', name: 'web_search', status: 'running' }] });
    const before = await f.first();
    const next = { ...f.snapshot() };
    if (change === 'entry') next.entries = [...next.entries, entry('2', 'Missed answer')];
    if (change === 'rename') f.title('Renamed elsewhere');
    if (change === 'partial') next.generation = { attempt: 1, message: { content: [{ type: 'text', text: 'In flight' }] } };
    if (change === 'busy') next.run = { inputs: [] };
    if (change === 'tool') next.tools = [{ callId: 'call', name: 'web_search', status: 'done' }];
    if (change === 'compaction failure') next.compactionFailure = { taskId: 'compaction' };
    if (change === 'reset') next.entries = [];
    f.update(next);
    const after = await f.first(before.id);
    assert.match(after.text, /^data: /);
    assert.notEqual(after.id, before.id);
    assert.equal(after.response.status, 200);
  });
}

test('fresh attachment/restart is stateless; session, invalid IDs and changed state always resynchronize safely', async t => {
  const f = fixture(t), other = fixture(t);
  const before = await f.first();
  assert.match((await other.first(before.id)).text, /^event: unchanged/);
  assert.notEqual((await other.first(before.id, '2')).id, before.id);
  for (const id of ['', 'hv0-' + '0'.repeat(64), 'hv1-' + '0'.repeat(64), 'invalid', 'x'.repeat(10000)])
    assert.match((await other.first(id)).text, /^data: /);
  assert.match((await other.first()).text, /^data: /, 'reload/new EventSource has no validator');
});

for (const ending of ['abort', 'timeout'] as const) test(`${ending} during initial hashing releases setup; late digest cannot start a stream`, async t => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const f = fixture(t), abort = new AbortController();
  let release!: (id: string) => void, entered!: () => void;
  const waiting = new Promise<void>(resolve => { entered = resolve; });
  t.mock.method(f.feed as any, 'contentId', () => { entered(); return new Promise(resolve => { release = resolve; }); });
  const pending = f.open(undefined, '1', abort.signal);
  await waiting;
  if (ending === 'abort') abort.abort(); else t.mock.timers.tick(55000);
  const { response } = await pending;
  assert.equal(response.status, ending === 'abort' ? 204 : 200);
  assert.deepEqual(f.inspect(), { scans: 1, stops: 1, starts: 0, active: 0 });
  release('hv1-' + '0'.repeat(64));
  await tick();
  assert.equal(f.inspect().starts, 0);
  assert.equal(f.inspect().active, 0);
});

test('cancelling during live hashing drops late output and releases the source once', async t => {
  const f = fixture(t), { reader } = await f.open();
  await reader.read();
  let release!: (id: string) => void, entered!: () => void;
  const waiting = new Promise<void>(resolve => { entered = resolve; });
  t.mock.method(f.feed as any, 'contentId', () => { entered(); return new Promise(resolve => { release = resolve; }); });
  const pending = f.emit([{ type: 'run_start' }]);
  await waiting;
  await reader.cancel();
  assert.equal(f.inspect().active, 0);
  assert.equal(f.inspect().stops, 1);
  release('hv1-' + '0'.repeat(64));
  await pending;
  assert.equal((await reader.read()).done, true);
  assert.equal(f.inspect().stops, 1);
});

test('a terminal failure supersedes an in-flight hash without holding the lease or queuing stale state', async t => {
  const f = fixture(t), { reader } = await f.open();
  await reader.read();
  const original = (f.feed as any).contentId.bind(f.feed);
  let release!: (id: string) => void, entered!: () => void, hashes = 0;
  const waiting = new Promise<void>(resolve => { entered = resolve; });
  t.mock.method(f.feed as any, 'contentId', (...args: unknown[]) => {
    if (++hashes !== 1) return original(...args);
    entered(); return new Promise(resolve => { release = resolve; });
  });
  const pending = f.emit([{ type: 'run_start' }]);
  await waiting;
  await f.end();
  assert.equal(f.inspect().active, 0);
  assert.equal(f.inspect().stops, 1);
  release('hv1-' + '0'.repeat(64));
  await pending;
  const text = new TextDecoder().decode((await reader.read()).value);
  const view = JSON.parse(text.split('\n')[0].slice(6));
  assert.equal(view.failureState.kind, 'session');
  assert.equal(view.busy, false);
  assert.doesNotMatch(text, new RegExp('id: hv1-' + '0'.repeat(64)));
  assert.equal((await reader.read()).done, true);
  assert.equal(hashes, 2);
});
