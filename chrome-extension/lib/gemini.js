// The AI client used to be Gemini-only and lived here; it is now lib/llm.js with one adapter per
// provider in lib/providers/. This module keeps the old names working (Gemini's settings and
// error rules; calls go to the provider chosen in the side panel).

import { short, PROVIDERS } from './llm.js';

export * from './llm.js';

export const GEMINI_BASE = PROVIDERS.gemini.base;
export const config = PROVIDERS.gemini.config;
export const errorFrom = (status, raw, headers) => PROVIDERS.gemini.errorFrom(status, raw, short, headers);
