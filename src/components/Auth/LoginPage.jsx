import { useState } from 'react';
import './LoginPage.css';

export default function LoginPage({ onLogin }) {
  const [mode,        setMode]        = useState('login'); // 'login' | 'register'
  const [username,    setUsername]    = useState('');
  const [displayName, setDisplayName] = useState('');
  const [password,    setPassword]    = useState('');
  const [error,       setError]       = useState('');
  const [loading,     setLoading]     = useState(false);

  async function submit(e) {
    e.preventDefault();
    const u  = username.trim();
    const dn = displayName.trim();
    if (!u)              { setError('نام کاربری را وارد کنید');       return; }
    if (u.length < 2)    { setError('حداقل ۲ کاراکتر وارد کنید');    return; }
    if (mode === 'register' && !/^[a-zA-Z0-9_]+$/.test(u))
                         { setError('نام کاربری باید فقط شامل حروف انگلیسی، عدد و _ باشد'); return; }
    if (mode === 'register' && dn.length < 2)
                         { setError('نام نمایشی باید حداقل ۲ کاراکتر باشد'); return; }
    if (!password)       { setError('رمز عبور را وارد کنید');         return; }
    if (new TextEncoder().encode(password).length > 72)
                         { setError('حداکثر طول رمز عبور ۷۲ بایت است'); return; }
    if (mode === 'register' && password.length < 8)
                         { setError('رمز عبور باید حداقل ۸ کاراکتر باشد'); return; }

    setLoading(true);
    setError('');
    try {
      await onLogin(u, password, mode, dn);
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
          <button type="button" className={mode === 'login'    ? 'active' : ''} onClick={() => { setMode('login'); setPassword(''); setError(''); }}>ورود</button>
          <button type="button" className={mode === 'register' ? 'active' : ''} onClick={() => { setMode('register'); setPassword(''); setError(''); }}>ثبت‌نام</button>
        </div>

        <form onSubmit={submit} className="login-form">
          <input
            className="login-input ltr"
            type="text"
            name="username"
            autoComplete="username"
            required
            value={username}
            onChange={e => { setUsername(e.target.value); setError(''); }}
            placeholder="نام کاربری (انگلیسی)..."
            autoFocus
            maxLength={30}
            disabled={loading}
          />
          {mode === 'register' && (
            <input
              className="login-input"
              type="text"
              name="displayName"
              autoComplete="nickname"
              required
              value={displayName}
              onChange={e => { setDisplayName(e.target.value); setError(''); }}
              placeholder="نام نمایشی (مثلاً علی رضایی)..."
              maxLength={50}
              disabled={loading}
            />
          )}
          <input
            className="login-input"
            type="password"
            name="password"
            autoComplete={mode === 'login' ? 'current-password' : 'new-password'}
            required
            value={password}
            onChange={e => { setPassword(e.target.value); setError(''); }}
            placeholder="رمز عبور..."
            maxLength={72}
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
