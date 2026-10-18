import { createServer } from 'node:http';
import { MAX_REQUEST_BYTES } from './core';
/** Node HTTP bridge; caller must bind loopback in this prototype. */
export function createRunnerServer(runner: (request: Request) => Promise<Response>) {
return createServer(async (incoming, outgoing) => {
  const abort = new AbortController();
  incoming.on('aborted', () => abort.abort());
  outgoing.on('close', () => { if (!outgoing.writableEnded) abort.abort(); });
  try {
    const chunks: Buffer[] = []; let bytes = 0;
    for await (const chunk of incoming) { bytes += chunk.length; if (bytes > MAX_REQUEST_BYTES) { outgoing.writeHead(413).end(); return; } chunks.push(chunk); }
    const body = Buffer.concat(chunks);
    const headers = new Headers(); for (const [key, value] of Object.entries(incoming.headers)) if (typeof value === 'string') headers.set(key, value);
    const request = new Request('http://127.0.0.1:4319' + incoming.url, { method: incoming.method, headers, signal: abort.signal, ...(body.length ? { body } : {}) });
    const response = await runner(request);
    outgoing.writeHead(response.status, Object.fromEntries(response.headers));
    if (response.body) {
      const reader = response.body.getReader();
      try { while (true) { const part = await reader.read(); if (part.done) break; if (!outgoing.write(part.value)) await new Promise<void>(resolve => { const done = () => { outgoing.off('drain', done); outgoing.off('close', done); resolve(); }; outgoing.once('drain', done); outgoing.once('close', done); }); if (abort.signal.aborted) break; } }
      finally { await reader.cancel().catch(() => {}); }
    }
    outgoing.end();
  } catch { if (!outgoing.headersSent) outgoing.writeHead(500); outgoing.end(); }
});
}
