// Turns explainer output ("TL;DR: ...\n\nbody") into safe HTML with [Page X] links.

import { t } from './i18n.js';

function escapeHtml(s) {
  return s.replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);
}

function inline(s) {
  return escapeHtml(s).replace(/\[Pages? (\d+)\]/g, (_, n) => `<a href="#" class="cite" data-goto="${n}">${escapeHtml(t('page', { n }))}</a>`);
}

export function splitExplanation(text) {
  const m = text.match(/^\s*TL;DR:\s*([\s\S]*?)(?:\n\s*\n([\s\S]*))?$/);
  if (!m) return { tldr: '', body: text };
  return { tldr: m[1].trim(), body: (m[2] || '').trim() };
}

export function bodyToHtml(body) {
  const out = [];
  let list = null;
  for (const line of body.split('\n')) {
    const bullet = line.match(/^\s*[-*•]\s+(.*)$/);
    if (bullet) {
      list ??= [];
      list.push(`<li dir="auto">${inline(bullet[1])}</li>`);
      continue;
    }
    if (list) {
      out.push(`<ul>${list.join('')}</ul>`);
      list = null;
    }
    if (line.trim()) out.push(`<p dir="auto">${inline(line.trim())}</p>`); // each paragraph in its own direction
  }
  if (list) out.push(`<ul>${list.join('')}</ul>`);
  return out.join('');
}

export function inlineToHtml(text) {
  return inline(text);
}

// Badge text for the context an answer used (see answerKey in background.js).
const LEVEL_LABEL = { passages: 'levelPassages', 'passages-basic': 'levelBasic' };

// Badge: the context, plus "web" for web-assisted answers.
export function badgeText(level, source) {
  const label = LEVEL_LABEL[level] && t(LEVEL_LABEL[level]);
  return label && source === 'web' ? `${label} · ${t('web')}` : (label ?? '');
}

// Answers made without the document summary: worth a note while it is still loading.
export const WITHOUT_SUMMARY = ['passages-basic'];

// "Document context is loading (part 3 of 8)" etc. for reader status { status, progress }.
// progress: { done, total, waitUntil? } (waitUntil: a rate-limit or retry wait, in ms since epoch).
export function readerNote(reader) {
  if (reader?.status === 'reading') {
    const { done, total, waitUntil } = reader.progress ?? {};
    const key = waitUntil > Date.now() ? 'readerWaiting' : 'readerLoading';
    return total > 1 ? t(`${key}Part`, { n: Math.min(done + 1, total), total }) : t(key);
  }
  if (reader?.status === 'error') return t('readerError');
  return '';
}
