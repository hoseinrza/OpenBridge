import { createContext, useCallback, useContext, useEffect, useState } from 'react';
import { storage } from '../services/storage';
import { login as apiLogin, register as apiRegister, logout as apiLogout, resolveUrl } from '../services/api';

const AuthContext = createContext(null);

export function AuthProvider({ children }) {
  const [currentUser, setCurrentUser] = useState(null);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    storage.getUser().then(u => { setCurrentUser(u); setLoading(false); });
  }, []);

  const persistUser = useCallback(async (user) => {
    const normalized = {
      id: user.id, name: user.username,
      avatar: resolveUrl(user.avatar), bio: user.bio ?? '', status: 'online',
    };
    await storage.setUser(normalized);
    setCurrentUser(normalized);
  }, []);

  const login = useCallback(async (username, password, mode) => {
    const user = mode === 'register'
      ? await apiRegister(username, password)
      : await apiLogin(username, password);
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
    <AuthContext.Provider value={{ currentUser, loading, login, logout, updateProfile }}>
      {children}
    </AuthContext.Provider>
  );
}

export function useAuth() {
  const ctx = useContext(AuthContext);
  if (!ctx) throw new Error('useAuth must be used within AuthProvider');
  return ctx;
}
