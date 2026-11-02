// Background service worker. Two jobs:
//
// A. Send PDFs opened in Chrome to the viewer (same tab), and decide which viewer tab may load
//    which document (lib/access.js).
//    Online PDFs are recognised by their response headers (Content-Type, or a .pdf filename in
//    Content-Disposition), not by the URL, and redirected by declarativeNetRequest before
//    Chrome's own viewer or a download starts. Local files have no headers, so file:// URLs
//    ending in .pdf are redirected via webNavigation (needs "Allow access to file URLs").
//
// B. AI work for the open document, calling the chosen provider directly (lib/llm.js) with the user's key.
//    Scrolling never causes a request: the viewer only reports the page in view, which chat
//    questions use as context. Requests happen only for
//    1. the document reader: once per document, builds the context pack (lib/reader.js)
//    2. a selection, when the user clicks Explain (streamed)
//    3. a chat question in the side panel (streamed)
//    Pack, finished reader parts, answers and chat live in storage.session per document
//    (lib/doc-session.js): they survive a viewer reload or a worker restart and are deleted when
//    the PDF's last tab closes. Then the document's pending work is cancelled too: no further
//    reader part, retry or new request; a request in flight is aborted on our side (Gemini has
//    no server-side cancel, so it may still be generated and billed). Clicking Explain again
//    while the same request runs doesn't start a second one.
//    Pages are checked when they connect, and get only messages about their own document.

import { PORT, MSG, getSettings } from './lib/messages.js';
import { fileViewerUrl, docViewerUrl, parseViewerQuery, looksLikePdfResponse } from './lib/pdf-routing.js';
import * as access from './lib/access.js';
import * as docSession from './lib/doc-session.js';
import { streamText, providerFor } from './lib/llm.js';
import { buildPack } from './lib/reader.js';
import { relevantPassages } from './lib/passages.js';
import { explainContents, chatContents, explainerSystem, chatSystem } from './lib/prompts.js';
import { watchLanguage, t } from './lib/i18n.js';

watchLanguage(); // messages from here (errors, notes) use the interface language

chrome.sidePanel.setPanelBehavior({ openPanelOnActionClick: true });

// ---------- A. Opening PDFs in the viewer ----------

const VIEWER = chrome.runtime.getURL('viewer.html');
const RULE_PDF_TYPE = 1;
const RULE_PDF_NAME = 2;
const RULE_BYPASS_BASE = 1000; // + tabId: lets one navigation in that tab through to Chrome's viewer
const bypassFiles = new Set(); // tabIds whose next file:// PDF should not be redirected
const pdfResponses = new Map(); // tabId -> URL of the last main-frame PDF response in that tab

async function installPdfRules() {
  const redirect = { type: 'redirect', redirect: { regexSubstitution: fileViewerUrl(VIEWER, '\\0') } };
  const base = { regexFilter: '^https?://.*', resourceTypes: ['main_frame'] };
  await chrome.declarativeNetRequest.updateSessionRules({
    removeRuleIds: [RULE_PDF_TYPE, RULE_PDF_NAME],
    addRules: [
      {
        id: RULE_PDF_TYPE,
        priority: 1,
        action: redirect,
        condition: { ...base, responseHeaders: [{ header: 'content-type', values: ['application/pdf', 'application/pdf;*', 'application/x-pdf', 'application/x-pdf;*'] }] },
      },
      {
        // e.g. application/octet-stream downloads named *.pdf
        id: RULE_PDF_NAME,
        priority: 1,
        action: redirect,
        condition: {
          ...base,
          responseHeaders: [{ header: 'content-disposition', values: ['*.pdf', '*.pdf"*', '*.pdf;*', '*.PDF', '*.PDF"*', '*.PDF;*'] }],
          excludedResponseHeaders: [{ header: 'content-type', values: ['text/*'] }],
        },
      },
    ],
  });
}

installPdfRules().catch((err) => console.warn('PDF rules:', err.message));

