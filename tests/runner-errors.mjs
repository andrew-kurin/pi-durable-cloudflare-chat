import { chromium } from 'playwright-core';
import { readFile, mkdir } from 'node:fs/promises';
import assert from 'node:assert/strict';
import { ChatProjection } from '../src/projector.ts';
const out = '.runtime/runner-errors'; await mkdir(out, { recursive: true });
function view(details, prose = 'PRIVATE-RAW-ERROR') {
  const projection = new ChatProjection();
  projection.entry({ id: 1, kind: 'pi.assistant', model: [{ role: 'assistant', content: [], stopReason: 'error', errorMessage: prose, diagnostics: [{ type: 'model_runner_round_failure', details }] }] });
  return { historyProtocol: 2, ...projection.view() };
}
const rich = view({ code: 'siwc_provider_rejected', httpStatus: 400, provider: { httpStatus: 400, code: 'subscription_sharing_unsupported_capability', param: 'input', message: 'PRIVATE-PROVIDER' } });
const gateway = view({ code: 'runner_http_rejected', httpStatus: 502 });
const browser = await chromium.launch({ executablePath: process.env.CHROME_EXECUTABLE || (process.platform === 'darwin' ? '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome' : '/usr/bin/google-chrome'), headless: true, args: ['--no-sandbox'] });
const errors = [], requests = [];
try {
  const page = await browser.newPage({ viewport: { width: 390, height: 844 } }); page.setDefaultTimeout(5000); page.on('pageerror', error => errors.push(error.message));
  await page.addInitScript(() => { window.offlineStreams = []; window.EventSource = class { constructor() { window.offlineStreams.push(this); queueMicrotask(() => this.onopen?.()); } close() {} }; });
  await page.route('**/*', async route => {
    const request = route.request(), url = new URL(request.url()); assert.equal(url.origin, 'https://chat.example.test'); requests.push([request.method(), url.pathname]);
    if (url.pathname === '/api/events/close') return route.fulfill({ json: { closed: true } });
    assert.equal(request.method(), 'GET', 'Error display must never submit or replay model work');
    if (url.pathname === '/api/status') return route.fulfill({ json: { connected: true, modelEnabled: true, workspaceEnabled: false } });
    if (url.pathname === '/api/sessions') return route.fulfill({ json: [{ id: '1', title: 'Offline error fixture' }] });
    if (url.pathname === '/favicon.ico') return route.fulfill({ status: 404 });
    const file = url.pathname === '/' ? 'index.html' : url.pathname.slice(1);
    assert.ok(['index.html', 'app.js', 'history-client.js', 'chat-session.js', 'history-view.js', 'workspace.js', 'markdown.js', 'tool-activity.js', 'copy-control.js', 'style.css'].includes(file));
    return route.fulfill({ body: await readFile('public/' + file), contentType: file.endsWith('.js') ? 'text/javascript' : file.endsWith('.css') ? 'text/css' : 'text/html' });
  });
  const emit = async value => { await page.waitForFunction(() => window.offlineStreams.length > 0); await page.evaluate(v => window.offlineStreams.at(-1).onmessage({ data: JSON.stringify(v) }), value); };
  await page.goto('https://chat.example.test/');
  for (const width of [390, 1280]) {
    await page.setViewportSize({ width, height: 844 }); await emit(rich);
    await page.locator('.response-diagnostic>summary').click();
    const message = await page.locator('#messages').textContent();
    assert.match(message, /subscription input capability rejected/); assert.match(message, /Provider HTTP 400/); assert.match(message, /subscription_sharing_unsupported_capability/); assert.match(message, /Provider parameter: input/);
    assert.doesNotMatch(message, /PRIVATE|No more specific cause/);
    assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), true);
    await page.screenshot({ path: out + '/provider-rejection-' + width + '.png' });
    // Snapshot/reconnect keeps the same diagnostics without creating a submission.
    await page.locator('.status-action').click(); await emit(rich);
    assert.match(await page.locator('#messages').textContent(), /subscription_sharing_unsupported_capability/);
    await emit(gateway); assert.match(await page.locator('#messages').textContent(), /runner HTTP rejection/); assert.match(await page.locator('#messages').textContent(), /Reported HTTP 502/); assert.doesNotMatch(await page.locator('#messages').textContent(), /Provider HTTP|unsupported_capability/);
    // Keep the loop's next diagnostic initially collapsed.
    await page.locator('.response-diagnostic>summary').click();
  }
  await emit(view(undefined, 'Model round failed (runner http rejected); automatic replay disabled.'));
  assert.match(await page.locator('#messages').textContent(), /runner HTTP rejection/);
  await emit(view({ code: 'siwc_provider_rejected', httpStatus: 502, provider: { httpStatus: 400, code: 'PRIVATE-CODE', param: '<img src=x onerror=PRIVATE>' } }));
  assert.doesNotMatch(await page.locator('#messages').textContent(), /PRIVATE|<img/); assert.equal(await page.locator('.message img, .message script').count(), 0);
  assert.ok(!requests.some(([, path]) => path === '/api/submit')); assert.deepEqual(errors, []);
  console.log('PASS bounded provider diagnostics, gateway/legacy fallbacks, reconnect and 390/1280px rendering; zero submissions, external requests or page errors');
} finally { await browser.close(); }
