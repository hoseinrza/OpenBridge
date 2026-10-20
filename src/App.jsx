import { useState } from 'react';
import { BrowserRouter, Routes, Route, Navigate } from 'react-router-dom';
import LoginPage from './components/Auth/LoginPage.jsx';
import ChatPage  from './components/Chat/ChatPage.jsx';
import { logout } from './services/api.js';

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

  function handleAuthenticated(user) {
    storeUser(user, setCurrentUser);
  }

  function handleLogout() {
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