// Online PDFs: grant the tab its document when *our* rule redirected a PDF response there.
// A website can also redirect to viewer.html?file=<some URL>, but then the redirect doesn't
// come from a PDF response at exactly that URL, so it gets no grant.
const MAIN_FRAMES = { urls: ['http://*/*', 'https://*/*'], types: ['main_frame'] };
chrome.webRequest.onHeadersReceived.addListener(
  ({ tabId, url, responseHeaders }) => {
    if (looksLikePdfResponse(responseHeaders)) pdfResponses.set(tabId, url);
  },
  MAIN_FRAMES,
  ['responseHeaders'],
);
chrome.webRequest.onBeforeRedirect.addListener(({ tabId, url, redirectUrl }) => {
  if (!redirectUrl.startsWith(`${VIEWER}?`)) return;
  if (parseViewerQuery(redirectUrl)?.file === url && pdfResponses.get(tabId) === url) access.addGrant(tabId, url);
  pdfResponses.delete(tabId);
}, MAIN_FRAMES);

// Local PDFs: grant first, then send the tab to the viewer with a short document ID.
chrome.webNavigation.onBeforeNavigate.addListener(
  async ({ tabId, frameId, url }) => {
    if (frameId !== 0) return;
    if (bypassFiles.delete(tabId)) return;
    await access.addGrant(tabId, url);
    chrome.tabs.update(tabId, { url: docViewerUrl(VIEWER, await access.docIdFor(url)) });
  },
  { url: [{ schemes: ['file'], urlMatches: '\\.[pP][dD][fF]$' }] },
);

// The tab left the viewer for another page: its grants go (except for that same URL).
chrome.webNavigation.onCommitted.addListener(({ tabId, frameId, url }) => {
  if (frameId === 0 && !url.startsWith(VIEWER)) access.leaveViewer(tabId, url);
});

// Only our own viewer, as the top frame of a tab, may ask. The document comes from the viewer's
// URL as the browser reports it (sender.url), not from anything the page says.
async function viewerRequest(sender) {
  if (sender.id !== chrome.runtime.id || sender.frameId !== 0 || sender.tab?.id == null || !sender.url?.startsWith(`${VIEWER}?`)) return null;
  const query = parseViewerQuery(sender.url);
  const url = query?.file ?? (query?.doc ? await access.urlForDoc(query.doc) : null);
  return { tabId: sender.tab.id, url };
}

// Viewer start: may this tab load its document? -> { ok, url, doc } or { ok: false, url? }
async function authorize(sender) {
  const req = await viewerRequest(sender);
  if (!req?.url) return { ok: false };
  if (!(await access.waitForGrant(req.tabId, req.url))) return { ok: false, url: req.url };
  await access.setOpened(req.tabId, req.url);
  return { ok: true, url: req.url, doc: await access.docIdFor(req.url) };
}

// "Open again" (needs a click in the viewer): go to the original URL, so the normal redirect
// creates a fresh grant if it really is a PDF.
async function reopen(sender) {
  const req = await viewerRequest(sender);
  if (!req?.url) return { ok: false, error: t('unknownDocument') };
  await chrome.tabs.update(req.tabId, { url: req.url });
  return { ok: true };
}

// Fallback button in the viewer: open the document once in Chrome's own viewer, without redirect.
async function openOriginal(sender) {
  const req = await viewerRequest(sender);
  if (!req?.url) return { ok: false, error: t('unknownDocument') };
  if (req.url.startsWith('file:')) {
    bypassFiles.add(req.tabId);
  } else {
    await chrome.declarativeNetRequest.updateSessionRules({
      removeRuleIds: [RULE_BYPASS_BASE + req.tabId],
      addRules: [{ id: RULE_BYPASS_BASE + req.tabId, priority: 2, action: { type: 'allow' }, condition: { tabIds: [req.tabId], resourceTypes: ['main_frame'] } }],
    });
  }
  await chrome.tabs.update(req.tabId, { url: req.url });
  return { ok: true };
}

chrome.webNavigation.onCompleted.addListener(({ tabId, frameId }) => {
  if (frameId === 0) chrome.declarativeNetRequest.updateSessionRules({ removeRuleIds: [RULE_BYPASS_BASE + tabId] });
});

