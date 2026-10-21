import { test } from 'node:test';
import assert from 'node:assert/strict';
import { setImmediate as tick } from 'node:timers/promises';
import { HistoryFeed } from '../src/history-feed';
import { ChatCatalog } from '../src/chat-catalog';

const phases = ['events', 'conversation', 'first-page', 'later-page', 'title', 'missing-title', 'title-fallback'] as const;
type Phase = typeof phases[number];
const deferred = <T>() => {
  let resolve!: (value: T) => void, reject!: (error: unknown) => void;
  const promise = new Promise<T>((a, b) => { resolve = a; reject = b; });
  return { promise, resolve, reject };
};
const entry = { id: 1, kind: 'pi.user', model: [{ role: 'user', content: 'Saved fixture', timestamp: 1 }] };
const snapshot = { type: 'snapshot', entries: [entry], tools: [], inbox: [], agent: {}, usage: {}, compactions: [] };

function fixture(phase: Phase, count = 3, options: { slowStop?: boolean; stopFailure?: boolean; acquired?: () => void } = {}) {
  const gate = deferred<void>(), entered = deferred<void>(), cleanup = deferred<void>();
  let waiting = 0, eventReads = 0, conversations = 0, pages = 0, titles = 0;
  const sources: { sid: string; stops: number; starts: number; end: (value: { reason: string }) => void }[] = [];
  const wait = async (at: Phase, sid: string) => {
    if (sid === '1' && phase === at) { if (++waiting === count) entered.resolve(); await gate.promise; }
  };
  const catalog = new ChatCatalog({ get: async (key: string) => {
    const sid = key.split(':')[1]; titles++;
    if (key.startsWith('chat-title:')) {
      await wait(phase === 'missing-title' ? 'missing-title' : 'title', sid);
      return phase === 'title-fallback' || phase === 'missing-title' ? undefined : 'Saved title';
    }
    await wait('title-fallback', sid); return 'Automatic title';
  } } as any, {} as any, async () => { throw Error('No model work'); }, async () => {});
  const feed = new HistoryFeed({
    session: (sid: string) => ({ events: async () => {
      eventReads++; await wait('events', sid);
      const closed = deferred<{ reason: string }>();
      const source = { sid, stops: 0, starts: 0, end: closed.resolve }; sources.push(source);
      options.acquired?.();
      return { snapshot, closed: closed.promise, start: () => { source.starts++; }, stop: async () => {
        source.stops++; if (options.slowStop && source === sources[0]) await cleanup.promise;
        if (options.stopFailure) throw Error('Synthetic source stop failure');
        closed.resolve({ reason: 'stopped' });
      } };
    } }),
    conversation: async (sid: string) => {
      conversations++; await wait('conversation', sid);
      return { entries: async (query: any, limit: number, cursor?: string) => {
        assert.deepEqual(query, { order: 'ascending', maxEntryId: 1 }); assert.equal(limit, 256);
        pages++; await wait(cursor === undefined ? 'first-page' : 'later-page', sid);
        return { items: cursor === undefined ? [entry] : [], ...(cursor === undefined ? { next: 'page-2' } : {}) };
      } };
    },
  } as any, catalog);
  const ids = Array.from({ length: count }, () => crypto.randomUUID());
  const aborts = ids.map(() => new AbortController());
  const requests = ids.map((id, i) => new Request('https://chat.example.test/api/events?stream=' + id, { signal: aborts[i].signal }));
  return { feed, ids, aborts, requests, sources, entered: entered.promise,
    open: () => requests.map(r => feed.subscribe(r, '1')),
    release: () => gate.resolve(), reject: () => gate.reject(Error('Late fixture failure')),
    releaseCleanup: () => cleanup.resolve(),
    reads: () => ({ eventReads, conversations, pages, titles }),
    capacity: () => ({ active: (feed as any).activeStreams, leases: (feed as any).streamStops.size }),
  };
}
async function probe(feed: HistoryFeed) {
  const response = await feed.subscribe(new Request('https://chat.example.test/api/events?stream=' + crypto.randomUUID()), '2');
  assert.equal(response.status, 200); await response.body!.cancel();
}

