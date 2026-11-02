// OpenAI (api.openai.com), Responses API, REST.
//   POST /v1/responses; stream: true for explain/chat (SSE events with a `type`), JSON for the reader
//   key: Authorization: Bearer <key>     web search: tools: [{ type: 'web_search' }]
//   JSON output: text.format = { type: 'json_schema', strict: true, schema }
//   store: false, so OpenAI does not keep the responses for later retrieval.
// Model IDs are checked with GET /v1/models/<id> when a key is saved (free).

import { t } from '../i18n.js';
import { strictSchema, retryAfterMs, parseError } from './common.js';

const name = 'OpenAI';
const say = (key, vars = {}) => t(key, { provider: name, ...vars });

export const openai = {
  id: 'openai',
  name,
  base: 'https://api.openai.com/v1',
  keyStorage: 'apiKey:openai',
  searchStatusKey: 'searchUnavailableUntil:openai',
  searchName: 'web search', // how the prompt names the search tool
  keyPattern: /^sk-(?!ant-)[\w-]{10,}$/, // the published key format, to catch a key pasted under the wrong service
  // One low-cost model for everything ($0.10 / $0.50 per 1M tokens). Its default effort is
  // medium, so low is set explicitly.
  config: {
    readerModel: 'gpt-6-luna',
    readerEffort: 'low',
    explainerModel: 'gpt-6-luna',
    explainerEffort: 'low',
    maxOutputExplain: 1536, // includes reasoning tokens, billed as output
    maxOutputReader: 8192,
    tpm: 200_000,
    rpm: 50,
    readerChunkTokens: 40_000,
  },

  headers: (apiKey) => ({ Authorization: `Bearer ${apiKey}` }),
  keyCheckPaths() {
    return [...new Set([this.config.explainerModel, this.config.readerModel])].map((m) => `models/${encodeURIComponent(m)}`);
  },

  jsonRequest({ systemInstruction, contents, schema }) {
    const c = this.config;
    return {
      path: 'responses',
      model: c.readerModel,
      body: {
        ...base(c.readerModel, systemInstruction, contents, c.maxOutputReader, c.readerEffort),
        text: { format: { type: 'json_schema', name: 'result', strict: true, schema: strictSchema(schema) } },
      },
    };
  },
  streamRequest({ systemInstruction, contents, search }) {
    const c = this.config;
    return {
      path: 'responses',
      model: c.explainerModel,
      body: { ...base(c.explainerModel, systemInstruction, contents, c.maxOutputExplain, c.explainerEffort), stream: true, ...(search ? { tools: [{ type: 'web_search' }] } : {}) },
    };
  },

  parseJson(json, short) {
    const content = (json.output ?? []).filter((o) => o.type === 'message').flatMap((o) => o.content ?? []);
    if (content.some((c) => c.type === 'refusal')) throw short(say('errRefused'), { status: 200 });
    return { text: content.filter((c) => c.type === 'output_text').map((c) => c.text).join(''), usage: usageOf(json.usage) };
  },
  streamEvent(event, acc, short) {
    switch (event.type) {
      case 'response.output_text.delta':
      case 'response.refusal.delta': // the refusal is shown as the answer
        return event.delta ?? '';
      case 'response.output_item.added':
        if (event.item?.type === 'web_search_call') acc.searches++;
        return '';
      case 'response.completed':
      case 'response.incomplete': // e.g. max_output_tokens: what arrived stays
        acc.usage = usageOf(event.response?.usage);
        return '';
      case 'response.failed':
        throw this.errorFromBody(event.response?.error ?? {}, 500, short);
      case 'error':
        throw this.errorFromBody(event, 500, short);
      default:
        return '';
    }
  },

  errorFrom(status, raw, short, headers) {
    return this.errorFromBody(parseError(raw), status, short, headers);
  },
  // error: { message, type, code } from a response body or a stream event.
  errorFromBody(error, status, short, headers) {
    const make = (message, extra = {}) => short(message, { status, ...extra });
    const code = `${error.code ?? ''} ${error.type ?? ''}`;
    const text = error.message ?? '';
    if (/insufficient_quota/.test(code)) return make(say('errBilling'));
    if (status === 429 || /rate_limit/.test(code)) {
      const ms = retryAfterMs(headers, text) ?? 20_000;
      return make(say('errRateLimit', { s: Math.ceil(ms / 1000) }), { status: 429, retryable: true, retryAfterMs: ms });
    }
    if (status === 401 || /invalid_api_key/.test(code)) return make(say('errKeyInvalid'));
    if (status === 403) return make(say('errKeyRejected'));
    if (status === 404 || /model_not_found/.test(code)) return make(say('errModel'));
    if (/context_length|too large|maximum context/i.test(code + text)) return make(say('errTooLarge'));
    if (status === 400 && /web_search/i.test(text)) return make(say('errNoQuota'), { searchRefused: true });
    if (status >= 500 || /server_error|overloaded/.test(code)) return make(say('errBusy'), { retryable: true, retryAfterMs: 5_000 });
    return make(say('errStatus', { status }));
  },
};

// contents: strings (parts of one user turn) or chat turns [{ role: 'user'|'model', parts }].
function base(model, systemInstruction, contents, maxOutputTokens, effort) {
  const input = contents.every((c) => typeof c === 'string')
    ? [{ role: 'user', content: contents.map((text) => ({ type: 'input_text', text })) }]
    : contents.map((c) => ({ role: c.role === 'model' ? 'assistant' : 'user', content: c.parts.map((p) => p.text).join('\n\n') }));
  return { model, instructions: systemInstruction, input, max_output_tokens: maxOutputTokens, reasoning: { effort }, store: false };
}

const usageOf = (u) => u && { input: u.input_tokens ?? 0, output: u.output_tokens ?? 0, thinking: u.output_tokens_details?.reasoning_tokens ?? 0 };
