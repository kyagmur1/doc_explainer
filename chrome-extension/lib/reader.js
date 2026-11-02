// Document reader: builds the context pack (purpose, audience, storyline, glossary, one-line
// summary per page). Small documents in one request; large ones in token-sized parts read one
// after another (the rate limiter sets the pace and lets the user's requests go first), then a
// merge of the overviews. Finished parts go through `cachedPart`, so a reader that stopped
// (worker restart, error) continues where it left off instead of starting over. An aborted
// `signal` (the document's last tab closed) ends it before the next part; no new request is sent.

import { providerFor, generateJson, cancelled } from './llm.js';
import { READER_SYSTEM, CONTEXT_PACK_SCHEMA, OVERVIEW_SCHEMA, estimateTokens, docToText, chunkPages, readerContents, readerChunkContents, mergeContents } from './prompts.js';

export const READER_CHUNK_TOKENS = 40_000; // estimated input tokens per reader request (provider default)
// Each page summary costs ~45 output tokens; keep a part's summaries within 60% of the output limit.
const chunkPagesFor = (config) => Math.max(1, Math.floor((config.maxOutputReader * 0.6) / 45));

async function sha256(text) {
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(text));
  return [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, '0')).join('');
}

// One reader call. The cache key covers everything that goes to the provider (provider, model,
// its settings, prompt, schema, text), so a changed prompt, model or provider never reuses an old part.
async function readPart(label, contents, schema, { cachedPart, signal, onState, provider }) {
  if (signal?.aborted) throw cancelled();
  const p = providerFor(provider);
  const key = await sha256(JSON.stringify([p.id, p.config, READER_SYSTEM, schema, contents]));
  return cachedPart(key, () => generateJson({ label, systemInstruction: READER_SYSTEM, contents, schema, signal, onState, provider: p.id }));
}

// doc = { title, pages: [{ n, text }] }; onProgress(done, total); cachedPart(key, compute) -> result;
// onState: what the current request is doing (see withRetries in llm.js). provider: its id.
export async function buildPack(doc, { onProgress, cachedPart, signal = null, onState, provider }) {
  const part = { cachedPart, signal, onState, provider };
  const { config } = providerFor(provider);
  const chunks = chunkPages(doc.pages, { maxTokens: config.readerChunkTokens ?? READER_CHUNK_TOKENS, maxPages: chunkPagesFor(config) });
  console.log(`[reader] "${doc.title}" ${doc.pages.length} pages, ~${estimateTokens(docToText(doc))} tokens, ${chunks.length} part(s)`);
  if (chunks.length === 1) {
    onProgress(0, 1);
    const pack = await readPart('reader', readerContents(doc), CONTEXT_PACK_SCHEMA, part);
    onProgress(1, 1);
    return pack;
  }

  const steps = chunks.length + 1; // + merge
  onProgress(0, steps);
  const partials = [];
  for (const [i, chunk] of chunks.entries()) {
    partials.push(await readPart(`reader part ${i + 1}/${chunks.length}`, readerChunkContents(doc, chunk), CONTEXT_PACK_SCHEMA, part));
    onProgress(i + 1, steps);
  }
  const overview = await readPart('reader merge', mergeContents(doc, partials), OVERVIEW_SCHEMA, part);
  onProgress(steps, steps);
  return { ...overview, pages: partials.flatMap((p) => p.pages).sort((a, b) => a.n - b.n) };
}
