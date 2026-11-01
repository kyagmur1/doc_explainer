// Gemini REST client for the extension's service worker (no SDK, no server).
//
// - The API key is entered in the side panel and kept in chrome.storage.session (gone when the
//   browser closes) or, with "Remember on this device", in chrome.storage.local (this computer's
//   Chrome profile, unencrypted; never storage.sync). It is sent only in the x-goog-api-key
//   header: never in a URL, never logged.
// - Every call goes through a per-model rate limiter whose counters live in storage.session,
//   so they survive a service-worker restart. 429/503 are retried a bounded number of times.
// - Errors leave this file as short, readable messages.
// - Cancelling: every call takes an optional AbortSignal (the background aborts when the
//   document's last tab closes). It removes a waiting call from the rate-limit queue, stops a
//   retry wait, and aborts the fetch, so no further request is sent. This only stops our side:
//   the Gemini API has no server-side cancel for generateContent/streamGenerateContent, and the
//   @google/genai docs say an abort "will not cancel the request in the service. You will still be
//   charged". So a request already sent may still be generated and billed by Google.

import { RateLimiter, PRIORITY } from './limiter.js';
import { estimateTokens } from './prompts.js';
import { t } from './i18n.js';

export { PRIORITY };

export const GEMINI_BASE = 'https://generativelanguage.googleapis.com/v1beta';

export const config = {
  readerModel: 'gemini-3.8-flash',
  readerThinking: 'LOW',
  explainerModel: 'gemini-3.5-flash-lite',
  explainerThinking: 'MINIMAL',
  maxOutputExplain: 1024, // includes thinking tokens, billed as output
  maxOutputReader: 8192,
  timeoutMs: 90_000,
  tpm: 200_000, // a bit under the free tier's 250k input tokens per minute
  rpm: 10,
  retries: true, // false: a 429/503 is reported at once, never asked again (used by test/real)
  searchFallback: true, // false: a key without Google Search fails instead of answering without it
};

// How long to keep retrying: the user is waiting for USER requests, not for BACKGROUND ones.
const RETRY = {
  [PRIORITY.USER]: { maxRetries: 2, maxWaitMs: 20_000 },
  [PRIORITY.BACKGROUND]: { maxRetries: 5, maxWaitMs: 90_000 },
};

const short = (message, extra = {}) => Object.assign(new Error(message), { short: true, retryable: false, ...extra });

// The key: this session's, else the one remembered on this device.
export async function getApiKey() {
  return (await chrome.storage.session.get('apiKey')).apiKey ?? (await chrome.storage.local.get('apiKey')).apiKey ?? null;
}

async function connection() {
  const apiKey = await getApiKey();
  if (!apiKey) throw short(t('errNoKey'), { status: 401, noKey: true });
  const base = GEMINI_BASE;
  return { apiKey, base };
}

// HTTP error response -> short Error with retry hints.
export function errorFrom(status, raw) {
  const make = (message, extra = {}) => short(message, { status, ...extra });
  if (status === 429) {
    if (/PerDay/i.test(raw)) return make(t('errDaily'));
    const delay = /"retryDelay"\s*:\s*"(\d+(?:\.\d+)?)s"/.exec(raw)?.[1];
    // No wait and no per-minute quota named: "not allowed for this key" (e.g. Google Search on the free tier).
    if (delay == null && !/PerMinute/i.test(raw)) return make(t('errNoQuota'), { noQuota: true });
    const s = Number(delay ?? 30);
    return make(t('errMinute', { s: Math.ceil(s) }), { retryable: true, retryAfterMs: Math.ceil(s * 1000) });
  }
  if (status === 500 || status === 503) return make(t('errBusy'), { retryable: true, retryAfterMs: 5_000 });
  if (status === 400 && /API key not valid|API_KEY_INVALID/i.test(raw)) return make(t('errKeyInvalid'));
  if (status === 401 || status === 403) return make(t('errKeyRejected'));
  if (status === 400 && /token/i.test(raw)) return make(t('errTooLarge'));
  return make(t('errStatus', { status }));
}

// Thrown when our AbortSignal was used; callers treat it as "stopped on purpose", not an error to show.
export const cancelled = () => short('Cancelled.', { cancelled: true });

// fetch() failure (no response) -> short Error. `signal` is ours: aborted means cancelled.
function networkError(err, signal) {
  if (signal?.aborted) return cancelled();
  if (err?.name === 'TimeoutError' || err?.name === 'AbortError') return short(t('errTimeout'), { status: 504 });
  return short(t('errOffline'), { status: 0 });
}

