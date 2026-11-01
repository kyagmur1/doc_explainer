// Viewer page. PDFs opened in Chrome arrive here as viewer.html?token=...&file=<URL> (see
// background.js). The viewer loads the file, draws every page with pdf.js exactly as in the
// file (plus an invisible text layer for selecting), and tracks which page is in view (only
// as context for chat; scrolling never asks the AI anything). When text is selected it shows
// an Explain button; one click sends one request and the answer appears in the bubble.

import { parsePdf, docText } from './lib/pdf-doc.js';
import { parseViewerQuery, isPdfBytes, pdfNameFor } from './lib/pdf-routing.js';
import { PORT, MSG } from './lib/messages.js';
import { initTheme } from './lib/theme.js';
import { initSourceSwitch } from './lib/source-switch.js';
import { initI18n, t } from './lib/i18n.js';
import { enableSelection } from './lib/text-selection.js';
import * as pdfjsLib from './vendor/pdfjs/pdf.min.mjs';
import './bubble.js';
import { initNav } from './nav.js';

pdfjsLib.GlobalWorkerOptions.workerSrc = chrome.runtime.getURL('vendor/pdfjs/pdf.worker.min.mjs');
initTheme();
initSourceSwitch();
initI18n(() => {
  bubble.relabel();
  nav?.relabel();
});

const FOCUS_PAUSE_MS = 300; // report the page in view once scrolling settles
const PING_MS = 20_000;

const $ = (id) => document.getElementById(id);
const pagesEl = $('pages');
const bubble = $('bubble');

let doc = null; // { hash, title, pdf, pages } from parsePdf
let port = null;
let focus = null; // page in view right now
let sentFocus = null; // page last reported to the background
let focusTimer = null;
let windowId = null;
let pendingSelection = null; // { n, text, range }: selected, Explain not clicked yet
let shownSelection = null; // { id, range }: the selection whose answer the bubble shows

chrome.windows.getCurrent().then((w) => (windowId = w.id));

function el(tag, attrs = {}, ...children) {
  const node = document.createElement(tag);
  Object.assign(node, attrs);
  node.append(...children.filter((c) => c != null));
  return node;
}

// ---------- Port to the background ----------
// Opened only after the background authorized this tab's document (load()); the background checks
// again when the port connects and refuses it otherwise. Reconnects if the service worker restarts.

let denied = false;
let retryMs = 200;

function connect() {
  port = chrome.runtime.connect({ name: PORT.VIEWER });
  const connectedAt = Date.now();
  port.onMessage.addListener(onMessage);
  port.onDisconnect.addListener(() => {
    port = null;
    if (denied) return; // no access (any more): don't knock again
    retryMs = Date.now() - connectedAt < 1000 ? Math.min(retryMs * 2, 5000) : 200;
    setTimeout(() => {
      connect();
      if (doc) {
        send({ type: MSG.DOC_LOADED, hash: doc.hash, doc: docText(doc) });
        if (sentFocus != null) send({ type: MSG.PAGE_FOCUS, hash: doc.hash, n: sentFocus });
      }
    }, retryMs);
  });
}

function send(msg) {
  port?.postMessage(msg);
}

setInterval(() => send({ type: MSG.PING }), PING_MS);

function onMessage(msg) {
  if (msg.type === MSG.DENIED) return (denied = true);
  if (!doc || (msg.hash && msg.hash !== doc.hash)) return;
  if (msg.type === MSG.EXPLAIN) {
    if (msg.id === shownSelection?.id) bubble.showSelection(msg, shownSelection.range.getBoundingClientRect());
  } else if (msg.type === MSG.READER_STATUS) {
    bubble.setReader(msg);
  } else if (msg.type === MSG.SNAPSHOT) {
    bubble.setReader(msg.reader);
  } else if (msg.type === MSG.GOTO) {
    goto(msg.n);
  }
}

// ---------- Side panel ----------

function openPanel() {
  if (windowId != null) chrome.sidePanel.open({ windowId }).catch((err) => showError(t('openPanelFailed', { error: err.message })));
}
$('open-panel').addEventListener('click', openPanel);
bubble.addEventListener('more', openPanel);
bubble.addEventListener('goto', (e) => goto(e.detail));

// ---------- Messages to the user ----------

// The background acts on this viewer's own URL (which document), so these messages carry no URL.
function ask(type) {
  return chrome.runtime.sendMessage({ type }).then((r) => r?.ok || showError(t('couldNotOpen', { error: r?.error ?? t('unknownError') })));
}

