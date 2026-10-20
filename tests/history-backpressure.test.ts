import { test, type TestContext } from 'node:test';
import assert from 'node:assert/strict';
import type { AgentEvent } from '@earendil-works/pi-durable';
import { HistoryFeed } from '../src/history-feed';

const streamId = 'aaaaaaaa-aaaa-4aaa-aaaa-aaaaaaaaaaaa';
const message = (id: string, text: string) => ({
  id, kind: 'pi.assistant', model: [{ role: 'assistant', content: [{ type: 'text', text }] }],
});
const history = Array.from({ length: 64 }, (_, i) => message(String(i + 1), 'saved '.repeat(683)));
const snapshot = {
  type: 'snapshot', entries: history, tools: [], inbox: [], agent: {}, usage: {}, compactions: [], run: {},
} as unknown as Extract<AgentEvent, { type: 'snapshot' }>;
const update = (n: number) => ({
  type: 'message_update', usage: {},
  changes: [{ type: 'message', message: { content: [{ type: 'text', text: String(n).padStart(4, '0') }] } }],
}) as unknown as AgentEvent;
const terminal = [
  { type: 'message_end', entry: message('65', 'Final answer') },
  { type: 'run_end', inputs: [] },
] as unknown as AgentEvent[];

function fixture(t: TestContext) {
  let receive!: (batch: AgentEvent[]) => Promise<void>;
  let stops = 0;
  let entries = async () => ({ items: history });
  let start = () => {};
  const abort = new AbortController();
  const request = new Request('https://chat.example.test/api/events?stream=' + streamId, { signal: abort.signal });
  const removed = t.mock.method(request.signal, 'removeEventListener');
  const feed = new HistoryFeed({
    session: () => ({ events: async () => ({
      snapshot,
      start: (callback: typeof receive) => { receive = callback; start(); },
      stop: async () => { stops++; },
    }) }),
    conversation: async () => ({ entries: () => entries() }),
  } as any, { title: async () => 'Large history' });
  const frame = (feed as any).frame;
  const serializedSizes: number[] = [];
  t.mock.method(feed as any, 'frame', function (...args: unknown[]) {
    const value = frame.apply(feed, args);
    serializedSizes.push(Buffer.byteLength('data: ' + JSON.stringify(value) + '\n\n'));
    return value;
  });
  // Inspect the actual Web Streams queue, without adding production diagnostics.
  const NativeStream = ReadableStream;
  let controller!: ReadableStreamDefaultController<Uint8Array>;
  t.mock.method(globalThis, 'ReadableStream', class extends NativeStream {
    constructor(source: UnderlyingDefaultSource<Uint8Array>, strategy?: QueuingStrategy<Uint8Array>) {
      super({ ...source, start(c) { controller = c; return source.start?.(c); } }, strategy);
    }
  });
  const readers: ReadableStreamDefaultReader<Uint8Array>[] = [];
  const reader = (response: Response) => {
    const r = response.body!.getReader();
    readers.push(r);
    return r;
  };
  t.after(async () => {
    for (const r of readers) await r.cancel().catch(() => {});
    await feed.close(streamId);
  });
  return {
    feed, abort, serializedSizes, reader,
    open: () => feed.subscribe(request, '1'),
    emit: (batch: AgentEvent[]) => receive(batch),
    replayWith: (read: typeof entries) => { entries = read; },
    onStart: (fn: typeof start) => { start = fn; },
    inspect: () => ({
      active: (feed as any).activeStreams, leases: (feed as any).streamStops.size, stops,
      removed: removed.mock.calls.filter(c => c.arguments[0] === 'abort').length,
    }),
    queuedFrames: () => 1 - controller.desiredSize!,
  };
}

async function readFrame(reader: ReadableStreamDefaultReader<Uint8Array>) {
  const next = await reader.read();
  assert.equal(next.done, false);
  const text = new TextDecoder().decode(next.value);
  assert.ok(text.startsWith('data: ') && text.endsWith('\n\n'));
  return JSON.parse(text.slice(6));
}
const released = { active: 0, leases: 0, stops: 1, removed: 1 };

