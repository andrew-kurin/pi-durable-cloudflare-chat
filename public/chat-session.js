/** Owns selected chat, in-memory drafts and durable submit identity; no DOM or transport. */
export function createChatSession({ api, onChange, platform = window, requestedId }) {
  const LAST = 'pi:last-chat:v1', RECENT = 'pi:recent-chats:v1';
  const valid = id => typeof id === 'string' && /^\d{1,12}$/.test(id);
  const read = key => { try { return platform.localStorage.getItem(key); } catch { return null; } };
  const write = (key, value) => { try { if (value === null) platform.localStorage.removeItem(key); else platform.localStorage.setItem(key, value); } catch {} };
  let recent;
  try { recent = JSON.parse(read(RECENT) || '{}'); } catch {}
  if (!recent || typeof recent !== 'object' || Array.isArray(recent)) recent = {};
  let selected = valid(requestedId) ? requestedId : valid(read(LAST)) ? read(LAST) : null;
  let chats = [], listVersion = 0, selectionVersion = 0, sending, sendingSession, creating, trashing;
  const drafts = new Map(), pending = new Map();
  const draft = id => drafts.get(id) || { value: '', revision: 0 };
  const state = () => ({ sessionId: selected, draft: draft(selected).value, submitting: !!sending,
    chats: chats.map(c => ({ ...c })).sort((a,b) => (recent[b.id] || 0) - (recent[a.id] || 0) || Number(b.id) - Number(a.id)) });
  const emit = (type, previousSession = selected) => onChange(state(), { type, previousSession });
  function remember() {
    write(LAST, selected);
    if (selected) {
      recent[selected] = Date.now();
      recent = Object.fromEntries(Object.entries(recent).filter(([id,time]) => valid(id) && Number.isFinite(time))
        .sort((a,b) => b[1]-a[1]).slice(0,100));
      write(RECENT, JSON.stringify(recent));
    }
  }
  function select(id) {
    if (!chats.some(c => c.id === id)) return false;
    const previous = selected;
    selected = id; selectionVersion++; remember(); emit('selection', previous);
    return true;
  }
  async function refresh() {
    const own = ++listVersion;
    const loaded = await api('/api/sessions');
    if (own !== listVersion) return state();
    const previous = selected;
    chats = loaded.filter(c => valid(c.id));
    if (!chats.some(c => c.id === selected)) selected = chats[0]?.id ?? null;
    remember(); emit('catalog', previous);
    return state();
  }
  function editDraft(value) {
    if (!selected || value === draft(selected).value) return;
    drafts.set(selected, { value, revision: draft(selected).revision + 1 });
    emit('draft');
  }
  function submit() {
    if (sending) return selected === sendingSession ? sending : Promise.resolve();
    const session = selected, submitted = draft(session), text = submitted.value.trim();
    if (!session || !text) return Promise.resolve();
    const operation = pending.get(session)?.text === text ? pending.get(session)
      : { session, text, operationId: platform.crypto.randomUUID() };
    pending.set(session, operation);
    sendingSession = session;
    let resolve, reject;
    sending = new Promise((yes, no) => { resolve = yes; reject = no; });
    const work = sending;
    emit('submission');
    void (async () => {
      try {
        const receipt = await api('/api/submit?session=' + session, operation);
        if (draft(session).revision === submitted.revision && draft(session).value === submitted.value)
          drafts.set(session, { value: '', revision: submitted.revision + 1 });
        if (pending.get(session) === operation) pending.delete(session);
        resolve(receipt);
      } catch (error) {
        if (error?.status === 409 && error?.code === 'submission_cancelled' && pending.get(session) === operation)
          pending.delete(session);
        reject(error);
      }
      finally { sending = undefined; sendingSession = undefined; emit('submission'); }
    })();
    return work;
  }
  function create() {
    if (creating) return creating;
    const selection = selectionVersion;
    creating = Promise.resolve().then(() => api('/api/sessions', {})).then(async created => {
      await refresh();
      if (selection === selectionVersion) select(created.id);
      return created;
    }).finally(() => { creating = undefined; });
    return creating;
  }
  function trash(id) {
    if (trashing) return Promise.resolve();
    trashing = Promise.resolve().then(() => api('/api/session-trash?session=' + id, { action: 'delete' })).then(async () => {
      const wasActive = selected === id;
      await refresh();
      return { id, wasActive };
    }).finally(() => { trashing = undefined; });
    return trashing;
  }
  async function restore(id, choose = false) {
    const selection = selectionVersion;
    await api('/api/session-trash?session=' + id, { action: 'restore' });
    await refresh();
    if (choose && selection === selectionVersion) select(id);
  }
  function updateTitle(id, title) {
    const chat = chats.find(c => c.id === id);
    if (chat && chat.title !== title) { chat.title = title; emit('catalog'); }
  }
  async function rename(id, title) {
    const result = await api('/api/session-title?session=' + id, { title });
    updateTitle(id, result.title);
  }
  const deleted = async () => (await api('/api/sessions?deleted=1')).filter(c => valid(c.id) && c.deletedAt);
  return { state, refresh, select, editDraft, submit, create, trash, restore, rename, updateTitle, deleted };
}
