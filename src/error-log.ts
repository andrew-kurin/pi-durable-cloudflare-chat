const TECHNICAL=new Set(['error','message','code','param','type','status','statusCode','name','stack']);
function redactText(text:string){return text
 .replace(/-----BEGIN [\s\S]*?-----END [^-]+-----/g,'[redacted key]')
 .replace(/\b(?:Cookie|Set-Cookie)\s*:\s*[^\n]*/gi,'[redacted cookie header]')
 .replace(/\b(?:Bearer|Basic)\s+[A-Za-z0-9._~+/=-]+/gi,'[redacted authorization]')
 .replace(/\b(?:gh[pousr]_|github_pat_|sk-|tvly-)[A-Za-z0-9_-]+/g,'[redacted token]')
 .replace(/\beyJ[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\b/g,'[redacted JWT]')
 .replace(/(["']?(?:authorization|cookie|set-cookie|password|secret|api[_-]?key|access[_-]?token|refresh[_-]?token|id[_-]?token|token)["']?\s*[=:]\s*)(?:"[^"\n]*"|'[^'\n]*'|[^\s,;}]+)/gi,'$1[redacted]')
 .replace(/(?<![\w])(["']?(?:prompt|input|messages|arguments|output|body|request|headers|file_contents|conversation|content|payload)["']?\s*[=:]\s*)(?:"(?:\\.|[^"\\])*"|'[^']*'|\[[^\n]*|\{[^\n]*|[^\n]+)/gi,'$1[redacted request data]')
 .replace(/https?:\/\/[^\s"'<>]+/g,url=>{try{const u=new URL(url);u.username='';u.password='';for(const key of [...u.searchParams.keys()])if(/^(?:token|access_token|refresh_token|api_key|key|password|secret|authorization)$/i.test(key))u.searchParams.set(key,'[redacted]');return u.href;}catch{return url;}})
 .replace(/\x1b\[[0-9;]*m/g,'').replace(/[\x00-\x08\x0b\x0c\x0e-\x1f\x7f]/g,'');}
export function redactErrorText(value:unknown,limit=1800):string {
 if(typeof value!=='string')return '[error text unavailable]';
 let text=value.slice(0,8000);
 const start=text.indexOf('{');if(start>=0){try{
  const parsed=JSON.parse(text.slice(start));
  const clean=(v:any,depth=0):any=>{if(!v||typeof v!=='object'||Array.isArray(v)||depth>5)return '[nontechnical body omitted]';return Object.fromEntries(Object.entries(v).filter(([k])=>TECHNICAL.has(k)).map(([k,x])=>[k,k==='error'?clean(x,depth+1):typeof x==='string'?redactText(x):typeof x==='number'?x:'[nontechnical value omitted]']));};
  text=text.slice(0,start)+JSON.stringify(clean(parsed));
 }catch{text=text.slice(0,start)+'[unparseable body omitted]';}}
 text=redactText(text);return text.length>limit?text.slice(0,limit)+' [truncated]':text;
}
export function technicalError(error:unknown,depth=0):{message:string;status?:number;code?:string;stack?:string;cause?:unknown}{
 const e=error as {message?:unknown;stack?:unknown;status?:unknown;statusCode?:unknown;code?:unknown;cause?:unknown}|null;
 const raw=(typeof error==='string'?error:typeof e?.message==='string'?e.message:'[error text unavailable]').slice(0,8000);
 const status=[e?.status,e?.statusCode,raw.match(/^([45]\d\d)(?:\s*:|\s+status code)/)?.[1]].map(Number).find(n=>Number.isInteger(n)&&n>=400&&n<=599);
 let providerCode:unknown;const bodyAt=raw.indexOf('{');if(bodyAt>=0)try{const body=JSON.parse(raw.slice(bodyAt));providerCode=body?.error?.code??body?.code;}catch{}
 const reported=error instanceof Error?e?.code??providerCode:providerCode;
 const code=typeof reported==='string'&&/^[A-Za-z][A-Za-z0-9_.-]{0,63}$/.test(reported)?redactErrorText(reported,64):undefined;
 return {message:redactErrorText(raw),...(status?{status}:{}),...(code?{code}:{}),...(typeof e?.stack==='string'?{stack:redactErrorText(e.stack,2400)}:{}),...(depth<2&&e?.cause&&e.cause!==error?{cause:technicalError(e.cause,depth+1)}:{})};
}
export function logTechnicalError(stage:'model_dispatch'|'request'|'saved_model_response'|'auto_title',error:unknown,correlation:string,extra:Record<string,string|number|boolean>={},emit:(record:unknown)=>void=record=>console.warn(JSON.stringify(record))){
 try{const source=stage==='request'&&(error instanceof SyntaxError||(error as any)?.name==='SyntaxError')?new Error('Request parsing failed; raw input omitted.'):error;emit({event:'pi_error',stage,correlation,...technicalError(source),...extra});return true;}catch{/* Diagnostics must not change chat or stream behavior. */return false;}
}
