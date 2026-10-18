const $ = id => document.getElementById(id);
async function api(path, body) {
  const r = await fetch(path, { method: body === undefined ? 'GET' : 'POST', headers: body === undefined ? {} : { 'Content-Type': 'application/json' }, body: body === undefined ? undefined : JSON.stringify(body) });
  const value = await r.json();
  if (!r.ok) throw Error(value.error || 'Check unavailable');
  return value;
}
async function refresh() {
  const s = await api('/api/openai-check/status');
  $('connection').textContent = s.connected ? 'Saved OpenAI connection found. Availability is verified by the check.' : 'No saved OpenAI connection. Reconnection requires the existing approved sign-in flow; this page cannot start it.';
  $('recheck').disabled = !s.connected || !!s.failureCaptureReport;
  if (s.failureCaptureReport) {
    $('recheck-status').textContent = 'Saved new attempt. It will not run again.';
    $('recheck-result').textContent = JSON.stringify(s.failureCaptureReport, null, 2);
  }
  $('run').disabled = !s.connected || s.reports.some(Boolean);
  if (s.reports.some(Boolean)) {
    $('status').textContent = 'Saved results. Running or interrupted checks will not be replayed.';
    $('result').textContent = JSON.stringify(s.reports, null, 2);
  }
}
$('run').onclick = async () => {
  $('run').disabled = true; $('recheck').disabled = true;
  $('status').textContent = 'Running the fixed checks. Keep this page open.';
  try { const reports = await api('/api/openai-check/run', { approved: true }); $('result').textContent = JSON.stringify(reports, null, 2); $('status').textContent = 'Check finished. See each model’s status below.'; }
  catch (error) { $('status').textContent = error.message; }
  finally { await refresh().catch(() => {}); }
};
$('recheck').onclick = async () => {
  $('recheck').disabled = true; $('run').disabled = true;
  $('recheck-status').textContent = 'Running one new Sol 6.1 diagnostic…';
  try { const reports = await api('/api/openai-check/recheck', { approved: true }); $('recheck-result').textContent = JSON.stringify(reports, null, 2); $('recheck-status').textContent = 'Finished. See the captured evidence below.'; }
  catch (error) { $('recheck-status').textContent = error.message; }
  finally { await refresh().catch(() => {}); }
};
refresh().catch(() => { $('connection').textContent = 'Status unavailable. Sign in through Cloudflare Access and reload.'; });
