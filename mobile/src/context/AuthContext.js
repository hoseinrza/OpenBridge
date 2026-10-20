import { createContext, useCallback, useContext, useEffect, useState } from 'react';
import { storage } from '../services/storage';
import {
  login as apiLogin, logout as apiLogout, requestOtp as apiRequestOtp,
  verifyOtp as apiVerifyOtp, resolveUrl, setUnauthorizedHandler,
} from '../services/api';

const AuthContext = createContext(null);

export function AuthProvider({ children }) {
  const [currentUser, setCurrentUser] = useState(null);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    storage.getUser().then(u => { setCurrentUser(u); setLoading(false); });
  }, []);

  useEffect(() => {
    setUnauthorizedHandler(() => setCurrentUser(null));
    return () => setUnauthorizedHandler(null);
  }, []);

  const persistUser = useCallback(async (user) => {
    const normalized = {
      id: user.id, name: user.displayName || user.username, username: user.username,
      avatar: resolveUrl(user.avatar), bio: user.bio ?? '', status: 'online',
    };
    await storage.setUser(normalized);
    setCurrentUser(normalized);
  }, []);

  const requestOtp = useCallback((phone) => apiRequestOtp(phone), []);

  const verifyOtp = useCallback(async (phone, code, displayName) => {
    const user = await apiVerifyOtp(phone, code, displayName);
    await persistUser(user);
  }, [persistUser]);

  const login = useCallback(async (username, password) => {
    const user = await apiLogin(username, password);
    await persistUser(user);
  }, [persistUser]);

  const logout = useCallback(async () => {
    await apiLogout();
    setCurrentUser(null);
  }, []);

  const updateProfile = useCallback((patch) => {
    setCurrentUser(prev => {
      const next = { ...prev, ...patch };
      storage.setUser(next);
      return next;
    });
  }, []);

  return (
    <AuthContext.Provider value={{ currentUser, loading, requestOtp, verifyOtp, login, logout, updateProfile }}>
      {children}
    </AuthContext.Provider>
  );
}

export function useAuth() {
  const ctx = useContext(AuthContext);
  if (!ctx) throw new Error('useAuth must be used within AuthProvider');
  return ctx;
}
