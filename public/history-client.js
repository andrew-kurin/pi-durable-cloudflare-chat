/** Owns one history connection and its lease. Rendering and chat selection stay outside. */
export function createHistoryClient({ onView, onState, platform = window }) {
  let target, current, suspended = false;
  const valid = (connection) => current === connection;
  const state = (connection, phase) => {
    if (valid(connection)) onState({ phase, loaded: connection.loaded });
  };
  function release() {
    const old = current;
    current = undefined; // Invalidate callbacks before abort/close can dispatch more events.
    if (!old) return;
    old.fallback?.abort();
    old.source.close();
    if (old.lease) {
      const url = '/api/events/close?stream=' + encodeURIComponent(old.lease);
      let sent = false;
      try { sent = platform.navigator?.sendBeacon?.(url, new Blob(['{}'], { type: 'application/json' })); } catch {}
      if (!sent) void platform.fetch(url, {
        method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{}', keepalive: true,
      }).catch(() => {});
    }
  }
  function accept(connection, view) {
    if (view.historyProtocol !== 2) connection.lease = undefined;
    onView(view);
  }
  function connect(next) {
    release();
    target = { ...next };
    suspended = false;
    const diagnostic = next.diagnostic;
    const suffix = diagnostic?.kind === 'saved-error' && /^[a-f0-9-]{36}$/.test(diagnostic.capture)
      ? '&diagnostic=saved-error&capture=' + encodeURIComponent(diagnostic.capture) : '';
    const session = encodeURIComponent(next.sessionId);
    const lease = platform.crypto.randomUUID();
    const source = new platform.EventSource('/api/events?session=' + session + '&stream=' + lease + suffix);
    const connection = { source, lease, loaded: false, pending: false, fallback: undefined };
    current = connection;
    state(connection, 'loading');
    source.onopen = () => state(connection, 'connected');
    source.onmessage = (event) => {
      if (!valid(connection)) return;
      let view;
      try { view = JSON.parse(event.data); } catch { return; }
      if (!view || !Array.isArray(view.messages)) return;
      connection.loaded = true;
      connection.fallback?.abort();
      accept(connection, view);
      state(connection, 'live');
    };
    // Keep EventSource's native reconnect behavior; snapshot fallback runs only before a first view.
    source.onerror = async () => {
      if (!valid(connection)) return;
      state(connection, 'unavailable');
      if (connection.loaded || connection.pending) return;
      connection.pending = true;
      const abort = new AbortController();
      connection.fallback = abort;
      try {
        const view = await snapshot('/api/events?session=' + session + '&snapshot=1' + suffix, abort);
        if (!valid(connection) || connection.loaded) return;
        if (!view || !Array.isArray(view.messages)) throw Error("History unavailable");
        connection.loaded = true;
        accept(connection, view);
        state(connection, 'snapshot');
      } catch {
        if (valid(connection) && !connection.loaded) state(connection, 'failed');
      } finally {
        connection.pending = false;
        if (connection.fallback === abort) connection.fallback = undefined;
      }
    };
  }
  async function snapshot(url, abort) {
    const timeout = platform.setTimeout(() => abort.abort(), 10000);
    let reader;
    const cancel = (body) => {
      try { if (body) void body.cancel().catch(() => {}); } catch {}
    };
    // Abort also bounds injected/slow readers that do not themselves honor fetch's signal.
    const bounded = (operation) => new Promise((resolve, reject) => {
      const cancel = () => reject(new Error('History unavailable'));
      if (abort.signal.aborted) { cancel(); return; }
      abort.signal.addEventListener('abort', cancel, { once: true });
      Promise.resolve(operation).then(resolve, reject).finally(() => abort.signal.removeEventListener('abort', cancel));
    });
    try {
      const pending = platform.fetch(url, { signal: abort.signal });
      // Native fetch honors abort; also dispose a late response from an injected transport.
      pending.then(response => { if (abort.signal.aborted) cancel(response.body); }, () => {});
      const response = await bounded(pending);
      if (response.body) reader = response.body.getReader();
      const type = response.headers?.get('Content-Type') || '';
      if (!response.ok || !reader || (!type.includes('application/json') && !type.includes('text/event-stream')))
        throw Error('History unavailable');
      const decoder = new TextDecoder();
      let text = '', bytes = 0;
      while (true) {
        const { value, done } = await bounded(reader.read());
        if (done) {
          text += decoder.decode();
          if (type.includes('application/json')) return JSON.parse(text);
          throw Error('History unavailable');
        }
        bytes += value.byteLength;
        if (bytes > 2 * 1024 * 1024) throw Error('History unavailable');
        text += decoder.decode(value, { stream: true });
        if (type.includes('text/event-stream')) {
          let boundary;
          while ((boundary = /\r?\n\r?\n/.exec(text))) {
            const frame = text.slice(0, boundary.index);
            text = text.slice(boundary.index + boundary[0].length);
            const data = frame.split(/\r?\n/).filter(line => line.startsWith('data:')).map(line => line.slice(5).trimStart()).join('\n');
            if (data) return JSON.parse(data);
          }
        }
      }
    } finally {
      platform.clearTimeout(timeout);
      cancel(reader);
    }
  }
  platform.addEventListener('pagehide', () => { suspended = !!target; release(); });
  platform.addEventListener('pageshow', (event) => {
    if (event.persisted && suspended && target) connect(target);
  });
  return {
    connect,
    retry: () => { if (target) connect(target); },
    close: () => { target = undefined; suspended = false; release(); },
  };
}
