import type { PiHarness } from 'agents/harness/pi';
import type { AgentEvent, EntryRecord } from '@earendil-works/pi-durable';
import { BACKGROUND_CONTEXT } from '@earendil-works/chord/context';
type Snapshot = Extract<AgentEvent, { type: 'snapshot' }>;
/** Subscribe first, then scan only through that immutable snapshot's tail.
 * Pi events expose model-active entries; the UI needs fork-aware saved history.
 */
export async function fullHistorySnapshot(
  harness: Pick<PiHarness, 'conversation'>,
  sid: string,
  snapshot: Snapshot,
  signal?: AbortSignal,
): Promise<Snapshot> {
  signal?.throwIfAborted();
  const tail = snapshot.entries.reduce<EntryRecord['id'] | undefined>(
    (max, e) => max === undefined || e.id > max ? e.id : max, undefined,
  );
  if (tail === undefined) return snapshot;
  const conversation = await harness.conversation(sid);
  signal?.throwIfAborted();
  const entries: EntryRecord[] = [];
  let cursor: Parameters<typeof conversation.entries>[2];
  do {
    signal?.throwIfAborted();
    const page = await conversation.entries({ order: 'ascending', maxEntryId: tail }, 256, cursor, BACKGROUND_CONTEXT);
    signal?.throwIfAborted();
    entries.push(...page.items);
    cursor = page.next;
  } while (cursor !== undefined);
  return { ...snapshot, entries };
}
