import { resumeSiwcAfterCatalog } from './siwc-resume';
/** Owner-operated local CLI. Default --plan is inert; privileged actions require
 * explicit flags AFTER action-time approval. Never import this from the Worker. */
import { createServer } from 'node:http';
import { mkdir, readFile, writeFile, rename, lstat } from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import { createLocalJWKSet } from 'jose';
import { SIWC, prepareSiwc, type LocalSiwcCredential } from './siwc-auth';
import { readSiwcCatalog } from './siwc-catalog';
import { runLocalSiwcCheck } from './siwc-check';
import { fileRoundJournal } from './journal';
const plan = { mode: 'local-personal-OSS-only; hosted hybrid eligibility unresolved', name: SIWC.name, issuer: SIWC.issuer, scope: SIWC.scopes, resource: SIWC.resource, callback: 'http://127.0.0.1:<ephemeral-port>/auth/callback', registration: 'dynamic_agent_client initially; retain issued client ID', persistence: '.runtime/local-siwc/credentials.json (0600), stable host ID; tokens stay on this Mac', billing: 'ChatGPT plan only; no API-key fallback or paid credits opt-in', diagnostic: 'one catalog GET, at most 2 Sol 6.1 requests + 1 Luna 6 request; no refresh/retries; unavailable models skipped' };
const action = process.argv[2] ?? '--plan';
if (action === '--plan') console.log(JSON.stringify(plan, null, 2));
else if ((action !== '--sign-in' || process.argv[3] !== '--approved-local-oauth') && (action !== '--check' || process.argv[3] !== '--approved-local-check') && (action !== '--catalog' || process.argv[3] !== '--approved-catalog-read') && (action !== '--resume-catalog-failure' || process.argv[3] !== '--approved-local-check')) { console.error('Explicit action-time approval required. Use --plan first.'); process.exitCode = 1; }
else {
 const dir = new URL('../../.runtime/local-siwc/', import.meta.url), credentialPath = new URL('credentials.json', dir);
 const protectedRead = async (path: URL) => { const stat = await lstat(path); if (!stat.isFile() || stat.isSymbolicLink() || (stat.mode & 0o077) || stat.uid !== process.getuid?.()) throw Error('Unsafe local credential file'); return JSON.parse(await readFile(path, 'utf8')); };
 const save = async (path: URL, value: unknown) => { const temp = new URL(randomUUID()+'.tmp', dir); await writeFile(temp, JSON.stringify(value), { flag: 'wx', mode: 0o600 }); await rename(temp, path); };
 try {
  if (action === '--sign-in') {
   await mkdir(dir, { recursive: true, mode: 0o700 }); const ds = await lstat(dir); if (!ds.isDirectory() || ds.isSymbolicLink() || (ds.mode & 0o077)) throw Error('Unsafe state directory');
   let host: string; try { host = (await protectedRead(new URL('host.json', dir))).host; } catch (error: any) { if (error.code !== 'ENOENT') throw error; host = 'urn:uuid:'+randomUUID(); await save(new URL('host.json', dir), { host }); }
   let saved: LocalSiwcCredential | undefined; try { saved = await protectedRead(credentialPath); } catch (error: any) { if (error.code !== 'ENOENT') throw error; }
   const controller = new AbortController(), timeout = setTimeout(() => controller.abort(), 600000);
   let pending: ReturnType<typeof prepareSiwc>;
   let resolve!: (value: ReturnType<ReturnType<typeof prepareSiwc>['exchange']>) => void, reject!: (error: Error) => void;
   const callback = new Promise<ReturnType<ReturnType<typeof prepareSiwc>['exchange']>>((ok, fail) => { resolve = ok; reject = fail; });
   const server = createServer((req, res) => { try { if (req.method !== 'GET' || !req.url?.startsWith('/auth/callback?')) { res.writeHead(404).end(); return; } const exchange = pending.exchange(new URL(req.url, pending.redirect).href); res.writeHead(200, { 'content-type': 'text/plain', 'cache-control': 'no-store' }).end('Local callback received. Return to the terminal.'); resolve(exchange); } catch (error) { res.writeHead(400).end('Local sign-in was not completed.'); if (error instanceof Error && ['Authorization declined','Invalid registration callback'].includes(error.message)) reject(Error('Callback rejected')); } });
   controller.signal.addEventListener('abort', () => reject(Error('Sign-in expired')), { once: true });
   try {
    await new Promise<void>((ok, fail) => { server.once('error', fail); server.listen(0, '127.0.0.1', ok); });
    pending = prepareSiwc(host, (server.address() as import('node:net').AddressInfo).port, saved);
    // Authorization URL contains no token/code; callback URLs must never be printed.
    console.log('Continue with ChatGPT in your Mac browser. Decline any paid-credit option.\n'+pending.url);
    const exchange = await callback;
    const response = await fetch(SIWC.token, { method: 'POST', redirect: 'error', headers: { 'content-type': 'application/x-www-form-urlencoded' }, body: exchange.body, signal: controller.signal });
    if (!response.ok) { await response.body?.cancel(); throw Error('Token exchange rejected'); }
    const tokens = await response.json();
    const keysResponse = await fetch(SIWC.jwks, { redirect: 'error', signal: controller.signal }); if (!keysResponse.ok) throw Error('JWKS unavailable');
    const record = await pending.validate(tokens, exchange.clientId, createLocalJWKSet(await keysResponse.json()));
    await save(credentialPath, record); console.log('Local SIWC identity and consent validated; protected credentials saved. No inference was run.');
   } finally { clearTimeout(timeout); controller.abort(); server.closeAllConnections(); await new Promise<void>(ok => server.close(() => ok())); }
  } else {
   const ds = await lstat(dir); if (!ds.isDirectory() || ds.isSymbolicLink() || (ds.mode & 0o077)) throw Error('Unsafe state directory');
   const credential = await protectedRead(credentialPath) as LocalSiwcCredential;
   if(action==='--resume-catalog-failure'){const catalog=await protectedRead(new URL('catalog-evidence.json',dir)), prior=await protectedRead(new URL('catalog-evidence-256k.json',dir));if(prior.status!==200||prior.bytesRead!==262144||!prior.bodyTruncated||catalog.bytesRead<=262144)throw Error('Catalog truncation recovery evidence missing');const report=await resumeSiwcAfterCatalog(dir,credential,catalog,fetch,{phase:'catalog-before-inference',previousInferenceRequests:0,originalCode:'919ad939088e8e02e707ea0010ec70c38c860bc3',reason:'Explicitly directed recovery: original 256KiB catalog reader failed before inference loop; reproduced by archived catalog evidence; corrected complete catalog exceeds old cap.'});console.log(JSON.stringify(report,null,2));} else if (action === '--catalog') { const report = await readSiwcCatalog(credential, fetch); await save(new URL('catalog-evidence.json', dir), report); console.log(JSON.stringify(report,null,2)); } else {
   const journal = await fileRoundJournal(new URL('diagnostic-rounds.jsonl', dir).pathname);
   try { const report = await runLocalSiwcCheck(credential, fetch, journal, true); await save(new URL('report.json', dir), report); console.log(JSON.stringify(report, null, 2)); } finally { await journal.close(); }
   }
  }
 } catch { console.error('Local SIWC action stopped. No raw OAuth/token/provider details are printed. Check consent, selected account and local file permissions before any separately approved retry.'); process.exitCode = 1; }
}