// Error box at the bottom. With `url`, it offers ways out: retry, Chrome's own viewer, download.
function showError(text, url = null) {
  const box = $('error');
  box.hidden = !text;
  box.replaceChildren();
  if (!text) return;
  box.append(el('p', { textContent: text }));
  if (!url) return;
  box.append(
    el(
      'div',
      { className: 'error-actions' },
      el('button', { type: 'button', textContent: t('retry'), onclick: () => location.reload() }),
      el('button', { type: 'button', textContent: t('openInChrome'), onclick: () => ask(MSG.OPEN_ORIGINAL) }),
      url.startsWith('file:') ? null : el('a', { href: url, textContent: t('download'), target: '_blank', rel: 'noopener' }),
    ),
  );
}

// No access (yet) in this tab: nothing is loaded until the user clicks "Open again", which
// goes to the original address and gets a fresh grant from the background if it is a PDF.
function showReopen(url) {
  $('message').hidden = false;
  $('message').replaceChildren(
    el('p', {}, el('strong', { textContent: t('openAgainTitle') })),
    el('p', { className: 'url', textContent: decodeURI(url) }),
    el('button', { type: 'button', className: 'primary', textContent: t('openAgain'), onclick: () => ask(MSG.REOPEN) }),
    el('p', { textContent: t('openAgainNote') }),
  );
}

function setStatus(title, position = '') {
  $('doc-title').textContent = title;
  $('position').textContent = position;
}

// ---------- Loading the PDF ----------

// Local files: fetch() can't read file: URLs, XHR can (once "Allow access to file URLs" is on).
function readFileUrl(url) {
  return new Promise((resolve, reject) => {
    const xhr = new XMLHttpRequest();
    xhr.open('GET', url);
    xhr.responseType = 'arraybuffer';
    xhr.onload = () => (xhr.response?.byteLength ? resolve(xhr.response) : reject(new Error(t('fileEmpty'))));
    xhr.onerror = () => reject(new Error(t('fileUnreadable')));
    xhr.send();
  });
}

// Returns { buffer, name }. Throws an Error whose message is shown to the user.
async function readPdf(url) {
  let name = pdfNameFor(url);
  let buffer;
  if (url.startsWith('file:')) {
    if (!(await chrome.extension.isAllowedFileSchemeAccess())) {
      throw new Error(t('fileAccess'));
    }
    buffer = await readFileUrl(url).catch((err) => {
      throw new Error(t('couldNotLoad', { name, error: err.message }));
    });
  } else {
    // credentials: 'include' sends the site's cookies, so logged-in downloads keep working.
    // The extension has host access, so CORS doesn't apply.
    const res = await fetch(url, { credentials: 'include' }).catch((err) => {
      throw new Error(t('couldNotLoad', { name, error: err.message }));
    });
    if (!res.ok) {
      const hint = res.status === 401 || res.status === 403 ? ` ${t('signInHint')}` : '';
      throw new Error(t('httpError', { name, status: res.status }) + hint);
    }
    name = pdfNameFor(res.url || url, res.headers.get('content-disposition') ?? '');
    buffer = await res.arrayBuffer();
  }
  if (!isPdfBytes(buffer)) {
    // Typical for expired links or sessions: the server answers with a sign-in or error page.
    throw new Error(t('notPdf', { name }));
  }
  return { buffer, name };
}

async function load() {
  if (!parseViewerQuery(location.search)) {
    $('message').hidden = false;
    return;
  }
  // Ask the background whether this tab may load its document (see background.js, access.js).
  const access = await chrome.runtime.sendMessage({ type: MSG.AUTHORIZE }).catch(() => null);
  if (!access?.ok) {
    if (access?.url) return showReopen(access.url);
    return showError(t('linkInvalid'));
  }
  const { url } = access;
  history.replaceState(null, '', `?doc=${access.doc}${location.hash}`); // short address; reload asks again
  connect();

  try {
    setStatus(pdfNameFor(url), t('loading'));
    const { buffer, name } = await readPdf(url);
    doc = await parsePdf(buffer, { pdfjsLib, fileName: name });
  } catch (err) {
    setStatus($('doc-title').textContent);
    return showError(err.message, url);
  }
  if (!doc.pages.length) return showError(t('noPages'), url);

  render();
  send({ type: MSG.DOC_LOADED, hash: doc.hash, doc: docText(doc) });
  const page = /page=(\d+)/.exec(location.hash)?.[1]; // e.g. report.pdf#page=4
  if (page) goto(Number(page));
}

// ---------- Drawing the pages ----------

