import { constants } from 'node:fs';
import { open, lstat, realpath, rename, unlink } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { randomUUID } from 'node:crypto';
import { jwtVerify, type JWTVerifyGetKey } from 'jose';
import { SIWC, type LocalSiwcCredential } from './siwc-auth';
import { interrupted, RunnerFailure } from './live-runner';
export type OwnedCredential = LocalSiwcCredential & { earliestRefreshAt?: number };
export async function protectedDirectory(path: string) {
  const stat = await lstat(path);
  if (!stat.isDirectory() || stat.isSymbolicLink() || (stat.mode & 0o077) || stat.uid !== process.getuid?.() || await realpath(path) !== resolve(path)) throw Error('Protected directory required');
}
export async function readProtected(path: string, max = 32768): Promise<string> {
  await protectedDirectory(dirname(path));
  const handle = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW);
  try { const stat = await handle.stat(); if (!stat.isFile() || (stat.mode & 0o077) || stat.uid !== process.getuid?.() || stat.size > max || stat.nlink !== 1) throw Error('Protected file required'); return await handle.readFile('utf8'); }
  finally { await handle.close(); }
}
async function syncDirectory(path: string) { const d = await open(path, 'r'); try { await d.sync(); } finally { await d.close(); } }
async function durableNew(path: string, text: string) {
  const h = await open(path, 'wx', 0o600);
  try { await h.writeFile(text); await h.sync(); } finally { await h.close(); }
  await syncDirectory(dirname(path));
}
function validate(value: OwnedCredential, expected: { clientId: string; subject: string; hostId: string }) {
  if (!value || value.clientId !== expected.clientId || value.subject !== expected.subject || value.hostId !== expected.hostId || value.clientId === 'dynamic_agent_client' || !value.idToken || !value.access || value.access.startsWith('sk-') || !value.refresh || !Number.isFinite(value.expires) || !Array.isArray(value.scopes) || !SIWC.scopes.split(' ').every(s => value.scopes.includes(s)) || (value.earliestRefreshAt !== undefined && !Number.isFinite(value.earliestRefreshAt))) throw new RunnerFailure('siwc_credential_invalid');
}
/** One process and one in-flight refresh own this registration. A crash or any
 * ambiguous refresh leaves a durable marker. Never remove that marker on failure.
 * An operator must resolve/re-authorize rather than replay a rotating token. */
export async function openSiwcOwner(options: { path: string; expected: { clientId: string; subject: string; hostId: string }; fetch: typeof fetch; keys: JWTVerifyGetKey; now?: () => number; refreshTimeoutMs?: number }) {
  const { path, expected } = options, dir = dirname(path), lock = path + '.owner', marker = path + '.refreshing';
  await protectedDirectory(dir);
  await durableNew(lock, 'single SIWC owner\n');
  let value: OwnedCredential;
  try {
    // Acquire ownership before reading: a prior owner may have just rotated or
    // left an ambiguous marker. Never act on a pre-lock credential snapshot.
    const text = await readProtected(path);
    try { value = JSON.parse(text) as OwnedCredential; } catch { throw new RunnerFailure('siwc_credential_invalid'); }
    validate(value, expected);
    try { await lstat(marker); throw new RunnerFailure('siwc_refresh_resolution_required'); } catch (e: any) { if (e.code !== 'ENOENT') throw e; }
  } catch (error) { await unlink(lock); await syncDirectory(dir); throw error; }
  let pending: Promise<string> | undefined, closed = false, blocked = false;
  const now = options.now ?? Date.now;
  const access = (): Promise<string> => {
    if (closed) return Promise.reject(new RunnerFailure('siwc_refresh_resolution_required'));
    if (pending) return pending;
    if (blocked) return Promise.reject(new RunnerFailure('siwc_refresh_resolution_required'));
    if (!pending) pending = (async () => {
      if (value.expires > now()) return value.access;
      if (value.earliestRefreshAt && value.earliestRefreshAt > now()) throw new RunnerFailure('siwc_refresh_deferred');
      // Fail closed even when marker persistence itself fails.
      blocked = true; await durableNew(marker, 'refresh may have been dispatched; owner resolution required\n');
      const controller = new AbortController(), timer = setTimeout(() => controller.abort(), options.refreshTimeoutMs ?? 30000);
      try {
        const pendingResponse = options.fetch(SIWC.token, { method: 'POST', redirect: 'error', signal: controller.signal,
          headers: { 'content-type': 'application/x-www-form-urlencoded' },
          body: new URLSearchParams({ grant_type: 'refresh_token', client_id: value.clientId, refresh_token: value.refresh, resource: SIWC.resource }) });
        void pendingResponse.then(r => { if (controller.signal.aborted) void r.body?.cancel().catch(() => {}); }, () => {});
        const response = await interrupted(pendingResponse, controller.signal);
        if (response.status !== 200 || !response.body) { void response.body?.cancel().catch(() => {}); throw Error(); }
        const reader = response.body.getReader(); let text = '', size = 0; const decoder = new TextDecoder('utf-8', { fatal: true });
        try { while (true) { const p = await interrupted(reader.read(), controller.signal); if (p.done) break; size += p.value.length; if (size > 32768) throw Error(); text += decoder.decode(p.value, { stream: true }); } text += decoder.decode(); }
        finally { void reader.cancel().catch(() => {}); }
        const t = JSON.parse(text);
        if (t.token_type !== 'Bearer' || typeof t.access_token !== 'string' || typeof t.refresh_token !== 'string' || typeof t.id_token !== 'string' || typeof t.scope !== 'string' || typeof t.expires_in !== 'number' || !Number.isFinite(t.expires_in) || t.expires_in <= 180 || (t.earliest_refresh_at !== undefined && (typeof t.earliest_refresh_at !== 'number' || !Number.isFinite(t.earliest_refresh_at)))) throw Error();
        const { payload } = await interrupted(jwtVerify(t.id_token, options.keys, { issuer: SIWC.issuer, audience: expected.clientId, requiredClaims: ['sub', 'exp', 'iat'], clockTolerance: 5, currentDate: new Date(now()) }), controller.signal);
        if (payload.sub !== expected.subject) throw Error();
        const next: OwnedCredential = { ...value, access: t.access_token, refresh: t.refresh_token, idToken: t.id_token, expires: now() + t.expires_in * 1000 - 180000, scopes: t.scope.split(/\s+/), earliestRefreshAt: t.earliest_refresh_at === undefined ? undefined : t.earliest_refresh_at * 1000 };
        validate(next, expected);
        const temp = join(dir, '.credential-' + randomUUID());
        try { await durableNew(temp, JSON.stringify(next) + '\n'); await rename(temp, path); await syncDirectory(dir); }
        finally { await unlink(temp).catch(() => {}); }
        // New tokens durable before marker removal or access publication.
        await unlink(marker); await syncDirectory(dir); value = next; blocked = false; return value.access;
      } catch { throw new RunnerFailure('siwc_refresh_resolution_required'); }
      finally { clearTimeout(timer); }
    })().finally(() => { pending = undefined; });
    return pending;
  };
  return { access, async close() { closed = true; await pending?.catch(() => {}); await unlink(lock); await syncDirectory(dir); } };
}