for (const phase of phases) for (const ending of ['abort', 'timeout'] as const) {
  test(`${ending} during ${phase} settles HTTP, frees all slots, and ignores late setup without further reads`, async t => {
    t.mock.timers.enable({ apis: ['setTimeout'] });
    const f = fixture(phase), removed = f.requests.map(r => t.mock.method(r.signal, 'removeEventListener'));
    const pending = f.open(); await f.entered;
    assert.deepEqual(f.capacity(), { active: 3, leases: 3 });
    if (ending === 'abort') f.aborts.forEach(a => a.abort());
    else { t.mock.timers.tick(54999); assert.equal(f.capacity().active, 3); t.mock.timers.tick(1); }
    // The fixture gate remains blocked: HTTP/capacity must settle independently.
    const responses = await Promise.all(pending); assert.ok(responses.every(r => r.status === (ending === 'timeout' ? 200 : 204)));
    if (ending === 'timeout') for (const r of responses) { assert.equal(r.headers.get('Content-Type'), 'text/event-stream'); assert.equal(await r.text(), ''); }
    assert.deepEqual(f.capacity(), { active: 0, leases: 0 });
    await probe(f.feed); assert.deepEqual(f.capacity(), { active: 0, leases: 0 });
    const before = f.reads(); f.release(); await tick(); assert.deepEqual(f.reads(), before, 'late setup cannot issue another page or title lookup');
    for (const source of f.sources) { assert.equal(source.stops, 1); if (source.sid === '1') assert.equal(source.starts, 0); }
    // Old cancellation, expiry and explicit-close callbacks cannot decrement again.
    f.aborts.forEach(a => a.abort()); for (const id of f.ids) await f.feed.close(id); t.mock.timers.tick(55000);
    assert.deepEqual(f.capacity(), { active: 0, leases: 0 });
    assert.ok(f.sources.every(s => s.stops === 1));
    assert.ok(removed.every(spy => spy.mock.calls.filter(c => c.arguments[0] === 'abort').length === 1));
  });
}

for (const phase of phases) test(`explicit close during ${phase} returns before setup and preserves late-source cleanup`, async () => {
  const f = fixture(phase, 1), [pending] = f.open(); await f.entered;
  await f.feed.close(f.ids[0]); assert.equal((await pending).status, 204);
  const before = f.reads(); f.release(); await tick(); assert.deepEqual(f.reads(), before);
  assert.deepEqual(f.capacity(), { active: 0, leases: 0 });
  assert.ok(f.sources.every(s => s.stops === 1 && s.starts === 0));
});

test('pre-aborted requests do not acquire an event source or start any setup read', async () => {
  const f = fixture('events', 1); f.aborts[0].abort();
  assert.equal((await f.open()[0]).status, 204); assert.deepEqual(f.capacity(), { active: 0, leases: 0 });
  assert.deepEqual(f.reads(), { eventReads: 0, conversations: 0, pages: 0, titles: 0 });
});

test('the lease expires 55 seconds from setup start rather than restarting after setup', async t => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const f = fixture('conversation', 1), [pending] = f.open(); await f.entered;
  t.mock.timers.tick(20000); f.release(); const response = await pending; assert.equal(response.status, 200);
  t.mock.timers.tick(34999); assert.equal(f.capacity().active, 1);
  t.mock.timers.tick(1); assert.deepEqual(f.capacity(), { active: 0, leases: 0 });
  await response.body!.cancel(); assert.equal(f.sources[0].stops, 1);
});

for (const phase of phases) test(`late rejection from ${phase} is observed after cancellation without reviving the lease`, async () => {
  const f = fixture(phase, 1), [pending] = f.open(); await f.entered; f.aborts[0].abort();
  assert.equal((await pending).status, 204); f.reject(); await tick();
  assert.deepEqual(f.capacity(), { active: 0, leases: 0 }); assert.ok(f.sources.every(s => s.stops === 1));
});

for (const phase of phases) test(`ordinary setup rejection at ${phase} preserves the error and releases its slot`, async () => {
  const f = fixture(phase, 1), pending = f.open()[0];
  const rejected = assert.rejects(pending, /Late fixture failure/);
  await f.entered; f.reject(); await rejected;
  assert.deepEqual(f.capacity(), { active: 0, leases: 0 });
  assert.ok(f.sources.every(s => s.stops === 1 && s.starts === 0));
  await probe(f.feed); f.aborts[0].abort(); await f.feed.close(f.ids[0]);
  assert.deepEqual(f.capacity(), { active: 0, leases: 0 }); assert.ok(f.sources.every(s => s.stops === 1));
});

