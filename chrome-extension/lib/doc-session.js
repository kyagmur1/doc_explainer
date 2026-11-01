// Per-document data that must outlive a viewer reload or a service-worker restart, but not the
// PDF tab: context pack, finished reader parts, answers, chat, last selection, reader status.
// Everything is in chrome.storage.session (memory only, cleared when the browser closes) and is
// deleted when the last viewer tab showing the document closes. Nothing is written to disk.
//
//   doc:<hash>     = { tabs: [tabId], pack, parts: { key: result }, answers: { key: text },
//                      selection, reader: { status, error, progress } }
//   chat:<hash>    = the conversation, kept apart so it can be saved on every streamed piece
//   tabdoc:<tabId> = hash

const docKey = (hash) => `doc:${hash}`;
const chatKey = (hash) => `chat:${hash}`;
const tabKey = (tabId) => `tabdoc:${tabId}`;
const empty = () => ({ tabs: [], pack: null, parts: {}, answers: {}, selection: null, reader: { status: 'idle', error: null, progress: null } });

// Writes must not interleave (read-modify-write of one object).
let queue = Promise.resolve();
const serial = (fn) => (queue = queue.then(fn, fn));

export async function docOfTab(tabId) {
  return (await chrome.storage.session.get(tabKey(tabId)))[tabKey(tabId)] ?? null;
}

export async function getDoc(hash) {
  return (await chrome.storage.session.get(docKey(hash)))[docKey(hash)] ?? null;
}

// change(doc) edits the stored object in place; returns the updated doc. A document whose tabs
// all closed is gone and stays gone (e.g. a reader that finishes after the tab closed).
export function updateDoc(hash, change) {
  return serial(async () => {
    const doc = await getDoc(hash);
    if (!doc) return null;
    change(doc);
    await chrome.storage.session.set({ [docKey(hash)]: doc });
    return doc;
  });
}

export async function getChat(hash) {
  return (await chrome.storage.session.get(chatKey(hash)))[chatKey(hash)] ?? null;
}

// Saves the conversation. With `ifId`, only if the stored one still has that id, so a late
// answer from an older conversation never overwrites a newer one. Never for a closed document.
export function saveChat(hash, chat, { ifId = undefined } = {}) {
  return serial(async () => {
    if (!(await getDoc(hash))) return false;
    if (ifId !== undefined && (await getChat(hash))?.id !== ifId) return false;
    await chrome.storage.session.set({ [chatKey(hash)]: chat });
    return true;
  });
}

// A viewer tab shows this document now (it may have shown another one before).
export function attachTab(tabId, hash) {
  return serial(async () => {
    const previous = (await chrome.storage.session.get(tabKey(tabId)))[tabKey(tabId)];
    if (previous && previous !== hash) await detach(tabId, previous);
    const doc = (await getDoc(hash)) ?? empty();
    if (!doc.tabs.includes(tabId)) doc.tabs.push(tabId);
    await chrome.storage.session.set({ [docKey(hash)]: doc, [tabKey(tabId)]: hash });
    return doc;
  });
}

async function detach(tabId, hash) {
  const doc = await getDoc(hash);
  if (!doc) return;
  doc.tabs = doc.tabs.filter((t) => t !== tabId);
  if (doc.tabs.length) await chrome.storage.session.set({ [docKey(hash)]: doc });
  else await chrome.storage.session.remove([docKey(hash), chatKey(hash)]); // last tab closed: forget the document
}

// The tab closed: its document's data goes when no other tab shows it.
export function forgetTab(tabId) {
  return serial(async () => {
    const hash = (await chrome.storage.session.get(tabKey(tabId)))[tabKey(tabId)];
    await chrome.storage.session.remove(tabKey(tabId));
    if (hash) await detach(tabId, hash);
  });
}
