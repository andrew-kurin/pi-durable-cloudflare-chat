import { redactDiagnosticCredentials } from '../../src/diagnostic-credentials';
import type { LocalSiwcCredential } from './siwc-auth';
export const MAX_CATALOG_BYTES = 2097152;
export interface CatalogEvidence {
 stage: string; outcome: 'failed' | 'available'; requests: number; recordedAt: string;
 status?: number; contentType?: string; requestId?: string; cfRay?: string; cfMitigated?: string;
 error?: string; providerError?: { code?: string; type?: string; message?: string };
 bodyExcerpt?: string; bodyTruncated?: boolean; bytesRead?: number;
 schema?: { topKeys: string[]; modelsType: string; dataType: string; modelsLength?: number; dataLength?: number; entryKeys?: string[] };
 catalog: { slug: string; display_name: string; visibility?: string }[]; observedDataIds?: string[];
}
/** Exactly one GET, no credential mutation, inference, retries or journal access. */
export async function readSiwcCatalog(credential: LocalSiwcCredential, transport: typeof fetch, timeoutMs = 30000): Promise<CatalogEvidence> {
 const r: CatalogEvidence = { stage: 'credentials', outcome: 'failed', requests: 0, recordedAt: new Date().toISOString(), catalog: [] };
 const secrets = [credential.access, credential.refresh, credential.idToken].filter(Boolean), clean = (value: unknown, limit = 4096) => redactDiagnosticCredentials(String(value), secrets).slice(0, limit);
 if (!credential.scopes?.includes('chatgpt.tokens.use.direct') || credential.expires <= Date.now() || !credential.access || credential.access.startsWith('sk-')) { r.error = 'Existing SIWC session is expired or lacks direct scope; no refresh or fallback attempted'; return r; }
 const controller = new AbortController(), timer = setTimeout(() => controller.abort(), timeoutMs);
 let reader: ReadableStreamDefaultReader<Uint8Array> | undefined;
 const abort = () => { void reader?.cancel().catch(() => {}); }; controller.signal.addEventListener('abort', abort);
 try {
  r.stage = 'request'; r.requests = 1;
  const response = await transport('https://api.openai.com/v1/models', { method: 'GET', headers: { authorization: `Bearer ${credential.access}` }, redirect: 'error', signal: controller.signal });
  r.status = response.status;
  for (const [header, field] of [['content-type','contentType'],['x-request-id','requestId'],['cf-ray','cfRay'],['cf-mitigated','cfMitigated']] as const) { const value = response.headers.get(header); if (value !== null) r[field] = clean(value,1024); }
  r.stage = 'body'; reader = response.body?.getReader();
  const chunks: Uint8Array[] = []; let size = 0, truncated = false;
  try { if (reader) while (true) { controller.signal.throwIfAborted(); const part = await reader.read(); controller.signal.throwIfAborted(); if (part.done) break; const remaining = MAX_CATALOG_BYTES-size; chunks.push(part.value.slice(0,remaining));size += Math.min(remaining,part.value.length);if(part.value.length>remaining){truncated=true;await reader.cancel();break;} } }
  catch(error) { r.error=clean(error instanceof Error?error.message:error); truncated=true; }
  const bytes=new Uint8Array(size);let offset=0;for(const chunk of chunks){bytes.set(chunk,offset);offset+=chunk.length;}
  const raw = new TextDecoder().decode(bytes), safe = redactDiagnosticCredentials(raw,secrets);r.bytesRead=size;r.bodyTruncated=truncated||safe.length>4096;r.bodyExcerpt=safe.length>4096?safe.slice(0,2048)+'\n[excerpt middle omitted]\n'+safe.slice(-2048):safe;
  if(truncated){r.stage='body';r.error ??= `Catalog exceeded ${MAX_CATALOG_BYTES} byte receive limit or body was interrupted`;return r;}
  let data: any;
  try { data=JSON.parse(raw); } catch { r.stage=response.ok?'parse':'http'; r.error ??= response.ok?'Catalog body is not valid JSON':'Catalog HTTP rejection'; return r; }
  const error=data?.error;
  if(error && typeof error==='object'){r.providerError={};for(const field of ['code','type','message'] as const)if(typeof error[field]==='string'||typeof error[field]==='number')r.providerError[field]=clean(error[field]);}
  const kind=(value:unknown)=>Array.isArray(value)?'array':value===null?'null':typeof value;
  r.schema={topKeys:data&&typeof data==='object'?Object.keys(data).slice(0,50).map(k=>clean(k,128)):[],modelsType:kind(data?.models),dataType:kind(data?.data),...(Array.isArray(data?.models)?{modelsLength:data.models.length}:{}),...(Array.isArray(data?.data)?{dataLength:data.data.length}:{}),...(data?.models?.[0]&&typeof data.models[0]==='object'?{entryKeys:Object.keys(data.models[0]).slice(0,30).map(k=>clean(k,128))}:{})};
  if(Array.isArray(data?.data))r.observedDataIds=data.data.slice(0,1000).flatMap((m:any)=>typeof m?.id==='string'?[clean(m.id,200)]:[]);
  if(!response.ok){r.stage='http';r.error ??='Catalog HTTP rejection';return r;}
  if(truncated){r.stage='body';r.error ??='Catalog receive limit or interrupted body';return r;}
  r.stage='schema';
  if(!Array.isArray(data?.models)||data.models.length>1000){r.error='Expected documented models array';return r;}
  for(const m of data.models){if(!m||typeof m.slug!=='string'||!/^[\w.-]{1,128}$/.test(m.slug)||typeof m.display_name!=='string'||m.display_name.length>200||/[\x00-\x1f]/.test(m.display_name)){r.error='Invalid documented catalog entry';r.catalog=[];return r;}r.catalog.push({slug:clean(m.slug,128),display_name:clean(m.display_name,200),...(m.visibility==='list'?{visibility:'list'}:{})});}
  r.stage='complete';r.outcome='available';return r;
 } catch(error) { r.error=clean(error instanceof Error?error.message:error);const cause=(error as {cause?:{code?:unknown}})?.cause?.code;if(cause)r.error+='; cause code: '+clean(cause,100);return r; }
 finally { clearTimeout(timer);controller.signal.removeEventListener('abort',abort);reader?.releaseLock(); }
}