chrome.tabs.onRemoved.addListener((tabId) => {
  bypassFiles.delete(tabId);
  pdfResponses.delete(tabId);
  access.forgetTab(tabId);
  forgetDocumentTab(tabId);
  chrome.declarativeNetRequest.updateSessionRules({ removeRuleIds: [RULE_BYPASS_BASE + tabId] });
});

const VIEWER_REQUESTS = { [MSG.AUTHORIZE]: authorize, [MSG.REOPEN]: reopen, [MSG.OPEN_ORIGINAL]: openOriginal };
chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  const handler = VIEWER_REQUESTS[msg?.type];
  if (!handler) return;
  handler(sender).then(sendResponse, (err) => sendResponse({ ok: false, error: err.message }));
  return true; // answer asynchronously
});

// ---------- B. Document context, selection explanations and chat ----------

const PASSAGE_TOKENS = 2_500; // related passages from other pages for a selection or question
const MAX_HISTORY = 12; // chat messages sent along with a question
const ANSWER_STYLE = 2; // bump when the explain prompt changes, so stored answers are made again (2: language rule)
const SIDEPANEL = chrome.runtime.getURL('sidepanel.html');

// Connected pages, each checked when it connects (see onConnect):
// port -> { kind: 'viewer' | 'panel', tabId, hash (viewer, after DOC_LOADED), ok: Promise<boolean> }
const ports = new Map();
const readerJobs = new Map(); // hash -> running reader (this worker)
const explainJobs = new Map(); // answer key -> running selection request
const runningAnswers = new Set(); // ids of chat answers this worker is still receiving
// Per document while a tab shows it: its text (memory only; viewers send it again after a worker
// restart) and an AbortController that cancels its pending work when the last tab closes.
const docTexts = new Map(); // hash -> { title, pages }
const docAborts = new Map(); // hash -> AbortController

// The document in the active viewer tab (what the side panel shows), mirrored from
// storage.session (see doc-session.js).
const state = {
  hash: null,
  doc: null,
  pack: null,
  reader: { status: 'idle', error: null, progress: null },
  focus: null, // page in view (context for chat only)
  selection: null, // last EXPLAIN message, shown in the bubble and the side panel
  latestSelectionId: null,
  chat: null, // { id, selection: { n, text } | null, selectionId, messages: [{ id, role, text, done, error?, interrupted? }] }
};

function post(port, msg) {
  try {
    port.postMessage(msg);
  } catch {
    ports.delete(port);
  }
}

// Messages go only to checked ports that belong to the document: its viewers, and the side
// panels when it is the document in front. Never to every port.
async function sendForDoc(hash, msg) {
  for (const [port, p] of ports) {
    if (!(await p.ok)) continue;
    if ((p.kind === 'viewer' && p.hash === hash) || (p.kind === 'panel' && hash === state.hash)) post(port, msg);
  }
}

function snapshot() {
  return {
    type: MSG.SNAPSHOT,
    hash: state.hash,
    title: state.doc?.title ?? null,
    pageCount: state.doc?.pages.length ?? 0,
    focus: state.focus,
    reader: state.reader,
    selection: state.selection,
    chat: state.chat,
  };
}

const signalFor = (hash) => {
  if (!docAborts.has(hash)) docAborts.set(hash, new AbortController());
  return docAborts.get(hash).signal;
};

// extra: e.g. { interrupted: true } (reading stopped by a worker restart; see startReader)
function setReader(hash, status, error = null, progress = null, extra = {}) {
  const reader = { status, error, progress, ...extra };
  docSession.updateDoc(hash, (d) => (d.reader = reader));
  if (hash === state.hash) state.reader = reader;
  sendForDoc(hash, { type: MSG.READER_STATUS, hash, ...reader });
}

// 1. Document reader. Long documents report progress part by part; finished parts are kept in
// the document's session data, so a restarted worker continues instead of starting over.
// Cancelled (no further part, no new request) when the document's last tab closes.
// A request that was on its way when the worker stopped is not sent again by itself (it may be
// billed twice): the reader then shows an error with Retry. `retry` = the user clicked Retry.