test('a late source cleanup rejection is observed without double release or an unhandled rejection', async t => {
  const warning = t.mock.method(console, 'warn', () => {});
  const f = fixture('events', 1, { stopFailure: true }), [pending] = f.open(); await f.entered;
  f.aborts[0].abort(); assert.equal((await pending).status, 204); f.release(); await tick();
  assert.deepEqual(f.capacity(), { active: 0, leases: 0 }); assert.equal(f.sources[0].stops, 1);
  assert.equal(warning.mock.calls.length, 1);
  await f.feed.close(f.ids[0]); assert.equal(f.sources[0].stops, 1);
});

test('cancellation while an event source is being fulfilled disposes that source once', async () => {
  const abort = new AbortController();
  const f = fixture('events', 1, { acquired: () => abort.abort() });
  const pending = f.feed.subscribe(new Request('https://chat.example.test/api/events?stream=' + f.ids[0], { signal: abort.signal }), '1');
  await f.entered; f.release(); assert.equal((await pending).status, 204); await tick();
  assert.deepEqual(f.capacity(), { active: 0, leases: 0 }); assert.equal(f.sources[0].stops, 1); assert.equal(f.sources[0].starts, 0);
});

test('a late source from an aborted lease cannot stop or decrement its same-ID replacement', async () => {
  const f = fixture('events', 1), [pending] = f.open(); await f.entered; f.aborts[0].abort(); assert.equal((await pending).status, 204);
  const response = await f.feed.subscribe(new Request('https://chat.example.test/api/events?stream=' + f.ids[0]), '2'); assert.equal(response.status, 200);
  f.release(); await tick(); assert.deepEqual(f.capacity(), { active: 1, leases: 1 });
  assert.equal(f.sources.find(s => s.sid === '1')!.stops, 1); assert.equal(f.sources.find(s => s.sid === '2')!.stops, 0);
  await f.feed.close(f.ids[0]); await response.body!.cancel(); assert.deepEqual(f.capacity(), { active: 0, leases: 0 }); assert.ok(f.sources.every(s => s.stops === 1));
});

for (const ending of ['abort', 'timeout'] as const) test(`replacement waiting for stalled old cleanup has its own bounded ${ending}`, async t => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const f = fixture('events', 1, { slowStop: true });
  // sid 2 bypasses setup delay so only source disposal is held.
  const first = await f.feed.subscribe(new Request('https://chat.example.test/api/events?stream=' + f.ids[0]), '2');
  const abort = new AbortController();
  const pending = f.feed.subscribe(new Request('https://chat.example.test/api/events?stream=' + f.ids[0], { signal: abort.signal }), '2');
  assert.deepEqual(f.capacity(), { active: 0, leases: 0 });
  if (ending === 'abort') abort.abort(); else t.mock.timers.tick(55000);
  assert.equal((await pending).status, ending === 'timeout' ? 200 : 204); assert.equal(f.sources[0].stops, 1);
  await probe(f.feed); f.releaseCleanup(); await tick(); await first.body!.cancel();
  assert.deepEqual(f.capacity(), { active: 0, leases: 0 }); assert.ok(f.sources.every(s => s.stops === 1));
});

test('abort releases setup even when an acquired source stop never resolves promptly', async () => {
  const f = fixture('first-page', 1, { slowStop: true }), [pending] = f.open(); await f.entered;
  f.aborts[0].abort(); assert.equal((await pending).status, 204); assert.deepEqual(f.capacity(), { active: 0, leases: 0 });
  await probe(f.feed); f.release(); f.releaseCleanup(); await tick(); assert.ok(f.sources.every(s => s.stops === 1));
});

test('a blocked setup counts toward the maximum; rejecting a fourth request does not release another lease', async t => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const f = fixture('events'), pending = f.open(); await f.entered;
  const response = await f.feed.subscribe(new Request('https://chat.example.test/api/events?stream=' + crypto.randomUUID()), '2');
  assert.equal(response.status, 429); assert.deepEqual(f.capacity(), { active: 3, leases: 3 });
  f.aborts[0].abort(); assert.equal((await pending[0]).status, 204); assert.equal(f.capacity().active, 2);
  await probe(f.feed); assert.equal(f.capacity().active, 2);
  f.aborts.slice(1).forEach(a => a.abort()); await Promise.all(pending); f.release(); await tick(); t.mock.timers.tick(55000);
  assert.deepEqual(f.capacity(), { active: 0, leases: 0 }); assert.ok(f.sources.every(s => s.stops === 1));
});
