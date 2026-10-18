import { createRunnerServer } from './http';
import { mkdir } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { createOfflineRunner, serializedCredentials } from './core';
import { fakeBackend } from './fake-backend';
import { fileRoundJournal } from './journal';
// Loopback-only, fake-only. No flags/env options that enable real inference.
const state = new URL('../../.runtime/model-runner/', import.meta.url);
await mkdir(state, { recursive: true, mode: 0o700 });
const journal = await fileRoundJournal(fileURLToPath(new URL('rounds.jsonl', state)));
let credential = { access: 'FAKE-OFFLINE-ONLY', expires: Date.now() + 3600000 };
const credentials = serializedCredentials({ read: async () => credential, write: async value => { credential = value; } }, async () => ({ access: 'FAKE-OFFLINE-ONLY', expires: Date.now() + 3600000 }));
const runner = createOfflineRunner({ journal, credentials, backend: fakeBackend });
const server = createRunnerServer(runner);
server.listen(4319, '127.0.0.1', () => console.log('Offline fake model runner: http://127.0.0.1:4319 (contract v1)'));
const shutdown = () => { server.closeAllConnections(); server.close(() => { void journal.close(); }); };
process.once('SIGINT', shutdown); process.once('SIGTERM', shutdown);