async function startReader(hash, { retry = false } = {}) {
  if (state.pack && hash === state.hash) return setReader(hash, 'ready');
  const stored = await docSession.getDoc(hash);
  if (stored?.pack) {
    if (hash === state.hash) state.pack = stored.pack;
    return setReader(hash, 'ready');
  }
  const doc = docTexts.get(hash);
  if (readerJobs.has(hash) || !doc) return readerJobs.get(hash);
  if (stored?.readerRequest && !retry) {
    if (!stored.reader?.interrupted) setReader(hash, 'error', t('readerInterrupted'), stored.reader?.progress ?? null, { interrupted: true });
    return;
  }

  const signal = signalFor(hash);
  const job = (async () => {
    let progress = stored?.reader?.progress ?? null;
    if (progress?.waitUntil) progress = { done: progress.done, total: progress.total };
    if (retry) await docSession.updateDoc(hash, (d) => delete d.readerRequest);
    setReader(hash, 'reading', null, progress);
    let waiting = false;
    try {
      const { provider } = await getSettings(); // the provider chosen when reading starts
      const pack = await buildPack(doc, {
        provider,
        signal,
        onProgress: (done, total) => setReader(hash, 'reading', null, (progress = { done, total })),
        // Shown as "waiting for Gemini's rate limit"; a request on its way is noted (see above).
        onState: (what, until) => {
          if (what === 'waiting') {
            waiting = true;
            setReader(hash, 'reading', null, { ...progress, waitUntil: until });
          } else if (what === 'sent') {
            docSession.updateDoc(hash, (d) => (d.readerRequest = Date.now()));
            if (waiting) setReader(hash, 'reading', null, progress);
            waiting = false;
          } else {
            docSession.updateDoc(hash, (d) => delete d.readerRequest);
          }
        },
        cachedPart: async (key, compute) => {
          const cached = (await docSession.getDoc(hash))?.parts?.[key];
          if (cached) return cached;
          const result = await compute();
          await docSession.updateDoc(hash, (d) => (d.parts[key] = result));
          return result;
        },
      });
      // The parts were only kept to resume; the pack replaces them.
      await docSession.updateDoc(hash, (d) => {
        d.pack = pack;
        d.parts = {};
      });
      if (hash === state.hash) state.pack = pack;
      setReader(hash, 'ready');
    } catch (err) {
      if (!err.cancelled) setReader(hash, 'error', err.message);
    } finally {
      readerJobs.delete(hash);
    }
  })();
  readerJobs.set(hash, job);
  return job;
}

// 2. Selection explanations

// Stored answers are per provider and model: another one never shows an answer it didn't write.
const answerKey = ({ n, context, source, lang, provider, model, selection }) => `v${ANSWER_STYLE}:${provider}:${model}:${n}:${context}:${source}:${lang}:${selection}`;

// Only the latest selection is shown; answers for older ones are dropped (but still stored).
function showSelection(job, text, done, extra = {}) {
  if (job.id !== state.latestSelectionId) return;
  state.selection = { type: MSG.EXPLAIN, hash: job.hash, id: job.id, n: job.n, selection: job.selection, level: job.context, source: job.source, lang: job.lang, text, done, ...extra };
  if (done) docSession.updateDoc(job.hash, (d) => (d.selection = state.selection));
  sendForDoc(job.hash, state.selection);
}

