// Keep async clipboard state across history DOM replacement, scoped to one document.
const documents = new WeakMap();
export function copyControl(document, key, text, label) {
  let entries = documents.get(document);
  if (!entries) documents.set(document, entries = new Map());
  let state = entries.get(key);
  if (!state) entries.set(key, state = { text, pending: false, feedback: '' });
  if (state.text !== text) { state.text = text; state.feedback = ''; }
  // Bound retained state without retaining detached DOM nodes indefinitely.
  if (entries.size > 300) for (const [id, entry] of entries) {
    if (id !== key && !entry.pending) { entries.delete(id); break; }
  }
  const root = document.createElement('div'); root.className = 'copy-control';
  const button = document.createElement('button'); button.type = 'button';
  button.className = 'copy-button icon-button'; button.dataset.copyId = key;
  button.setAttribute('aria-label', label); button.title = label;
  const svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
  for (const [name, value] of Object.entries({class:'ui-icon',viewBox:'0 0 24 24',fill:'none',stroke:'currentColor','stroke-width':'2','stroke-linecap':'round','stroke-linejoin':'round','aria-hidden':'true',focusable:'false'})) svg.setAttribute(name,value);
  const use = document.createElementNS(svg.namespaceURI,'use'); use.setAttribute('href','#icon-copy'); svg.append(use); button.append(svg);
  const feedback = document.createElement('span'); feedback.className = 'copy-feedback'; feedback.setAttribute('role','status'); feedback.setAttribute('aria-live','polite');
  const render = () => { button.setAttribute('aria-disabled',String(state.pending)); button.setAttribute('aria-busy',String(state.pending)); feedback.textContent = state.feedback; root.dataset.copyState = state.pending ? 'pending' : state.feedback.startsWith('Copied') ? 'copied' : state.feedback ? 'error' : 'idle'; };
  state.render = render; render();
  button.addEventListener('click', async event => {
    event.preventDefault(); event.stopPropagation();
    if (state.pending) return;
    const value = state.text; state.pending = true; state.feedback = ''; state.render();
    try {
      const clipboard = document.defaultView?.navigator.clipboard;
      if (typeof clipboard?.writeText !== 'function') { state.feedback = 'Clipboard unavailable. Select text to copy.'; return; }
      await clipboard.writeText(value);
      state.feedback = state.text === value ? 'Copied' : 'Copied earlier version';
    } catch { state.feedback = 'Couldn’t copy. Try again.'; }
    finally { state.pending = false; state.render(); }
  });
  root.append(button,feedback); return root;
}
export function toolClipboardText(tool) {
  const sections = [['Tool',tool.name || tool.label || 'Tool'],['Call ID',tool.id],['State',tool.state],['Context',tool.context],['Arguments',tool.input],['Result',tool.output],['Details',tool.detail],['Sources',Array.isArray(tool.sources)?JSON.stringify(tool.sources,null,2):undefined]];
  const text = sections.filter(([,value])=>typeof value==='string'&&value.length).map(([heading,value])=>heading+':\n'+value).join('\n\n');
  const notes = [tool.inputTruncated?'Arguments were truncated in recorded history.':'',tool.outputTruncated?'Result was truncated in recorded history.':''].filter(Boolean);
  return text + (notes.length?'\n\n'+notes.join('\n'):'');
}
