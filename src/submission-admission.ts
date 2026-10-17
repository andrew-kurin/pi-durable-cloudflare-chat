import { RequestError } from "./http-input";
export interface SubmissionInput {
  sessionId: string;
  operationId: string;
  text: string;
}
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
  ) {}
  async submit(input: SubmissionInput): Promise<Receipt> {
    const { sessionId, operationId, text } = input;
    const key = `admission:${sessionId}:${operationId}`;
    const digest = Array.from(
      new Uint8Array(
        await crypto.subtle.digest("SHA-256", new TextEncoder().encode(text)),
      ),
    ).map((x) => x.toString(16).padStart(2, "0")).join("");
    const prior = await this.store.get<{ digest: string; receipt?: Receipt }>(key);
    if (prior && prior.digest !== digest)
      throw new RequestError(409, "Operation ID already used");
    if (prior?.receipt) return prior.receipt;
    if (!prior) {
      if (await this.isBusy())
        throw new RequestError(409, "Wait for the current request to finish");
      const reserved = await this.store.transaction(async (tx) => {
        const today = new Date().toISOString().slice(0, 10);
        const daily = await tx.get<{ day: string; count: number }>("quota");
        const count = daily?.day === today ? daily.count : 0;
        if (count >= 50) return false;
        await tx.put("quota", { day: today, count: count + 1 });
        await tx.put(key, { digest });
        return true;
      });
      if (!reserved)
        throw new RequestError(429, "Daily limit of 50 messages reached");
    }
    const receipt = await this.dispatch(input);
    await this.store.put(key, { digest, receipt });
    return receipt;
  }
}
