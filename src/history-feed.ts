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
  async snapshot(sid: string, url: URL) {
    const events = await this.harness.session(sid).events();
    try {
      const projection = new ChatProjection();
      projection.apply(await fullHistorySnapshot(this.harness,sid,events.snapshot));
      const title = await this.chatCatalog.title(sid);
      return Response.json(this.frame(projection, title), {
        headers: { "Cache-Control": "no-store" },
      });
    } finally {
      await events.stop();
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
    while (id && this.streamStops.has(id)) await this.streamStops.get(id)!();
    if (id && this.closedStreams.has(id))
      return new Response(null, { status: 204 });
    if (this.activeStreams >= 3)
      return Response.json(
        {
          error:
            "Too many open chats. Close another chat and retry loading history.",
        },
        { status: 429 },
      );
    this.activeStreams++;
    let events:
      | Awaited<ReturnType<ReturnType<typeof this.harness.session>["events"]>>
      | undefined;
    let ended = false;
    let timer: ReturnType<typeof setTimeout> | undefined;
    let controller: ReadableStreamDefaultController<Uint8Array> | undefined;
    let flush = () => {};
    const onAbort = () => {
      void stop();
    };
    const stop = async () => {
      if (ended) return;
      ended = true;
      clearTimeout(timer);
      this.activeStreams--;
      if (id && this.streamStops.get(id) === stop) this.streamStops.delete(id);
      request.signal.removeEventListener("abort", onAbort);
      flush();
      try {
        await events?.stop();
      } catch (error) {
        logTechnicalError("request", error, crypto.randomUUID());
      }
    };
    if (id) this.streamStops.set(id, stop);
    try {
      events = await this.harness.session(sid).events();
      if (ended) {
        await events.stop();
        return new Response(null, { status: 204 });
      }
      let projection: ChatProjection | undefined = new ChatProjection();
      projection.apply(await fullHistorySnapshot(this.harness,sid,events.snapshot));
      const title = await this.chatCatalog.title(sid);
      if (ended) return new Response(null, { status: 204 });
      const encoder = new TextEncoder();
      const source = events;
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
          timer = setTimeout(() => {
            void stop();
          }, 55000);
          request.signal.addEventListener("abort", onAbort, { once: true });
          if (request.signal.aborted) void stop();
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
            for (const event of batch) {
              if (ended) return;
              const next = event.type === 'snapshot'
                ? await fullHistorySnapshot(this.harness, sid, event)
                : event;
              if (ended) return;
              projection!.apply(next);
              dirty = true;
            }
            flush();
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
      return new Response(body, {
        headers: {
          "Content-Type": "text/event-stream",
          "Cache-Control": "no-store",
        },
      });
    } catch (error) {
      await stop();
      throw error;
    }
  }
}