async function explainSelection({ n, text, id }) {
  if (!state.doc) return;
  state.latestSelectionId = id;
  // Follow-ups are about this selection. Explaining the same text again keeps its conversation.
  const same = state.chat?.selection?.n === n && state.chat.selection.text === text;
  setChat(same ? { ...state.chat, selectionId: id } : newChat({ n, text }, id));
  const { source, lang, provider } = await getSettings();
  if (id !== state.latestSelectionId) return;
  const p = providerFor(provider); // a newer click came in meanwhile

  // Context version and source are fixed now, so the stored answer matches what the request uses.
  const context = state.pack ? 'passages' : 'passages-basic';
  const job = { hash: state.hash, doc: state.doc, pack: state.pack, n, selection: text, id, context, source, lang, provider: p.id, model: p.config.explainerModel, answer: '' };
  const key = answerKey(job);
  const running = explainJobs.get(`${job.hash}:${key}`);
  if (running) {
    running.id = id; // same request already on its way: show it for this click instead
    return showSelection(running, running.answer, false);
  }
  explainJobs.set(`${job.hash}:${key}`, job); // before any await, so a quick second click finds it
  try {
    const stored = (await docSession.getDoc(job.hash))?.answers?.[key];
    if (stored != null) return showSelection(job, stored, true, { cached: true });

    showSelection(job, '', false);
    const passages = relevantPassages(job.doc, { n, selection: text, maxTokens: PASSAGE_TOKENS });
    await streamText({
      label: `explain page=${n}`,
      systemInstruction: explainerSystem(source, lang, p.searchName),
      provider: p.id,
      contents: explainContents({ doc: job.doc, pack: job.pack, n, selection: text, passages, lang }),
      search: source === 'web',
      signal: signalFor(job.hash),
      // A rate-limit wait is shown as such (bubble and side panel), until the request goes out.
      onState: (what, until) => {
        if (what === 'waiting') showSelection(job, job.answer, false, { waitUntil: until });
        else if (what === 'sent') showSelection(job, job.answer, false);
      },
      onText: (chunk) => {
        job.answer += chunk;
        showSelection(job, job.answer, false);
      },
    });
    await docSession.updateDoc(job.hash, (d) => (d.answers[key] = job.answer)); // also if the user moved on: it was paid for
    showSelection(job, job.answer, true);
  } catch (err) {
    if (!err.cancelled) showSelection(job, job.answer, true, { error: err.message });
  } finally {
    explainJobs.delete(`${job.hash}:${key}`);
  }
}

// 3. Chat in the side panel: follow-ups about the selection, or questions about the page in view.
// Every conversation and message has an id: a late answer from an older request only ever
// changes its own conversation, never the one shown now.

const newChat = (selection = null, selectionId = null) => ({ id: crypto.randomUUID(), selection, selectionId, messages: [] });

function setChat(chat) {
  state.chat = chat;
  if (state.hash) docSession.saveChat(state.hash, chat);
  sendForDoc(state.hash, { type: MSG.CHAT, hash: state.hash, chat });
}

// Saves and shows `chat` only if it is still the document's current conversation. Called for
// every streamed piece too, so text that arrived survives a worker restart.
async function updateChat(hash, chat) {
  await docSession.saveChat(hash, chat, { ifId: chat.id });
  if (hash === state.hash && state.chat?.id === chat.id) {
    state.chat = chat;
    sendForDoc(hash, { type: MSG.CHAT, hash, chat });
  }
}

// After a worker restart nobody receives the answers that were still coming in: mark them
// "interrupted" (their text so far stays). Nothing is asked again automatically.
function markInterrupted(chat) {
  let changed = false;
  for (const m of chat?.messages ?? []) {
    if (m.role === 'model' && !m.done && !runningAnswers.has(m.id)) {
      Object.assign(m, { done: true, interrupted: true, error: t('answerInterrupted') });
      changed = true;
    }
  }
  return changed;
}

