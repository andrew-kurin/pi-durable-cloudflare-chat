import type { PiHarness } from "agents/harness/pi";
import type { ChatCatalog } from "./chat-catalog";
import { ChatProjection } from "./projector";
import { conversationTitle } from "./conversation-title";
import {
  diagnoseSavedErrorRead,
  logSavedFailure,
  logTechnicalError,
} from "./error-log";
/** Owns history leases and close-before-open races, never model admission.
 * A lease releases exactly once on setup failure, cancellation, abort or expiry.
 */
export class HistoryFeed {
  private activeStreams = 0;
  private streamStops = new Map<string, () => Promise<void>>();
  private closedStreams = new Map<string, number>();
  constructor(
    private harness: Pick<PiHarness, "session">,
    private storage: DurableObjectStorage,
    private chatCatalog: Pick<ChatCatalog, "title">,
  ) {}
  private frame(
    projection: ChatProjection,
    title: string | undefined,
    diagnostic?: Awaited<ReturnType<typeof diagnoseSavedErrorRead>>,
  ) {
    return {
      ...projection.view(),
      historyProtocol: 2,
      ...(diagnostic ? { diagnostic } : {}),
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
      projection.apply(events.snapshot);
      const diagnostic =
        url.searchParams.get("diagnostic") === "saved-error"
          ? await diagnoseSavedErrorRead(
              url,
              events.snapshot.entries,
              this.storage,
              sid,
            )
          : undefined;
      const title = await this.chatCatalog.title(sid);
      return Response.json(this.frame(projection, title, diagnostic), {
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
      try {
        controller?.close();
      } catch {}
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
      const projection = new ChatProjection();
      projection.apply(events.snapshot);
      const diagnostic =
        url.searchParams.get("diagnostic") === "saved-error"
          ? await diagnoseSavedErrorRead(
              url,
              events.snapshot.entries,
              this.storage,
              sid,
            )
          : undefined;
      const title = await this.chatCatalog.title(sid);
      if (ended) return new Response(null, { status: 204 });
      const encoder = new TextEncoder();
      const source = events;
      const body = new ReadableStream<Uint8Array>({
        start: (c) => {
          controller = c;
          const send = () => {
            if (!ended)
              controller!.enqueue(
                encoder.encode(
                  `data: ${JSON.stringify(this.frame(projection, title, diagnostic))}\n\n`,
                ),
              );
          };
          send();
          source.start(async (batch) => {
            batch.forEach((e) => projection.apply(e));
            const entries = batch.flatMap((e) =>
              e.type === "message_end" || e.type === "entry_appended"
                ? [e.entry]
                : [],
            );
            if (entries.length)
              await logSavedFailure(entries, this.storage, sid, "live-v1");
            send();
          });
          timer = setTimeout(() => {
            void stop();
          }, 55000);
          request.signal.addEventListener("abort", onAbort, { once: true });
          if (request.signal.aborted) void stop();
        },
        cancel: () => stop(),
      });
      return new Response(body, {
        headers: {
          "Content-Type": "text/event-stream",
          "Cache-Control": "no-store",
          ...(diagnostic
            ? { "X-Pi-Diagnostic-Outcome": diagnostic.outcome }
            : {}),
        },
      });
    } catch (error) {
      await stop();
      throw error;
    }
  }
}
