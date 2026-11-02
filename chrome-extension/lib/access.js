// Which tab may load which document. Used only by the background.
//
// A grant is (tab, document URL) for this browser session (chrome.storage.session). It is
// written only when the background itself sent that tab to the viewer for that URL:
//   - file:// PDFs: before redirecting the tab (webNavigation)
//   - online PDFs: when our redirect rule fired for a PDF response in that tab (webRequest)
// The viewer asks for its document by message; the answer depends on the sender's tab and
// the viewer's own URL (set by the browser, not by the page). Grants are dropped when the tab
// goes to another page or closes.
//
// Document IDs (viewer.html?doc=<id>) only make the address short and let "Open again" find the
// original URL during this browser session. They are kept in chrome.storage.session only: no PDF
// address is written to disk, and after a browser restart an old viewer address can't be resolved.
// An ID alone never grants access.

const MAX_DOCS = 500; // remembered IDs this session, oldest dropped first

const grantKey = (tabId) => `grants:${tabId}`;
const openedKey = (tabId) => `opened:${tabId}`;

// Storage writes for the same tab must not interleave.
let queue = Promise.resolve();
const serial = (fn) => (queue = queue.then(fn, fn));

async function grantsOf(tabId) {
  return (await chrome.storage.session.get(grantKey(tabId)))[grantKey(tabId)] ?? [];
}

export function addGrant(tabId, url) {
  return serial(async () => {
    const urls = await grantsOf(tabId);
    if (!urls.includes(url)) await chrome.storage.session.set({ [grantKey(tabId)]: [...urls, url] });
  });
}

// The tab went to `url`, which isn't the viewer: keep only a grant for that same URL (e.g. the
// PDF opened in Chrome's own viewer, so Back still works), drop the rest.
export function leaveViewer(tabId, url) {
  return serial(async () => {
    const urls = await grantsOf(tabId);
    const keep = urls.filter((u) => u === url);
    if (keep.length !== urls.length) await chrome.storage.session.set({ [grantKey(tabId)]: keep });
  });
}

// The tab closed: its grants go, and so do document IDs whose URL no open tab still uses
// (as a grant or as the document it opened). An ID another open tab needs for "Open again" stays.
export function forgetTab(tabId) {
  return serial(async () => {
    await chrome.storage.session.remove([grantKey(tabId), openedKey(tabId)]);
    const all = await chrome.storage.session.get(null);
    const inUse = new Set();
    for (const [key, value] of Object.entries(all)) {
      if (key.startsWith('grants:')) value.forEach((u) => inUse.add(u));
      if (key.startsWith('opened:')) inUse.add(value);
    }
    const ids = all.docs ?? {};
    const kept = Object.fromEntries(Object.entries(ids).filter(([, d]) => inUse.has(d.url)));
    if (Object.keys(kept).length !== Object.keys(ids).length) await chrome.storage.session.set({ docs: kept });
  });
}

export async function hasGrant(tabId, url) {
  return (await grantsOf(tabId)).includes(url);
}

// The redirect and the viewer's first message can race by a few milliseconds.
export async function waitForGrant(tabId, url, { tries = 20, everyMs = 100 } = {}) {
  for (let i = 0; i < tries; i++) {
    if (await hasGrant(tabId, url)) return true;
    await new Promise((r) => setTimeout(r, everyMs));
  }
  return false;
}

// The document a viewer tab was allowed to open (checked again before its text is sent anywhere).
export async function setOpened(tabId, url) {
  await chrome.storage.session.set({ [openedKey(tabId)]: url });
}

export async function openedDocument(tabId) {
  const url = (await chrome.storage.session.get(openedKey(tabId)))[openedKey(tabId)];
  return url && (await hasGrant(tabId, url)) ? url : null;
}

// ---------- Document IDs ----------

function newId() {
  const bytes = crypto.getRandomValues(new Uint8Array(8));
  return [...bytes].map((b) => (b % 36).toString(36)).join('');
}

async function docs() {
  return (await chrome.storage.session.get('docs')).docs ?? {};
}

// Same URL, same ID; a new URL gets a new random ID. Only a new ID writes the map.
// The oldest are dropped by their `seq` number, not by the object's key order: an ID made only of
// digits (e.g. "12345678", about 1 in 23,000) is an array-index key, which JavaScript always lists
// first, so key order would drop it (even the brand-new one) instead of the oldest.
export function docIdFor(url) {
  return serial(async () => {
    const all = await docs();
    const known = Object.keys(all).find((k) => all[k].url === url);
    if (known) return known;
    let id;
    do id = newId();
    while (all[id]);
    const seq = Math.max(0, ...Object.values(all).map((d) => d.seq ?? 0)) + 1;
    all[id] = { url, at: Date.now(), seq };
    const kept = Object.entries(all)
      .sort(([, a], [, b]) => (a.seq ?? 0) - (b.seq ?? 0))
      .slice(-MAX_DOCS); // the oldest go first, never the new one
    await chrome.storage.session.set({ docs: Object.fromEntries(kept) });
    return id;
  });
}

export async function urlForDoc(id) {
  return (await docs())[id]?.url ?? null;
}
