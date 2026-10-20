import { useEffect, useRef, useState } from 'react';
import ThemeToggle from '../ui/ThemeToggle.jsx';
import { requestOtp, verifyOtp } from '../../services/api.js';
import { normalizeIranMobile } from '../../utils/phone.js';
import './LoginPage.css';

const DIGIT_MAP = { fa: '۰۱۲۳۴۵۶۷۸۹', ar: '٠١٢٣٤٥٦٧٨٩' };

function normalizeCode(value) {
  return value
    .replace(/[۰-۹]/g, digit => String(DIGIT_MAP.fa.indexOf(digit)))
    .replace(/[٠-٩]/g, digit => String(DIGIT_MAP.ar.indexOf(digit)))
    .replace(/\D/g, '')
    .slice(0, 6);
}

export default function LoginPage({ onLogin, onAuthenticated }) {
  const [flow,        setFlow]        = useState('otp');     // 'otp' | 'password'
  const [step,        setStep]        = useState('phone');   // 'phone' | 'code'
  const [phone,       setPhone]       = useState('');
  const [code,        setCode]        = useState('');
  const [newUsername, setNewUsername] = useState('');
  const [displayName, setDisplayName] = useState('');
  const [isNewUser,   setIsNewUser]   = useState(false);
  const [testCode,    setTestCode]    = useState('');
  const [resendIn,    setResendIn]    = useState(0);

  const [username,     setUsername]     = useState('');
  const [password,     setPassword]     = useState('');
  const [showPassword, setShowPassword] = useState(false);

  const [error,      setError]      = useState('');
  const [busyAction, setBusyAction] = useState(null); // 'request' | 'verify' | 'resend' | 'password'
  const busy = busyAction !== null;

  const phoneRef    = useRef(null);
  const codeRef     = useRef(null);
  const usernameRef = useRef(null);
  const newUsernameRef = useRef(null);

  useEffect(() => {
    if (flow === 'password') usernameRef.current?.focus();
    else if (step === 'code') {
      if (isNewUser) newUsernameRef.current?.focus();
      else codeRef.current?.focus();
    }
    else phoneRef.current?.focus();
  }, [flow, step, isNewUser]);

  useEffect(() => {
    if (resendIn <= 0) return undefined;
    const timer = setTimeout(() => setResendIn(value => Math.max(0, value - 1)), 1000);
    return () => clearTimeout(timer);
  }, [resendIn]);

  function switchFlow(next) {
    if (busy) return;
    setFlow(next);
    setError('');
    setCode('');
    setTestCode('');
    setResendIn(0);
    setShowPassword(false);
  }

  async function issueCode(isResend = false) {
    const normalized = normalizeIranMobile(phone);
    if (!normalized) {
      setError('شماره موبایل معتبر نیست؛ نمونه: ۰۹۱۲۳۴۵۶۷۸۹');
      if (!isResend) phoneRef.current?.focus();
      return;
    }

    setBusyAction(isResend ? 'resend' : 'request');
    setError('');
    try {
      const data = await requestOtp(normalized);
      setPhone(normalized);
      setIsNewUser(!!data.isNewUser);
      setTestCode(typeof data.testCode === 'string' ? data.testCode : '');
      setCode('');
      setStep('code');
      setResendIn(30);
    } catch (err) {
      setError(err.message ?? 'خطا در اتصال به سرور');
    } finally {
      setBusyAction(null);
    }
  }

  async function submitPhone(e) {
    e.preventDefault();
    await issueCode(false);
  }

  async function submitCode(e) {
    e.preventDefault();
    if (code.length !== 6) { setError('کد تأیید باید ۶ رقم باشد'); return; }
    if (isNewUser) {
      const u = newUsername.trim();
      if (u.length < 2 || !/^[a-zA-Z0-9_]+$/.test(u)) {
        setError('نام کاربری باید فقط شامل حروف انگلیسی، عدد و _ باشد (حداقل ۲ کاراکتر)');
        return;
      }
      if (displayName.trim().length < 2) {
        setError('نام نمایشی باید حداقل ۲ کاراکتر باشد');
        return;
      }
    }

    setBusyAction('verify');
    setError('');
    try {
      const user = await verifyOtp(
        phone,
        code,
        isNewUser ? newUsername.trim() : undefined,
        isNewUser ? displayName.trim() : undefined,
      );
      onAuthenticated(user);
    } catch (err) {
      setError(err.message ?? 'خطا در اتصال به سرور');
    } finally {
      setBusyAction(null);
    }
  }

  function changePhone() {
    if (busy) return;
    setStep('phone');
    setCode('');
    setTestCode('');
    setNewUsername('');
    setDisplayName('');
    setIsNewUser(false);
    setResendIn(0);
    setError('');
  }

  async function submitPassword(e) {
    e.preventDefault();
    const u = username.trim();
    if (!u) { setError('نام کاربری را وارد کنید'); return; }
    if (!password) { setError('رمز عبور را وارد کنید'); return; }

    setBusyAction('password');
    setError('');
    try {
      await onLogin(u, password);
    } catch (err) {
      setError(err.message ?? 'خطا در اتصال به سرور');
    } finally {
      setBusyAction(null);
    }
  }

  const heading = flow === 'password'
    ? { title: 'ورود با رمز عبور', sub: 'این روش برای حساب‌های ساخته‌شده پیش از ورود با موبایل است.' }
    : step === 'phone'
      ? { title: 'ورود یا ثبت‌نام', sub: 'شماره موبایلات را وارد کن تا کد تأیید صادر شود.' }
      : { title: 'کد تأیید', sub: 'کد ۶ رقمی صادرشده برای شماره‌ات را وارد کن.' };

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
            <h2>{heading.title}</h2>
            <p>{heading.sub}</p>
          </header>

          {flow === 'password' ? (
            <form onSubmit={submitPassword} className="auth-form" noValidate>
              <div className="field">
                <label htmlFor="auth-username">نام کاربری</label>
                <div className="field-control">
                  <i className="fas fa-at field-icon" aria-hidden="true" />
                  <input
                    id="auth-username"
                    ref={usernameRef}
                    type="text"
                    name="username"
                    autoComplete="username"
                    required
                    value={username}
                    onChange={e => { setUsername(e.target.value); setError(''); }}
                    placeholder="username"
                    dir="ltr"
                    maxLength={30}
                    disabled={busy}
                    aria-invalid={!!error}
                    aria-describedby={error ? 'auth-error' : undefined}
                  />
                </div>
              </div>

              <div className="field">
                <label htmlFor="auth-password">رمز عبور</label>
                <div className="field-control">
                  <i className="fas fa-lock field-icon" aria-hidden="true" />
                  <input
                    id="auth-password"
                    type={showPassword ? 'text' : 'password'}
                    name="password"
                    autoComplete="current-password"
                    required
                    value={password}
                    onChange={e => { setPassword(e.target.value); setError(''); }}
                    placeholder="رمز عبور"
                    maxLength={72}
                    disabled={busy}
                    aria-invalid={!!error}
                    aria-describedby={error ? 'auth-error' : undefined}
                  />
                  <button
                    type="button"
                    className="password-toggle"
                    onClick={() => setShowPassword(value => !value)}
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

              <button className="btn btn-primary auth-submit" type="submit" disabled={busy}>
                {busyAction === 'password' ? (
                  <>
                    <i className="fas fa-circle-notch spin" aria-hidden="true" />
                    لطفاً صبر کنید…
                  </>
                ) : (
                  <>
                    <i className="fas fa-arrow-left" aria-hidden="true" />
                    ورود به OpenBridge
                  </>
                )}
              </button>

              <button
                type="button"
                className="auth-link auth-switch"
                onClick={() => switchFlow('otp')}
                disabled={busy}
              >
                ورود با شماره موبایل
              </button>
            </form>
          ) : step === 'phone' ? (
            <form onSubmit={submitPhone} className="auth-form" noValidate>
              <div className="field">
                <label htmlFor="auth-phone">شماره موبایل</label>
                <div className="field-control">
                  <i className="fas fa-mobile-screen field-icon" aria-hidden="true" />
                  <input
                    id="auth-phone"
                    ref={phoneRef}
                    type="tel"
                    inputMode="tel"
                    name="phone"
                    autoComplete="tel"
                    required
                    value={phone}
                    onChange={e => { setPhone(e.target.value); setError(''); }}
                    placeholder="۰۹۱۲۳۴۵۶۷۸۹"
                    dir="ltr"
                    maxLength={20}
                    disabled={busy}
                    aria-invalid={!!error}
                    aria-describedby={error ? 'auth-error' : 'auth-phone-hint'}
                  />
                </div>
                <p className="auth-hint" id="auth-phone-hint">
                  با هر قالب رایج؛ مثلاً ۰۹۱۲۳۴۵۶۷۸۹ یا +۹۸۹۱۲۳۴۵۶۷۸۹.
                </p>
              </div>

              {error && (
                <div className="auth-error" id="auth-error" role="alert">
                  <i className="fas fa-circle-exclamation" aria-hidden="true" />
                  <span>{error}</span>
                </div>
              )}

              <button className="btn btn-primary auth-submit" type="submit" disabled={busy}>
                {busyAction === 'request' ? (
                  <>
                    <i className="fas fa-circle-notch spin" aria-hidden="true" />
                    در حال صدور کد…
                  </>
                ) : (
                  <>
                    <i className="fas fa-paper-plane" aria-hidden="true" />
                    دریافت کد تأیید
                  </>
                )}
              </button>

              <p className="auth-note">
                با تأیید شماره، اگر حسابی نداشته باشی در مرحله بعد نام کاربری و نام نمایشی انتخاب می‌کنی.
              </p>

              <button
                type="button"
                className="auth-link auth-switch"
                onClick={() => switchFlow('password')}
                disabled={busy}
              >
                ورود با نام کاربری و رمز (حساب‌های قدیمی)
              </button>
            </form>
          ) : (
            <form onSubmit={submitCode} className="auth-form" noValidate>
              <div className="auth-target-row">
                <span className="auth-target">
                  کد تأیید برای <strong dir="ltr">{phone}</strong> صادر شد.
                </span>
                <button type="button" className="auth-link" onClick={changePhone} disabled={busy}>
                  تغییر شماره
                </button>
              </div>

              {isNewUser && (
                <>
                  <div className="field">
                    <label htmlFor="auth-new-username">نام کاربری</label>
                    <div className="field-control">
                      <i className="fas fa-at field-icon" aria-hidden="true" />
                      <input
                        id="auth-new-username"
                        ref={newUsernameRef}
                        type="text"
                        name="username"
                        autoComplete="username"
                        required
                        value={newUsername}
                        onChange={e => { setNewUsername(e.target.value); setError(''); }}
                        placeholder="username"
                        dir="ltr"
                        maxLength={30}
                        disabled={busy}
                        aria-invalid={!!error}
                        aria-describedby={error ? 'auth-error' : 'auth-username-hint'}
                      />
                    </div>
                    <p className="auth-hint" id="auth-username-hint">
                      هر نام کاربری یکتاست؛ فقط حروف انگلیسی، عدد و _ (حداقل ۲ کاراکتر).
                    </p>
                  </div>

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
                        disabled={busy}
                        aria-invalid={!!error}
                        aria-describedby={error ? 'auth-error' : 'auth-display-hint'}
                      />
                    </div>
                    <p className="auth-hint" id="auth-display-hint">
                      این نام برای بقیه کاربران نمایش داده می‌شود.
                    </p>
                  </div>
                </>
              )}

              <div className="field">
                <label htmlFor="auth-code">کد تأیید ۶ رقمی</label>
                <div className="field-control">
                  <i className="fas fa-shield-halved field-icon" aria-hidden="true" />
                  <input
                    id="auth-code"
                    ref={codeRef}
                    className="auth-code-input"
                    type="text"
                    inputMode="numeric"
                    autoComplete="one-time-code"
                    pattern="[0-9]{6}"
                    required
                    value={code}
                    onChange={e => { setCode(normalizeCode(e.target.value)); setError(''); }}
                    placeholder="۱۲۳۴۵۶"
                    dir="ltr"
                    maxLength={6}
                    disabled={busy}
                    aria-invalid={!!error}
                    aria-describedby={error ? 'auth-error' : undefined}
                  />
                </div>
              </div>

              {testCode && (
                <div className="auth-test-code" role="status">
                  <i className="fas fa-flask" aria-hidden="true" />
                  <span>
                    کد تست (فقط محیط توسعه): <strong dir="ltr">{testCode}</strong>
                  </span>
                </div>
              )}

              {error && (
                <div className="auth-error" id="auth-error" role="alert">
                  <i className="fas fa-circle-exclamation" aria-hidden="true" />
                  <span>{error}</span>
                </div>
              )}

              <button className="btn btn-primary auth-submit" type="submit" disabled={busy}>
                {busyAction === 'verify' ? (
                  <>
                    <i className="fas fa-circle-notch spin" aria-hidden="true" />
                    لطفاً صبر کنید…
                  </>
                ) : isNewUser ? (
                  <>
                    <i className="fas fa-user-plus" aria-hidden="true" />
                    ساخت حساب و ورود
                  </>
                ) : (
                  <>
                    <i className="fas fa-arrow-left" aria-hidden="true" />
                    تأیید و ورود
                  </>
                )}
              </button>

              <div className="auth-code-actions">
                <button
                  type="button"
                  className="auth-link"
                  onClick={() => issueCode(true)}
                  disabled={busy || resendIn > 0}
                >
                  {busyAction === 'resend'
                    ? 'در حال ارسال…'
                    : resendIn > 0
                      ? `ارسال دوباره تا ${resendIn.toLocaleString('fa-IR')} ثانیه`
                      : 'ارسال دوباره کد'}
                </button>
              </div>
            </form>
          )}
        </div>
      </main>
    </div>
  );
}
