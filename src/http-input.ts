/** Expected client failures stay separate from unexpected durable/provider failures. */
export class RequestError extends Error {
  constructor(
    readonly status: number,
    message: string,
    readonly code?: "submission_cancelled" | "maintenance_paused",
  ) {
    super(message);
  }
}
export function jsonObject(raw: string): Record<string, unknown> {
  let value: unknown;
  try {
    value = JSON.parse(raw);
  } catch {
    throw new RequestError(400, "Invalid JSON object");
  }
  if (!value || typeof value !== "object" || Array.isArray(value))
    throw new RequestError(400, "Invalid JSON object");
  return value as Record<string, unknown>;
}

export const BODY_READ_TIMEOUT_MS = 10000;
interface BodyReadOptions {
  timeoutMs?: number;
  maxBytes?: number;
  status?: number;
  message?: string;
}

/** Read one bounded request body. Cancellation ends the HTTP work even when the
 * underlying source never settles its read/cancel promises. Never retain a
 * chunk above the byte budget or wait for source cleanup before releasing it.
 */
async function consumeBody(
  request: Request,
  maxBytes: number,
  consume: (chunk: Uint8Array) => void,
  options: BodyReadOptions,
): Promise<void> {
  const reader = request.body?.getReader();
  const cancelled = () => new RequestError(408, "Request body cancelled");
  if (!reader) {
    if (request.signal.aborted) throw cancelled();
    return;
  }
  let complete = false, disposed = false, failure: unknown;
  let rejectStopped!: (error: unknown) => void;
  const stopped = new Promise<never>((_, reject) => { rejectStopped = reject; });
  // A pre-aborted request can end before the first read races this promise.
  void stopped.catch(() => {});
  const dispose = () => {
    if (disposed) return;
    disposed = true;
    void reader.cancel().catch(() => {});
  };
  const stop = (error: unknown) => {
    if (failure !== undefined) return;
    failure = error;
    rejectStopped(error);
    dispose();
  };
  const abort = () => stop(cancelled());
  const timer = setTimeout(
    () => stop(new RequestError(408, "Request body timed out")),
    options.timeoutMs ?? BODY_READ_TIMEOUT_MS,
  );
  request.signal.addEventListener("abort", abort, { once: true });
  try {
    if (request.signal.aborted) abort();
    let bytes = 0;
    while (true) {
      if (failure !== undefined) throw failure;
      const part = await Promise.race([reader.read(), stopped]);
      if (failure !== undefined) throw failure;
      if (part.done) { complete = true; return; }
      bytes += part.value.byteLength;
      if (bytes > maxBytes)
        throw new RequestError(options.status ?? 413, options.message ?? "Request body too large");
      consume(part.value);
    }
  } finally {
    clearTimeout(timer);
    request.signal.removeEventListener("abort", abort);
    if (!complete) dispose();
    reader.releaseLock();
  }
}

/** Preserve each route's existing UTF-16 character limit while bounding bytes
 * before decoding. Three UTF-8 bytes per code unit accepts all previously valid
 * Unicode strings (plus an optional UTF-8 BOM); surrogate pairs require only
 * four bytes for two units.
 */
export async function readBodyText(request: Request, maxCharacters: number, options: BodyReadOptions = {}): Promise<string> {
  const decoder = new TextDecoder();
  let text = "";
  const append = (value: string) => {
    if (text.length + value.length > maxCharacters)
      throw new RequestError(options.status ?? 413, options.message ?? "Request body too large");
    text += value;
  };
  await consumeBody(request, options.maxBytes ?? maxCharacters * 3 + 3, chunk => append(decoder.decode(chunk, { stream: true })), options);
  append(decoder.decode());
  return text;
}
/** Finish body framing before replying on routes that do not use a payload.
 * workerd closes HTTP/1 connections with unread request bodies. A following
 * request can otherwise race that close in the local runtime's client pool.
 * Discard incrementally so an ignored payload cannot require unbounded memory.
 */
export async function discardBody(request: Request, maxBytes = 20000, options: BodyReadOptions = {}): Promise<void> {
  await consumeBody(request, maxBytes, () => {}, options);
}
