// "Only document / Web assisted" switch, shown in the viewer's top bar and in the side panel.
// Setting `source`: 'document' (default: answers stay faithful to the document, no search)
// or 'web' (may add background knowledge and use Google Search for simpler explanations).
// Markup: <div data-source-switch><button data-source="document">…</button><button data-source="web">…</button></div>

import { getSettings } from './messages.js';

function show(source) {
  for (const button of document.querySelectorAll('[data-source-switch] [data-source]')) {
    button.ariaPressed = String(button.dataset.source === source);
  }
}

export function initSourceSwitch() {
  getSettings().then((s) => show(s.source));
  chrome.storage.onChanged.addListener((changes, area) => area === 'sync' && changes.source && show(changes.source.newValue ?? 'document'));
  for (const button of document.querySelectorAll('[data-source-switch] [data-source]')) {
    button.addEventListener('click', () => chrome.storage.sync.set({ source: button.dataset.source }));
  }
}
