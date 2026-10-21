import { test } from 'node:test';
import assert from 'node:assert/strict';
import { setImmediate as tick } from 'node:timers/promises';
import { HistoryFeed } from '../src/history-feed';
import { ChatCatalog } from '../src/chat-catalog';

const phases = ['events', 'conversation', 'first-page', 'later-page', 'title', 'missing-title', 'title-fallback', 'cleanup'] as const;
type Phase = typeof phases[number];
function deferred<T>() {
  let resolve!: (value: T) => void, reject!: (error: unknown) => void;
  const promise = new Promise<T>((a, b) => { resolve = a; reject = b; });
  return { promise, resolve, reject };
}
const entries = [1, 2].map(id => ({ id, kind: 'pi.user', model: [{ role: 'user', content: 'Saved fixture ' + id, timestamp: id }] }));
const snapshot = { type: 'snapshot', entries: entries.slice(1), tools: [], inbox: [], agent: {}, usage: {}, compactions: [] };

function fixture(phase?: Phase, count = 1, options: { stopFailure?: boolean; acquired?: () => void } = {}) {
  const gate = deferred<void>(), entered = deferred<void>();
  let waiting = 0, eventReads = 0, conversations = 0, pages = 0, titles = 0;
  const sources: { sid: string; stops: number; starts: number }[] = [];
  async function wait(at: Phase, sid: string) {
    if (phase === at && sid === '1') { if (++waiting === count) entered.resolve(); await gate.promise; }
  }
  const catalog = new ChatCatalog({ get: async (key: string) => {
    titles++;
    const sid = key.split(':')[1];
    if (key.startsWith('chat-title:')) {
      await wait(phase === 'missing-title' ? 'missing-title' : 'title', sid);
      return phase === 'title-fallback' || phase === 'missing-title' ? undefined : 'Saved title';
    }
    await wait('title-fallback', sid); return 'Automatic title';
  } } as any, {} as any, async () => { throw Error('No model work'); }, async () => {});
  const feed = new HistoryFeed({
    session: (sid: string) => ({ events: async () => {
      eventReads++; await wait('events', sid);
      const source = { sid, stops: 0, starts: 0 }; sources.push(source);
      options.acquired?.();
      return { snapshot, start: () => { source.starts++; }, stop: async () => {
        source.stops++; await wait('cleanup', sid);
        if (options.stopFailure) throw Error('Synthetic snapshot stop failure');
      } };
    } }),
    conversation: async (sid: string) => {
      conversations++; await wait('conversation', sid);
      return { entries: async (query: unknown, limit: number, cursor?: string) => {
        assert.deepEqual(query, { order: 'ascending', maxEntryId: 2 }); assert.equal(limit, 256);
        pages++; await wait(cursor === undefined ? 'first-page' : 'later-page', sid);
        return { items: [entries[cursor === undefined ? 0 : 1]], ...(cursor === undefined ? { next: 'page-2' } : {}) };
      } };
    },
  } as any, catalog);
  const aborts = Array.from({ length: count }, () => new AbortController());
  const requests = aborts.map(a => new Request('https://chat.example.test/api/events?session=1&snapshot=1', { signal: a.signal }));
  return {
    feed, aborts, requests, sources, entered: entered.promise,
    open: () => requests.map(r => feed.snapshot(r, '1')),
    release: () => gate.resolve(), reject: () => gate.reject(Error('Synthetic snapshot setup failure')),
    reads: () => ({ eventReads, conversations, pages, titles }),
    capacity: () => ({ snapshots: (feed as any).activeSnapshots, streams: (feed as any).activeStreams }),
  };
}
async function probe(feed: HistoryFeed) {
  const response = await feed.snapshot(new Request('https://chat.example.test/api/events?snapshot=1'), '2');
  assert.equal(response.status, 200); assert.equal((await response.json() as any).historyProtocol, 2);
}

test('snapshot preserves complete fork-aware JSON, title and cache response while never starting live events', async () => {
  const f = fixture();
  const response = await f.open()[0];
  assert.equal(response.status, 200); assert.equal(response.headers.get('cache-control'), 'no-store');
  assert.match(response.headers.get('content-type')!, /application\/json/);
  const body = await response.json() as any;
  assert.equal(body.historyProtocol, 2); assert.equal(body.title, 'Saved title');
  assert.deepEqual(body.messages.map((m: any) => m.text), ['Saved fixture 1', 'Saved fixture 2']);
  assert.deepEqual(f.capacity(), { snapshots: 0, streams: 0 });
  assert.deepEqual(f.sources.map(s => ({ stops: s.stops, starts: s.starts })), [{ stops: 1, starts: 0 }]);
});

for (const phase of phases) for (const ending of ['abort', 'timeout'] as const) {
  test(`snapshot ${ending} during ${phase} releases admission and observes late setup/cleanup once`, async t => {
    t.mock.timers.enable({ apis: ['setTimeout'] });
    const f = fixture(phase, 3), removed = f.requests.map(r => t.mock.method(r.signal, 'removeEventListener'));
    const pending = f.open(); await f.entered;
    assert.deepEqual(f.capacity(), { snapshots: 3, streams: 0 });
    if (ending === 'abort') f.aborts.forEach(a => a.abort());
    else { t.mock.timers.tick(54999); assert.equal(f.capacity().snapshots, 3); t.mock.timers.tick(1); }
    const responses = await Promise.all(pending);
    for (const response of responses) {
      assert.equal(response.status, ending === 'abort' ? 408 : 504);
      assert.equal(response.headers.get('cache-control'), 'no-store');
      assert.equal(typeof (await response.json() as any).error, 'string');
    }
    assert.deepEqual(f.capacity(), { snapshots: 0, streams: 0 });
    await probe(f.feed);
    const before = f.reads(); f.release(); await tick();
    assert.deepEqual(f.reads(), before, 'aborted I/O must not start further history pages or title reads');
    assert.ok(f.sources.every(s => s.stops === 1 && s.starts === 0));
    f.aborts.forEach(a => a.abort()); t.mock.timers.tick(55000);
    assert.deepEqual(f.capacity(), { snapshots: 0, streams: 0 });
    assert.ok(removed.every(spy => spy.mock.calls.filter(c => c.arguments[0] === 'abort').length === 1));
  });
}

