// Navigation panel on the left of the viewer: the PDF's own table of contents (outline /
// bookmarks) and numbered page thumbnails. Entirely local (pdf.js only): nothing is sent anywhere.
// Opened with the ☰ button; the pages move aside, the panel never covers them.
//
// Thumbnails are drawn only when they come near the visible part of the list, one at a time,
// and at most MAX_THUMBS are kept: the ones farthest from view are cleared again.

import { t, textDirection } from './lib/i18n.js';
import { getSettings } from './lib/messages.js';

const THUMB_WIDTH = 132; // CSS px
const MAX_THUMBS = 40; // drawn thumbnails kept at once
const NEAR = '400px 0px'; // how far outside the list's view a thumbnail is drawn ahead

const $ = (id) => document.getElementById(id);

// doc: { pdf, pages: [{ n, width, height }] } from parsePdf; jump({ n, top }) moves the view
// (top: a PDF y coordinate on that page, or null for the page's top).
export function initNav({ doc, jump }) {
  const panel = $('nav');
  const toggle = $('nav-toggle');
  const tabs = { outline: $('nav-tab-outline'), pages: $('nav-tab-pages') };
  const views = { outline: $('nav-outline'), pages: $('nav-pages') };
  let open = false;
  let tab = 'outline';
  let outlineBuilt = false;
  let thumbs = null; // built on first view of the Pages tab
  let current = null;

  function show() {
    panel.hidden = !open;
    document.body.classList.toggle('nav-open', open);
    toggle.ariaExpanded = String(open);
    for (const [name, button] of Object.entries(tabs)) {
      button.ariaSelected = String(name === tab);
      button.tabIndex = name === tab ? 0 : -1;
      views[name].hidden = name !== tab;
    }
    if (!open) return thumbs?.pause();
    if (tab === 'outline' && !outlineBuilt) buildOutline();
    if (tab === 'pages') (thumbs ??= thumbnails()).resume();
  }
  function save() {
    chrome.storage.sync.set({ nav: { open, tab } }).catch(() => {});
  }

  toggle.hidden = false;
  toggle.addEventListener('click', () => {
    open = !open;
    show();
    save();
  });
  for (const [name, button] of Object.entries(tabs)) {
    button.addEventListener('click', () => {
      tab = name;
      show();
      save();
    });
  }
  // Left/right arrows move between the two tabs.
  $('nav-tabs').addEventListener('keydown', (e) => {
    if (e.key !== 'ArrowLeft' && e.key !== 'ArrowRight') return;
    tab = tab === 'outline' ? 'pages' : 'outline';
    show();
    tabs[tab].focus();
    save();
  });
  getSettings().then((s) => {
    open = !!s.nav?.open;
    tab = s.nav?.tab === 'pages' ? 'pages' : 'outline';
    show();
  });

  // ---------- Table of contents ----------

  async function buildOutline() {
    outlineBuilt = true;
    const box = views.outline;
    let outline = null;
    try {
      outline = await doc.pdf.getOutline();
    } catch {
      outline = null;
    }
    if (!outline?.length) {
      box.replaceChildren(Object.assign(document.createElement('p'), { className: 'nav-empty', textContent: t('navNoOutline') }));
      box.querySelector('.nav-empty').dataset.i18n = 'navNoOutline';
      return;
    }
    box.replaceChildren(tree(outline, 0));
  }

  function tree(items, depth) {
    const list = document.createElement('ul');
    list.className = 'nav-tree';
    if (depth === 0) list.role = 'tree';
    else list.role = 'group';
    for (const item of items) {
      const li = document.createElement('li');
      li.role = 'treeitem';
      const row = document.createElement('div');
      row.className = 'nav-row';
      row.style.setProperty('--depth', depth);
      const hasChildren = item.items?.length > 0;
      const twisty = document.createElement('button');
      twisty.type = 'button';
      twisty.className = 'nav-twisty';
      if (hasChildren) {
        twisty.ariaExpanded = 'false';
        twisty.ariaLabel = item.title;
        twisty.textContent = '▸';
      } else {
        twisty.disabled = true;
        twisty.ariaHidden = 'true';
      }
      const link = document.createElement('button');
      link.type = 'button';
      link.className = 'nav-link';
      link.dir = 'auto';
      link.textContent = item.title?.trim() || '—';
      link.title = link.textContent;
      if (item.bold) link.style.fontWeight = '600';
      if (item.italic) link.style.fontStyle = 'italic';
      link.addEventListener('click', () => go(item));
      row.append(twisty, link);
      li.append(row);
      if (hasChildren) {
        let children = null; // made on first expand
        li.ariaExpanded = 'false';
        twisty.addEventListener('click', () => {
          const expand = twisty.ariaExpanded !== 'true';
          if (expand && !children) li.append((children = tree(item.items, depth + 1)));
          children.hidden = !expand;
          twisty.ariaExpanded = li.ariaExpanded = String(expand);
          twisty.textContent = expand ? '▾' : '▸';
        });
      }
      list.append(li);
    }
    return list;
  }

  // An outline entry's destination -> page number and position. External links open in a new tab.
  async function go(item) {
    if (item.url) return window.open(item.url, '_blank', 'noopener');
    const target = await destination(item.dest).catch(() => null);
    if (target) jump(target);
  }

  async function destination(dest) {
    const explicit = typeof dest === 'string' ? await doc.pdf.getDestination(dest) : dest;
    if (!Array.isArray(explicit) || !explicit.length) return null;
    const [ref, mode, ...args] = explicit;
    const index = Number.isInteger(ref) ? ref : await doc.pdf.getPageIndex(ref);
    // The y coordinate, for the kinds of destination that have one.
    const top = { XYZ: args[1], FitH: args[0], FitBH: args[0], FitR: args[3] }[mode?.name];
    return { n: index + 1, top: typeof top === 'number' ? top : null };
  }

  // ---------- Page thumbnails ----------

  function thumbnails() {
    const box = views.pages;
    const list = document.createElement('ol');
    list.className = 'nav-thumbs';
    const drawn = new Set(); // items with a drawn canvas
    const queue = []; // items waiting to be drawn, in the order they came near
    let busy = false;
    let active = false;

    for (const page of doc.pages) {
      const li = document.createElement('li');
      li.dataset.page = page.n;
      const button = document.createElement('button');
      button.type = 'button';
      button.className = 'nav-thumb';
      button.ariaLabel = t('page', { n: page.n });
      const frame = document.createElement('span');
      frame.className = 'nav-frame';
      frame.style.aspectRatio = `${page.width} / ${page.height}`;
      const number = document.createElement('span');
      number.className = 'nav-number';
      number.textContent = page.n;
      button.append(frame, number);
      button.addEventListener('click', () => jump({ n: page.n, top: null }));
      li.append(button);
      list.append(li);
    }
    box.replaceChildren(list);

    const near = new Map(); // li -> is near the visible part of the list
    const observer = new IntersectionObserver(
      (entries) => {
        for (const e of entries) {
          near.set(e.target, e.isIntersecting);
          if (e.isIntersecting && !drawn.has(e.target) && !queue.includes(e.target)) queue.push(e.target);
        }
        pump();
      },
      { root: box, rootMargin: NEAR },
    );
    for (const li of list.children) observer.observe(li);

    async function pump() {
      if (busy || !active) return;
      busy = true;
      try {
        while (active && queue.length) {
          const li = queue.shift();
          if (!near.get(li) || drawn.has(li)) continue; // scrolled away meanwhile
          await draw(li).catch(() => {});
          drawn.add(li);
          evict();
        }
      } finally {
        busy = false;
      }
    }

    async function draw(li) {
      const page = await doc.pdf.getPage(Number(li.dataset.page));
      const dpr = devicePixelRatio || 1;
      const viewport = page.getViewport({ scale: (THUMB_WIDTH * dpr) / page.getViewport({ scale: 1 }).width });
      const canvas = document.createElement('canvas');
      canvas.width = Math.floor(viewport.width);
      canvas.height = Math.floor(viewport.height);
      await page.render({ canvasContext: canvas.getContext('2d'), viewport }).promise;
      li.querySelector('.nav-frame').replaceChildren(canvas);
      li.classList.add('drawn');
    }

    // Keeps at most MAX_THUMBS: clears the ones farthest from the visible part of the list.
    function evict() {
      if (drawn.size <= MAX_THUMBS) return;
      const middle = box.scrollTop + box.clientHeight / 2;
      const far = [...drawn].filter((li) => !near.get(li)).sort((a, b) => Math.abs(b.offsetTop - middle) - Math.abs(a.offsetTop - middle));
      for (const li of far.slice(0, drawn.size - MAX_THUMBS)) {
        const canvas = li.querySelector('canvas');
        if (canvas) canvas.width = canvas.height = 0; // frees the bitmap now, not at garbage collection
        li.querySelector('.nav-frame').replaceChildren();
        li.classList.remove('drawn');
        drawn.delete(li);
      }
    }

    return {
      list,
      drawnCount: () => drawn.size,
      pause: () => (active = false),
      resume() {
        active = true;
        mark(current, true);
        pump();
      },
    };
  }

  // The page in view: highlighted in the list, which follows it while it is shown.
  function mark(n, scroll) {
    if (!thumbs || n == null) return;
    for (const li of thumbs.list.querySelectorAll('li.current')) li.classList.remove('current');
    const li = thumbs.list.children[n - 1];
    if (!li) return;
    li.classList.add('current');
    li.querySelector('button').ariaCurrent = 'page';
    for (const other of thumbs.list.querySelectorAll('button[aria-current]')) if (other.parentElement !== li) other.removeAttribute('aria-current');
    if (scroll && open && tab === 'pages') li.scrollIntoView({ block: 'nearest' });
  }

  return {
    // The page in view changed.
    setCurrent(n) {
      current = n;
      mark(n, true);
    },
    // The language changed: texts made here.
    relabel() {
      panel.dir = textDirection();
      for (const el of panel.querySelectorAll('[data-i18n="navNoOutline"]')) el.textContent = t('navNoOutline');
      if (thumbs) for (const li of thumbs.list.children) li.querySelector('button').ariaLabel = t('page', { n: li.dataset.page });
    },
    // For tests: how many thumbnails are drawn now.
    stats: () => ({ drawn: thumbs?.drawnCount() ?? 0, max: MAX_THUMBS }),
  };
}