async function ask(question) {
  question = question?.trim();
  if (!state.doc || !question) return;
  const chat = state.chat ?? newChat();
  if (chat.messages.some((m) => !m.done)) return; // one answer at a time

  // History for the model: the bubble's explanation first (for a selection), then earlier
  // question-answer pairs whose answer arrived complete.
  const explanation = state.selection?.id === chat.selectionId && state.selection.done && !state.selection.error ? state.selection.text : '';
  const turns = [];
  for (let i = 0; i + 1 < chat.messages.length; i += 2) {
    const [q, a] = [chat.messages[i], chat.messages[i + 1]];
    if (a.done && !a.error) turns.push({ role: 'user', text: q.text }, { role: 'model', text: a.text });
  }
  const history = [...(explanation ? [{ role: 'model', text: explanation }] : []), ...turns].slice(-MAX_HISTORY);
  const n = chat.selection?.n ?? state.focus ?? 1;
  const answer = { id: crypto.randomUUID(), role: 'model', text: '', done: false };
  chat.messages.push({ id: crypto.randomUUID(), role: 'user', text: question, done: true }, answer);
  setChat(chat);

  const hash = state.hash;
  const doc = state.doc;
  const pack = state.pack;
  const { source, lang, provider } = await getSettings();
  const p = providerFor(provider);
  Object.assign(answer, { provider: p.id, model: p.config.explainerModel });
  answer.lang = lang; // shown with a note if the language is changed before or after it arrives
  runningAnswers.add(answer.id);
  try {
    const passages = relevantPassages(doc, { n, selection: `${chat.selection?.text ?? ''} ${question}`, maxTokens: PASSAGE_TOKENS });
    await streamText({
      label: `chat page=${n}${chat.selection ? ' selection' : ''}`,
      systemInstruction: chatSystem(source, lang, p.searchName),
      provider: p.id,
      contents: chatContents({ doc, pack, n, selection: chat.selection?.text, history, question, passages, lang }),
      search: source === 'web',
      signal: signalFor(hash),
      onState: (what, until) => {
        if (what === 'waiting') answer.waitUntil = until;
        else if (what === 'sent') delete answer.waitUntil;
        else return;
        updateChat(hash, chat);
      },
      onText: (chunk) => {
        answer.text += chunk;
        updateChat(hash, chat);
      },
    });
  } catch (err) {
    if (err.cancelled) return; // the document is closed: nothing left to update
    answer.error = err.message;
  } finally {
    runningAnswers.delete(answer.id);
    delete answer.waitUntil;
  }
  answer.done = true;
  await updateChat(hash, chat);
}

// "Retry" on a failed or interrupted answer: ask its question again (only when the user clicks).
function retryLast() {
  const messages = state.chat?.messages ?? [];
  const last = messages.at(-1);
  if (last?.role !== 'model' || !last.done || !last.error) return;
  ask(messages.at(-2)?.text);
}

// Messaging

// Text from a viewer is only used if that tab still holds a grant for the document it opened.
// Stored session data for the document (pack, answers, chat) comes back with it.
async function onDocLoaded({ hash, doc }, port) {
  const p = ports.get(port);
  if (!(await access.openedDocument(p.tabId))) return console.warn('Ignored document text from a viewer without access.');
  p.hash = hash;
  await docSession.attachTab(p.tabId, hash);
  docTexts.set(hash, doc);
  // The document becomes the one in front if its tab is the active one (or nothing is in front).
  // After a worker restart all open viewers send their text again, in any order.
  const [active] = await chrome.tabs.query({ active: true, lastFocusedWindow: true });
  if (!state.hash || hash === state.hash || active?.id === p.tabId) await showDocument(hash);
  else post(port, { type: MSG.READER_STATUS, hash, ...((await docSession.getDoc(hash))?.reader ?? {}) });
  startReader(hash);
}

// Puts a document in front: the side panel and chat follow it.
async function showDocument(hash) {
  const stored = await docSession.getDoc(hash);
  const doc = docTexts.get(hash);
  if (!stored || !doc) return;
  const sameDoc = hash === state.hash;
  // This worker's own conversation (same document) is the newest; otherwise take the stored one.
  const chat = sameDoc && state.chat ? state.chat : await docSession.getChat(hash);
  if (markInterrupted(chat)) await docSession.saveChat(hash, chat, { ifId: chat.id });
  Object.assign(state, { hash, doc, pack: stored.pack ?? (sameDoc ? state.pack : null), reader: stored.reader, chat });
  if (!sameDoc) Object.assign(state, { focus: null, selection: stored.selection, latestSelectionId: stored.selection?.id ?? null });
  sendForDoc(hash, snapshot());
}

// Switching to another viewer tab brings its document to the front.
chrome.tabs.onActivated.addListener(async ({ tabId }) => {
  const hash = await docSession.docOfTab(tabId);
  if (hash && hash !== state.hash) showDocument(hash);
});

