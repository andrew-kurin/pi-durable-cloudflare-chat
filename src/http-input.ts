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
