import { useState } from 'react';
import { BrowserRouter, Routes, Route, Navigate } from 'react-router-dom';
import LoginPage     from './components/Auth/LoginPage.jsx';
import ChatPage      from './components/Chat/ChatPage.jsx';
import VideoCallPage from './components/VideoCall/VideoCallPage.jsx';
import { login, register, logout } from './services/api.js';

function loadUser() {
  try { return JSON.parse(localStorage.getItem('chatapp_user')) || null; }
  catch { return null; }
}

export default function App() {
  const [currentUser, setCurrentUser] = useState(loadUser);

  async function handleLogin(username, password, mode) {
    try {
      const user = mode === 'register'
        ? await register(username, password)
        : await login(username, password);
      const normalized = { id: user.id, name: user.username, avatar: user.avatar ?? '/images/user.png', bio: user.bio ?? '', status: 'online' };
      localStorage.setItem('chatapp_user', JSON.stringify(normalized));
      setCurrentUser(normalized);
    } catch (err) {
      // Backend not running → fallback to mock mode
      if (err.message === 'Failed to fetch' || err.name === 'TypeError') {
        const mock = { id: `local-${Date.now()}`, name: username, avatar: '/images/user.png', status: 'online' };
        localStorage.setItem('chatapp_user', JSON.stringify(mock));
        setCurrentUser(mock);
      } else {
        throw err;
      }
    }
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

  if (!currentUser) return <LoginPage onLogin={handleLogin} />;

  return (
    <BrowserRouter>
      <Routes>
        <Route path="/"      element={<ChatPage      currentUser={currentUser} onLogout={handleLogout} onProfileUpdate={handleProfileUpdate} />} />
        <Route path="/video" element={<VideoCallPage currentUser={currentUser} onLogout={handleLogout} />} />
        <Route path="*"      element={<Navigate to="/" replace />} />
      </Routes>
    </BrowserRouter>
  );
}
