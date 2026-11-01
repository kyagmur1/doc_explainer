// <doc-bubble>: the explanation speech bubble plus the "Explain" chip shown on text selection.
// Lives in a Shadow DOM so it can later be reused as a content script on other pages
// without page CSS leaking in. Emits 'goto' (detail: n), 'more' and 'explain-selection'.
// Colors follow <html data-theme> (see lib/theme.js) via :host-context.

import { splitExplanation, bodyToHtml, inlineToHtml, badgeText, WITHOUT_SUMMARY, readerNote } from './lib/render.js';
import { t, textDirection, currentLanguage, LANGUAGES } from './lib/i18n.js';

const CSS = `
  :host {
    all: initial;
    --fg: #2b2f45; --bg: #f7f8ff; --edge: #d9defa; --muted: #6b7090; --chip: #e9ecff;
    --warn-bg: #fff1d6; --accent: #5b6cf0; --error: #c0362c;
    --drop: #d9defa; --glow: rgba(60, 70, 140, 0.14);
  }
  :host-context([data-theme="dark"]) {
    --fg: #e8eaf6; --bg: #262a3f; --edge: #3d4366; --muted: #a3a8c8; --chip: #33395a;
    --warn-bg: #4a3f22; --accent: #9aa6ff; --error: #ff8a80;
    --drop: #15182a; --glow: rgba(0, 0, 0, 0.35);
  }
  * { box-sizing: border-box; }
  [hidden] { display: none !important; }

  /* Speech bubble: the outer box draws the shape and the tail, .content scrolls. */
  .bubble {
    position: fixed; z-index: 2147483000;
    width: min(360px, calc(100vw - 32px));
    font: 14px/1.5 system-ui, -apple-system, "Segoe UI", Roboto, sans-serif;
    color: var(--fg); background: var(--bg);
    border: 2px solid var(--edge); border-radius: 20px;
    box-shadow: 0 3px 0 var(--drop), 0 10px 24px var(--glow); /* small solid drop = soft cartoon look */
    animation: appear 0.14s ease-out;
  }
  .content { position: relative; z-index: 1; max-height: 50vh; overflow: auto; padding: 12px 16px 12px; }

  /* Tail: a rotated square with two visible edges, half outside the bubble. */
  .bubble::after {
    content: ''; position: absolute; left: var(--tail-x, 50%);
    width: 14px; height: 14px; margin-left: -7px;
    background: var(--bg); border: 2px solid var(--edge);
    transform: rotate(45deg);
  }
  .bubble.tail-down::after { bottom: -9px; border-top-color: transparent; border-left-color: transparent; border-bottom-right-radius: 4px; }
  .bubble.tail-up::after { top: -9px; border-bottom-color: transparent; border-right-color: transparent; border-top-left-radius: 4px; }

  .head { display: flex; align-items: center; gap: 8px; font-size: 12px; color: var(--muted); margin-bottom: 4px; }
  .head .label { flex: 1; font-weight: 600; }
  .badge { padding: 1px 8px; border-radius: 999px; background: var(--chip); color: var(--fg); font-size: 11px; }
  .badge.passages-basic { background: var(--warn-bg); }
  button { font: inherit; cursor: pointer; border: 0; background: none; color: inherit; }
  .close { font-size: 16px; line-height: 1; padding: 2px 6px; border-radius: 999px; color: var(--muted); }
  .close:hover { background: var(--chip); }
  .tldr { margin: 0; }
  .body p, .body ul { margin: 6px 0 0; }
  .body ul { padding-inline-start: 18px; }
  .foot { display: flex; gap: 12px; margin-top: 8px; font-size: 12px; }
  .foot button, .note .again { color: var(--accent); padding: 0; font-size: 12px; }
  .muted { color: var(--muted); }
  .note { margin: 6px 0 0; font-size: 12px; color: var(--muted); }
  .error { color: var(--error); }
  .cite { color: var(--accent); text-decoration: underline; cursor: pointer; }

  .chip {
    position: fixed; z-index: 2147483000;
    padding: 5px 12px; border-radius: 999px;
    font: 13px/1.4 system-ui, -apple-system, "Segoe UI", Roboto, sans-serif;
    color: #fff; background: var(--accent);
    box-shadow: 0 2px 0 var(--drop), 0 6px 14px var(--glow);
  }
  :host-context([data-theme="dark"]) .chip { color: #15182a; }

  .dots::after { content: '…'; animation: blink 1s steps(2) infinite; }
  @keyframes blink { 50% { opacity: 0.2; } }
  @keyframes appear { from { opacity: 0; transform: translateY(4px); } }
  @media (prefers-reduced-motion: reduce) { .bubble, .dots::after { animation: none; } }
`;

const TAIL_GAP = 12; // space between a selection and the bubble, room for the tail

