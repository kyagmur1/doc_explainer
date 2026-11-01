// Side panel: the answer for the selection, a chat for follow-up questions (about the
// selection, or about the page in view), the document-reader status, and settings.

import { PORT, MSG } from './lib/messages.js';
import { checkKey, webSearchStatus, getApiKey } from './lib/gemini.js';
import { splitExplanation, bodyToHtml, inlineToHtml, badgeText, readerNote } from './lib/render.js';
import { initTheme } from './lib/theme.js';
import { initSourceSwitch } from './lib/source-switch.js';
import { initI18n, t, currentLanguage, LANGUAGES } from './lib/i18n.js';

initTheme();
initSourceSwitch();

const $ = (id) => document.getElementById(id);
let port = null;
let hash = null;
let focus = null; // page in view
let chat = null; // see MSG.CHAT
let title = null; // document in front
let reader = { status: 'idle' };
let selection = null; // last EXPLAIN message

let denied = false;

function connect() {
  port = chrome.runtime.connect({ name: PORT.SIDEPANEL });
  port.onMessage.addListener(onMessage);
  port.onDisconnect.addListener(() => denied || setTimeout(connect, 200));
  port.postMessage({ type: MSG.HELLO });
}
connect();

function onMessage(msg) {
  if (msg.type === MSG.DENIED) return (denied = true);
  if (msg.type === MSG.SNAPSHOT) {
    hash = msg.hash;
    focus = msg.focus;
    title = msg.title;
    selection = msg.selection;
    $('title').textContent = title ?? t('noDocument');
    $('selection-section').hidden = !msg.selection;
    renderReader(msg.reader);
    if (msg.selection) renderSelection(msg.selection);
    renderChat(msg.chat);
    return;
  }
  if (msg.hash && msg.hash !== hash) return;
  if (msg.type === MSG.READER_STATUS) renderReader(msg);
  if (msg.type === MSG.EXPLAIN) renderSelection(msg);
  if (msg.type === MSG.CHAT) renderChat(msg.chat);
  if (msg.type === MSG.PAGE_FOCUS) {
    focus = msg.n;
    renderChat(chat);
  }
}

function renderReader(next) {
  reader = next;
  const el = $('reader');
  el.className = `reader ${reader.status}`;
  if (reader.status === 'ready') el.textContent = t('readerReady');
  else if (reader.status === 'reading') el.textContent = readerNote(reader);
  else if (reader.status === 'error') el.innerHTML = `${readerNote(reader)} ${inlineToHtml(reader.error || '')} <button id="retry" type="button">${t('retry')}</button>`;
  else el.textContent = '';
}

// lang: the language the answer was asked in; a note if another one is chosen now.
function answerHtml(text, done, error, lang) {
  const { tldr, body } = splitExplanation(text);
  return (
    (tldr ? `<p class="tldr" dir="auto">${inlineToHtml(tldr)}</p>` : '') +
    bodyToHtml(body) +
    (done ? '' : '<p class="muted">…</p>') +
    (error ? `<p class="error">${inlineToHtml(error)}</p>` : '') +
    (done && lang && lang !== currentLanguage() ? `<p class="muted small">${t('answerInLanguage', { language: LANGUAGES[lang] })}</p>` : '')
  );
}

function renderSelection(msg) {
  selection = msg;
  $('selection-section').hidden = false;
  $('selection-label').textContent = t('selectionPage', { n: msg.n });
  $('selection-quote').textContent = msg.selection ?? '';
  const badge = $('selection-badge');
  badge.textContent = badgeText(msg.level, msg.source);
  badge.className = `badge ${msg.level}`;
  badge.hidden = !badge.textContent;
  $('selection').innerHTML = msg.text ? answerHtml(msg.text, msg.done, msg.error, msg.lang) : msg.error ? `<p class="error">${inlineToHtml(msg.error)}</p>` : `<p class="muted">${t('explaining')}…</p>`;
  renderChat(chat);
}

// ---------- Chat ----------