async function post(path, payload, timeoutMs, signal) {
  const { apiKey, base } = await connection();
  if (signal?.aborted) throw cancelled();
  let res;
  try {
    res = await fetch(`${base}/${path}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'x-goog-api-key': apiKey },
      body: JSON.stringify(payload),
      signal: signal ? AbortSignal.any([signal, AbortSignal.timeout(timeoutMs)]) : AbortSignal.timeout(timeoutMs),
    });
  } catch (err) {
    throw networkError(err, signal);
  }
  if (!res.ok) throw errorFrom(res.status, await res.text().catch(() => ''));
  return res;
}

// Checks a key with the free model list (no tokens used). Returns null if fine, else a message.
export async function checkKey(apiKey) {
  const base = GEMINI_BASE;
  try {
    const res = await fetch(`${base}/models?pageSize=1`, { headers: { 'x-goog-api-key': apiKey }, signal: AbortSignal.timeout(15_000) });
    return res.ok ? null : errorFrom(res.status, await res.text().catch(() => '')).message;
  } catch (err) {
    return networkError(err).message;
  }
}

// contents: strings (parts of one user turn) or chat turns [{ role, parts: [{ text }] }].
function requestBody({ systemInstruction, contents, maxOutputTokens, thinkingLevel, search, schema }) {
  const turns = contents.every((c) => typeof c === 'string') ? [{ role: 'user', parts: contents.map((text) => ({ text })) }] : contents;
  return {
    contents: turns,
    systemInstruction: { parts: [{ text: systemInstruction }] },
    ...(search ? { tools: [{ googleSearch: {} }] } : {}),
    generationConfig: {
      maxOutputTokens,
      thinkingConfig: { thinkingLevel },
      ...(schema ? { responseMimeType: 'application/json', responseJsonSchema: schema } : {}),
    },
  };
}

function textOf(contents) {
  return contents.map((c) => (typeof c === 'string' ? c : c.parts.map((p) => p.text).join('\n'))).join('\n');
}

// ---------- Rate limiters, kept in storage.session ----------

const limiters = new Map(); // model -> Promise<RateLimiter>

function limiterFor(model) {
  if (!limiters.has(model)) {
    const key = `limiter:${model}`;
    limiters.set(
      model,
      chrome.storage.session.get(key).then((stored) => {
        const limiter = new RateLimiter({
          tpm: config.tpm,
          rpm: config.rpm,
          saved: stored[key],
          onChange: () => chrome.storage.session.set({ [key]: limiter.state() }).catch(() => {}),
        });
        return limiter;
      }),
    );
  }
  return limiters.get(model);
}

// A wait that ends early (rejects) when the signal aborts.
const sleep = (ms, signal) =>
  new Promise((resolve, reject) => {
    if (signal?.aborted) return reject(cancelled());
    const timer = setTimeout(resolve, ms);
    signal?.addEventListener('abort', () => (clearTimeout(timer), reject(cancelled())), { once: true });
  });

// Runs fn() under the rate limiter and retries retryable errors, a bounded number of times.
// fn returns { result, promptTokens }. canRetry() says whether a retry is still safe
// (a stream that already showed text can't be retried). An aborted signal ends everything:
// no queue place, no retry, no new request.
// onState (optional) reports what the call is doing: ('waiting', untilMs) for a rate-limit or
// retry wait of more than a second, ('sent') when a request goes out, ('settled') when it ended.
export async function withRetries(fn, { limiter, tokens, priority, label, canRetry = () => true, wait = sleep, signal = null, onState = () => {} }) {
  const { maxRetries, maxWaitMs } = config.retries ? RETRY[priority] : { maxRetries: 0, maxWaitMs: 0 };
  for (let attempt = 0; ; attempt++) {
    if (signal?.aborted) throw cancelled();
    const queued = limiter.waitMs(Math.min(tokens, limiter.tpm), Date.now());
    if (queued > 1000) onState('waiting', Date.now() + queued);
    const ticket = await limiter.acquire(tokens, priority, signal).catch(() => {
      throw cancelled();
    });
    onState('sent');
    try {
      const { result, promptTokens } = await fn().finally(() => onState('settled'));
      ticket.settle(promptTokens);
      return result;
    } catch (err) {
      if (signal?.aborted || err?.cancelled) throw cancelled();
      const e = err?.short ? err : short(t('errGeneric', { message: err?.message ?? err }));
      console.warn(`[gemini] ${label}: ${e.message}`);
      if (e.status === 429 && e.retryable) limiter.pauseFor(e.retryAfterMs);
      const delay = e.status === 429 ? e.retryAfterMs : (e.retryAfterMs ?? 0) * 2 ** attempt; // 503: 5, 10, 20 s ...
      if (!e.retryable || attempt >= maxRetries || delay > maxWaitMs || !canRetry()) throw e;
      console.log(`[gemini] ${label}: retry ${attempt + 1}/${maxRetries} in ${Math.round(delay / 1000)} s`);
      if (delay > 1000) onState('waiting', Date.now() + delay);
      await wait(delay + Math.random() * 500, signal);
    }
  }
}

function logUsage(label, model, usage) {
  if (!usage) return;
  console.log(`[usage] ${label} model=${model} in=${usage.promptTokenCount ?? 0} out=${usage.candidatesTokenCount ?? 0} thinking=${usage.thoughtsTokenCount ?? 0}`);
}

// ---------- Document reader: one-shot JSON, background priority ----------

export async function generateJson({ label, systemInstruction, contents, schema, signal = null, onState }) {
  const model = config.readerModel;
  const payload = requestBody({ systemInstruction, contents, schema, maxOutputTokens: config.maxOutputReader, thinkingLevel: config.readerThinking });
  return withRetries(
    async () => {
      let json;
      try {
        json = await (await post(`models/${model}:generateContent`, payload, config.timeoutMs * 2, signal)).json();
      } catch (err) {
        throw err?.short ? err : networkError(err, signal);
      }
      logUsage(label, model, json.usageMetadata);
      const text = json.candidates?.[0]?.content?.parts?.map((p) => p.text ?? '').join('') ?? '';
      try {
        return { result: JSON.parse(text), promptTokens: json.usageMetadata?.promptTokenCount };
      } catch {
        throw short(t('errIncomplete'), { status: 502 });
      }
    },
    { limiter: await limiterFor(model), tokens: estimateTokens(systemInstruction + textOf(contents)), priority: PRIORITY.BACKGROUND, label, signal, onState },
  );
}

// ---------- Explanations and chat: streamed, user priority ----------

// Server-sent events -> parsed JSON objects, as they arrive.
async function* sseJson(stream) {
  const decoder = new TextDecoder();
  let buffer = '';
  for await (const chunk of stream) {
    buffer += decoder.decode(chunk, { stream: true });
    let cut;
    while ((cut = buffer.search(/\r?\n\r?\n/)) >= 0) {
      const event = buffer.slice(0, cut);
      buffer = buffer.slice(cut).replace(/^\r?\n\r?\n/, '');
      const data = event.split(/\r?\n/).filter((l) => l.startsWith('data:')).map((l) => l.slice(5).trim()).join('');
      if (data) yield JSON.parse(data);
    }
  }
}

// Google Search can be unavailable for a key (the free tier refuses it). Then web-assisted
// answers go without search, and search isn't tried again for an hour (kept in storage.session).
const SEARCH_RECHECK_MS = 60 * 60_000;

export async function webSearchStatus() {
  const { searchUnavailableUntil = 0 } = await chrome.storage.session.get('searchUnavailableUntil');
  return Date.now() < searchUnavailableUntil ? 'unavailable for this API key' : 'available';
}

// onText(chunk) per piece. search: let the model use Google Search (it decides when).
// signal: aborting stops waiting, retrying and reading (see the note at the top).
export async function streamText({ label, systemInstruction, contents, onText, search = false, signal = null }) {
  const useSearch = search && (await webSearchStatus()) === 'available';
  try {
    return await streamOnce({ label, systemInstruction, contents, onText, search: useSearch, signal });
  } catch (err) {
    if (!useSearch || !err.noQuota || !config.searchFallback || signal?.aborted) throw err;
    await chrome.storage.session.set({ searchUnavailableUntil: Date.now() + SEARCH_RECHECK_MS });
    console.warn('[gemini] Google Search is not available for this API key; web-assisted answers use general knowledge only for the next hour.');
    return streamOnce({ label: `${label} no-search`, systemInstruction, contents, onText, search: false, signal });
  }
}

async function streamOnce({ label, systemInstruction, contents, onText, search, signal }) {
  const model = config.explainerModel;
  const payload = requestBody({ systemInstruction, contents, search, maxOutputTokens: config.maxOutputExplain, thinkingLevel: config.explainerThinking });
  let sentText = false;
  return withRetries(
    async () => {
      const res = await post(`models/${model}:streamGenerateContent?alt=sse`, payload, config.timeoutMs, signal);
      let usage;
      const searches = new Set();
      try {
        for await (const event of sseJson(res.body)) {
          const candidate = event.candidates?.[0];
          const text = candidate?.content?.parts?.map((p) => p.text ?? '').join('') ?? '';
          if (text) {
            sentText = true;
            onText(text);
          }
          if (event.usageMetadata) usage = event.usageMetadata;
          for (const q of candidate?.groundingMetadata?.webSearchQueries ?? []) searches.add(q);
        }
      } catch (err) {
        throw err?.short ? err : networkError(err, signal);
      }
      logUsage(search ? `${label} searches=${searches.size}` : label, model, usage);
      return { result: undefined, promptTokens: usage?.promptTokenCount };
    },
    { limiter: await limiterFor(model), tokens: estimateTokens(systemInstruction + textOf(contents)), priority: PRIORITY.USER, label, canRetry: () => !sentText, signal },
  );
}
