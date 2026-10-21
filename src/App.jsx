import { useEffect, useState } from 'react';
import { BrowserRouter, Routes, Route, Navigate } from 'react-router-dom';
import LoginPage from './components/Auth/LoginPage.jsx';
import ChatPage  from './components/Chat/ChatPage.jsx';
import { logout } from './services/api.js';
import { closeE2ee, initE2ee } from './services/e2ee.js';

function loadUser() {
  try { return JSON.parse(localStorage.getItem('chatapp_user')) || null; }
  catch { return null; }
}

function storeUser(user, setCurrentUser) {
  const normalized = {
    id: user.id,
    name: user.displayName || user.username,
    username: user.username,
    firstName: user.firstName ?? null,
    lastName: user.lastName ?? null,
    phone: user.phone ?? null,
    // No avatar means the UI draws the user's initials instead of a stock image.
    avatar: user.avatar ?? null,
    bio: user.bio ?? '',
    status: 'online',
    createdAt: user.createdAt ?? null,
  };
  localStorage.setItem('chatapp_user', JSON.stringify(normalized));
  setCurrentUser(normalized);
}

export default function App() {
  const [currentUser, setCurrentUser] = useState(loadUser);

  // A signed-in device must be invitable before anybody opens a chat with it:
  // registering the device and pooling its key packages happens here, not on
  // first use, so the first message someone sends to this account can already
  // be encrypted rather than falling back to readable text.
  useEffect(() => {
    if (currentUser?.id) initE2ee({ id: currentUser.id }).catch(() => undefined);
  }, [currentUser?.id]);

  function handleAuthenticated(user) {
    storeUser(user, setCurrentUser);
  }

  function handleLogout() {
    // Releases the MLS client and its connection. The device keys stay in
    // IndexedDB on purpose: this browser is still the same device, and losing
    // its keys would make every conversation it joined unreadable for good.
    closeE2ee();
    logout();
    setCurrentUser(null);
  }

  function handleProfileUpdate(patch) {
    setCurrentUser(prev => {
      const next = { ...prev, ...patch };
      localStorage.setItem('chatapp_user', JSON.stringify(next));
      return next;
    });
  }

  if (!currentUser) return <LoginPage onAuthenticated={handleAuthenticated} />;

  return (
    <BrowserRouter>
      <Routes>
        <Route path="/" element={<ChatPage currentUser={currentUser} onLogout={handleLogout} onProfileUpdate={handleProfileUpdate} />} />
        <Route path="*" element={<Navigate to="/" replace />} />
      </Routes>
    </BrowserRouter>
  );
}
