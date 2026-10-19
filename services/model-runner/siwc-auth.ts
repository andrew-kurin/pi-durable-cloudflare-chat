import { createHash, randomBytes } from 'node:crypto';
import { jwtVerify, type JWTVerifyGetKey } from 'jose';
export const SIWC = { issuer: 'https://auth.openai.com', authorize: 'https://auth.openai.com/api/accounts/authorize', token: 'https://auth.openai.com/api/accounts/oauth/token', jwks: 'https://auth.openai.com/.well-known/jwks.json', resource: 'https://api.openai.com/v1', scopes: 'openid profile email offline_access resource.invoke chatgpt.tokens.use.direct', name: 'pi-durable-cloudflare-chat' } as const;
export interface LocalSiwcCredential { clientId: string; subject: string; hostId: string; idToken: string; access: string; refresh: string; expires: number; scopes: string[] }
/** Pure protocol preparation: no listener, browser, network or persistence. */
export function prepareSiwc(hostId: string, port: number, saved?: LocalSiwcCredential) {
 if (!/^urn:uuid:[a-f0-9-]{36}$/i.test(hostId) || !Number.isInteger(port) || port < 1024 || port > 65535) throw Error('Invalid local host');
 if (saved && (saved.hostId !== hostId || !saved.clientId || saved.clientId === 'dynamic_agent_client')) throw Error('Invalid saved registration');
 const state = randomBytes(32).toString('base64url'), nonce = randomBytes(32).toString('base64url'), verifier = randomBytes(48).toString('base64url');
 const redirect = `http://127.0.0.1:${port}/auth/callback`, issued = saved?.clientId;
 const url = new URL(SIWC.authorize); url.search = new URLSearchParams({ client_id: issued ?? 'dynamic_agent_client', ...(!issued ? { agent_name_hint: SIWC.name } : {}), ext_agent_host_id: hostId, response_type: 'code', redirect_uri: redirect, scope: SIWC.scopes, resource: SIWC.resource, state, nonce, code_challenge_method: 'S256', code_challenge: createHash('sha256').update(verifier).digest('base64url') }).toString();
 let consumed = false, validated = false; let expectedClient: string | undefined; const expires = Date.now() + 600000;
 return { url: url.href, redirect,
  exchange(callback: string) {
   if (consumed || Date.now() > expires) throw Error('Attempt expired or consumed');
   const returned = new URL(callback);
   if (returned.origin !== new URL(redirect).origin || returned.pathname !== '/auth/callback' || returned.searchParams.getAll('state').length !== 1 || returned.searchParams.get('state') !== state) throw Error('Invalid callback');
   consumed = true;
   if (returned.searchParams.has('error')) throw Error('Authorization declined');
   const clientId = returned.searchParams.get('client_id') ?? issued, code = returned.searchParams.get('code');
   if (!clientId || clientId === 'dynamic_agent_client' || (issued && clientId !== issued) || !code || returned.searchParams.getAll('code').length !== 1 || returned.searchParams.getAll('client_id').length > 1) throw Error('Invalid registration callback');
   expectedClient = clientId;
   return { clientId, body: new URLSearchParams({ grant_type: 'authorization_code', client_id: clientId, code, code_verifier: verifier, redirect_uri: redirect, resource: SIWC.resource }) };
  },
  async validate(tokens: unknown, clientId: string, keys: JWTVerifyGetKey): Promise<LocalSiwcCredential> {
   if (!consumed || validated || clientId !== expectedClient) throw Error('Callback not consumed or client mismatch');
   validated = true;
   const t = tokens as Record<string, unknown>;
   if (!t || t.token_type !== 'Bearer' || typeof t.id_token !== 'string' || typeof t.access_token !== 'string' || !t.access_token || t.access_token.startsWith('sk-') || typeof t.refresh_token !== 'string' || !t.refresh_token || typeof t.scope !== 'string' || typeof t.expires_in !== 'number' || !Number.isFinite(t.expires_in) || t.expires_in <= 180) throw Error('Invalid token contract');
   const { payload } = await jwtVerify(t.id_token, keys, { issuer: SIWC.issuer, audience: clientId, requiredClaims: ['sub', 'exp', 'iat'], clockTolerance: 5 });
   if (payload.nonce !== nonce || !payload.sub || (saved && (payload.sub !== saved.subject || clientId !== saved.clientId))) throw Error('Account or nonce mismatch');
   const scopes = t.scope.split(/\s+/); if (!SIWC.scopes.split(' ').every(scope => scopes.includes(scope))) throw Error('Required consent missing');
   return { clientId, subject: payload.sub, hostId, idToken: t.id_token, access: t.access_token, refresh: t.refresh_token, expires: Date.now() + t.expires_in * 1000 - 180000, scopes };
  },
 };
}
