/** Shared Worker/Node contract. No ambient auth, generated IDs, or network calls. */
export const RUNNER_MODELS = ['gpt-6.1-sol', 'gpt-6-luna'] as const;
export const ROUND_ID = /^[a-zA-Z0-9_-]{8,80}$/;
export const RUNNER_PATH = '/v1/responses';
const encoder = new TextEncoder();
export const sha256 = async (body: string) => [...new Uint8Array(await crypto.subtle.digest('SHA-256', encoder.encode(body)))].map(x => x.toString(16).padStart(2, '0')).join('');
export async function transportKey(bytes: Uint8Array): Promise<CryptoKey> {
  if (bytes.byteLength < 32) throw Error('Transport key must contain at least 32 bytes');
  return crypto.subtle.importKey('raw', bytes as Uint8Array<ArrayBuffer>, { name: 'HMAC', hash: 'SHA-256' }, false, ['sign', 'verify']);
}
async function canonical(method: string, path: string, id: string, timestamp: string, body: string) {
  if (method !== 'POST' || path !== RUNNER_PATH || !ROUND_ID.test(id) || !/^\d{10,13}$/.test(timestamp)) throw Error('Invalid signed envelope');
  return encoder.encode(['pi-runner-v1', method, path, timestamp, id, await sha256(body)].join('\n'));
}
export async function signRound(key: CryptoKey, body: string, id: string, now = Date.now()) {
  const timestamp = String(now);
  const signature = [...new Uint8Array(await crypto.subtle.sign('HMAC', key, await canonical('POST', RUNNER_PATH, id, timestamp, body)))].map(x => x.toString(16).padStart(2, '0')).join('');
  return { 'content-type': 'application/json', 'x-pi-round-id': id, 'x-pi-timestamp': timestamp, 'x-pi-signature': signature };
}
export async function verifyRound(key: CryptoKey, request: Request, body: string, now = Date.now()) {
  try {
    const url = new URL(request.url), id = request.headers.get('x-pi-round-id') ?? '', timestamp = request.headers.get('x-pi-timestamp') ?? '', signature = request.headers.get('x-pi-signature') ?? '';
    if (url.search || !/^[a-f0-9]{64}$/.test(signature) || Math.abs(now - Number(timestamp)) > 30000) return false;
    const bytes = Uint8Array.from(signature.match(/../g)!, hex => parseInt(hex, 16));
    return await crypto.subtle.verify('HMAC', key, bytes, await canonical(request.method, url.pathname, id, timestamp, body));
  } catch { return false; }
}
/** Pinned Pi Responses -> documented SIWC subset. Full input retained verbatim.
 * Unsupported tuning/state options are deliberately omitted. No tool execution. */
export function siwcPayload(raw: unknown): Record<string, unknown> {
  const p = raw as Record<string, any>;
  if (!p || !RUNNER_MODELS.includes(p.model) || !Array.isArray(p.input) || p.input.some((x: any) => !x || typeof x !== 'object' || x.role === 'system')) throw Error('Invalid SIWC input');
  const validTool = (t: any): boolean => !!t && (t.type === 'function' || t.type === 'custom') && typeof t.name === 'string' && t.name.length > 0;
  if (p.tools !== undefined && (!Array.isArray(p.tools) || !p.tools.every(validTool))) throw Error('Unsupported SIWC tools');
  for (const item of p.input) if (item.type === 'additional_tools' && (!Array.isArray(item.tools) || !item.tools.every(validTool))) throw Error('Unsupported SIWC tools');
  if (p.tool_choice !== undefined && !['auto', 'none', 'required'].includes(p.tool_choice)) throw Error('Unsupported tool choice');
  if (p.reasoning !== undefined && (typeof p.reasoning !== 'object' || !p.reasoning || Object.keys(p.reasoning).some(k => !['effort', 'summary'].includes(k)))) throw Error('Unsupported reasoning');
  if (p.include !== undefined && (!Array.isArray(p.include) || !p.include.every((x: unknown) => x === 'reasoning.encrypted_content'))) throw Error('Unsupported include');
  return { model: p.model, input: [...(p.tools?.length ? [{ type: 'additional_tools', role: 'developer', tools: p.tools }] : []), ...p.input], store: false, stream: true,
    ...(typeof p.instructions === 'string' ? { instructions: p.instructions } : {}), ...(p.reasoning ? { reasoning: p.reasoning } : {}), ...(p.include ? { include: p.include } : {}), ...(p.tool_choice ? { tool_choice: p.tool_choice } : {}) };
}
