import type { Harness } from '@earendil-works/pi-durable';

/** Agents 0.28 caches its opened Harness after Pi closes on storage failure.
 * Clear that cache only after closure, at the next request boundary. Never
 * replay the request that failed: its commit/dispatch outcome may be uncertain.
 */
export class HarnessRecovery {
 private current?: Harness;
 private failed = false;
 private disposal?: Promise<void>;
 observe(harness: Harness) {
  this.current = harness;
  this.failed = false;
  void harness.closed.then(end => {
   if (this.current === harness && end.reason === 'failed') this.failed = true;
  });
  return harness;
 }
 async prepare(dispose: () => Promise<void>) {
  if (this.disposal) return this.disposal;
  if (!this.failed) return;
  const failedHarness = this.current;
  this.disposal = dispose().then(() => {
   // A lifecycle job may open the replacement while the old close completes.
   if (this.current === failedHarness) {
    this.current = undefined;
    this.failed = false;
   }
  }).finally(() => { this.disposal = undefined; });
  return this.disposal;
 }
}
