import { useRef, useState } from 'react';
import ThemeToggle from '../ui/ThemeToggle.jsx';
import './LoginPage.css';

const MODES = ['login', 'register'];

export default function LoginPage({ onLogin }) {
  const [mode,        setMode]        = useState('login'); // 'login' | 'register'
  const [username,    setUsername]    = useState('');
  const [displayName, setDisplayName] = useState('');
  const [password,    setPassword]    = useState('');
  const [showPassword, setShowPassword] = useState(false);
  const [error,       setError]       = useState('');
  const [loading,     setLoading]     = useState(false);
  const tabRefs = useRef({});

  function switchMode(next, focus = false) {
    setMode(next);
    setPassword('');
    setError('');
    setShowPassword(false);
    if (focus) tabRefs.current[next]?.focus();
  }

  function handleTabKey(e) {
    const current = MODES.indexOf(mode);
    let index;
    // RTL tablists advance with ArrowLeft, per the ARIA authoring practices.
    if (e.key === 'ArrowLeft')       index = (current + 1) % MODES.length;
    else if (e.key === 'ArrowRight') index = (current - 1 + MODES.length) % MODES.length;
    else if (e.key === 'Home')       index = 0;
    else if (e.key === 'End')        index = MODES.length - 1;
    else return;
    e.preventDefault();
    switchMode(MODES[index], true);
  }

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

  const isRegister = mode === 'register';

  return (
    <div className="auth-page">
      <div className="auth-topbar">
        <ThemeToggle />
      </div>

      <section className="auth-brand" aria-label="OpenBridge">
        <div className="auth-brand-inner">
          <div className="auth-brand-mark">
            <img src="/logo.svg" alt="" width="56" height="56" />
            <span className="auth-brand-name">OpenBridge</span>
          </div>

          <div className="auth-brand-copy">
            <h1>پلی میان آدم‌ها</h1>
            <p>
              گفتگوهای خصوصی و گروهی، پیام‌های لحظه‌ای و اشتراک فایل —
              همه در یک فضای ساده و آرام.
            </p>
          </div>

          <ul className="auth-brand-points">
            <li><i className="fas fa-comment" aria-hidden="true" /> گفتگوی خصوصی و گروهی</li>
            <li><i className="fas fa-bolt" aria-hidden="true" /> پیام‌رسانی لحظه‌ای</li>
            <li><i className="fas fa-paperclip" aria-hidden="true" /> ارسال تصویر و فایل</li>
          </ul>
        </div>
      </section>

      <main className="auth-main">
        <div className="auth-mobile-brand">
          <img src="/logo.svg" alt="" width="40" height="40" />
          <span>OpenBridge</span>
        </div>

        <div className="auth-card">
          <header className="auth-card-head">
            <h2>{isRegister ? 'ساخت حساب جدید' : 'خوش برگشتی'}</h2>
            <p>{isRegister ? 'برای شروع، اطلاعات حساب خود را وارد کن.' : 'برای ادامه وارد حساب کاربری خود شو.'}</p>
          </header>

          <div className="auth-tabs" role="tablist" aria-label="ورود یا ثبت‌نام" onKeyDown={handleTabKey}>
            <button
              type="button"
              role="tab"
              id="auth-tab-login"
              aria-selected={!isRegister}
              aria-controls="auth-panel"
              tabIndex={isRegister ? -1 : 0}
              ref={el => { tabRefs.current.login = el; }}
              className={!isRegister ? 'active' : ''}
              onClick={() => switchMode('login')}
            >
              ورود
            </button>
            <button
              type="button"
              role="tab"
              id="auth-tab-register"
              aria-selected={isRegister}
              aria-controls="auth-panel"
              tabIndex={isRegister ? 0 : -1}
              ref={el => { tabRefs.current.register = el; }}
              className={isRegister ? 'active' : ''}
              onClick={() => switchMode('register')}
            >
              ثبت‌نام
            </button>
          </div>

          <div
            id="auth-panel"
            role="tabpanel"
            aria-labelledby={isRegister ? 'auth-tab-register' : 'auth-tab-login'}
            tabIndex={-1}
          >
          <form onSubmit={submit} className="auth-form" noValidate>
            <div className="field">
              <label htmlFor="auth-username">نام کاربری</label>
              <div className="field-control">
                <i className="fas fa-at field-icon" aria-hidden="true" />
                <input
                  id="auth-username"
                  type="text"
                  name="username"
                  autoComplete="username"
                  required
                  value={username}
                  onChange={e => { setUsername(e.target.value); setError(''); }}
                  placeholder="مثلاً ali_reza"
                  dir="ltr"
                  autoFocus
                  maxLength={30}
                  disabled={loading}
                  aria-invalid={!!error}
                  aria-describedby={error ? 'auth-error' : undefined}
                />
              </div>
            </div>

            {isRegister && (
              <div className="field">
                <label htmlFor="auth-display-name">نام نمایشی</label>
                <div className="field-control">
                  <i className="fas fa-user field-icon" aria-hidden="true" />
                  <input
                    id="auth-display-name"
                    type="text"
                    name="displayName"
                    autoComplete="nickname"
                    required
                    value={displayName}
                    onChange={e => { setDisplayName(e.target.value); setError(''); }}
                    placeholder="مثلاً علی رضایی"
                    maxLength={50}
                    disabled={loading}
                  />
                </div>
              </div>
            )}

            <div className="field">
              <label htmlFor="auth-password">رمز عبور</label>
              <div className="field-control">
                <i className="fas fa-lock field-icon" aria-hidden="true" />
                <input
                  id="auth-password"
                  type={showPassword ? 'text' : 'password'}
                  name="password"
                  autoComplete={isRegister ? 'new-password' : 'current-password'}
                  required
                  value={password}
                  onChange={e => { setPassword(e.target.value); setError(''); }}
                  placeholder={isRegister ? 'حداقل ۸ کاراکتر' : 'رمز عبور'}
                  maxLength={72}
                  disabled={loading}
                  aria-invalid={!!error}
                  aria-describedby={error ? 'auth-error' : undefined}
                />
                <button
                  type="button"
                  className="password-toggle"
                  onClick={() => setShowPassword(v => !v)}
                  aria-label={showPassword ? 'پنهان‌کردن رمز عبور' : 'نمایش رمز عبور'}
                  aria-pressed={showPassword}
                  tabIndex={0}
                >
                  <i className={`fas fa-${showPassword ? 'eye-slash' : 'eye'}`} aria-hidden="true" />
                </button>
              </div>
            </div>

            {error && (
              <div className="auth-error" id="auth-error" role="alert">
                <i className="fas fa-circle-exclamation" aria-hidden="true" />
                <span>{error}</span>
              </div>
            )}

            <button className="btn btn-primary auth-submit" type="submit" disabled={loading}>
              {loading ? (
                <>
                  <i className="fas fa-circle-notch spin" aria-hidden="true" />
                  لطفاً صبر کنید…
                </>
              ) : isRegister ? (
                <>
                  <i className="fas fa-user-plus" aria-hidden="true" />
                  ساخت حساب
                </>
              ) : (
                <>
                  <i className="fas fa-arrow-left" aria-hidden="true" />
                  ورود به OpenBridge
                </>
              )}
            </button>
          </form>

          <p className="auth-note">
            {isRegister
              ? 'با ثبت‌نام، یک حساب تازه برای گفتگوهایت ساخته می‌شود.'
              : 'اگر حساب نداری، از تب «ثبت‌نام» شروع کن.'}
          </p>
          </div>
        </div>
      </main>
    </div>
  );
}
