import { createContext, useCallback, useContext, useEffect, useState } from 'react';
import { storage } from '../services/storage';
import {
  logout as apiLogout, requestOtp as apiRequestOtp,
  verifyOtp as apiVerifyOtp, completeSignup as apiCompleteSignup,
  updateProfile as apiUpdateProfile, resolveUrl, setUnauthorizedHandler,
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
      firstName: user.firstName ?? null, lastName: user.lastName ?? null,
      phone: user.phone ?? null,
      // No avatar means the UI renders the user's initials.
      avatar: resolveUrl(user.avatar), bio: user.bio ?? '', status: 'online',
    };
    await storage.setUser(normalized);
    setCurrentUser(normalized);
  }, []);

  const requestOtp = useCallback((phone) => apiRequestOtp(phone), []);

  const verifyOtp = useCallback(async (phone, code) => {
    const result = await apiVerifyOtp(phone, code);
    if (result.requiresSignup) return result;
    await persistUser(result.user);
    return result;
  }, [persistUser]);

  const completeSignup = useCallback(async (signupToken, profile) => {
    const user = await apiCompleteSignup(signupToken, profile);
    await persistUser(user);
    return user;
  }, [persistUser]);

  const logout = useCallback(async () => {
    await apiLogout();
    setCurrentUser(null);
  }, []);

  // The server's answer is the only trustworthy profile: it recomputes the
  // display name from the two name parts and re-signs the avatar URL, so the
  // stored user is rebuilt the same way a sign-in rebuilds it.
  const saveProfile = useCallback(async (patch) => {
    const user = await apiUpdateProfile(patch);
    await persistUser(user);
    return user;
  }, [persistUser]);

  return (
    <AuthContext.Provider value={{ currentUser, loading, requestOtp, verifyOtp, completeSignup, logout, saveProfile }}>
      {children}
    </AuthContext.Provider>
  );
}

export function useAuth() {
  const ctx = useContext(AuthContext);
  if (!ctx) throw new Error('useAuth must be used within AuthProvider');
  return ctx;
}