// Each page starts as an empty box with the page's aspect ratio. Canvas and text layer are
// added only when it comes near the viewport, so long PDFs open fast.
function pageBox(page) {
  const box = el('section', { className: 'page', id: `page-${page.n}` });
  box.dataset.page = page.n;
  box.style.aspectRatio = `${page.width} / ${page.height}`;
  box.style.maxWidth = `${Math.round(page.width * 1.6)}px`; // don't blow small pages up beyond ~160%
  return box;
}

async function drawPage(box) {
  if (box.dataset.drawn) return;
  box.dataset.drawn = '1';
  const page = await doc.pdf.getPage(Number(box.dataset.page));
  const scale = box.clientWidth / page.getViewport({ scale: 1 }).width;
  const viewport = page.getViewport({ scale });
  const dpr = devicePixelRatio || 1;

  const canvas = el('canvas', { width: Math.floor(viewport.width * dpr), height: Math.floor(viewport.height * dpr) });
  const textLayer = el('div', { className: 'textLayer' });
  box.style.setProperty('--scale-factor', scale);
  box.append(canvas, textLayer);

  await page.render({ canvasContext: canvas.getContext('2d'), viewport, transform: dpr !== 1 ? [dpr, 0, 0, dpr, 0, 0] : null }).promise;
  await new pdfjsLib.TextLayer({ textContentSource: page.streamTextContent(), container: textLayer, viewport }).render();
  enableSelection(textLayer);
}

// When the page area changes width (window resized, navigation panel opened or closed), the
// canvas just stretches with CSS; the text layer follows --scale-factor.
new ResizeObserver(() => {
  if (!doc) return;
  for (const box of pagesEl.querySelectorAll('.page[data-drawn]')) {
    box.style.setProperty('--scale-factor', box.clientWidth / doc.pages[box.dataset.page - 1].width);
  }
}).observe(pagesEl);

// The navigation panel sits below the top bar, whose height changes when it wraps.
new ResizeObserver(([entry]) => document.documentElement.style.setProperty('--topbar-h', `${entry.target.offsetHeight}px`)).observe(document.querySelector('.topbar'));

let nav = null; // navigation panel (nav.js), once the document is drawn

const ratios = new Map(); // page n -> share of the viewport it covers

function render() {
  pagesEl.replaceChildren(...doc.pages.map(pageBox));
  pagesEl.hidden = false;
  setStatus(doc.title);
  setUpPager();
  nav = initNav({ doc, jump });
  document.title = `${doc.title} · Doc Explainer`;

  const focusObserver = new IntersectionObserver(onIntersect, { threshold: [0, 0.1, 0.25, 0.5, 0.75, 0.9, 1] });
  const drawObserver = new IntersectionObserver(
    (entries) => {
      for (const e of entries) {
        if (e.isIntersecting) drawPage(e.target).catch((err) => showError(t('couldNotDraw', { n: e.target.dataset.page, error: err.message })));
      }
    },
    { rootMargin: '1000px 0px' },
  );
  for (const box of pagesEl.children) {
    focusObserver.observe(box);
    drawObserver.observe(box);
  }
}

// ---------- Which page is in view ----------

function onIntersect(entries) {
  for (const e of entries) {
    // Share of the viewport, so a tall page still wins when it fills the screen.
    ratios.set(Number(e.target.dataset.page), e.isIntersecting ? e.intersectionRect.height / innerHeight : 0);
  }
  let best = null;
  for (const [n, r] of ratios) if (r > 0 && (best == null || r > ratios.get(best))) best = n;
  if (best == null || best === focus) return;
  focus = best;
  showPage();
  nav?.setCurrent(focus);
  reportFocus();
}

// ---------- Page number box: type a page number, Enter jumps there ----------

const pageInput = $('page-input');

function showPage() {
  if (document.activeElement !== pageInput) pageInput.value = focus ?? 1;
}

function setUpPager() {
  $('position').textContent = '';
  $('page-total').textContent = `/ ${doc.pages.length}`;
  pageInput.style.width = `${String(doc.pages.length).length + 2}ch`;
  $('pager').hidden = false;
  showPage();
}

pageInput.addEventListener('focus', () => pageInput.select());
pageInput.addEventListener('blur', showPage); // a number not confirmed with Enter is dropped
pageInput.addEventListener('keydown', (e) => {
  if (e.key === 'Escape') return pageInput.blur();
  if (e.key !== 'Enter') return;
  const n = /^\s*\d+\s*$/.test(pageInput.value) ? Number(pageInput.value) : NaN;
  if (n >= 1 && n <= doc.pages.length) jump({ n, top: null });
  pageInput.blur();
});

