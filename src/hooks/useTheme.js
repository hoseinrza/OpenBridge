import { useCallback, useSyncExternalStore } from 'react';

const STORAGE_KEY = 'openbridge_theme';
const listeners = new Set();

function readTheme() {
  return document.documentElement.dataset.theme === 'dark' ? 'dark' : 'light';
}

function subscribe(listener) {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

function writeTheme(next) {
  const theme = next === 'dark' ? 'dark' : 'light';
  if (readTheme() === theme) return;
  document.documentElement.dataset.theme = theme;
  try { localStorage.setItem(STORAGE_KEY, theme); } catch { /* storage may be unavailable */ }
  const meta = document.querySelector('meta[name="theme-color"]');
  if (meta) meta.setAttribute('content', theme === 'dark' ? '#141210' : '#C5161D');
  listeners.forEach(listener => listener());
}

export function useTheme() {
  // The dataset attribute is the single source of truth: index.html writes it
  // before first paint, so a second hook instance always reads the same value.
  const theme = useSyncExternalStore(subscribe, readTheme, () => 'light');
  const setTheme = useCallback(next => writeTheme(next), []);
  const toggleTheme = useCallback(() => writeTheme(readTheme() === 'dark' ? 'light' : 'dark'), []);
  return { theme, setTheme, toggleTheme };
}
