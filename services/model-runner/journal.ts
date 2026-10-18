import { open, readFile } from 'node:fs/promises';
import { MemoryRoundJournal, type RoundJournal } from './core';
/** Dispatch fence only, not a second conversation/orchestration database.
 * One process owns a file. Corruption fails startup; never prune live IDs. */
export async function fileRoundJournal(path: string): Promise<RoundJournal & { close(): Promise<void> }> {
  const memory = new MemoryRoundJournal();
  const handle = await open(path, 'a+', 0o600);
  try {
    for (const line of (await readFile(path, 'utf8')).split('\n').filter(Boolean)) {
      const record = JSON.parse(line);
      if (!/^[a-zA-Z0-9_-]{8,80}$/.test(record.id) || !/^[a-f0-9]{64}$/.test(record.fingerprint)) throw Error('Invalid journal');
      await memory.reserve(record.id, record.fingerprint);
    }
  } catch (error) { await handle.close(); throw error; }
  let writes = Promise.resolve();
  return {
    async reserve(id, fingerprint) {
      const status = await memory.reserve(id, fingerprint);
      if (status === 'new') {
        // Failed persistence leaves the in-memory ID fenced; never dispatch.
        const persisted = writes.then(async () => { await handle.write(JSON.stringify({ id, fingerprint }) + '\n'); await handle.sync(); });
        writes = persisted.catch(() => {}); await persisted;
      }
      return status;
    },
    async close() { await writes; await handle.close(); },
  };
}
