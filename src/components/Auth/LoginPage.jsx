import { useState } from 'react';
import './LoginPage.css';

export default function LoginPage({ onLogin }) {
  const [mode,     setMode]     = useState('login'); // 'login' | 'register'
  const [username, setUsername] = useState('');
  const [password, setPassword] = useState('');
  const [error,    setError]    = useState('');
  const [loading,  setLoading]  = useState(false);

  async function submit(e) {
    e.preventDefault();
    const u = username.trim();
    if (!u)              { setError('نام کاربری را وارد کنید');       return; }
    if (u.length < 2)    { setError('حداقل ۲ کاراکتر وارد کنید');    return; }
    if (!password)       { setError('رمز عبور را وارد کنید');         return; }
    if (mode === 'register' && password.length < 6)
                         { setError('رمز عبور حداقل ۶ کاراکتر');     return; }

    setLoading(true);
    setError('');
    try {
      await onLogin(u, password, mode);
    } catch (err) {
      setError(err.message ?? 'خطا در اتصال به سرور');
    } finally {
      setLoading(false);
    }
  }

  return (
    <div className="login-page">
      <div className="login-card">
        <img src="/logo.svg" alt="OpenBridge" className="login-logo" />
        <h1 className="login-title">OpenBridge</h1>
        <p className="login-sub">
          {mode === 'login' ? 'به حساب کاربری خود وارد شوید' : 'حساب جدید بسازید'}
        </p>

        <div className="login-tabs">
          <button className={mode === 'login'    ? 'active' : ''} onClick={() => { setMode('login');    setError(''); }}>ورود</button>
          <button className={mode === 'register' ? 'active' : ''} onClick={() => { setMode('register'); setError(''); }}>ثبت‌نام</button>
        </div>

        <form onSubmit={submit} className="login-form">
          <input
            className="login-input"
            type="text"
            value={username}
            onChange={e => { setUsername(e.target.value); setError(''); }}
            placeholder="نام کاربری..."
            autoFocus
            maxLength={30}
            disabled={loading}
          />
          <input
            className="login-input"
            type="password"
            value={password}
            onChange={e => { setPassword(e.target.value); setError(''); }}
            placeholder="رمز عبور..."
            maxLength={100}
            disabled={loading}
          />
          {error && <span className="login-error">{error}</span>}
          <button className="login-btn" type="submit" disabled={loading}>
            {loading
              ? <><i className="fas fa-circle-notch fa-spin" /> لطفاً صبر کنید...</>
              : mode === 'login'
                ? <><i className="fas fa-right-to-bracket" /> ورود به چت</>
                : <><i className="fas fa-user-plus" /> ثبت‌نام</>
            }
          </button>
        </form>
      </div>
    </div>
  );
}
