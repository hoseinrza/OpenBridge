import { useCallback, useSyncExternalStore } from 'react';

const STORAGE_KEY = 'openbridge_theme';
const THEMES = ['light', 'dark'];
const BROWSER_COLOR = { light: '#C5161D', dark: '#141210' };
const listeners = new Set();

function readTheme() {
  return document.documentElement.dataset.theme === 'dark' ? 'dark' : 'light';
}

function subscribe(listener) {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

// Browser chrome is a separate concern from the document theme: index.html
// hardcodes the light value, so a dark load has to rewrite the meta tag even
// when the theme itself already matches.
function applyBrowserColor(theme) {
  const meta = document.querySelector('meta[name="theme-color"]');
  if (meta) meta.setAttribute('content', BROWSER_COLOR[theme]);
}

function writeTheme(next) {
  if (!THEMES.includes(next)) return;
  applyBrowserColor(next);
  if (readTheme() === next) return;
  document.documentElement.dataset.theme = next;
  try { localStorage.setItem(STORAGE_KEY, next); } catch { /* storage may be unavailable */ }
  listeners.forEach(listener => listener());
}

applyBrowserColor(readTheme());

export function useTheme() {
  // The dataset attribute is the single source of truth: index.html writes it
  // before first paint, so a second hook instance always reads the same value.
  const theme = useSyncExternalStore(subscribe, readTheme, () => 'light');
  const setTheme = useCallback(next => writeTheme(next), []);
  const toggleTheme = useCallback(() => writeTheme(readTheme() === 'dark' ? 'light' : 'dark'), []);
  return { theme, setTheme, toggleTheme };
}
