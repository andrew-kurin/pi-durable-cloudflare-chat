/** Prepared entrypoint only. No default config, OAuth flow or public listener.
 * Must be started separately from the approved fake service after activation review. */
import {execFileSync} from 'node:child_process';
import { isAbsolute, join, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createRemoteJWKSet } from 'jose';
import { MAX_REQUEST_BYTES, transportKey } from '../../src/model-runner-protocol';
import { createRunnerServer } from './http';
import { fileRoundJournal } from './journal';
import { createSiwcRunner } from './live-runner';
import { openSiwcOwner, protectedDirectory, readProtected } from './siwc-owner';
import { SIWC } from './siwc-auth';
export async function startLiveServer(configPath: string) {
  if (!isAbsolute(configPath)) throw Error('Absolute protected config path required');
  let c: any;
  try { c = JSON.parse(await readProtected(configPath)); } catch { throw Error('Invalid protected runner configuration'); }
  if (c.eligibility !== 'confirmed-for-this-deployment' || !Number.isInteger(c.port) || c.port < 1024 || c.port > 65535 || !c.identity?.clientId || !c.identity?.subject || !/^urn:uuid:[a-f0-9-]{36}$/i.test(c.identity?.hostId ?? '')) throw Error('Reviewed deployment configuration required');
  const checkout = resolve(fileURLToPath(new URL('../..', import.meta.url)));
  for (const p of [configPath, c.credentialPath, c.transportKeyPath, c.stateDirectory]) {
    if (typeof p !== 'string' || !isAbsolute(p) || resolve(p) === checkout || resolve(p).startsWith(checkout + sep)) throw Error('Live state must be outside checkout');
  }
  await protectedDirectory(c.stateDirectory);
  const keyText = (await readProtected(c.transportKeyPath, 129)).trim();
  if (!/^[a-f0-9]{64}$/.test(keyText)) throw Error('Protected 32-byte hex transport key required');
  const key = await transportKey(Uint8Array.from(keyText.match(/../g)!, (x: string) => parseInt(x, 16)));
  const owner = await openSiwcOwner({ path: c.credentialPath, expected: c.identity, fetch: globalThis.fetch, keys: createRemoteJWKSet(new URL(SIWC.jwks)) });
  let journal: Awaited<ReturnType<typeof fileRoundJournal>> | undefined;
  try {
    const journalPath = join(c.stateDirectory, 'rounds.jsonl');
    try { await readProtected(journalPath, 2000000); } catch (e: any) { if (e.code !== 'ENOENT') throw e; }
    journal = await fileRoundJournal(journalPath);
    let version:string|undefined;try{const sha=execFileSync('git',['-C',checkout,'rev-parse','HEAD'],{encoding:'utf8',timeout:2000}).trim();if(/^[a-f0-9]{40}$/.test(sha))version=sha;}catch{}
    const server = createRunnerServer(createSiwcRunner({ key, journal, version, credentials: owner, fetch: globalThis.fetch, diagnostic: record=>console.info(JSON.stringify(record)) }));
    server.headersTimeout = 10000; server.requestTimeout = 15000;
    await new Promise<void>((ok, fail) => { server.once('error', fail); server.listen(c.port, '127.0.0.1', () => { server.off('error', fail); ok(); }); });
    console.info(JSON.stringify({event:'pi_runner_service',phase:'started',runnerVersion:version,maxRequestBytes:MAX_REQUEST_BYTES}));
    let stopped = false;
    return { server, async close() { if (stopped) return; stopped = true; server.closeAllConnections(); await new Promise<void>(ok => server.close(() => ok())); await journal!.close(); await owner.close(); } };
  } catch (error) { await journal?.close(); await owner.close(); throw error; }
}
if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const path = process.argv[2];
  if (!path) throw Error('Usage: live-server.ts /absolute/protected/config.json');
  const service = await startLiveServer(path);
  for (const signal of ['SIGINT', 'SIGTERM'] as const) process.once(signal, () => { void service.close().then(() => process.exit(0)); });
}
