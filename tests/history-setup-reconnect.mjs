import { chromium } from 'playwright-core';
import { mock } from 'node:test';
import { setImmediate as tick } from 'node:timers/promises';
import assert from 'node:assert/strict';
import { HistoryFeed } from '../src/history-feed.ts';

// Generate the actual setup-ending responses without waiting 55 seconds or
// opening Pi. Chrome then consumes those responses with its native EventSource.
async function setupResponse(ending) {
  mock.timers.enable({ apis: ['setTimeout'] });
  let entered, release, stops = 0;
  const waiting = new Promise(resolve => { entered = resolve; });
  const delayed = new Promise(resolve => { release = resolve; });
  const feed = new HistoryFeed({ session: () => ({ events: async () => { entered(); return delayed; } }) }, { title: async () => { throw Error('Cancelled setup must not read titles'); } });
  const id = 'aaaaaaaa-aaaa-4aaa-aaaa-aaaaaaaaaaaa', abort = new AbortController();
  try {
    const pending = feed.subscribe(new Request('https://chat.example.test/events?stream=' + id, { signal: abort.signal }), '1');
    await waiting;
    if (ending === 'timeout') mock.timers.tick(55000);
    else if (ending === 'abort') abort.abort();
    else await feed.close(id);
    const response = await pending;
    release({ snapshot: {}, start: () => { throw Error('Late source must not start'); }, stop: async () => { stops++; } });
    await tick(); assert.equal(stops, 1);
    return { status: response.status, headers: Object.fromEntries(response.headers), body: await response.text() };
  } finally { mock.timers.reset(); }
}
const responses = {};
for (const ending of ['timeout', 'abort', 'close']) responses[ending] = await setupResponse(ending);
assert.equal(responses.timeout.status, 200); assert.equal(responses.abort.status, 204); assert.equal(responses.close.status, 204);
const browser = await chromium.launch({ executablePath: process.env.CHROME_EXECUTABLE || (process.platform === 'darwin' ? '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome' : '/usr/bin/google-chrome'), headless: true, args: ['--no-sandbox'] });
const errors = [];
try {
  for (const ending of ['timeout', 'abort', 'close']) {
    const page = await browser.newPage(); page.setDefaultTimeout(10000); page.on('pageerror', error => errors.push(error.message));
    let requests = 0;
    await page.route('**/*', async route => {
      const url = new URL(route.request().url()); assert.equal(url.origin, 'https://chat.example.test'); assert.equal(route.request().method(), 'GET');
      if (url.pathname === '/events') {
        requests++;
        if (ending === 'timeout' && requests === 2) return route.fulfill({ contentType: 'text/event-stream', body: 'data: {"reconnected":true}\n\n' });
        assert.equal(requests, 1);
        return route.fulfill(responses[ending]);
      }
      if (url.pathname === '/favicon.ico') return route.fulfill({ status: 404 });
      assert.equal(url.pathname, '/');
      return route.fulfill({ contentType: 'text/html', body: '<script>window.states=[];const source=new EventSource("/events");source.onerror=()=>{states.push(source.readyState);if(source.readyState===EventSource.CLOSED)window.result={closed:true};};source.onmessage=e=>{source.close();window.result=JSON.parse(e.data);};</script>' });
    });
    await page.goto('https://chat.example.test/');
    await page.waitForFunction(() => window.result);
    const result = await page.evaluate(() => ({ result: window.result, states: window.states }));
    assert.deepEqual(result.result, ending === 'timeout' ? { reconnected: true } : { closed: true });
    assert.equal(requests, ending === 'timeout' ? 2 : 1);
    assert.ok(result.states.includes(ending === 'timeout' ? 0 : 2));
    await page.close();
  }
  assert.deepEqual(errors, []);
  console.log('PASS native Chrome EventSource reconnects after setup expiry; abort and explicit close stop reconnect; actual HistoryFeed responses, zero external calls');
} finally { await browser.close(); }
