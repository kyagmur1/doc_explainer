// Google Gemini (generativelanguage.googleapis.com), REST.
//   explain/chat: models/<m>:streamGenerateContent?alt=sse   reader: models/<m>:generateContent (JSON)
//   key: x-goog-api-key header     web search: tools: [{ googleSearch: {} }]
// The free tier refuses Google Search with a 429 that names no quota and no wait; that error is
// marked `searchRefused`, so web-assisted answers go on without search.

import { t } from '../i18n.js';

const name = 'Gemini';
const say = (key, vars = {}) => t(key, { provider: name, ...vars });

export const gemini = {
  id: 'gemini',
  name,
  base: 'https://generativelanguage.googleapis.com/v1beta',
  keyStorage: 'apiKey', // the first provider's key keeps its old storage name
  searchStatusKey: 'searchUnavailableUntil',
  searchName: 'Google Search', // how the prompt names the search tool
  keyPattern: /^AIza[\w-]{20,}$/, // the published key format, to catch a key pasted under the wrong service
  // One low-cost model for everything ($0.30 / $2.50 per 1M tokens, thinking billed as output;
  // also on the free tier). Its thinking levels are documented: minimal (default), low, medium, high.
  config: {
    readerModel: 'gemini-3.5-flash-lite',
    readerThinking: 'LOW',
    explainerModel: 'gemini-3.5-flash-lite',
    explainerThinking: 'MINIMAL',
    maxOutputExplain: 1024, // includes thinking tokens, billed as output
    maxOutputReader: 8192,
    tpm: 200_000, // a bit under the free tier's 250k input tokens per minute (shared by reader and explainer: same model)
    rpm: 10,
    readerChunkTokens: 40_000,
  },

  headers: (apiKey) => ({ 'x-goog-api-key': apiKey }),
  keyCheckPaths: () => ['models?pageSize=1'], // free; no tokens

  jsonRequest({ systemInstruction, contents, schema }) {
    const c = this.config;
    return { path: `models/${c.readerModel}:generateContent`, model: c.readerModel, body: body({ systemInstruction, contents, schema, maxOutputTokens: c.maxOutputReader, thinkingLevel: c.readerThinking }) };
  },
  streamRequest({ systemInstruction, contents, search }) {
    const c = this.config;
    return { path: `models/${c.explainerModel}:streamGenerateContent?alt=sse`, model: c.explainerModel, body: body({ systemInstruction, contents, search, maxOutputTokens: c.maxOutputExplain, thinkingLevel: c.explainerThinking }) };
  },

  // Whole JSON response -> { text, usage }.
  parseJson(json) {
    return { text: json.candidates?.[0]?.content?.parts?.map((p) => p.text ?? '').join('') ?? '', usage: usageOf(json.usageMetadata) };
  },
  // One SSE event -> text to show (may be ''); usage and searches go into acc.
  streamEvent(event, acc) {
    const candidate = event.candidates?.[0];
    if (event.usageMetadata) acc.usage = usageOf(event.usageMetadata);
    for (const q of candidate?.groundingMetadata?.webSearchQueries ?? []) acc.queries.add(q);
    acc.searches = acc.queries.size;
    return candidate?.content?.parts?.map((p) => p.text ?? '').join('') ?? '';
  },

  // HTTP error response -> short Error with retry hints.
  errorFrom(status, raw, short) {
    const make = (message, extra = {}) => short(message, { status, ...extra });
    if (status === 429) {
      if (/PerDay/i.test(raw)) return make(say('errDaily'));
      const delay = /"retryDelay"\s*:\s*"(\d+(?:\.\d+)?)s"/.exec(raw)?.[1];
      // No wait and no per-minute quota named: "not allowed for this key" (e.g. Google Search on the free tier).
      if (delay == null && !/PerMinute/i.test(raw)) return make(say('errNoQuota'), { noQuota: true, searchRefused: true });
      const s = Number(delay ?? 30);
      return make(say('errMinute', { s: Math.ceil(s) }), { retryable: true, retryAfterMs: Math.ceil(s * 1000) });
    }
    if (status === 500 || status === 503) return make(say('errBusy'), { retryable: true, retryAfterMs: 5_000 });
    if (status === 400 && /API key not valid|API_KEY_INVALID/i.test(raw)) return make(say('errKeyInvalid'));
    if (status === 401 || status === 403) return make(say('errKeyRejected'));
    if (status === 400 && /token/i.test(raw)) return make(say('errTooLarge'));
    return make(say('errStatus', { status }));
  },
};

// contents: strings (parts of one user turn) or chat turns [{ role, parts: [{ text }] }].
function body({ systemInstruction, contents, maxOutputTokens, thinkingLevel, search, schema }) {
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

const usageOf = (u) => u && { input: u.promptTokenCount ?? 0, output: u.candidatesTokenCount ?? 0, thinking: u.thoughtsTokenCount ?? 0 };
