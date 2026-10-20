import { useState } from 'react';
import { BrowserRouter, Routes, Route, Navigate } from 'react-router-dom';
import LoginPage from './components/Auth/LoginPage.jsx';
import ChatPage  from './components/Chat/ChatPage.jsx';
import { login, logout } from './services/api.js';

function loadUser() {
  try { return JSON.parse(localStorage.getItem('chatapp_user')) || null; }
  catch { return null; }
}

function storeUser(user, setCurrentUser) {
  const normalized = { id: user.id, name: user.displayName || user.username, username: user.username, avatar: user.avatar ?? '/images/user.png', bio: user.bio ?? '', status: 'online' };
  localStorage.setItem('chatapp_user', JSON.stringify(normalized));
  setCurrentUser(normalized);
}

export default function App() {
  const [currentUser, setCurrentUser] = useState(loadUser);

  async function handleLogin(username, password) {
    storeUser(await login(username, password), setCurrentUser);
  }

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

  if (!currentUser) return <LoginPage onLogin={handleLogin} onAuthenticated={handleAuthenticated} />;

  return (
    <BrowserRouter>
      <Routes>
        <Route path="/" element={<ChatPage currentUser={currentUser} onLogout={handleLogout} onProfileUpdate={handleProfileUpdate} />} />
        <Route path="*" element={<Navigate to="/" replace />} />
      </Routes>
    </BrowserRouter>
  );
}
