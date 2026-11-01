// Prompt builders. A document is { title, pages: [{ n, text }] }.
// The document text always comes first in `contents` so repeated requests for the same
// document share a prefix, which lets Gemini's implicit caching kick in.

import { promptLanguage } from './i18n.js';

// Rough token count for budgets: ~3 characters per token is on the safe side for English,
// German and Turkish text. The rate limiter is corrected with Gemini's real counts afterwards.
export function estimateTokens(text) {
  return Math.ceil(text.length / 3);
}

export function pageToText(page) {
  return `## Page ${page.n}\n${page.text || '(no text on this page)'}`;
}

export function docToText(doc) {
  return [`# ${doc.title || 'Untitled document'} (${doc.pages.length} pages)`, ...doc.pages.map(pageToText)].join('\n\n');
}

// Splits pages into chunks of at most maxTokens input tokens (a single page that is bigger
// gets its own chunk) and at most maxPages pages, so the per-page summaries of a chunk fit
// into the reader's output limit.
export function chunkPages(pages, { maxTokens, maxPages }) {
  const chunks = [];
  let chunk = [];
  let tokens = 0;
  for (const page of pages) {
    const t = estimateTokens(pageToText(page));
    if (chunk.length && (tokens + t > maxTokens || chunk.length >= maxPages)) {
      chunks.push(chunk);
      chunk = [];
      tokens = 0;
    }
    chunk.push(page);
    tokens += t;
  }
  if (chunk.length) chunks.push(chunk);
  return chunks;
}

// ---------- Document reader ----------

export const READER_SYSTEM =
  'You read documents (for example slide decks exported to PDF, reports or papers) and produce a compact ' +
  '"context pack" that lets someone explain any single page in the context of the whole document. ' +
  'Use only the document content. Be concise and factual. Write in the language of the document.';

const OVERVIEW_PROPERTIES = {
  purpose: { type: 'string', description: 'What the document is for, one or two sentences.' },
  audience: { type: 'string', description: 'Who the document is for.' },
  storyline: {
    type: 'array',
    description: 'Sections of the document in order, each with its page range, e.g. "Q2 recap (1-4)".',
    items: { type: 'string' },
  },
  glossary: {
    type: 'array',
    description: 'Abbreviations and domain terms used in the document, with their meaning in this document.',
    items: {
      type: 'object',
      properties: { term: { type: 'string' }, meaning: { type: 'string' } },
      required: ['term', 'meaning'],
    },
  },
};

export const CONTEXT_PACK_SCHEMA = {
  type: 'object',
  properties: {
    ...OVERVIEW_PROPERTIES,
    pages: {
      type: 'array',
      items: {
        type: 'object',
        properties: {
          n: { type: 'integer' },
          summary: { type: 'string', description: 'One sentence: what this page says.' },
          refs: { type: 'array', items: { type: 'integer' }, description: 'Other pages this one builds on or leads to.' },
        },
        required: ['n', 'summary', 'refs'],
      },
    },
  },
  required: ['purpose', 'audience', 'storyline', 'glossary', 'pages'],
};

// The merge step only writes the overview; page summaries are taken from the chunks as they are.
export const OVERVIEW_SCHEMA = {
  type: 'object',
  properties: OVERVIEW_PROPERTIES,
  required: ['purpose', 'audience', 'storyline', 'glossary'],
};

export function readerContents(doc) {
  return [docToText(doc), 'Build the context pack for this document. Include every page in `pages`.'];
}

// For long documents: read in chunks first, then merge the partial packs.
export function readerChunkContents(doc, chunk) {
  const first = chunk[0].n;
  const last = chunk.at(-1).n;
  return [
    docToText({ title: doc.title, pages: chunk }),
    `These are pages ${first}-${last} of a ${doc.pages.length}-page document titled "${doc.title}". ` +
      'Build a partial context pack for these pages only.',
  ];
}

export function mergeContents(doc, partials) {
  const overviews = partials.map(({ purpose, audience, storyline, glossary }) => ({ purpose, audience, storyline, glossary }));
  return [
    `Partial overviews of the document "${doc.title}" (${doc.pages.length} pages), one per part, in order:\n\n` +
      JSON.stringify(overviews, null, 1),
    'Merge these into one overview of the whole document: one purpose, one audience, one storyline with page ranges, ' +
      'and a de-duplicated glossary.',
  ];
}

// ---------- Selection explainer and chat ----------
// Both get the same context: the document summary (when ready), passages from other pages
// that match the selection or question, and the current page. Never the whole document.

const SIMPLE_STYLE =
  'Use plain, direct language: short sentences and everyday words. ' +
  'Define an essential technical term in a few words the first time you use it. ' +
  'No introductions, no filler, no fancy wording, no general remarks about why something matters. ' +
  'Use the document context only when it helps. ' +
  'Cite other pages exactly as [Page X].';

// The reader picks the language (switch next to the theme switch). Everything else in a request
// is English or in the document's language, and a light model tends to answer in the language of
// the last thing it read; so the rule opens the system instruction and closes the last user turn.
const languageRule = (lang) =>
  `Write your whole answer in ${promptLanguage(lang)}, including the first summary line, even though these instructions ` +
  `and the document are in another language. Keep names and short quoted terms as written.`;
