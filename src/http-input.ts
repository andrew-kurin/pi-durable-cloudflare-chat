/** Expected client failures stay separate from unexpected durable/provider failures. */
export class RequestError extends Error {
  constructor(
    readonly status: number,
    message: string,
    readonly code?: "submission_cancelled",
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
/** Finish body framing before replying on routes that do not use a payload.
 * workerd closes HTTP/1 connections with unread request bodies. A following
 * request can otherwise race that close in the local runtime's client pool.
 * Discard incrementally so an ignored payload cannot require unbounded memory.
 */
export async function discardBody(request: Request, maxBytes = 20000): Promise<void> {
  const reader = request.body?.getReader();
  if (!reader) return;
  let bytes = 0;
  try {
    while (true) {
      const part = await reader.read();
      if (part.done) return;
      bytes += part.value.byteLength;
      if (bytes > maxBytes) {
        await reader.cancel();
        throw new RequestError(413, "Request body too large");
      }
    }
  } finally {
    reader.releaseLock();
  }
}