export class DocBubble extends HTMLElement {
  constructor() {
    super();
    this.root = this.attachShadow({ mode: 'open' });
    this.root.innerHTML = `<style>${CSS}</style>
      <div class="bubble" hidden role="status" aria-live="polite"><div class="content"></div></div>
      <button class="chip" hidden type="button">Explain</button>`;
    this.box = this.root.querySelector('.bubble');
    this.content = this.root.querySelector('.content');
    this.chip = this.root.querySelector('.chip');

    this.root.addEventListener('click', (e) => {
      const cite = e.target.closest('[data-goto]');
      if (cite) {
        e.preventDefault();
        this.dispatchEvent(new CustomEvent('goto', { detail: Number(cite.dataset.goto) }));
      } else if (e.target.closest('.close')) {
        this.hide();
      } else if (e.target.closest('.again')) {
        // Asked in another language (switched before or while it was answered): ask again, on click only.
        this.dispatchEvent(new CustomEvent('explain-again', { detail: { n: this.current.n, text: this.current.selection } }));
      } else if (e.target.closest('.more')) {
        this.dispatchEvent(new CustomEvent('more'));
      } else if (e.target === this.chip) {
        this.chip.hidden = true;
        this.dispatchEvent(new CustomEvent('explain-selection'));
      }
    });
    this.chip.addEventListener('mousedown', (e) => e.preventDefault()); // keep the selection
  }

  hide() {
    this.box.hidden = true;
    this.current = null;
  }

  // The language changed: redraw the texts.
  relabel() {
    this.chip.textContent = t('explain');
    this.chip.dir = textDirection();
    if (this.current && !this.box.hidden) this.render(this.current);
  }

  // Reader status from the background ({ status, progress }), for the "context is loading" note.
  setReader(reader) {
    this.reader = reader;
    if (this.current && !this.box.hidden) this.render(this.current);
  }

  // The small Explain button, right next to the end of the selection.
  showChip(rect) {
    this.chip.style.left = `${Math.max(8, Math.min(rect.right + 6, innerWidth - 90))}px`;
    this.chip.style.top = `${Math.max(8, Math.min(rect.bottom - 30, innerHeight - 40))}px`;
    this.chip.hidden = false;
  }

  hideChip() {
    this.chip.hidden = true;
  }

  // msg: EXPLAIN message for the selection; rect: where the selection is now.
  // Opens below the selection (tail up) or, if there is no room, above it (tail down).
  // The side is chosen once per selection, so the bubble doesn't flip while text streams in.
  showSelection(msg, rect) {
    this.render(msg);
    if (this.placedId !== msg.id) {
      this.placedId = msg.id;
      this.side = rect.bottom + TAIL_GAP + 200 < innerHeight ? 'below' : 'above';
      this.box.className = `bubble ${this.side === 'below' ? 'tail-up' : 'tail-down'}`;
    }
    this.follow(rect);
  }

  // Keeps the bubble next to the selection, e.g. while the page scrolls.
  follow(rect) {
    if (!this.current) return;
    const width = this.box.offsetWidth;
    const left = Math.max(16, Math.min(rect.left, innerWidth - width - 16));
    const top = this.side === 'below' ? rect.bottom + TAIL_GAP : rect.top - this.box.offsetHeight - TAIL_GAP;
    this.box.style.left = `${left}px`;
    this.box.style.top = `${top}px`;
    this.box.style.setProperty('--tail-x', `${Math.max(24, Math.min(rect.left + rect.width / 2 - left, width - 24))}px`);
  }

  render(msg) {
    this.current = msg;
    const { tldr, body } = splitExplanation(msg.text || '');
    const note = WITHOUT_SUMMARY.includes(msg.level) ? readerNote(this.reader) + (this.reader?.status === 'error' ? ` ${t('readerErrorHint')}` : '') : '';
    const badge = badgeText(msg.level, msg.source);
    let text;
    if (msg.error && !msg.text) text = `<p class="error">${inlineToHtml(msg.error)}</p>`;
    else if (!msg.text) text = `<p class="muted dots">${t('explaining')}</p>`;
    else {
      text = `<p class="tldr" dir="auto">${inlineToHtml(tldr || body.split('\n')[0])}</p>`;
      if (tldr && body) text += `<div class="body">${bodyToHtml(body)}</div>`;
      if (!msg.done) text += `<p class="muted dots"></p>`;
      if (msg.error) text += `<p class="error">${inlineToHtml(msg.error)}</p>`;
    }
    this.box.dir = textDirection();
    this.content.innerHTML = `
      <div class="head">
        <span class="label">${t('page', { n: msg.n })}</span>
        ${badge ? `<span class="badge ${msg.level}">${badge}</span>` : ''}
        <button class="close" type="button" aria-label="${t('close')}">×</button>
      </div>
      ${text}
      ${note ? `<p class="note">${note}</p>` : ''}
      ${msg.done && msg.lang && msg.lang !== currentLanguage() && msg.selection ? `<p class="note">${t('answerInLanguage', { language: LANGUAGES[msg.lang] })} <button class="again" type="button">${t('explainInLanguage', { language: LANGUAGES[currentLanguage()] })}</button></p>` : ''}
      ${msg.done && !msg.error ? `<div class="foot"><button class="more" type="button">${t('askFollowUp')}</button></div>` : ''}`;
    this.box.hidden = false;
  }
}

customElements.define('doc-bubble', DocBubble);
