import type { PiHarness } from "agents/harness/pi";
import type { ChatCatalog } from "./chat-catalog";
import { ChatProjection } from "./projector";
import { conversationTitle } from "./conversation-title";
import { fullHistorySnapshot } from './history-snapshot';
import { logTechnicalError } from './error-log';
/** Owns history leases and close-before-open races, never model admission.
 * A lease releases exactly once on setup failure, cancellation, abort or expiry.
 */
export class HistoryFeed {
  private activeStreams = 0;
  private activeSnapshots = 0;
  private streamStops = new Map<string, () => Promise<void>>();
  private closedStreams = new Map<string, number>();
  constructor(
    private harness: Pick<PiHarness, "session"|"conversation">,
    private chatCatalog: Pick<ChatCatalog, "title">,
  ) {}
  private frame(
    projection: ChatProjection,
    title: string | undefined,
  ) {
    return {
      ...projection.view(),
      historyProtocol: 2,
      title:
        title ||
        conversationTitle(
          projection.messages.find(
            (m) => m.role === "user" && conversationTitle(m.text),
          )?.text,
        ),
    };
  }
  async close(id: string) {
    this.closedStreams.set(id, Date.now() + 55000);
    while (this.closedStreams.size > 64)
      this.closedStreams.delete(this.closedStreams.keys().next().value!);
    await this.streamStops.get(id)?.();
    return Response.json({ closed: true });
  }
  async snapshot(request: Request, sid: string) {
    const unavailable = (status: number, error: string) => Response.json(
      { error }, { status, headers: { 'Cache-Control': 'no-store' } },
    );
    if (request.signal.aborted)
      return unavailable(408, 'History request cancelled.');
    // One-shot reads have their own budget: a fallback must still work while
    // the browser's three SSE leases are open, without allowing unlimited scans.
    if (this.activeSnapshots >= 3)
      return unavailable(429, 'Too many history requests. Retry loading history.');
    this.activeSnapshots++;
    let events:
      | Awaited<ReturnType<ReturnType<typeof this.harness.session>["events"]>>
      | undefined;
    let ended = false, expired = false, sourceStopped = false;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const lifetime = new AbortController();
    const stopped = Symbol('History snapshot lease ended');
    let cancelSetup!: (value: typeof stopped) => void;
    const cancelled = new Promise<typeof stopped>(resolve => { cancelSetup = resolve; });
    const stopSource = async () => {
      if (!events || sourceStopped) return;
      sourceStopped = true;
      try { await events.stop(); }
      catch (error) { logTechnicalError('request', error, crypto.randomUUID()); }
    };
    const stop = () => {
      if (ended) return;
      ended = true;
      clearTimeout(timer);
      this.activeSnapshots--;
      request.signal.removeEventListener('abort', onAbort);
      lifetime.abort();
      cancelSetup(stopped);
      // A stalled stop must not hold the HTTP response or its admission slot.
      // The source may also arrive after cancellation; that path owns it below.
      void stopSource();
    };
    const onAbort = () => stop();
    const setup = async <T>(read: () => Promise<T>): Promise<T> => {
      if (ended) throw stopped;
      const value = await Promise.race([read(), cancelled]);
      if (ended || value === stopped) throw stopped;
      return value as T;
    };
    try {
      request.signal.addEventListener('abort', onAbort, { once: true });
      // One deadline covers acquisition, every history page, title and cleanup.
      timer = setTimeout(() => { if (!ended) { expired = true; stop(); } }, 55000);
      if (request.signal.aborted) stop();
      const source = await setup(async () => {
        events = await this.harness.session(sid).events();
        if (ended) void stopSource();
        return events;
      });
      const projection = new ChatProjection();
      projection.apply(await setup(() => fullHistorySnapshot(this.harness, sid, source.snapshot, lifetime.signal)));
      const title = await setup(() => this.chatCatalog.title(sid, undefined, lifetime.signal));
      const response = Response.json(this.frame(projection, title), {
        headers: { "Cache-Control": "no-store" },
      });
      await setup(stopSource);
      return response;
    } catch (error) {
      if (ended) return unavailable(expired ? 504 : 408, expired
        ? 'History request timed out. Retry loading history.'
        : 'History request cancelled.');
      throw error;
    } finally {
      stop();
    }
  }
  async subscribe(request: Request, sid: string) {
    const url = new URL(request.url);
    const id = url.searchParams.get("stream");
    if (id !== null && !/^[a-f0-9-]{36}$/.test(id))
      return Response.json({ error: "Invalid stream" }, { status: 400 });
    for (const [key, deadline] of this.closedStreams)
      if (deadline <= Date.now()) this.closedStreams.delete(key);
    if (id && this.closedStreams.has(id))
      return new Response(null, { status: 204 });
    let events:
      | Awaited<ReturnType<ReturnType<typeof this.harness.session>["events"]>>
      | undefined;
    let ended = false;
    let expired = false;
    let reserved = false;
    let streaming = false;
    let sourceStopped = false;
    let timer: ReturnType<typeof setTimeout> | undefined;
    let controller: ReadableStreamDefaultController<Uint8Array> | undefined;
    let flush = () => {};
    const lifetime = new AbortController();
    const stopped = Symbol('History lease ended');
    let cancelSetup!: (value: typeof stopped) => void;
    const cancelled = new Promise<typeof stopped>(resolve => { cancelSetup = resolve; });
    // 204 permanently stops EventSource reconnect. Lease expiry is temporary:
    // end an empty SSE response so the existing client can reconnect normally.
    const endedResponse = () => expired
      ? new Response(null, { headers: { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-store' } })
      : new Response(null, { status: 204 });
    // Cancellation settles the caller even when an SDK/storage operation does
    // not honor abort. Promise.race also observes any late rejection.
    const setup = async <T>(read: () => Promise<T>): Promise<T> => {
      if (ended) throw stopped;
      const value = await Promise.race([read(), cancelled]);
      if (ended || value === stopped) throw stopped;
      return value as T;
    };
    const stopSource = async () => {
      if (!events || sourceStopped) return;
      sourceStopped = true;
      try {
        await events.stop();
      } catch (error) {
        logTechnicalError('request', error, crypto.randomUUID());
      }
    };
    const onAbort = () => {
      void stop();
    };
    const stop = async () => {
      if (ended) return;
      ended = true;
      clearTimeout(timer);
      if (reserved) {
        reserved = false;
        this.activeStreams--;
      }
      if (id && this.streamStops.get(id) === stop) this.streamStops.delete(id);
      request.signal.removeEventListener("abort", onAbort);
      lifetime.abort();
      cancelSetup(stopped);
      flush();
      await stopSource();
    };
    try {
      // One deadline covers replacement, all initial setup and live streaming.
      request.signal.addEventListener('abort', onAbort, { once: true });
      timer = setTimeout(() => { if (!ended) { expired = true; void stop(); } }, 55000);
      if (request.signal.aborted) void stop();
      if (ended) return endedResponse();
      while (id && this.streamStops.has(id))
        await setup(() => this.streamStops.get(id)!());
      if (id && this.closedStreams.has(id))
        return new Response(null, { status: 204 });
      if (this.activeStreams >= 3)
        return Response.json({ error: 'Too many open chats. Close another chat and retry loading history.' }, { status: 429 });
      this.activeStreams++;
      reserved = true;
      if (id) this.streamStops.set(id, stop);
      const source = await setup(async () => {
        events = await this.harness.session(sid).events();
        // The setup race may already have returned 204. Own and dispose the
        // late source without reserving a slot again or awaiting it in the HTTP path.
        if (ended) void stopSource();
        return events;
      });
      let projection: ChatProjection | undefined = new ChatProjection();
      projection.apply(await setup(() => fullHistorySnapshot(this.harness,sid,source.snapshot,lifetime.signal)));
      const title = await setup(() => this.chatCatalog.title(sid, undefined, lifetime.signal));
      if (ended) return endedResponse();
      const encoder = new TextEncoder();
      // Keep one encoded frame in the readable queue. Further batches update
      // only the projection and this flag, without copying/encoding history.
      let dirty = true;
      flush = () => {
        if (!controller || !projection) return;
        if (dirty && controller.desiredSize! > 0) {
          controller.enqueue(
            encoder.encode(`data: ${JSON.stringify(this.frame(projection, title))}\n\n`),
          );
          dirty = false;
        }
        // Release the lease/source immediately on stop, but let a reader drain
        // the initial frame and latest state even after close or lease expiry.
        if (ended && !dirty) {
          controller.close();
          controller = undefined;
          projection = undefined;
        }
      };
      const body = new ReadableStream<Uint8Array>({
        start: (c) => {
          controller = c;
          flush();
          void source.closed?.then(async end => {
            if (ended) return;
            if (end.reason === 'session_failed') {
              projection!.sessionFailed();
              dirty = true;
            }
            await stop();
          }).catch(error => {
            logTechnicalError('request', error, crypto.randomUUID());
            void stop();
          });
          if (!ended) source.start(async (batch) => {
            try {
              for (const event of batch) {
                if (ended) return;
                const next = event.type === 'snapshot'
                  ? await fullHistorySnapshot(this.harness, sid, event, lifetime.signal)
                  : event;
                if (ended) return;
                projection!.apply(next);
                dirty = true;
              }
              flush();
            } catch (error) {
              if (!ended) throw error;
            }
          });
        },
        pull: () => flush(),
        cancel: () => {
          dirty = false;
          projection = undefined;
          controller = undefined;
          return stop();
        },
      }, { highWaterMark: 1 });
      const response = new Response(body, {
        headers: {
          "Content-Type": "text/event-stream",
          "Cache-Control": "no-store",
        },
      });
      streaming = true;
      return response;
    } catch (error) {
      if (ended) return endedResponse();
      throw error;
    } finally {
      // Do not hold an aborted setup response open for uncooperative cleanup.
      // stopSource observes errors and runs once even if the source arrives late.
      if (!streaming) void stop();
    }
  }
}