for (const ending of ['close', 'expiry'] as const) {
  test(`unread large history retains one encoded frame through 2000 updates and ${ending}`, async t => {
    t.mock.timers.enable({ apis: ['setTimeout'] });
    const f = fixture(t);
    const response = await f.open();
    assert.equal(response.status, 200);
    assert.equal(response.headers.get('Content-Type'), 'text/event-stream');
    const initialBytes = f.serializedSizes[0];
    assert.ok(initialBytes > 256 * 1024);
    try {
      for (let i = 1; i <= 2000; i++) {
        await f.emit([update(i)]);
        if (i === 10 || i === 100 || i === 2000) {
          assert.equal(f.queuedFrames(), 1, `queue at ${i} updates`);
          assert.deepEqual(f.serializedSizes, [initialBytes], `encoded bytes at ${i} updates`);
        }
      }
      await f.emit(terminal);
      if (ending === 'close') await f.feed.close(streamId);
      else t.mock.timers.tick(55000);
      assert.deepEqual(f.inspect(), released, 'lease released before the reader resumes');
      assert.deepEqual(f.serializedSizes, [initialBytes], 'no eager final serialization while full');
      const reader = f.reader(response);
      const initial = await readFrame(reader);
      assert.equal(initial.messages.length, 64);
      assert.equal(initial.busy, true);
      assert.equal(initial.partial, '');
      const latest = await readFrame(reader);
      assert.equal(latest.messages.length, 65);
      assert.equal(latest.messages.at(-1).text, 'Final answer');
      assert.equal(latest.busy, false);
      assert.equal(latest.partial, '');
      assert.equal(latest.historyProtocol, 2);
      assert.equal(latest.title, 'Large history');
      assert.equal((await reader.read()).done, true);
      assert.equal(f.serializedSizes.length, 2, 'only initial and final frames, with no stale backlog');
      assert.ok(f.serializedSizes[1] < initialBytes + 256);
      await f.emit([update(9999)]);
      assert.equal(f.serializedSizes.length, 2, 'late callbacks cannot revive a closed stream');
      t.diagnostic(`${initialBytes} queued bytes at 10, 100 and 2000 updates; two total frames after drain`);
    } finally {
      await f.feed.close(streamId);
      await response.body?.cancel().catch(() => {});
    }
  });
}

test('slow reads coalesce each burst and eventually receive the latest partial and terminal state', async t => {
  const f = fixture(t);
  const response = await f.open();
  const reader = f.reader(response);
  assert.equal((await readFrame(reader)).busy, true);
  for (let burst = 0; burst < 4; burst++) {
    for (let i = 1; i <= 100; i++) await f.emit([update(burst * 100 + i)]);
    assert.equal(f.queuedFrames(), 1);
    // One already-queued frame and one latest projection, regardless of burst length.
    const queued = await readFrame(reader);
    const latest = await readFrame(reader);
    assert.equal(queued.partial, String(burst * 100 + 1).padStart(4, '0'));
    assert.equal(latest.partial, String(burst * 100 + 100).padStart(4, '0'));
  }
  await f.emit(terminal);
  const final = await readFrame(reader);
  assert.equal(final.busy, false);
  assert.equal(final.messages.at(-1).text, 'Final answer');
  assert.equal(f.serializedSizes.length, 10);
  await reader.cancel();
  assert.deepEqual(f.inspect(), released);
});

test('a waiting reader receives normal updates without waiting for another batch', async t => {
  const f = fixture(t);
  const reader = f.reader(await f.open());
  await readFrame(reader);
  for (let i = 1; i <= 3; i++) {
    const next = readFrame(reader);
    await f.emit([update(i)]);
    assert.equal((await next).partial, String(i).padStart(4, '0'));
  }
  await reader.cancel();
  assert.deepEqual(f.inspect(), released);
});

for (const ending of ['cancel', 'abort', 'close', 'expiry'] as const) {
  test(`backpressured ${ending} and racing cleanup stop the source exactly once`, async t => {
    t.mock.timers.enable({ apis: ['setTimeout'] });
    const f = fixture(t);
    const response = await f.open();
    for (let i = 0; i < 100; i++) await f.emit([update(i)]);
    if (ending === 'cancel') await response.body!.cancel();
    if (ending === 'abort') f.abort.abort();
    if (ending === 'close') await f.feed.close(streamId);
    if (ending === 'expiry') t.mock.timers.tick(55000);
    assert.deepEqual(f.inspect(), released);
    await response.body!.cancel();
    f.abort.abort();
    await f.feed.close(streamId);
    t.mock.timers.tick(55000);
    await f.emit([update(9999)]);
    assert.deepEqual(f.inspect(), released);
    assert.equal(f.serializedSizes.length, 1, 'discarded pending state is never serialized');
    assert.equal((await f.open()).status, 204, 'explicitly closed identity stays closed');
  });
}

test('cancellation during asynchronous snapshot replay ignores the late snapshot', async t => {
  const f = fixture(t);
  const response = await f.open();
  let release!: (value: { items: typeof history }) => void;
  let entered!: () => void;
  const waiting = new Promise<void>(resolve => { entered = resolve; });
  f.replayWith(() => { entered(); return new Promise(resolve => { release = resolve; }); });
  const replay = f.emit([snapshot, update(9000)]);
  await waiting;
  await response.body!.cancel();
  release({ items: history });
  await replay;
  assert.deepEqual(f.inspect(), released);
  assert.equal(f.serializedSizes.length, 1);
});

test('synchronous source setup failure clears the lease and timer exactly once', async t => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const f = fixture(t);
  f.onStart(() => { throw Error('Synthetic source setup failure'); });
  await assert.rejects(f.open(), /Synthetic source setup failure/);
  await f.feed.close(streamId);
  f.abort.abort();
  t.mock.timers.tick(55000);
  assert.deepEqual(f.inspect(), released);
});
