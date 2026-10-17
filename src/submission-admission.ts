import { RequestError } from "./http-input";
export interface SubmissionInput {
  sessionId: string;
  operationId: string;
  text: string;
}
export const submissionCancelKey = (sessionId: string) => `submission-cancel:${sessionId}`;
const cancelled = () => new RequestError(409, "Submission cancelled. Send again to start a new message.", "submission_cancelled");
type Store = Pick<DurableObjectStorage, "get" | "put" | "transaction">;
/** Owns the exact-text binding, attempt quota and receipt journal.
 * Inputs are validated by the HTTP edge. Callers retain the Assistant POST queue:
 * this module adds no second queue and relies on SDK request-ID deduplication
 * when an accepted submission has no saved app receipt yet.
 */
export class SubmissionAdmission<Receipt = unknown> {
  constructor(
    private store: Store,
    private isBusy: () => Promise<boolean>,
    private dispatch: (input: SubmissionInput) => Promise<Receipt>,
    private abort: (input: SubmissionInput) => Promise<unknown> = async () => {},
    private ready: (input: SubmissionInput) => Promise<void> = async () => {},
  ) {}
  async submit(input: SubmissionInput, epoch?: string): Promise<Receipt> {
    const { sessionId, operationId, text } = input;
    const key = `admission:${sessionId}:${operationId}`;
    const digest = Array.from(
      new Uint8Array(
        await crypto.subtle.digest("SHA-256", new TextEncoder().encode(text)),
      ),
    ).map((x) => x.toString(16).padStart(2, "0")).join("");
    const prior = await this.store.get<{ digest: string; receipt?: Receipt; epoch?: string }>(key);
    if (prior && prior.digest !== digest)
      throw new RequestError(409, "Operation ID already used");
    if (prior?.receipt) return prior.receipt;
    const reservedEpoch = prior ? prior.epoch : epoch;
    let dispatchStarted = false;
    const checkCancellation = async () => {
      if (await this.store.get<string>(submissionCancelKey(sessionId)) !== reservedEpoch) {
        // Bind even a queued, not-yet-reserved operation to its old epoch.
        // A retry with the same ID must not resurrect cancelled intent.
        if (!prior) await this.store.put(key, { digest, epoch: reservedEpoch });
        // Only this live dispatch needs late-acceptance cleanup. Replaying an old
        // cancelled ID must never abort a newer intentional submission.
        if (dispatchStarted) await this.abort(input);
        throw cancelled();
      }
    };
    await checkCancellation();
    if (!prior) {
      if (await this.isBusy())
        throw new RequestError(409, "Wait for the current request to finish");
      const reserved = await this.store.transaction(async (tx) => {
        if (await tx.get<string>(submissionCancelKey(sessionId)) !== reservedEpoch) {
          await tx.put(key, { digest, epoch: reservedEpoch });
          return "cancelled";
        }
        const today = new Date().toISOString().slice(0, 10);
        const daily = await tx.get<{ day: string; count: number }>("quota");
        const count = daily?.day === today ? daily.count : 0;
        if (count >= 50) return false;
        await tx.put("quota", { day: today, count: count + 1 });
        await tx.put(key, { digest, epoch: reservedEpoch });
        return true;
      });
      if (reserved === "cancelled") throw cancelled();
      if (!reserved)
        throw new RequestError(429, "Daily limit of 50 messages reached");
    }
    // A session-wide Stop may still be reaching the SDK. New intent must wait
    // for it, then recheck its generation before entering dispatch.
    await this.ready(input);
    await checkCancellation();
    dispatchStarted = true;
    let receipt: Receipt;
    try { receipt = await this.dispatch(input); }
    catch (error) { await checkCancellation(); throw error; }
    await checkCancellation();
    await this.store.put(key, { digest, receipt, epoch: reservedEpoch });
    return receipt;
  }
}