for (const phase of phases) test(`late snapshot rejection during ${phase} cannot revive or leak a lease`, async t => {
  t.mock.method(console, 'warn', () => {});
  const f = fixture(phase), [pending] = f.open(); await f.entered;
  f.aborts[0].abort(); assert.equal((await pending).status, 408);
  f.reject(); await tick();
  assert.deepEqual(f.capacity(), { snapshots: 0, streams: 0 });
  assert.ok(f.sources.every(s => s.stops === 1 && s.starts === 0));
  await probe(f.feed);
});

for (const phase of phases.filter(p => p !== 'cleanup')) test(`ordinary snapshot failure during ${phase} preserves the error and releases its lease`, async () => {
  const f = fixture(phase), [pending] = f.open();
  const rejected = assert.rejects(pending, /Synthetic snapshot setup failure/);
  await f.entered; f.reject(); await rejected; await tick();
  assert.deepEqual(f.capacity(), { snapshots: 0, streams: 0 });
  assert.ok(f.sources.every(s => s.stops === 1 && s.starts === 0));
  await probe(f.feed);
});

test('the fourth snapshot is rejected without acquiring a source or releasing another lease', async () => {
  const f = fixture('events', 3), pending = f.open(); await f.entered;
  const response = await f.feed.snapshot(new Request('https://chat.example.test/api/events?snapshot=1'), '2');
  assert.equal(response.status, 429); assert.equal(f.reads().eventReads, 3);
  assert.deepEqual(f.capacity(), { snapshots: 3, streams: 0 });
  f.aborts[0].abort(); assert.equal((await pending[0]).status, 408);
  await probe(f.feed); assert.equal(f.capacity().snapshots, 2);
  f.aborts.slice(1).forEach(a => a.abort()); await Promise.all(pending); f.release(); await tick();
  assert.deepEqual(f.capacity(), { snapshots: 0, streams: 0 });
  assert.ok(f.sources.every(s => s.stops === 1));
});

test('pre-aborted snapshots do not start setup or alter another snapshot lease', async () => {
  const f = fixture('events'), [pending] = f.open(); await f.entered;
  const abort = new AbortController(); abort.abort();
  const response = await f.feed.snapshot(new Request('https://chat.example.test/api/events?snapshot=1', { signal: abort.signal }), '2');
  assert.equal(response.status, 408); assert.equal(f.reads().eventReads, 1);
  assert.deepEqual(f.capacity(), { snapshots: 1, streams: 0 });
  f.aborts[0].abort(); await pending; f.release(); await tick();
  assert.deepEqual(f.capacity(), { snapshots: 0, streams: 0 });
});

test('one deadline includes all setup and cleanup rather than restarting for each phase', async t => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const f = fixture('cleanup'), [pending] = f.open(); await f.entered;
  t.mock.timers.tick(54999); assert.equal(f.capacity().snapshots, 1);
  t.mock.timers.tick(1); assert.equal((await pending).status, 504);
  assert.deepEqual(f.capacity(), { snapshots: 0, streams: 0 });
  f.release(); await tick(); assert.equal(f.sources[0].stops, 1);
});

test('aborting as an event source arrives disposes it once without scanning history', async () => {
  const abort = new AbortController(), f = fixture('events', 1, { acquired: () => abort.abort() });
  const pending = f.feed.snapshot(new Request('https://chat.example.test/api/events?snapshot=1', { signal: abort.signal }), '1');
  await f.entered; f.release(); assert.equal((await pending).status, 408); await tick();
  assert.equal(f.reads().conversations, 0); assert.equal(f.sources[0].stops, 1);
  assert.deepEqual(f.capacity(), { snapshots: 0, streams: 0 });
});

test('cleanup rejection is observed and logged once without changing complete JSON or retaining admission', async t => {
  const warn = t.mock.method(console, 'warn', () => {}), f = fixture(undefined, 1, { stopFailure: true });
  assert.equal((await f.open()[0]).status, 200); await tick();
  assert.equal(warn.mock.calls.length, 1); assert.equal(f.sources[0].stops, 1);
  assert.deepEqual(f.capacity(), { snapshots: 0, streams: 0 });
});

test('snapshot admission and abort do not change three existing SSE leases', async () => {
  const f = fixture('events'), streams: Response[] = [];
  try {
    for (let i = 0; i < 3; i++) streams.push(await f.feed.subscribe(new Request('https://chat.example.test/api/events'), '2'));
    assert.deepEqual(f.capacity(), { snapshots: 0, streams: 3 });
    const [pending] = f.open(); await f.entered;
    assert.deepEqual(f.capacity(), { snapshots: 1, streams: 3 });
    f.aborts[0].abort(); assert.equal((await pending).status, 408);
    assert.deepEqual(f.capacity(), { snapshots: 0, streams: 3 });
    await probe(f.feed); f.release(); await tick();
  } finally { for (const response of streams) await response.body!.cancel(); }
  assert.deepEqual(f.capacity(), { snapshots: 0, streams: 0 });
});
