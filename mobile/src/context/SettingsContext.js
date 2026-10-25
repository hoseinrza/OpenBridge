import { createContext, useCallback, useContext, useEffect, useMemo, useState } from 'react';
import AsyncStorage from '@react-native-async-storage/async-storage';

const STORAGE_KEY = 'openbridge_theme_mode';
const MODES = ['system', 'light', 'dark'];

// The default keeps components that render outside the provider (tests, the
// splash screen) working: they simply follow the OS and are never held back
// by a hydration step the default context does not own.
const SettingsContext = createContext({ themeMode: 'system', setThemeMode: () => {}, ready: true });

export function SettingsProvider({ children }) {
  const [themeMode, setThemeModeState] = useState('system');
  // The stored mode arrives asynchronously. Until it does, the app would paint
  // the fallback theme and then jump, so readiness is part of the contract.
  const [ready, setReady] = useState(false);

  useEffect(() => {
    let cancelled = false;
    AsyncStorage.getItem(STORAGE_KEY)
      .then(saved => {
        if (cancelled) return;
        if (MODES.includes(saved)) setThemeModeState(saved);
        setReady(true);
      })
      .catch(() => {
        // A storage failure must not hold the splash screen forever: the
        // fallback is to follow the OS.
        if (!cancelled) setReady(true);
      });
    return () => { cancelled = true; };
  }, []);

  const setThemeMode = useCallback(mode => {
    if (!MODES.includes(mode)) return;
    setThemeModeState(mode);
    AsyncStorage.setItem(STORAGE_KEY, mode).catch(() => undefined);
  }, []);

  const value = useMemo(() => ({ themeMode, setThemeMode, ready }), [themeMode, setThemeMode, ready]);
  return <SettingsContext.Provider value={value}>{children}</SettingsContext.Provider>;
}

export function useSettings() {
  return useContext(SettingsContext);
}
