// Helpers shared by the OpenAI and Anthropic adapters.

// Structured output on OpenAI (strict) and Anthropic: every object closed and every property
// required. The schemas in prompts.js are written for Gemini; this makes a strict copy.
export function strictSchema(schema) {
  if (Array.isArray(schema)) return schema.map(strictSchema);
  if (!schema || typeof schema !== 'object') return schema;
  const out = Object.fromEntries(Object.entries(schema).map(([k, v]) => [k, strictSchema(v)]));
  if (out.type === 'object' && out.properties) {
    out.additionalProperties = false;
    out.required = Object.keys(out.properties);
  }
  return out;
}

// Wait before a retry, from a retry-after header (seconds) or "try again in 1.5s / 20ms" text.
export function retryAfterMs(headers, text = '') {
  const header = Number(headers?.get?.('retry-after'));
  if (header > 0) return Math.ceil(header * 1000);
  const m = /try again in (\d+(?:\.\d+)?)\s*(ms|s)\b/i.exec(text);
  return m ? Math.ceil(Number(m[1]) * (m[2] === 'ms' ? 1 : 1000)) : null;
}

// { error: { ... } } body -> the inner object (or {} when the body isn't JSON).
export function parseError(raw) {
  try {
    return JSON.parse(raw).error ?? {};
  } catch {
    return { message: raw };
  }
}
