/** Bounded incremental SSE validation. Never stores/logs prompt/output frames.
 * Headerless and mixed-case SSE are accepted, but a terminal completion is mandatory. */
export function validatedStream(body: ReadableStream<Uint8Array>, signal: AbortSignal, finish: () => void, abort: () => void) {
  const reader = body.getReader(), decoder = new TextDecoder('utf-8', { fatal: true });
  let buffer = '', bytes = 0, terminal = false, ended = false;
  const stop = () => { void reader.cancel().catch(() => {}); };
  signal.addEventListener('abort', stop, { once: true });
  const cleanup = () => { if (!ended) { ended = true; signal.removeEventListener('abort', stop); finish(); } };
  function validate(text: string) {
    buffer += text;
    // Normalize CRLF only after complete lines; split chunks may end at CR.
    let match: RegExpExecArray | null;
    while ((match = /\r?\n\r?\n/.exec(buffer))) {
      const frame = buffer.slice(0, match.index); buffer = buffer.slice(match.index + match[0].length);
      if (frame.length > 131072) throw Error('stream_frame_limit');
      const data = frame.split(/\r?\n/).filter(l => l.startsWith('data:')).map(l => l.slice(5).trimStart()).join('\n');
      if (!data) { if (frame.split(/\r?\n/).some(l => l && !l.startsWith(':') && !/^(event|id|retry):/.test(l))) throw Error('invalid_stream'); continue; }
      if (data === '[DONE]') { if (!terminal) throw Error('missing_completion'); continue; }
      if (terminal) throw Error('after_completion');
      const event = JSON.parse(data);
      if (typeof event.type !== 'string' || !event.type.startsWith('response.')) throw Error('invalid_stream');
      if (['response.failed', 'response.incomplete'].includes(event.type)) throw Error('provider_stream_failed');
      if (event.type === 'response.completed') {
        if (event.response?.status !== 'completed') throw Error('invalid_completion');
        terminal = true;
      }
    }
    if (buffer.length > 131072) throw Error('stream_frame_limit');
  }
  return new ReadableStream<Uint8Array>({
    async pull(output) {
      try {
        signal.throwIfAborted(); const part = await reader.read(); signal.throwIfAborted();
        if (part.done) { validate(decoder.decode()); if (!terminal || buffer.trim()) throw Error('missing_completion'); cleanup(); output.close(); return; }
        bytes += part.value.length; if (bytes > 4194304) throw Error('stream_receive_limit');
        validate(decoder.decode(part.value, { stream: true })); output.enqueue(part.value);
      } catch { abort(); cleanup(); output.error(Error('Model stream interrupted; automatic replay disabled.')); }
    },
    async cancel() { abort(); cleanup(); await reader.cancel().catch(() => {}); },
  });
}
