import { createContext, useCallback, useContext, useEffect, useMemo, useState } from 'react';
import AsyncStorage from '@react-native-async-storage/async-storage';

const STORAGE_KEY = 'openbridge_theme_mode';
const MODES = ['system', 'light', 'dark'];

// The default keeps components that render outside the provider (tests, the
// splash screen) working: they simply follow the OS.
const SettingsContext = createContext({ themeMode: 'system', setThemeMode: () => {} });

export function SettingsProvider({ children }) {
  const [themeMode, setThemeModeState] = useState('system');

  useEffect(() => {
    let cancelled = false;
    AsyncStorage.getItem(STORAGE_KEY)
      .then(saved => {
        if (!cancelled && MODES.includes(saved)) setThemeModeState(saved);
      })
      .catch(() => undefined);
    return () => { cancelled = true; };
  }, []);

  const setThemeMode = useCallback(mode => {
    if (!MODES.includes(mode)) return;
    setThemeModeState(mode);
    AsyncStorage.setItem(STORAGE_KEY, mode).catch(() => undefined);
  }, []);

  const value = useMemo(() => ({ themeMode, setThemeMode }), [themeMode, setThemeMode]);
  return <SettingsContext.Provider value={value}>{children}</SettingsContext.Provider>;
}

export function useSettings() {
  return useContext(SettingsContext);
}