// Tells the background which page is in view (chat context only, no AI request).
function reportFocus() {
  clearTimeout(focusTimer);
  focusTimer = setTimeout(() => {
    if (focus == null || focus === sentFocus) return;
    sentFocus = focus;
    send({ type: MSG.PAGE_FOCUS, hash: doc.hash, n: focus });
  }, FOCUS_PAUSE_MS);
}

// smooth for nearby pages (links in answers); a typed page number jumps at once.
function goto(n, { smooth = true } = {}) {
  $(`page-${n}`)?.scrollIntoView({ behavior: smooth ? 'smooth' : 'instant', block: 'start' });
}

// Jumps at once to page n (page box, contents, thumbnails); with `top` (a PDF y coordinate, as in
// an outline entry's destination) to that place on the page. The page is shown and reported
// right away; the observer confirms it after the jump.
async function jump({ n, top }) {
  if (!(n >= 1 && n <= doc.pages.length)) return;
  focus = n;
  showPage();
  nav?.setCurrent(n);
  reportFocus();
  const box = $(`page-${n}`);
  if (top == null) return goto(n, { smooth: false });
  const page = await doc.pdf.getPage(n);
  const viewport = page.getViewport({ scale: box.clientWidth / page.getViewport({ scale: 1 }).width });
  const [, y] = viewport.convertToViewportPoint(0, top);
  const below = document.querySelector('.topbar').offsetHeight + 8;
  window.scrollTo({ top: box.getBoundingClientRect().top + scrollY + Math.max(0, y) - below, behavior: 'instant' });
}

// ---------- Selection: Explain button, one request per click ----------

function closeBubble() {
  shownSelection = null;
  bubble.hide();
}

// A click anywhere outside the bubble closes it, and hides the old Explain button so it
// can't get in the way of a new drag. Dragging the page's scrollbar doesn't count.
document.addEventListener('pointerdown', (e) => {
  if (e.composedPath().includes(bubble)) return;
  const onScrollbar = e.target === document.documentElement && e.clientX >= document.documentElement.clientWidth;
  if (onScrollbar) return;
  bubble.hideChip();
  if (shownSelection) closeBubble();
});

addEventListener('keydown', (e) => e.key === 'Escape' && shownSelection && closeBubble());

document.addEventListener('mouseup', (e) => {
  if (e.composedPath().includes(bubble)) return;
  setTimeout(() => {
    const sel = getSelection();
    const text = sel.toString().trim();
    if (!doc || sel.isCollapsed || text.length < 2) {
      pendingSelection = null;
      return bubble.hideChip();
    }
    const range = sel.getRangeAt(0);
    const node = range.commonAncestorContainer;
    const box = (node.nodeType === Node.ELEMENT_NODE ? node : node.parentElement).closest('[data-page]');
    if (!box) return bubble.hideChip();
    // A copy of the range keeps pointing at the text even after the selection is cleared,
    // so the bubble can stay next to it while the page scrolls.
    pendingSelection = { n: Number(box.dataset.page), text: text.slice(0, 1000), range: range.cloneRange() };
    bubble.showChip(range.getBoundingClientRect());
  });
});

bubble.addEventListener('explain-selection', () => {
  if (!pendingSelection) return;
  const { n, text, range } = pendingSelection;
  pendingSelection = null; // one click, one request
  const id = crypto.randomUUID(); // unique across viewer reloads, so old answers never match
  shownSelection = { id, range };
  bubble.showSelection({ id, n, text: '', done: false }, range.getBoundingClientRect());
  send({ type: MSG.SELECTION, hash: doc.hash, n, text, id });
});

// The answer is in another language than the one now chosen: the same selection, asked again.
bubble.addEventListener('explain-again', (e) => {
  if (!shownSelection) return;
  const { n, text } = e.detail;
  const id = crypto.randomUUID();
  shownSelection = { id, range: shownSelection.range };
  bubble.showSelection({ id, n, text: '', done: false }, shownSelection.range.getBoundingClientRect());
  send({ type: MSG.SELECTION, hash: doc.hash, n, text, id });
});

// Scrolling keeps the bubble open and moves it with the selected text.
// (The Explain button doesn't follow; it hides until the next selection.)
addEventListener('scroll', () => {
  bubble.hideChip();
  if (shownSelection) bubble.follow(shownSelection.range.getBoundingClientRect());
}, { passive: true });

load();
