import type {EntryRecord} from '@earendil-works/pi-durable';
const TECHNICAL=new Set(['error','message','code','param','type','status','statusCode','name','stack']);
function redactText(text:string){return text
 .replace(/-----BEGIN [\s\S]*?-----END [^-]+-----/g,'[redacted key]')
 .replace(/\b(?:Cookie|Set-Cookie)\s*:\s*[^\n]*/gi,'[redacted cookie header]')
 .replace(/\b(?:Bearer|Basic)\s+[A-Za-z0-9._~+/=-]+/gi,'[redacted authorization]')
 .replace(/\b(?:gh[pousr]_|github_pat_|sk-|tvly-)[A-Za-z0-9_-]+/g,'[redacted token]')
 .replace(/\beyJ[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\b/g,'[redacted JWT]')
 .replace(/(["']?(?:authorization|cookie|set-cookie|password|secret|api[_-]?key|access[_-]?token|refresh[_-]?token|id[_-]?token|token)["']?\s*[=:]\s*)(?:"[^"\n]*"|'[^'\n]*'|[^\s,;}]+)/gi,'$1[redacted]')
 .replace(/(?<![\w])(["']?(?:prompt|input|messages|arguments|output|body|request|headers|file_contents|conversation|content|payload)["']?\s*[=:]\s*)(?:"(?:\\.|[^"\\])*"|'[^']*'|\[[^\n]*|\{[^\n]*|[^\n]+)/gi,'$1[redacted request data]')
 .replace(/https?:\/\/[^\s"'<>]+/g,url=>{try{const u=new URL(url);return u.origin+u.pathname.replace(/\/[\w.+-]+@[\w.-]+/g,'/[redacted]')+(u.search?'?[redacted query]':'');}catch{return '[redacted URL]';}})
 .replace(/[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}/gi,'[redacted email]')
 .replace(/\b(?:\d{1,3}\.){3}\d{1,3}\b/g,'[redacted IP]')
 .replace(/\/(?:Users|home)\/[^\s/:]+/g,'/[redacted home]')
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
export function technicalError(error:unknown){
 const e=error as {message?:unknown;stack?:unknown;status?:unknown;statusCode?:unknown;code?:unknown}|null;
 const raw=(typeof error==='string'?error:typeof e?.message==='string'?e.message:'[error text unavailable]').slice(0,8000);
 const status=[e?.status,e?.statusCode,raw.match(/^([45]\d\d)(?:\s*:|\s+status code)/)?.[1]].map(Number).find(n=>Number.isInteger(n)&&n>=400&&n<=599);
 let providerCode:unknown;const bodyAt=raw.indexOf('{');if(bodyAt>=0)try{const body=JSON.parse(raw.slice(bodyAt));providerCode=body?.error?.code??body?.code;}catch{}
 const reported=error instanceof Error?e?.code??providerCode:providerCode;
 const code=typeof reported==='string'&&/^[a-z][a-z0-9_.-]{0,63}$/.test(reported)?redactErrorText(reported,64):undefined;
 return {message:redactErrorText(raw),...(status?{status}:{}),...(code?{code}:{}),...(typeof e?.stack==='string'?{stack:redactErrorText(e.stack,2400)}:{})};
}
export function logTechnicalError(stage:'model_dispatch'|'request'|'saved_model_response'|'auto_title',error:unknown,correlation:string,extra:Record<string,string|number|boolean|SavedRunnerRoundDiagnostic>={},emit:(record:unknown)=>void=record=>console.warn(JSON.stringify(record))){
 try{const source=stage==='request'&&(error instanceof SyntaxError||(error as any)?.name==='SyntaxError')?new Error('Request parsing failed; raw input omitted.'):error;emit({event:'pi_error',stage,correlation,...technicalError(source),...extra});return true;}catch{/* Diagnostics must not change chat or stream behavior. */return false;}
}
interface ErrorLogTx{get<T>(key:string):Promise<T|undefined>;put<T>(key:string,value:T):Promise<void>}
export interface ErrorLogStore extends ErrorLogTx{transaction<T>(fn:(tx:ErrorLogTx)=>Promise<T>):Promise<T>}
export type SavedFailureOutcome='emitted'|'deduplicated'|'no_saved_error'|'storage_failed'|'emission_failed'|'correlation_failed'|'inspection_failed';
export interface SavedRunnerRoundDiagnostic {roundId?:string;code?:string;bodyBytes?:number;httpStatus?:number;timestamp?:number}
/** Read only the known transport diagnostic, never conversation content or arbitrary diagnostic details. */
function savedRunnerRound(message:unknown):SavedRunnerRoundDiagnostic|undefined {
 const diagnostics=(message as {diagnostics?:unknown})?.diagnostics;if(!Array.isArray(diagnostics))return;
 const diagnostic=[...diagnostics].reverse().find(d=>d?.type==='model_runner_round_failure');
 const details=diagnostic?.details;if(!details||typeof details!=='object')return;
 const result:SavedRunnerRoundDiagnostic={};
 if(typeof details.roundId==='string'&&/^[a-zA-Z0-9_-]{1,100}$/.test(details.roundId))result.roundId=details.roundId;
 if(typeof details.code==='string'&&/^[a-z][a-z0-9_]{0,100}$/.test(details.code))result.code=details.code;
 if(Number.isSafeInteger(details.bodyBytes)&&details.bodyBytes>=0)result.bodyBytes=details.bodyBytes;
 if(Number.isInteger(details.httpStatus)&&details.httpStatus>=100&&details.httpStatus<=599)result.httpStatus=details.httpStatus;
 if(Number.isSafeInteger(diagnostic.timestamp)&&diagnostic.timestamp>=0)result.timestamp=diagnostic.timestamp;
 return Object.keys(result).length?result:undefined;
}
export interface SavedFailureDiagnostic {runnerRound?:SavedRunnerRoundDiagnostic;outcome:SavedFailureOutcome;emissionAccepted:boolean;correlation?:string;errorMessagePresent?:boolean;errorMessageType?:string;errorMessageLength?:number}
/** Return branch outcomes and known round metadata, never saved text, entry IDs, prompts or tool data. */
export async function diagnoseSavedFailure(entries:readonly EntryRecord[],store:ErrorLogStore,session:string,capture:string,emit?:(record:unknown)=>void):Promise<SavedFailureDiagnostic>{
 let message:Extract<NonNullable<EntryRecord['model']>[number],{role:'assistant'}>|undefined,entry:EntryRecord|undefined;
 try{entry=[...entries].reverse().find(e=>e.kind==='pi.assistant'&&e.model?.some(m=>m.role==='assistant'&&m.stopReason==='error'));if(!entry)return {outcome:'no_saved_error',emissionAccepted:false};message=entry.model?.filter(m=>m.role==='assistant').find(m=>m.stopReason==='error');if(!message)return {outcome:'no_saved_error',emissionAccepted:false};}catch{return {outcome:'inspection_failed',emissionAccepted:false}}
 let correlation:string;
 try{const bytes=await crypto.subtle.digest('SHA-256',new TextEncoder().encode(session+':'+String(entry.id)+':'+capture));correlation=Array.from(new Uint8Array(bytes)).map(x=>x.toString(16).padStart(2,'0')).join('').slice(0,24);}catch{return {outcome:'correlation_failed',emissionAccepted:false}}
 let raw:unknown,timestamp:unknown;try{raw=message.errorMessage;timestamp=message.timestamp;}catch{return {outcome:'inspection_failed',emissionAccepted:false,correlation}}const runnerRound=savedRunnerRound(message);const metadata={correlation,errorMessagePresent:raw!==undefined,errorMessageType:typeof raw,errorMessageLength:typeof raw==='string'?raw.length:0,...(runnerRound?{runnerRound}:{})};let emissionAccepted=false;
 try{return await store.transaction(async tx=>{const key='diagnostic:saved-error:'+session;const seen=await tx.get<string[]>(key)??[];if(seen.includes(correlation))return {outcome:'deduplicated',emissionAccepted:false,...metadata};
  emissionAccepted=logTechnicalError('saved_model_response',typeof raw==='string'?raw:undefined,correlation,{errorMessagePresent:metadata.errorMessagePresent,errorMessageType:metadata.errorMessageType,errorMessageLength:metadata.errorMessageLength,...(metadata.runnerRound?{runnerRound:metadata.runnerRound}:{}),...(typeof timestamp==='number'&&Number.isSafeInteger(timestamp)?{messageTimestamp:timestamp}:{})},emit);
  if(!emissionAccepted)return {outcome:'emission_failed',emissionAccepted:false,...metadata};
  await tx.put(key,[...seen,correlation].slice(-32));return {outcome:'emitted',emissionAccepted:true,...metadata};
 });}catch{return {outcome:'storage_failed',emissionAccepted,...metadata}}
}
export async function logSavedFailure(entries:readonly EntryRecord[],store:ErrorLogStore,session:string,capture:string,emit?:(record:unknown)=>void){return (await diagnoseSavedFailure(entries,store,session,capture,emit)).outcome==='emitted';}
export async function diagnoseSavedErrorRead(url:URL,entries:readonly EntryRecord[],store:ErrorLogStore,session:string,emit?:(record:unknown)=>void){
 const captures=url.searchParams.getAll('capture');const capture=captures[0];const gate={capturePresent:captures.length>0,captureCount:captures.length,captureLength:capture?.length??0,captureShapeValid:typeof capture==='string'&&/^[a-f0-9-]{36}$/.test(capture)};
 const result=captures.length!==1||!gate.captureShapeValid?{outcome:'invalid_capture' as const,emissionAccepted:false}:await diagnoseSavedFailure(entries,store,session,capture!,emit);
 const diagnostic={...result,...gate,session,snapshotEntryCount:entries.length};try{console.info(JSON.stringify({event:'pi_diagnostic',stage:'saved_error_read',...diagnostic}));}catch{/* The owner-only SSE acknowledgement remains available if console logging fails. */}return diagnostic;
}
