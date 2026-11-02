// AI client for the extension's service worker (no SDK, no server): one interface for Gemini,
// OpenAI and Anthropic. What differs (request bodies, streaming events, JSON output, errors,
// web search) is in lib/providers/<id>.js; everything around a call is here.
//
// - Keys are per provider, entered in the side panel, kept in chrome.storage.session (gone when
//   the browser closes) or, with "Remember on this device", in chrome.storage.local (this
//   computer's Chrome profile, unencrypted; never storage.sync). A key is sent only to its own
//   provider's official API address, in a header: never in a URL, never logged.
// - The provider in use is the `provider` setting (chrome.storage.sync, default 'gemini').
// - Every call goes through a per-model rate limiter whose counters live in storage.session,
//   so they survive a service-worker restart. 429/5xx are retried a bounded number of times.
// - Errors leave this file as short, readable messages.
// - Cancelling: every call takes an optional AbortSignal (the background aborts when the
//   document's last tab closes). It removes a waiting call from the rate-limit queue, stops a
//   retry wait, and aborts the fetch, so no further request is sent. This only stops our side:
//   none of the three APIs cancels generation when a client disconnects, so a request already
//   sent may still be generated and billed.

import { RateLimiter, PRIORITY } from './limiter.js';
import { estimateTokens } from './prompts.js';
import { t } from './i18n.js';
import { gemini } from './providers/gemini.js';
import { openai } from './providers/openai.js';
import { anthropic } from './providers/anthropic.js';

export { PRIORITY };

export const PROVIDERS = { gemini, openai, anthropic };
export const DEFAULT_PROVIDER = 'gemini';

// Not provider-specific. retries/searchFallback are switched off by test/real.
export const options = {
  timeoutMs: 90_000,
  retries: true, // false: a 429/5xx is reported at once, never asked again
  searchFallback: true, // false: a key without web search fails instead of answering without it
};

// How long to keep retrying: the user is waiting for USER requests, not for BACKGROUND ones.
const RETRY = {
  [PRIORITY.USER]: { maxRetries: 2, maxWaitMs: 20_000 },
  [PRIORITY.BACKGROUND]: { maxRetries: 5, maxWaitMs: 90_000 },
};

export const short = (message, extra = {}) => Object.assign(new Error(message), { short: true, retryable: false, ...extra });

// Thrown when our AbortSignal was used; callers treat it as "stopped on purpose", not an error to show.
export const cancelled = () => short('Cancelled.', { cancelled: true });

// fetch() failure (no response) -> short Error. `signal` is ours: aborted means cancelled.
function networkError(err, signal, p) {
  if (signal?.aborted) return cancelled();
  if (err?.name === 'TimeoutError' || err?.name === 'AbortError') return short(t('errTimeout', { provider: p.name }), { status: 504 });
  return short(t('errOffline', { provider: p.name }), { status: 0 });
}

// ---------- Provider, key, address ----------

export function providerFor(id) {
  return PROVIDERS[id] ?? PROVIDERS[DEFAULT_PROVIDER];
}

export async function activeProviderId() {
  const { provider } = await chrome.storage.sync.get('provider');
  return PROVIDERS[provider] ? provider : DEFAULT_PROVIDER;
}

async function resolve(id) {
  return providerFor(id ?? (await activeProviderId()));
}

// The key: this session's, else the one remembered on this device.
export async function getApiKey(id) {
  const k = (await resolve(id)).keyStorage;
  return (await chrome.storage.session.get(k))[k] ?? (await chrome.storage.local.get(k))[k] ?? null;
}

// Last check before a key leaves: the address must be this provider's own official API address.
function assertOwnAddress(p, url) {
  if (!url.startsWith(`${p.base}/`)) throw short(t('errStatus', { provider: p.name, status: 0 }), { status: 0 });
}

async function send(p, path, { method = 'POST', body, model, apiKey, timeoutMs, signal }) {
  const url = `${p.base}/${path}`;
  assertOwnAddress(p, url);
  if (signal?.aborted) throw cancelled();
  let res;
  try {
    res = await fetch(url, {
      method,
      headers: { ...(body ? { 'Content-Type': 'application/json' } : {}), ...p.headers(apiKey, model) },
      ...(body ? { body: JSON.stringify(body) } : {}),
      signal: signal ? AbortSignal.any([signal, AbortSignal.timeout(timeoutMs)]) : AbortSignal.timeout(timeoutMs),
    });
  } catch (err) {
    throw networkError(err, signal, p);
  }
  if (!res.ok) throw p.errorFrom(res.status, await res.text().catch(() => ''), short, res.headers);
  return res;
}

async function keyFor(p) {
  const apiKey = await getApiKey(p.id);
  if (!apiKey) throw short(t('errNoKey', { provider: p.name }), { status: 401, noKey: true });
  return apiKey;
}

// Checks a key without using tokens (Gemini: the model list; OpenAI/Anthropic: the models this
// extension uses, which also catches a model the key can't use). Returns null if fine, else a message.
export async function checkKey(apiKey, id) {
  const p = await resolve(id);
  // A key that is clearly another service's is not sent anywhere (it would go to the wrong company).
  const other = Object.values(PROVIDERS).find((o) => o !== p && o.keyPattern.test(apiKey) && !p.keyPattern.test(apiKey));
  if (other) return t('errOtherKey', { provider: p.name, other: other.name });
  try {
    for (const path of p.keyCheckPaths()) await send(p, path, { method: 'GET', apiKey, timeoutMs: 15_000 });
    return null;
  } catch (err) {
    return err.message;
  }
}

// ---------- Rate limiters, kept in storage.session ----------

const limiters = new Map(); // model -> Promise<RateLimiter>

