/** Technical diagnostics only. Never pass request bodies, credentials or SSE output. */
export type Diagnostic = (record: Record<string, unknown>) => void;
export function diagnosticText(value: unknown): string | undefined {
 if (typeof value !== 'string') return undefined;
 return value.slice(0,4096)
  .replace(/\b(?:Bearer|Basic)\s+[A-Za-z0-9._~+/=-]+/gi,'[redacted]')
  .replace(/\beyJ[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\b/g,'[redacted JWT]')
  .replace(/\b(?:sk-|gh[pousr]_|github_pat_)[A-Za-z0-9_-]+/g,'[redacted token]')
  .replace(/(["']?(?:authorization|cookie|set-cookie|access_token|refresh_token|id_token|api_key|token)["']?\s*[:=]\s*)(?:"[^"\n]*"|'[^'\n]*'|[^\s,;}]+)/gi,'$1[redacted]');
}
export function providerError(value: unknown) {
 if (!value || typeof value !== 'object') return undefined;
 const e=value as Record<string,unknown>;
 return Object.fromEntries(['code','type','param','message'].filter(k=>typeof e[k]==='string').map(k=>[k,diagnosticText(e[k])]));
}
export function emitDiagnostic(emit: Diagnostic | undefined, record: Record<string,unknown>) {
 try { emit?.({timestamp:new Date().toISOString(),...record}); } catch { /* logging never changes dispatch */ }
}
