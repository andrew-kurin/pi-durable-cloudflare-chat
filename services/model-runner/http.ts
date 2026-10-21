import {technicalError} from '../../src/error-log';
import { createServer } from 'node:http';
import { MAX_REQUEST_BYTES, RUNNER_PATH, validRoundEnvelope } from '../../src/model-runner-protocol';
import { BodyReadError, bodyLength, RequestAdmission, type RequestAdmissionLimits } from './admission';
export interface RunnerServerOptions extends Partial<RequestAdmissionLimits> {
  /** The offline fake service has its own separate envelope. Live must opt in. */
  signed?: boolean;
}
/** Node HTTP bridge; callers bind loopback. The body is streamed into the
 * handler, without a second complete Node buffer/concat. Admission is retained
 * until the handler returns, including its auth/parse/upstream preparation.
 */
export function createRunnerServer(runner: (request: Request) => Promise<Response>, options: RunnerServerOptions = {}) {
 const admission = new RequestAdmission(options);
 return createServer(async (incoming, outgoing) => {
  const started=Date.now(), reportedId=incoming.headers['x-pi-round-id'];const roundId=typeof reportedId==='string'&&/^[a-zA-Z0-9_-]{8,80}$/.test(reportedId)?reportedId:undefined;
  const log=(fields:Record<string,unknown>)=>{try{console.warn(JSON.stringify({event:'pi_runner_http',roundId,durationMs:Date.now()-started,...fields}));}catch{}};
  const abort = new AbortController();
  const onAbort = () => abort.abort();
  const onClose = () => { if (!outgoing.writableEnded) abort.abort(); };
  incoming.on('aborted', onAbort); outgoing.on('close', onClose);
  let release: (() => void) | undefined, timer: ReturnType<typeof setTimeout> | undefined;
  let stopBody = () => {}, inputLimit = false;
  const reject = (status: number, code: string) => {
    if (code !== 'runner_input_limit') log({phase:'rejected',httpStatus:status,bodyBytes:0,code});
    outgoing.shouldKeepAlive = false;
    outgoing.setHeader('connection', 'close');
    outgoing.setHeader('content-type', 'application/json');
    outgoing.writeHead(status).end(JSON.stringify({error:{code,message:code}}));
  };
  try {
    const headers = new Headers(); for (const [key, value] of Object.entries(incoming.headers)) if (typeof value === 'string') headers.set(key, value);
    const url = 'http://127.0.0.1:4319' + incoming.url;
    if (options.signed) {
      const parsed = new URL(url);
      if (incoming.method !== 'POST' || parsed.pathname !== RUNNER_PATH || parsed.search) { reject(404, 'not_found'); return; }
      const counts = new Map<string, number>();
      for (let i = 0; i < incoming.rawHeaders.length; i += 2) { const name = incoming.rawHeaders[i].toLowerCase(); counts.set(name, (counts.get(name) ?? 0) + 1); }
      if (['x-pi-round-id', 'x-pi-timestamp', 'x-pi-signature'].some(name => counts.get(name) !== 1) || !validRoundEnvelope({url, method:incoming.method, headers})) { reject(403, 'transport_auth_failed'); return; }
    }
    let length: number | undefined;
    try { length = bodyLength(headers); } catch {
      const tooLarge = /^\d+$/.test(headers.get('content-length') ?? '') && Number(headers.get('content-length')) > MAX_REQUEST_BYTES;
      if (tooLarge) log({phase:'rejected',httpStatus:413,bodyBytes:0,code:'runner_input_limit'});
      reject(tooLarge ? 413 : 400, tooLarge ? 'runner_input_limit' : 'invalid_body'); return;
    }
    const hasBody = !['GET', 'HEAD'].includes(incoming.method ?? 'GET');
    if (hasBody) {
      release = admission.reserve(length);
      if (!release) { reject(503, 'runner_admission_limit'); return; }
    }
    let bytes = 0, complete = !hasBody;
    const iterator = incoming.iterator({destroyOnReturn:false});
    let source: ReadableStreamDefaultController<Uint8Array> | undefined;
    const endRead = () => { clearTimeout(timer); timer = undefined; };
    let stopped = false;
    stopBody = () => {
      if (stopped) return; stopped = true;
      endRead(); incoming.pause();
      // A pending iterator.return/cancel must never hold the HTTP response open.
      void iterator.return?.().catch(() => {});
    };
    const interrupted = () => { if (!complete) { stopBody(); try { source?.error(new BodyReadError('round_cancelled')); } catch {} } };
    abort.signal.addEventListener('abort', interrupted, {once:true});
    if (hasBody) timer = setTimeout(() => abort.abort(), admission.limits.readTimeoutMs);
    const body = hasBody ? new ReadableStream<Uint8Array>({
      start(controller) { source = controller; if (abort.signal.aborted) interrupted(); },
      async pull(controller) {
        try {
          if (abort.signal.aborted) throw new BodyReadError('round_cancelled');
          const part = await iterator.next();
          if (abort.signal.aborted) return;
          if (part.done) {
            complete = true; endRead();
            if (length !== undefined && bytes !== length) throw new BodyReadError('invalid_body');
            controller.close(); return;
          }
          bytes += part.value.byteLength;
          if (bytes > MAX_REQUEST_BYTES || (length !== undefined && bytes > length)) {
            inputLimit = true;
            log({phase:'rejected',httpStatus:413,bodyBytes:bytes,code:'runner_input_limit'});
            throw new BodyReadError('invalid_body');
          }
          controller.enqueue(part.value);
        } catch (error) { stopBody(); try { controller.error(error); } catch {} }
      },
      cancel() { stopBody(); },
    }, {highWaterMark:0}) : undefined;
    const request = new Request(url, { method:incoming.method, headers, signal:abort.signal, ...(body ? {body, duplex:'half'} : {}) } as RequestInit);
    const response = await runner(request);
    release?.(); release = undefined;
    if (inputLimit) { void response.body?.cancel().catch(()=>{});reject(413, 'runner_input_limit');return; }
    if (!complete) { stopBody(); outgoing.shouldKeepAlive = false; outgoing.setHeader('connection', 'close'); }
    outgoing.writeHead(response.status, Object.fromEntries(response.headers));
    if (response.body) {
      const reader = response.body.getReader();
      try { while (true) { const part = await reader.read(); if (part.done) break; if (!outgoing.write(part.value)) await new Promise<void>(resolve => { const done = () => { outgoing.off('drain', done); outgoing.off('close', done); resolve(); }; outgoing.once('drain', done); outgoing.once('close', done); }); if (abort.signal.aborted) break; } }
      finally { await reader.cancel().catch(() => {}); }
    }
    outgoing.end();
  } catch(error) { if(inputLimit&&!outgoing.headersSent){reject(413,'runner_input_limit');}else{log({phase:'failed',httpStatus:outgoing.headersSent?undefined:500,error:technicalError(error)});if (!outgoing.headersSent) outgoing.writeHead(500); outgoing.end();} }
  finally {
    release?.(); clearTimeout(timer); stopBody();
    incoming.off('aborted', onAbort); outgoing.off('close', onClose);
    // Unread rejected bodies are closed after the response, never drained into memory.
    if (!incoming.complete) { if (outgoing.writableFinished) incoming.destroy(); else outgoing.once('finish', () => incoming.destroy()); }
  }
 });
}
