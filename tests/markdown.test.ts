import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { JSDOM } from 'jsdom';
import { toolActivity } from '../public/tool-activity.js';
import { renderMarkdown } from '../public/markdown.js';

function fixture(source: string) { const dom = new JSDOM('<div id="message"></div>', { url: 'https://chat.example.test/' }); const box = dom.window.document.getElementById('message')!; box.append(renderMarkdown(dom.window.document, source)); return box; }
test('bundled Markdown renders blocks, inline formatting, code, nested lists and tables', () => {
 const box = fixture('# Heading\n\nA **bold** and *emphasized* paragraph with `x < y`.\n\n> Quoted\n\n1. First\n   - Nested\n2. Second\n\n```js\n<script>alert(1)</script>\n```\n\n| Name | Value |\n| --- | --- |\n| One | Two |');
 assert.equal(box.querySelector('h2')?.textContent, 'Heading'); assert.equal(box.querySelector('strong')?.textContent, 'bold'); assert.equal(box.querySelector('em')?.textContent, 'emphasized'); assert.equal(box.querySelector('blockquote')?.textContent?.trim(), 'Quoted'); assert.ok(box.querySelector('ol ul')); assert.match(box.querySelector('pre code')!.textContent!, /<script>/); assert.equal(box.querySelectorAll('table th').length, 2); assert.equal(box.querySelector('table td')?.textContent, 'One'); assert.equal(box.querySelector('script'), null);
});
test('raw HTML, event handlers and images remain inert text without resource loading', () => {
 const box = fixture('<script>alert(1)</script>\n\n<img src="https://tracker.test/pixel" onerror="alert(2)">\n\n<svg onload=alert(3)></svg>\n\n![alt](https://tracker.test/image)\n\n<iframe src="https://tracker.test"></iframe>');
 assert.equal(box.querySelector('script,img,svg,iframe,object,style'), null); assert.match(box.textContent!, /<script>/); assert.match(box.textContent!, /\[Image: alt\]/); for (const node of box.querySelectorAll('*')) for (const name of node.getAttributeNames()) assert.equal(/^on|^src$/i.test(name), false);
});
test('unsafe and obscured URL schemes never become links; safe links isolate new tabs', () => {
 const payloads = ['javascript:alert%281%29', 'JaVaScRiPt:alert%281%29', 'data:text/html,attack', 'vbscript:attack', 'file:///etc/passwd', 'blob:https://example.test/id', 'java&#x73;cript:attack', 'javascript&#58;attack', 'https:\\evil.test', '//evil.test', '/api/submit'];
 for (const url of payloads) assert.equal(fixture('[click](' + url + ')').querySelector('a'), null, url);
 const box = fixture('[HTTPS](https://example.test/path?q=1) [HTTP](http://example.test) [Email](mailto:hello@example.test)');
 assert.equal(box.querySelectorAll('a').length, 3); for (const link of box.querySelectorAll('a')) { assert.equal(link.getAttribute('target'), '_blank'); assert.equal(link.getAttribute('rel'), 'noopener noreferrer'); }
});
test('every prefix of streamed Markdown renders safely, including unfinished links and fences', () => {
 const source = '**Thinking** [source](https://example.test/docs)\n\n```js\nconst value = "<img onerror=alert(1)>";\n```\n\n| A | B |\n| - | - |\n| x | y |';
 for (let i = 0; i <= source.length; i++) { const box = fixture(source.slice(0, i)); assert.equal(box.querySelector('script,img'), null); for (const link of box.querySelectorAll('a')) assert.match(link.getAttribute('href')!, /^https:\/\//); }
});
test('SSE partials, completed history, session switches and reload use the same safe renderer', async () => {
 const html = await readFile('public/index.html', 'utf8'); const script = (await readFile('public/app.js', 'utf8')).replace(/^import[^\n]+\n/gm, '');
 const saved = [{ role: 'user', text: '**Saved question**' }, { role: 'assistant', text: '[Saved answer](https://example.test)' }];
 for (let reload = 0; reload < 2; reload++) {
  const dom = new JSDOM(html, { url: 'https://chat.example.test', runScripts: 'outside-only' }); const w = dom.window as any; const streams: any[] = [];
  w.renderMarkdown = renderMarkdown; w.toolActivity = toolActivity; w.fetch = async (path: string) => ({ ok: true, json: async () => path.includes('/api/sessions') ? [{ id: '1' }, { id: '2' }] : { connected: true, modelEnabled: true, canLogin: false, webSearchEnabled: true } });
  w.EventSource = class { onmessage: any; close() {} constructor() { streams.push(this); } }; w.eval(script); await new Promise(resolve => setTimeout(resolve, 0));
  streams[0].onmessage({ data: JSON.stringify({ messages: saved, partial: '```\n<script>alert(1)', busy: true }) });
  assert.equal(w.document.querySelector('.partial pre code').textContent, '<script>alert(1)'); assert.equal(w.document.querySelectorAll('.message a').length, 1); assert.equal(w.document.querySelector('#messages script'), null);
  streams[0].onmessage({ data: JSON.stringify({ messages: [...saved, { role: 'assistant', text: '**Finished**' }], partial: '', busy: false }) }); assert.equal(w.document.querySelector('.partial'), null); assert.equal(w.document.querySelectorAll('.message strong').length, 2);
  w.document.getElementById('sessions').value = '2'; w.document.getElementById('sessions').onchange(); streams[1].onmessage({ data: JSON.stringify({ messages: saved, partial: '', busy: false }) }); assert.equal(w.document.querySelector('.message a').textContent, 'Saved answer'); dom.window.close();
 }
});
