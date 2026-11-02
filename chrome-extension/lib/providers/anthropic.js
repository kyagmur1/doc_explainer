// Anthropic Claude (api.anthropic.com), Messages API, REST (the extension has no build step, so
// no SDK). POST /v1/messages; stream: true for explain/chat (SSE), JSON for the reader.
//   key: x-api-key header, with anthropic-version and the header that allows calls from a
//   browser context (anthropic-dangerous-direct-browser-access)
//   JSON output: output_config.format = { type: 'json_schema', schema }
//   effort: output_config.effort (default medium on claude-haiku-5-5; low keeps thinking short)
//   web search: tools: [{ type: 'web_search_20260209', name: 'web_search' }] ($10 per 1,000
//   searches; an organisation admin can turn it off in the Claude Console, then a 400 says so)
//   refusals: HTTP 200 with stop_reason 'refusal', shown as an error. No server-side fallback
//   (`fallbacks`): a request never moves to another, more expensive model.
//   Price: $0.10 / $0.50 per 1M tokens for prompts up to 100,000 tokens ($0.50 / $2.50 above);
//   reader parts stay at ~25,000 input tokens, well under that.

import { t } from '../i18n.js';
import { strictSchema, retryAfterMs, parseError } from './common.js';

const name = 'Claude';
const say = (key, vars = {}) => t(key, { provider: name, ...vars });

export const anthropic = {
  id: 'anthropic',
  name,
  base: 'https://api.anthropic.com/v1',
  keyStorage: 'apiKey:anthropic',
  searchStatusKey: 'searchUnavailableUntil:anthropic',
  searchName: 'web search', // how the prompt names the search tool
  keyPattern: /^sk-ant-[\w-]{10,}$/, // the published key format, to catch a key pasted under the wrong service
  config: {
    readerModel: 'claude-haiku-5-5',
    readerEffort: 'low',
    explainerModel: 'claude-haiku-5-5',
    explainerEffort: 'low',
    maxOutputExplain: 1536, // includes thinking tokens, billed as output
    maxOutputReader: 8192,
    tpm: 40_000,
    rpm: 50,
    readerChunkTokens: 25_000,
  },

  headers(apiKey) {
    return {
      'x-api-key': apiKey,
      'anthropic-version': '2026-10-21',
      'anthropic-dangerous-direct-browser-access': 'true',
    };
  },
  keyCheckPaths() {
    return [...new Set([this.config.explainerModel, this.config.readerModel])].map((m) => `models/${encodeURIComponent(m)}`);
  },

  jsonRequest({ systemInstruction, contents, schema }) {
    const c = this.config;
    return {
      path: 'messages',
      model: c.readerModel,
      body: { ...base(c.readerModel, systemInstruction, contents, c.maxOutputReader), output_config: { effort: c.readerEffort, format: { type: 'json_schema', schema: strictSchema(schema) } } },
    };
  },
  streamRequest({ systemInstruction, contents, search }) {
    const c = this.config;
    return {
      path: 'messages',
      model: c.explainerModel,
      body: {
        ...base(c.explainerModel, systemInstruction, contents, c.maxOutputExplain),
        output_config: { effort: c.explainerEffort },
        stream: true,
        ...(search ? { tools: [{ type: 'web_search_20260209', name: 'web_search', max_uses: 3 }] } : {}),
      },
    };
  },

  parseJson(json, short) {
    if (json.stop_reason === 'refusal') throw short(say('errRefused'), { status: 200 });
    return { text: (json.content ?? []).filter((b) => b.type === 'text').map((b) => b.text).join(''), usage: usageOf(json.usage) };
  },
  streamEvent(event, acc, short) {
    switch (event.type) {
      case 'message_start':
        acc.usage = usageOf(event.message?.usage);
        return '';
      case 'content_block_start':
        if (event.content_block?.type === 'server_tool_use' && event.content_block.name === 'web_search') acc.searches++;
        return '';
      case 'content_block_delta':
        return event.delta?.type === 'text_delta' ? (event.delta.text ?? '') : '';
      case 'message_delta':
        if (event.usage) acc.usage = { ...(acc.usage ?? { input: 0, thinking: 0 }), output: event.usage.output_tokens ?? 0 };
        if (event.delta?.stop_reason === 'refusal') throw short(say('errRefused'), { status: 200 });
        return '';
      case 'error':
        throw this.errorFromBody(event.error ?? {}, event.error?.type === 'overloaded_error' ? 529 : 500, short);
      default:
        return '';
    }
  },

  errorFrom(status, raw, short, headers) {
    return this.errorFromBody(parseError(raw), status, short, headers);
  },
  // error: { type, message } from a response body or a stream event.
  errorFromBody(error, status, short, headers) {
    const make = (message, extra = {}) => short(message, { status, ...extra });
    const type = error.type ?? '';
    const text = error.message ?? '';
    if (status === 402 || type === 'billing_error' || /credit balance/i.test(text)) return make(say('errBilling'));
    if (status === 429 || type === 'rate_limit_error') {
      const ms = retryAfterMs(headers, text) ?? 20_000;
      return make(say('errRateLimit', { s: Math.ceil(ms / 1000) }), { status: 429, retryable: true, retryAfterMs: ms });
    }
    if (status === 401 || type === 'authentication_error') return make(say('errKeyInvalid'));
    if (status === 403 || type === 'permission_error') return make(say('errKeyRejected'));
    if (status === 404 || type === 'not_found_error') return make(say('errModel'));
    if (status === 413 || /prompt is too long|too large/i.test(text)) return make(say('errTooLarge'));
    if (status === 400 && /web.?search/i.test(text)) return make(say('errNoQuota'), { searchRefused: true });
    if (status >= 500 || type === 'overloaded_error' || type === 'api_error') return make(say('errBusy'), { status, retryable: true, retryAfterMs: 5_000 });
    return make(say('errStatus', { status }));
  },
};

// contents: strings (parts of one user turn) or chat turns [{ role: 'user'|'model', parts }].
function base(model, systemInstruction, contents, maxTokens) {
  const messages = contents.every((c) => typeof c === 'string')
    ? [{ role: 'user', content: contents.map((text) => ({ type: 'text', text })) }]
    : contents.map((c) => ({ role: c.role === 'model' ? 'assistant' : 'user', content: c.parts.map((p) => p.text).join('\n\n') }));
  return { model, max_tokens: maxTokens, system: systemInstruction, messages };
}

const usageOf = (u) => u && { input: (u.input_tokens ?? 0) + (u.cache_read_input_tokens ?? 0) + (u.cache_creation_input_tokens ?? 0), output: u.output_tokens ?? 0, thinking: 0 };