const languageReminder = (lang) => `(Answer in ${promptLanguage(lang)}.)`;

// Where knowledge may come from (the user's switch). Kept short: it goes with every request.
//   document: faithful to the document only, no search.
//   web: may add background knowledge and Google Search (gemini.js turns the tool on), so it
//        can explain what an advanced document takes for granted.
export const SOURCES = ['document', 'web'];
const SOURCE_RULE = {
  document: 'Use only the document text provided. If something needed is missing, say so in one short sentence; do not guess.',
  web:
    'You may use general knowledge and Google Search to explain background the document takes for granted. ' +
    "Facts, numbers and claims about this document come only from its text; never present outside knowledge as the document's. " +
    'If unsure, say so briefly.',
};

// The bubble shows this answer; the TL;DR line comes first.
export function explainerSystem(source, lang = 'en') {
  return (
    `${languageRule(lang)} ` +
    'You help someone understand a document they are reading on their own. They selected a piece of text. ' +
    'Explain what it means here: the idea behind it, not a rephrasing. Do not explain the whole page. ' +
    `${SIMPLE_STYLE} ${SOURCE_RULE[source]} ` +
    `Format: the first line starts with the label "TL;DR: " (keep this label exactly), followed by the core meaning in ${promptLanguage(lang)}, 1-2 short sentences, under 40 words. ` +
    'Then an empty line and a short explanation (short paragraphs or "- " bullets, no headings, no repeat of the TL;DR). ' +
    'Whole answer under 100 words.'
  );
}

export function chatSystem(source, lang = 'en') {
  return (
    `${languageRule(lang)} ` +
    'You answer follow-up questions from someone reading a document on their own. Answer only what was asked. ' +
    `${SIMPLE_STYLE} ${SOURCE_RULE[source]} ` +
    'Under 100 words: short paragraphs or "- " bullets, no headings.'
  );
}

function packToText(pack, n) {
  const neighbours = pack.pages.filter((p) => Math.abs(p.n - n) <= 2 && p.n !== n);
  const self = pack.pages.find((p) => p.n === n);
  const related = self ? pack.pages.filter((p) => self.refs.includes(p.n) && !neighbours.includes(p)) : [];
  const fmt = (p) => `- Page ${p.n}: ${p.summary}`;
  return [
    `Document purpose: ${pack.purpose}`,
    `Audience: ${pack.audience}`,
    `Storyline:\n${pack.storyline.map((s) => `- ${s}`).join('\n')}`,
    pack.glossary.length ? `Glossary:\n${pack.glossary.map((g) => `- ${g.term}: ${g.meaning}`).join('\n')}` : '',
    neighbours.length ? `Nearby pages:\n${neighbours.map(fmt).join('\n')}` : '',
    related.length ? `Related pages:\n${related.map(fmt).join('\n')}` : '',
  ]
    .filter(Boolean)
    .join('\n\n');
}

// Summary (or a note that it isn't ready), related passages, current page.
function contextText({ doc, pack, n, passages }) {
  const page = doc.pages.find((p) => p.n === n);
  if (!page) throw Object.assign(new Error(`Page ${n} not in document`), { status: 400 });
  return [
    pack
      ? `Context about the whole document "${doc.title}" (use only if it helps):\n\n${packToText(pack, n)}`
      : `This page is part of the document "${doc.title}" (${doc.pages.length} pages). A summary of the whole document is not available yet.`,
    passages.length ? `Passages from other pages that may be related (use only if they help):\n\n${passages.map(pageToText).join('\n\n')}` : '',
    `Current page:\n\n${pageToText(page)}`,
  ]
    .filter(Boolean)
    .join('\n\n');
}

const selectionAsk = (n, selection) => `The reader selected this text on page ${n}: "${selection}". Explain what it means here.`;

export function explainContents({ doc, pack, n, selection, passages = [], lang = 'en' }) {
  return [contextText({ doc, pack, n, passages }), `${selectionAsk(n, selection)} ${languageReminder(lang)}`];
}

// Chat turns for Gemini. history: earlier messages [{ role: 'user'|'model', text }]; for a
// selection thread it starts with the bubble's explanation (a 'model' message).
export function chatContents({ doc, pack, n, selection, history = [], question, passages = [], lang = 'en' }) {
  const messages = [...history, { role: 'user', text: `${question}\n\n${languageReminder(lang)}` }];
  if (selection && messages[0].role === 'model') messages.unshift({ role: 'user', text: selectionAsk(n, selection) });
  else messages[0] = { ...messages[0], text: `${selection ? `The reader selected this text on page ${n}: "${selection}".` : `The reader is on page ${n}.`}\n\n${messages[0].text}` };
  messages[0] = { ...messages[0], text: `${contextText({ doc, pack, n, passages })}\n\n${messages[0].text}` };
  return messages.map((m) => ({ role: m.role === 'model' ? 'model' : 'user', parts: [{ text: m.text }] }));
}
