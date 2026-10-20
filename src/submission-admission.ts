import { RequestError } from "./http-input";
export interface SubmissionInput {
  sessionId: string;
  operationId: string;
  text: string;
}
const submissionCancelKey = (sessionId: string) => `submission-cancel:${sessionId}`;
const cancelled = () => new RequestError(409, "Submission cancelled. Send again to start a new message.", "submission_cancelled");
type Store = Pick<DurableObjectStorage, "get" | "put" | "transaction">;
export interface SubmissionRuntime<Receipt> {
  isBusy(): Promise<boolean>;
  submit(input: SubmissionInput, intent?: string): Promise<Receipt>;
  captureIntent?(sessionId: string): Promise<string | undefined>;
  abort(input: { sessionId: string; operationId?: string }): Promise<unknown>;
}
export type ArrivedSubmission<Receipt> = (
  message: Pick<SubmissionInput, "operationId" | "text">,
) => Promise<Receipt>;
/** One owner for submission journals and cancellation lifetime.
 * Capture atArrival() before entering the caller's existing mutation queue; invoke
 * its one-shot capability inside that queue. Stop bypasses the queue. Auth,
 * provider gating and title policy stay with the caller. SDK request-ID
 * deduplication still recovers acceptance when app receipt persistence fails.
 */
export class SubmissionAdmission<Receipt = unknown> {
  private stops = new Map<string, Promise<unknown>>();
  constructor(private store: Store, private runtime: SubmissionRuntime<Receipt>) {}
  atArrival(sessionId: string): ArrivedSubmission<Receipt> {
    const epoch = this.store.get<string>(submissionCancelKey(sessionId));
    const intent = this.runtime.captureIntent?.(sessionId);
    void intent?.catch(() => {});
    // A request can wait in the queue or fail validation without consuming this.
    void epoch.catch(() => {});
    let consumed = false;
    return async ({ operationId, text }) => {
      if (consumed) throw new Error("Submission arrival already consumed");
      consumed = true;
      return this.submit({ sessionId, operationId, text }, await epoch, await intent);
    };
  }
  stop(sessionId: string): Promise<unknown> {
    const prior = this.stops.get(sessionId);
    const stop = (async () => {
      await this.store.put(submissionCancelKey(sessionId), crypto.randomUUID());
      await prior?.catch(() => {});
      return this.runtime.abort({ sessionId });
    })().finally(() => {
      if (this.stops.get(sessionId) === stop) this.stops.delete(sessionId);
    });
    this.stops.set(sessionId, stop);
    return stop;
  }
  private async waitForStop(sessionId: string) {
    while (this.stops.has(sessionId)) await this.stops.get(sessionId);
  }
  private async submit(input: SubmissionInput, epoch?: string, intent?: string): Promise<Receipt> {
    const { sessionId, operationId, text } = input;
    const key = `admission:${sessionId}:${operationId}`;
    const digest = Array.from(
      new Uint8Array(
        await crypto.subtle.digest("SHA-256", new TextEncoder().encode(text)),
      ),
    ).map((x) => x.toString(16).padStart(2, "0")).join("");
    const prior = await this.store.get<{ digest: string; receipt?: Receipt; epoch?: string; intent?: string }>(key);
    if (prior && prior.digest !== digest)
      throw new RequestError(409, "Operation ID already used");
    if (prior?.receipt) return prior.receipt;
    const reservedEpoch = prior ? prior.epoch : epoch;
    const reservedIntent = prior ? prior.intent : intent;
    let dispatchStarted = false;
    const checkCancellation = async () => {
      if (await this.store.get<string>(submissionCancelKey(sessionId)) !== reservedEpoch) {
        // Bind even a queued, not-yet-reserved operation to its old epoch.
        // A retry with the same ID must not resurrect cancelled intent.
        if (!prior) await this.store.put(key, { digest, epoch: reservedEpoch, intent: reservedIntent });
        // Only this live dispatch needs late-acceptance cleanup. Replaying an old
        // cancelled ID must never abort a newer intentional submission.
        if (dispatchStarted) await this.runtime.abort(input);
        throw cancelled();
      }
    };
    await checkCancellation();
    if (!prior) {
      if (await this.runtime.isBusy())
        throw new RequestError(409, "Wait for the current request to finish");
      const reserved = await this.store.transaction(async (tx) => {
        if (await tx.get<string>(submissionCancelKey(sessionId)) !== reservedEpoch) {
          await tx.put(key, { digest, epoch: reservedEpoch, intent: reservedIntent });
          return "cancelled";
        }
        const today = new Date().toISOString().slice(0, 10);
        const daily = await tx.get<{ day: string; count: number }>("quota");
        const count = daily?.day === today ? daily.count : 0;
        if (count >= 50) return false;
        await tx.put("quota", { day: today, count: count + 1 });
        await tx.put(key, { digest, epoch: reservedEpoch, intent: reservedIntent });
        return true;
      });
      if (reserved === "cancelled") throw cancelled();
      if (!reserved)
        throw new RequestError(429, "Daily limit of 50 messages reached");
    }
    // A session-wide Stop may still be reaching the SDK. New intent must wait
    // for it, then recheck its generation before entering dispatch.
    await this.waitForStop(sessionId);
    await checkCancellation();
    dispatchStarted = true;
    let receipt: Receipt;
    try { receipt = await this.runtime.submit(input, reservedIntent); }
    catch (error) { await checkCancellation(); throw error; }
    await checkCancellation();
    await this.store.put(key, { digest, receipt, epoch: reservedEpoch, intent: reservedIntent });
    return receipt;
  }
}
