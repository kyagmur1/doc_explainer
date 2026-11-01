// Finds the passages of a long document that matter for a selection, so the explainer gets
// a few relevant paragraphs instead of the whole book. Plain BM25 keyword ranking: no extra
// API calls, works in any language that separates words with spaces.

import { estimateTokens } from './prompts.js';

const PASSAGE_WORDS = 120; // passage size: consecutive lines of a page, about this many words

function words(text) {
  return text.toLowerCase().match(/[\p{L}\p{N}]{3,}/gu) ?? [];
}

// Pages -> passages of about PASSAGE_WORDS words, each { n, text }.
export function splitPassages(pages) {
  const passages = [];
  for (const page of pages) {
    let lines = [];
    let count = 0;
    for (const line of (page.text ?? '').split('\n')) {
      lines.push(line);
      count += line.split(/\s+/).length;
      if (count >= PASSAGE_WORDS) {
        passages.push({ n: page.n, text: lines.join('\n') });
        lines = [];
        count = 0;
      }
    }
    if (lines.join('').trim()) passages.push({ n: page.n, text: lines.join('\n') });
  }
  return passages;
}

// The best-matching passages from other pages than `n`, within `maxTokens`, in page order.
// The selection counts three times as much as the rest of the current page.
export function relevantPassages(doc, { n, selection, maxTokens }) {
  const current = doc.pages.find((p) => p.n === n)?.text ?? '';
  const query = new Map();
  for (const w of words(current)) query.set(w, (query.get(w) ?? 0) + 1);
  for (const w of words(selection)) query.set(w, (query.get(w) ?? 0) + 3);

  const passages = splitPassages(doc.pages).filter((p) => p.n !== n);
  const docs = passages.map((p) => words(p.text));
  const avgLength = docs.reduce((sum, d) => sum + d.length, 0) / Math.max(docs.length, 1);
  const docFreq = new Map();
  for (const d of docs) for (const w of new Set(d)) docFreq.set(w, (docFreq.get(w) ?? 0) + 1);

  const k1 = 1.2;
  const b = 0.75;
  const scored = passages.map((p, i) => {
    const tf = new Map();
    for (const w of docs[i]) tf.set(w, (tf.get(w) ?? 0) + 1);
    let score = 0;
    for (const [w, weight] of query) {
      const f = tf.get(w);
      if (!f) continue;
      const idf = Math.log(1 + (docs.length - docFreq.get(w) + 0.5) / (docFreq.get(w) + 0.5));
      score += weight * idf * ((f * (k1 + 1)) / (f + k1 * (1 - b + (b * docs[i].length) / avgLength)));
    }
    return { ...p, score };
  });

  const picked = [];
  let used = 0;
  for (const p of scored.filter((p) => p.score > 0).sort((a, b) => b.score - a.score)) {
    const tokens = estimateTokens(p.text);
    if (used + tokens > maxTokens) continue;
    picked.push(p);
    used += tokens;
  }
  return picked.sort((a, b) => a.n - b.n).map(({ n, text }) => ({ n, text }));
}
