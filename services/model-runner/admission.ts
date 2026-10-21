import { MAX_REQUEST_BYTES } from '../../src/model-runner-protocol';

export interface RequestAdmissionLimits {
  maxReaders: number;
  /** Aggregate raw-body capacity. Decoding/JSON have bounded expansion too. */
  maxBodyBytes: number;
  readTimeoutMs: number;
}
export const REQUEST_ADMISSION: RequestAdmissionLimits = {
  maxReaders: 4,
  maxBodyBytes: 2 * MAX_REQUEST_BYTES,
  readTimeoutMs: 15000,
};
export class BodyReadError extends Error {}
export function bodyLength(headers: Headers): number | undefined {
  const raw = headers.get('content-length');
  if (raw === null) return;
  if (!/^\d{1,16}$/.test(raw) || !Number.isSafeInteger(Number(raw)) || Number(raw) > MAX_REQUEST_BYTES) throw new BodyReadError('invalid_body');
  return Number(raw);
}
/** Reserve the complete possible body before reading, not just bytes received.
 * Unknown/chunked lengths reserve the full per-request limit. Reservations stay
 * held through authentication, parsing and upstream request preparation.
 * This is admission for that processing phase, not active inference/streaming.
 * This bounds admitted body capacity, not VM/HTTP buffers or exact process RSS.
 */
export class RequestAdmission {
  private readers = 0;
  private bytes = 0;
  readonly limits: RequestAdmissionLimits;
  constructor(limits: Partial<RequestAdmissionLimits> = {}) {
    this.limits = {
      maxReaders: limits.maxReaders ?? REQUEST_ADMISSION.maxReaders,
      maxBodyBytes: limits.maxBodyBytes ?? REQUEST_ADMISSION.maxBodyBytes,
      readTimeoutMs: limits.readTimeoutMs ?? REQUEST_ADMISSION.readTimeoutMs,
    };
    if (Object.values(this.limits).some(n => !Number.isSafeInteger(n) || n <= 0)) throw Error('Invalid request admission limits');
  }
  reserve(length?: number): (() => void) | undefined {
    const capacity = length ?? MAX_REQUEST_BYTES;
    if (this.readers >= this.limits.maxReaders || capacity > this.limits.maxBodyBytes - this.bytes) return;
    this.readers++; this.bytes += capacity;
    let held = true;
    return () => { if (held) { held = false; this.readers--; this.bytes -= capacity; } };
  }
}
export async function readRunnerBody(request: Request, signal: AbortSignal, timeoutMs: number, length?: number, onBytes?: (bytes: number) => void): Promise<string> {
  if (signal.aborted) { void request.body?.cancel().catch(() => {}); throw new BodyReadError('round_cancelled'); }
  const reader = request.body?.getReader();
  if (!reader) throw new BodyReadError('invalid_body');
  let rejectStop!: (error: unknown) => void, failure: BodyReadError | undefined;
  const stopped = new Promise<never>((_, reject) => { rejectStop = reject; });
  void stopped.catch(() => {});
  const stop = (code: string) => { failure ??= new BodyReadError(code); rejectStop(failure); };
  const check = () => { if (signal.aborted) stop('round_cancelled'); if (failure) throw failure; };
  const abort = () => stop('round_cancelled');
  signal.addEventListener('abort', abort, { once: true });
  const timer = setTimeout(() => stop('request_body_timeout'), timeoutMs);
  if (signal.aborted) abort();
  const decoder = new TextDecoder('utf-8', { fatal: true }), parts: string[] = [], small: string[] = [];
  let pending = '';
  let bytes = 0;
  try {
    while (true) {
      check();
      const part = await Promise.race([reader.read(), stopped]);
      check();
      if (part.done) break;
      bytes += part.value.byteLength;
      onBytes?.(bytes);
      if (bytes > MAX_REQUEST_BYTES || (length !== undefined && bytes > length)) throw new BodyReadError('invalid_body');
      small.push(decoder.decode(part.value, { stream: true }));
      // Tiny hostile chunks must not create one retained string per byte.
      if (small.length >= 128 || part.value.byteLength >= 16384) {
        pending += small.join(''); small.length = 0;
        if (pending.length >= 16384) { parts.push(pending); pending = ''; }
      }
    }
    check();
    if (length !== undefined && bytes !== length) throw new BodyReadError('invalid_body');
    parts.push(pending, small.join(''), decoder.decode());
    return parts.join('');
  } finally {
    clearTimeout(timer); signal.removeEventListener('abort', abort);
    // Cancellation settles HTTP/admission even if an underlying cancel stalls.
    void reader.cancel().catch(() => {});
    reader.releaseLock();
  }
}