function renderChat(next) {
  chat = next;
  const open = !!hash;
  $('chat-section').hidden = !open;
  $('empty').hidden = !!(chat?.selection || chat?.messages.length || !$('selection-section').hidden);
  if (!open) return;

  // A failed or interrupted answer keeps the text that arrived; the last one offers "Retry".
  const messages = chat?.messages ?? [];
  const last = messages.at(-1);
  const canRetry = last?.role === 'model' && last.done && !!last.error;
  $('chat').innerHTML = messages
    .map((m) =>
      m.role === 'user'
        ? `<p class="msg user" dir="auto">${inlineToHtml(m.text)}</p>`
        : `<div class="msg model${m.interrupted ? ' interrupted' : ''}">${m.text ? answerHtml(m.text, m.done, m.error, m.lang) : m.error ? `<p class="error">${inlineToHtml(m.error)}</p>` : `<p class="muted">${t('thinking')}</p>`}${m === last && canRetry ? `<button type="button" class="link retry-chat">${t('retry')}</button>` : ''}</div>`,
    )
    .join('');
  const busy = !!chat?.messages.some((m) => !m.done);
  $('ask').disabled = busy;
  $('question').placeholder = chat?.selection ? t('askSelection') : t('askPage', { n: focus ?? 1 });
  $('new-chat').hidden = !(chat?.selection || chat?.messages.length);
}

$('ask-form').addEventListener('submit', (e) => {
  e.preventDefault();
  const question = $('question').value.trim();
  if (!question || $('ask').disabled) return;
  port.postMessage({ type: MSG.CHAT_ASK, question });
  $('question').value = '';
});

// Enter sends, Shift+Enter makes a new line.
$('question').addEventListener('keydown', (e) => {
  if (e.key === 'Enter' && !e.shiftKey) {
    e.preventDefault();
    $('ask-form').requestSubmit();
  }
});

$('new-chat').addEventListener('click', () => port.postMessage({ type: MSG.CHAT_RESET }));
$('chat').addEventListener('click', (e) => e.target.closest('.retry-chat') && port.postMessage({ type: MSG.CHAT_RETRY }));

document.addEventListener('click', (e) => {
  const cite = e.target.closest('[data-goto]');
  if (cite) {
    e.preventDefault();
    port.postMessage({ type: MSG.GOTO, n: Number(cite.dataset.goto) });
  }
  if (e.target.id === 'retry') port.postMessage({ type: MSG.RETRY_READER });
});

// ---------- Settings: the Gemini API key ----------
// Kept in chrome.storage.session (memory; gone when the browser closes) or, with "Remember on
// this device", in chrome.storage.local (this computer's Chrome profile; never storage.sync).
// Always in one of the two only. It is checked with Google's free model list before saving,
// and never shown again or logged.

const remembered = async () => !!(await chrome.storage.local.get('apiKey')).apiKey;

async function storeKey(key, onDevice) {
  if (onDevice) {
    await chrome.storage.local.set({ apiKey: key });
    await chrome.storage.session.remove('apiKey');
  } else {
    await chrome.storage.session.set({ apiKey: key });
    await chrome.storage.local.remove('apiKey');
  }
}

async function showKeyState() {
  const apiKey = await getApiKey();
  const onDevice = await remembered();
  $('api-key').value = '';
  $('api-key').placeholder = apiKey ? t(onDevice ? 'keySavedDevice' : 'keySaved') : t('pasteKey');
  $('forget-key').hidden = !apiKey;
  if (apiKey) $('remember-key').checked = onDevice;
  if (!apiKey) {
    $('settings').open = true;
    $('key-status').textContent = t('noKeyYet');
  } else {
    const search = (await webSearchStatus()) === 'available' ? t('searchAvailable') : t('searchUnavailable');
    $('key-status').textContent = t(onDevice ? 'keySavedDeviceStatus' : 'keySavedStatus', { status: search });
  }
}

$('key-form').addEventListener('submit', async (e) => {
  e.preventDefault();
  const key = $('api-key').value.trim();
  if (!key) return;
  $('save-key').disabled = true;
  $('key-status').textContent = t('checkingKey');
  const problem = await checkKey(key);
  $('save-key').disabled = false;
  if (problem) {
    $('key-status').textContent = problem;
    return;
  }
  await storeKey(key, $('remember-key').checked);
  await showKeyState();
});

// Changed after the key was saved: the key moves there right away.
$('remember-key').addEventListener('change', async () => {
  const key = await getApiKey();
  if (!key) return;
  await storeKey(key, $('remember-key').checked);
  await showKeyState();
});

$('forget-key').addEventListener('click', async () => {
  await chrome.storage.session.remove('apiKey');
  await chrome.storage.local.remove('apiKey');
  $('remember-key').checked = false;
  await showKeyState();
});

// The language changed: redraw everything that was drawn with the old one.
initI18n(() => {
  $('title').textContent = title ?? t('noDocument');
  renderReader(reader);
  if (selection) renderSelection(selection);
  renderChat(chat);
  showKeyState();
});

// Keep the service worker running while the panel is open (a chat answer can take a while).
setInterval(() => port?.postMessage({ type: MSG.PING }), 20_000);
