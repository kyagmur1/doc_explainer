// Light/dark theme for the viewer, side panel and bubble.
// Setting `theme`: 'system' (default: follow the OS) | 'light' | 'dark'. The first click on a
// theme switch stores an explicit choice. Pages get <html data-theme="light|dark">; their CSS
// and the bubble (via :host-context) style themselves from that. PDF pages are never themed.

import { getSettings } from './messages.js';
import { watchLanguage, t } from './i18n.js';

const systemDark = matchMedia('(prefers-color-scheme: dark)');
let setting = 'system';

function current() {
  return setting === 'system' ? (systemDark.matches ? 'dark' : 'light') : setting;
}

function apply() {
  const theme = current();
  document.documentElement.dataset.theme = theme;
  for (const button of document.querySelectorAll('[data-theme-switch]')) {
    button.textContent = theme === 'dark' ? '☀︎' : '☾︎'; // ︎: text glyph, not emoji
    button.title = button.ariaLabel = t(theme === 'dark' ? 'themeToLight' : 'themeToDark');
  }
}

// Call once per page. Buttons with a data-theme-switch attribute become theme switches.
export function initTheme() {
  apply(); // follow the system right away, before the stored setting arrives
  getSettings().then((s) => {
    setting = s.theme;
    apply();
  });
  systemDark.addEventListener('change', apply);
  watchLanguage(apply);
  chrome.storage.onChanged.addListener((changes, area) => {
    if (area !== 'sync' || !changes.theme) return;
    setting = changes.theme.newValue ?? 'system';
    apply();
  });
  for (const button of document.querySelectorAll('[data-theme-switch]')) {
    button.addEventListener('click', () => chrome.storage.sync.set({ theme: current() === 'dark' ? 'light' : 'dark' }));
  }
}