function limiterFor(model, { tpm, rpm }) {
  if (!limiters.has(model)) {
    const key = `limiter:${model}`;
    limiters.set(
      model,
      chrome.storage.session.get(key).then((stored) => {
        const limiter = new RateLimiter({ tpm, rpm, saved: stored[key], onChange: () => chrome.storage.session.set({ [key]: limiter.state() }).catch(() => {}) });
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
  const { maxRetries, maxWaitMs } = options.retries ? RETRY[priority] : { maxRetries: 0, maxWaitMs: 0 };
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
      console.warn(`[ai] ${label}: ${e.message}`);
      if (e.status === 429 && e.retryable) limiter.pauseFor(e.retryAfterMs);
      const delay = e.status === 429 ? e.retryAfterMs : (e.retryAfterMs ?? 0) * 2 ** attempt; // 5xx: 5, 10, 20 s ...
      if (!e.retryable || attempt >= maxRetries || delay > maxWaitMs || !canRetry()) throw e;
      console.log(`[ai] ${label}: retry ${attempt + 1}/${maxRetries} in ${Math.round(delay / 1000)} s`);
      if (delay > 1000) onState('waiting', Date.now() + delay);
      await wait(delay + Math.random() * 500, signal);
    }
  }
}

function logUsage(label, model, usage) {
  if (!usage) return;
  console.log(`[usage] ${label} model=${model} in=${usage.input ?? 0} out=${usage.output ?? 0} thinking=${usage.thinking ?? 0}`);
}

function textOf(contents) {
  return contents.map((c) => (typeof c === 'string' ? c : c.parts.map((p) => p.text).join('\n'))).join('\n');
}

// ---------- Document reader: one-shot JSON, background priority ----------

export async function generateJson({ label, systemInstruction, contents, schema, signal = null, onState, provider }) {
  const p = await resolve(provider);
  const apiKey = await keyFor(p);
  const req = p.jsonRequest({ systemInstruction, contents, schema });
  return withRetries(
    async () => {
      let json;
      try {
        json = await (await send(p, req.path, { body: req.body, model: req.model, apiKey, timeoutMs: options.timeoutMs * 2, signal })).json();
      } catch (err) {
        throw err?.short ? err : networkError(err, signal, p);
      }
      const { text, usage } = p.parseJson(json, short);
      logUsage(label, req.model, usage);
      try {
        return { result: JSON.parse(text), promptTokens: usage?.input };
      } catch {
        throw short(t('errIncomplete', { provider: p.name }), { status: 502 });
      }
    },
    { limiter: await limiterFor(req.model, p.config), tokens: estimateTokens(systemInstruction + textOf(contents)), priority: PRIORITY.BACKGROUND, label, signal, onState },
  );
}

// ---------- Explanations and chat: streamed, user priority ----------

// Server-sent events -> parsed JSON objects, as they arrive (event: lines are not needed: every
// provider puts the event type in the data too).
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
      if (data && data !== '[DONE]') yield JSON.parse(data);
    }
  }
}

// Web search can be unavailable for a key (Gemini's free tier, an Anthropic organisation that
// hasn't enabled it, a model without the tool). Then web-assisted answers go without search, and
// search isn't tried again with that provider for an hour (kept in storage.session).
const SEARCH_RECHECK_MS = 60 * 60_000;

export async function webSearchStatus(id) {
  const k = (await resolve(id)).searchStatusKey;
  const { [k]: until = 0 } = await chrome.storage.session.get(k);
  return Date.now() < until ? 'unavailable for this API key' : 'available';
}

// onText(chunk) per piece. search: let the model search the web (it decides when).
// signal: aborting stops waiting, retrying and reading (see the note at the top).
// onState (optional): as in withRetries, so the page can show a rate-limit wait.
export async function streamText({ label, systemInstruction, contents, onText, search = false, signal = null, provider, onState }) {
  const p = await resolve(provider);
  const useSearch = search && (await webSearchStatus(p.id)) === 'available';
  try {
    return await streamOnce(p, { label, systemInstruction, contents, onText, search: useSearch, signal, onState });
  } catch (err) {
    if (!useSearch || !err.searchRefused || !options.searchFallback || signal?.aborted) throw err;
    await chrome.storage.session.set({ [p.searchStatusKey]: Date.now() + SEARCH_RECHECK_MS });
    console.warn(`[ai] Web search is not available for this ${p.name} API key; web-assisted answers use general knowledge only for the next hour.`);
    return streamOnce(p, { label: `${label} no-search`, systemInstruction, contents, onText, search: false, signal, onState });
  }
}

async function streamOnce(p, { label, systemInstruction, contents, onText, search, signal, onState }) {
  const apiKey = await keyFor(p);
  const req = p.streamRequest({ systemInstruction, contents, search });
  let sentText = false;
  return withRetries(
    async () => {
      const res = await send(p, req.path, { body: req.body, model: req.model, apiKey, timeoutMs: options.timeoutMs, signal });
      const acc = { usage: null, searches: 0, queries: new Set() };
      try {
        for await (const event of sseJson(res.body)) {
          const text = p.streamEvent(event, acc, short);
          if (text) {
            sentText = true;
            onText(text);
          }
        }
      } catch (err) {
        throw err?.short ? err : networkError(err, signal, p);
      }
      logUsage(search ? `${label} searches=${acc.searches}` : label, req.model, acc.usage);
      return { result: undefined, promptTokens: acc.usage?.input };
    },
    { limiter: await limiterFor(req.model, p.config), tokens: estimateTokens(systemInstruction + textOf(contents)), priority: PRIORITY.USER, label, canRetry: () => !sentText, signal, onState },
  );
}