// A tab closed. If no other tab shows its document: cancel the document's pending work (reader
// parts, retries, answers; a request already sent is aborted on our side) and drop its data.
async function forgetDocumentTab(tabId) {
  await docSession.forgetTab(tabId);
  for (const hash of [...docTexts.keys()]) {
    if (await docSession.getDoc(hash)) continue;
    docAborts.get(hash)?.abort();
    docAborts.delete(hash);
    docTexts.delete(hash);
  }
  if (state.hash && !(await docSession.getDoc(state.hash))) {
    Object.assign(state, { hash: null, doc: null, pack: null, reader: { status: 'idle', error: null, progress: null }, focus: null, selection: null, latestSelectionId: null, chat: null });
    for (const [port, p] of ports) if (p.kind === 'panel' && (await p.ok)) post(port, snapshot());
  }
}

// What each kind of page may send.
const VIEWER_MESSAGES = new Set([MSG.DOC_LOADED, MSG.PAGE_FOCUS, MSG.SELECTION, MSG.PING]);
const PANEL_MESSAGES = new Set([MSG.HELLO, MSG.CHAT_ASK, MSG.CHAT_RETRY, MSG.CHAT_RESET, MSG.RETRY_READER, MSG.GOTO, MSG.PING]);

async function onPortMessage(msg, port) {
  const p = ports.get(port);
  if (!p || !(await p.ok)) return;
  if (!(p.kind === 'viewer' ? VIEWER_MESSAGES : PANEL_MESSAGES).has(msg?.type)) return;
  // A viewer speaks only for the document it loaded.
  if (p.kind === 'viewer' && msg.type !== MSG.DOC_LOADED && msg.type !== MSG.PING && msg.hash !== p.hash) return;
  switch (msg.type) {
    case MSG.DOC_LOADED:
      return onDocLoaded(msg, port);
    case MSG.PAGE_FOCUS:
      if (msg.hash !== state.hash) return;
      state.focus = msg.n;
      return sendForDoc(state.hash, { type: MSG.PAGE_FOCUS, hash: state.hash, n: msg.n });
    case MSG.SELECTION:
      if (msg.hash !== state.hash) return;
      return explainSelection(msg);
    case MSG.CHAT_ASK:
      return ask(msg.question);
    case MSG.CHAT_RETRY:
      return retryLast();
    case MSG.CHAT_RESET:
      return state.hash && setChat(null);
    case MSG.HELLO:
      return post(port, snapshot());
    case MSG.RETRY_READER:
      return state.hash && startReader(state.hash, { retry: true });
    case MSG.GOTO:
      return sendForDoc(state.hash, { type: MSG.GOTO, n: msg.n });
  }
}

// Who may connect, from what the browser reports about the sender (not from the page):
// - viewer: our viewer.html as the top frame of a tab that has access to the document in its URL
// - side panel: our sidepanel.html. Chrome reports the real side panel without a tab and without a
//   frame ID; opened as a tab (tests), it must be the top frame.
async function checkPort(port) {
  const s = port.sender;
  if (s?.id !== chrome.runtime.id) return false;
  if (port.name === PORT.SIDEPANEL) return s.url === SIDEPANEL && (s.tab == null ? s.frameId == null : s.frameId === 0);
  if (s.frameId !== 0) return false;
  if (port.name !== PORT.VIEWER || s.tab?.id == null || !s.url?.startsWith(`${VIEWER}?`)) return false;
  const opened = await access.openedDocument(s.tab.id);
  const req = await viewerRequest(s);
  return !!opened && req?.url === opened;
}

chrome.runtime.onConnect.addListener((port) => {
  const entry = { kind: port.name === PORT.SIDEPANEL ? 'panel' : 'viewer', tabId: port.sender?.tab?.id ?? null, hash: null };
  entry.ok = checkPort(port).catch(() => false);
  ports.set(port, entry);
  port.onDisconnect.addListener(() => ports.delete(port));
  port.onMessage.addListener((msg) => onPortMessage(msg, port));
  entry.ok.then((ok) => {
    if (ok) return;
    post(port, { type: MSG.DENIED });
    ports.delete(port);
    port.disconnect();
  });
});

// A key was entered after reading failed for lack of one: try again.
chrome.storage.onChanged.addListener((changes, area) => {
  const keySet = Object.entries(changes).some(([k, c]) => /^apiKey(:|$)/.test(k) && c.newValue);
  if ((area === 'session' || area === 'local') && keySet && state.hash && state.reader.status === 'error') startReader(state.hash);
});
