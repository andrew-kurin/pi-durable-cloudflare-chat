import { createRemoteJWKSet, jwtVerify, type JWTVerifyGetKey } from 'jose';
export interface AccessConfig { ACCESS_TEAM_DOMAIN: string; ACCESS_AUD: string; OWNER_EMAIL: string; APP_ORIGIN: string }
const keys = new Map<string, JWTVerifyGetKey>();
export async function authorize(request: Request, env: AccessConfig, testKey?: JWTVerifyGetKey) {
  if (!env.ACCESS_AUD || !env.OWNER_EMAIL || !/^https:\/\/[a-z0-9-]+\.cloudflareaccess\.com$/.test(env.ACCESS_TEAM_DOMAIN) || !env.APP_ORIGIN) throw new Error('unconfigured');
  const url = new URL(request.url);
  if (url.origin !== env.APP_ORIGIN) throw new Error('origin');
  if (!['GET', 'HEAD'].includes(request.method) && (request.headers.get('origin') !== env.APP_ORIGIN || request.headers.get('content-type') !== 'application/json')) throw new Error('csrf');
  const token = request.headers.get('Cf-Access-Jwt-Assertion');
  if (!token) throw new Error('unauthorized');
  let key = testKey ?? keys.get(env.ACCESS_TEAM_DOMAIN);
  if (!key) { key = createRemoteJWKSet(new URL(env.ACCESS_TEAM_DOMAIN + '/cdn-cgi/access/certs')); keys.set(env.ACCESS_TEAM_DOMAIN, key); }
  const {payload} = await jwtVerify(token, key, {issuer: env.ACCESS_TEAM_DOMAIN, audience: env.ACCESS_AUD, algorithms: ['RS256'], requiredClaims: ['exp', 'iat', 'sub', 'email']});
  if (typeof payload.email !== 'string' || payload.email.toLowerCase() !== env.OWNER_EMAIL.toLowerCase()) throw new Error('forbidden');
  return {email: payload.email};
}
export function secured(response: Response) {
 const headers = new Headers(response.headers);
 headers.set('Cache-Control', 'no-store'); headers.set('X-Content-Type-Options','nosniff'); headers.set('Referrer-Policy','no-referrer');
 headers.set('Content-Security-Policy', "default-src 'self'; script-src 'self'; style-src 'self'; connect-src 'self'; img-src 'self' data:; frame-ancestors 'none'; base-uri 'none'; form-action 'self'");
 return new Response(response.body,{status:response.status,headers});
}
