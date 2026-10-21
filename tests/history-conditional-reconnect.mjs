import { chromium } from 'playwright-core';
import { readFile } from 'node:fs/promises';
import { createServer } from 'node:http';
import assert from 'node:assert/strict';
import { HistoryFeed } from '../src/history-feed.ts';

// Native EventSource consumes real HistoryFeed frames over loopback HTTP. Responses
// finish early to exercise renewal without waiting for each 55-second lease;
// the absolute lease deadline is covered by history-setup-cancellation.test.ts.
let origin;
let text = 'Saved answer\n\n' + 'A fixture paragraph for reading and scrolling.\n\n'.repeat(180);
const entry = () => ({ id: '1', kind: 'pi.assistant', model: [{ role: 'assistant', content: [{ type: 'text', text }] }] });
const entries = () => [{ id: '0', kind: 'pi.assistant', model: [{ role: 'assistant', content: [{ type: 'text', text: 'A short saved answer with a visible copy control.' }] }] }, entry()];
const feed = new HistoryFeed({
  session: () => ({ events: async () => ({
    snapshot: { type: 'snapshot', entries: entries(), tools: [], inbox: [], agent: {}, usage: {}, compactions: [] },
    start() {}, stop: async () => {},
  }) }),
  conversation: async () => ({ entries: async () => ({ items: entries() }) }),
}, { title: async () => 'Saved chat' });
const browser = await chromium.launch({
  executablePath: process.env.CHROME_EXECUTABLE || (process.platform === 'darwin' ? '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome' : '/usr/bin/google-chrome'),
  headless: true, args: ['--no-sandbox'],
});
let server;
try {
  const page = await browser.newPage({ viewport: { width: 390, height: 844 } });
  page.setDefaultTimeout(20000);
  const errors = [], requests = [], payloads = [];
  let releaseChanged;
  const changeAllowed = new Promise(resolve => { releaseChanged = resolve; });
  let resyncCompleted;
  const resynced = new Promise(resolve => { resyncCompleted = resolve; });
  page.on('pageerror', error => errors.push(error.message));
  server = createServer(async (request, output) => {
   try {
    const url = new URL(request.url, origin);
    const send = (status, headers, body = '') => { output.writeHead(status, { 'Cache-Control': 'no-store', ...headers }); output.end(body); };
    const json = value => send(200, { 'Content-Type': 'application/json' }, JSON.stringify(value));
    if (url.pathname === '/api/events/close') {
      assert.equal(request.method, 'POST');
      return json({ closed: true });
    }
    assert.equal(request.method, 'GET', 'No model or workspace commands');
    if (url.pathname === '/api/status') return json({ connected: true, modelEnabled: false, workspaceEnabled: false });
    if (url.pathname === '/api/sessions') return json([{ id: '1', title: 'Saved chat' }]);
    if (url.pathname === '/api/events') {
      assert.equal(url.searchParams.get('snapshot'), null, 'Healthy renewal needs no snapshot fallback');
      const headers = request.headers;
      requests.push({ id: headers['last-event-id'], stream: url.searchParams.get('stream') });
      const number = requests.length;
      if (number === 3) { await changeAllowed; text = 'Changed while disconnected\n\n' + text; }
      if (number === 4) return send(200, { 'Content-Type': 'text/event-stream' }, 'event: unchanged\ndata: {}\nid: hv1-' + '0'.repeat(64) + '\n\n');
      const response = await feed.subscribe(new Request(url, { headers }), '1');
      const reader = response.body.getReader();
      const bytes = (await reader.read()).value;
      await reader.cancel();
      payloads.push({ number, bytes: bytes.byteLength, text: new TextDecoder().decode(bytes) });
      send(response.status, Object.fromEntries(response.headers), Buffer.from(bytes));
      if (number === 5) resyncCompleted();
      return;
    }
    const file = url.pathname === '/' ? 'index.html' : url.pathname.slice(1);
    if (!['index.html', 'app.bundle.js', 'style.css'].includes(file)) return send(404, {});
    return send(200, { 'Content-Type': file.endsWith('.js') ? 'text/javascript' : file.endsWith('.css') ? 'text/css' : 'text/html' }, await readFile('public/' + file));
   } catch (error) { errors.push(error.message); output.writeHead(500); output.end(); }
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  origin = 'http://127.0.0.1:' + server.address().port;
  await page.route('**/*', async route => {
    assert.equal(new URL(route.request().url()).origin, origin, 'No external fixture requests');
    await route.continue();
  });
  await page.goto(origin + '/?session=1');
  await page.locator('#messages .message').first().waitFor();
  await page.waitForFunction(() => document.querySelector('#connection').textContent === 'History connection unavailable');
  await page.evaluate(() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve))));
  await page.evaluate(() => {
    const box = document.querySelector('#messages');
    window.retainedNode = box.firstElementChild;
    window.retainedFocus = box.querySelector('.copy-control > button');
    window.retainedFocus.focus({ preventScroll: true });
    box.scrollTop = 140;
  });
  // The app deliberately uses CSS smooth scrolling. Establish the baseline
  // after that user-positioning animation finishes, not at its initial zero.
  await page.waitForFunction(() => Math.abs(document.querySelector('#messages').scrollTop - 140) < 1);
  await page.evaluate(() => {
    const box = document.querySelector('#messages');
    window.retainedScroll = box.scrollTop;
    window.renewals = [];
    window.rebuilds = 0;
    new MutationObserver(() => { window.rebuilds++; }).observe(box, { childList: true });
    new MutationObserver(() => {
      if (document.querySelector('#history-status').dataset.ready === 'true' && document.querySelector('#history-retry').hidden && document.querySelector('#activity').textContent === '') {
        window.renewals.push({
          sameNode: box.firstElementChild === window.retainedNode,
          sameFocus: document.activeElement === window.retainedFocus,
          sameScroll: Math.abs(box.scrollTop - window.retainedScroll) < 1,
          connection: document.querySelector('#connection').textContent,
        });
      }
    }).observe(document.querySelector('#history-status'), { attributes: true });
  });
  await page.waitForFunction(() => window.renewals?.length > 0);
  assert.equal(requests[0].id, undefined);
  assert.match(requests[1].id, /^hv1-[a-f0-9]{64}$/, JSON.stringify(requests));
  assert.equal(requests[1].stream, requests[0].stream, 'Native reconnect retains the lease identity');
  assert.deepEqual(await page.evaluate(() => window.renewals.at(-1)), { sameNode: true, sameFocus: true, sameScroll: true, connection: 'History connected' });
  assert.match(payloads.find(p => p.number === 2).text, /^event: unchanged/);
  assert.equal(payloads.find(p => p.number === 2).bytes, 100);
  releaseChanged();
  await page.waitForFunction(() => document.querySelector('#messages').textContent.includes('Changed while disconnected'));
  await page.waitForFunction(() => window.retainedNode && !window.retainedNode.isConnected);
  // The fourth response deliberately carries an ID the UI never accepted.
  // The client must replace EventSource, dropping the native transport cursor.
  let timeout;
  try { await Promise.race([resynced, new Promise((_, reject) => { timeout = setTimeout(() => reject(Error('No full resynchronization after mismatched ID')), 20000); })]); }
  finally { clearTimeout(timeout); }
  assert.ok(requests.length >= 5, 'Mismatched unchanged marker caused immediate full resynchronization');
  assert.equal(requests[4].id, undefined);
  assert.notEqual(requests[4].stream, requests[3].stream);
  assert.match(payloads.find(p => p.number === 5).text, /^data: /);
  await page.waitForFunction(() => window.rebuilds >= 2, null, { timeout: 20000 });
  await page.reload();
  await page.locator('#messages .message').first().waitFor();
  assert.equal(requests.at(-1).id, undefined, 'Reload starts with a full authoritative snapshot');
  assert.match(payloads.at(-1).text, /^data: /);
  assert.deepEqual(errors, []);
  await page.close();
  assert.equal(feed.activeStreams, 0);
  console.log('PASS native Last-Event-ID renewal: unchanged retains transcript nodes/focus/scroll and status; missed changes, mismatched receipt and reload resynchronize; 100-byte unchanged SSE, no external calls');
} finally { await browser.close(); server?.closeAllConnections(); if (server) await new Promise(resolve => server.close(resolve)); }
