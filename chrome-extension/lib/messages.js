// Message types between viewer, side panel and background (chrome.runtime ports, except
// AUTHORIZE, REOPEN and OPEN_ORIGINAL which are one-off chrome.runtime.sendMessage calls).

export const PORT = { VIEWER: 'viewer', SIDEPANEL: 'sidepanel' };

export const MSG = {
  // viewer -> background
  DOC_LOADED: 'doc-loaded', // { hash, doc }  doc = docText(...)
  PAGE_FOCUS: 'page-focus', // { hash, n }  page in view; context for chat only, never triggers a request (also background -> all)
  SELECTION: 'selection', // { hash, n, text, id }  the user clicked Explain
  PING: 'ping', // keeps the service worker alive during long reader calls
  // viewer -> background, one-off chrome.runtime.sendMessage; the document comes from the
  // viewer's URL as the browser reports it, never from the message (see background.js)
  AUTHORIZE: 'authorize', // -> { ok: true, url, doc } | { ok: false, url? }
  REOPEN: 'reopen', // "Open again": go to the original URL, which grants it anew
  OPEN_ORIGINAL: 'open-original', // open the PDF in Chrome's own viewer

  // side panel -> background
  HELLO: 'hello', // asks for a SNAPSHOT
  RETRY_READER: 'retry-reader',
  CHAT_ASK: 'chat-ask', // { question }
  CHAT_RETRY: 'chat-retry', // ask the last question again after its answer failed or was interrupted
  CHAT_RESET: 'chat-reset', // start a new chat about the current page

  // side panel -> background -> the viewer(s) of the document in front
  GOTO: 'goto', // { n }

  // background -> only the ports of that document (viewers) / the side panels (document in front)
  SNAPSHOT: 'snapshot', // { hash, title, pageCount, focus, reader, selection, chat }
  READER_STATUS: 'reader-status', // { hash, status: 'reading'|'ready'|'error', error?, progress?: { done, total } }
  EXPLAIN: 'explain', // { hash, id, n, selection, level, source, text, done, error?, cached? }  level: see LEVEL_LABEL
  CHAT: 'chat', // { hash, chat: { id, selection: { n, text } | null, messages: [{ id, role, text, done, error?, interrupted? }] } | null }
  DENIED: 'denied', // the port was refused (no access); the page should not reconnect
};

// Preferences (chrome.storage.sync). API keys are NOT here: they live in chrome.storage.session
// or, if the user chooses, chrome.storage.local (see sidepanel.js, llm.js).
export const DEFAULT_SETTINGS = {
  theme: 'system', // 'system' | 'light' | 'dark', see theme.js
  source: 'document', // 'document' = only the document | 'web' = web assisted, see source-switch.js
  lang: 'en', // interface and answer language, see i18n.js
  nav: { open: false, tab: 'outline' }, // viewer's navigation panel, see nav.js
  provider: 'gemini', // 'gemini' | 'openai' | 'anthropic', see llm.js
};

export async function getSettings() {
  return { ...DEFAULT_SETTINGS, ...(await chrome.storage.sync.get(DEFAULT_SETTINGS)) };
}
