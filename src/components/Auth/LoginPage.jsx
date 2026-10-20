import { useEffect, useRef, useState } from 'react';
import ThemeToggle from '../ui/ThemeToggle.jsx';
import Avatar from '../ui/Avatar.jsx';
import { requestOtp, verifyOtp, completeSignup } from '../../services/api.js';
import { normalizeIranMobile } from '../../utils/phone.js';
import './LoginPage.css';

const DIGIT_MAP = { fa: '۰۱۲۳۴۵۶۷۸۹', ar: '٠١٢٣٤٥٦٧٨٩' };
const USERNAME_PATTERN = /^[a-zA-Z0-9_]{2,30}$/;
// Mirrors the backend rule: letters of any script (Persian ZWNJ included),
// spaces, apostrophes and hyphens; at least two characters.
const NAME_PATTERN = /^[\p{L}][\p{L}\p{M}\u200c'’ .-]{1,49}$/u;

const SIGN_UP_STEPS = ['phone', 'code', 'username', 'name'];
const STEP_LABELS = { phone: 'شماره', code: 'کد تأیید', username: 'نام کاربری', name: 'نام شما' };

function normalizeCode(value) {
  return value
    .replace(/[۰-۹]/g, digit => String(DIGIT_MAP.fa.indexOf(digit)))
    .replace(/[٠-٩]/g, digit => String(DIGIT_MAP.ar.indexOf(digit)))
    .replace(/\D/g, '')
    .slice(0, 6);
}

function toFa(value) {
  return String(value).replace(/\d/g, digit => DIGIT_MAP.fa[Number(digit)]);
}

function StepTracker({ steps, current }) {
  const index = steps.indexOf(current) + 1;
  if (index < 1) return null;
  return (
    <div className="auth-tracker">
      <div className="auth-tracker-dots" aria-hidden="true">
        {steps.map((key, i) => (
          <span key={key} className={`auth-tracker-dot ${i < index ? 'is-done' : ''} ${i === index - 1 ? 'is-current' : ''}`} />
        ))}
      </div>
      <span className="auth-tracker-label">
        مرحله {toFa(index)} از {toFa(steps.length)} · {STEP_LABELS[current]}
      </span>
    </div>
  );
}

const HEADINGS = {
  phone:    { title: 'ورود یا ثبت‌نام', sub: 'شماره موبایلت را وارد کن تا کد تأیید صادر شود.' },
  code:     { title: 'کد تأیید',        sub: 'کد ۶ رقمی صادرشده برای شماره‌ات را وارد کن.' },
  username: { title: 'نام کاربری',      sub: 'این نام یکتاست و راهی است که دیگران تو را با آن پیدا می‌کنند.' },
  name:     { title: 'نام تو',          sub: 'این نام را در چت‌ها می‌بینند. نام خانوادگی اختیاری است.' },
};

export default function LoginPage({ onAuthenticated }) {
  const [step,        setStep]        = useState('phone');
  const [phone,       setPhone]       = useState('');
  const [code,        setCode]        = useState('');
  const [signupToken, setSignupToken] = useState('');
  const [username,    setUsername]    = useState('');
  const [firstName,   setFirstName]   = useState('');
  const [lastName,    setLastName]    = useState('');
  const [isNewUser,   setIsNewUser]   = useState(false);
  const [testCode,    setTestCode]    = useState('');
  const [resendIn,    setResendIn]    = useState(0);

  const [error,      setError]      = useState('');
  const [busyAction, setBusyAction] = useState(null); // 'request' | 'verify' | 'resend' | 'signup' | 'continue'
  const busy = busyAction !== null;

  const phoneRef    = useRef(null);
  const codeRef     = useRef(null);
  const usernameRef = useRef(null);
  const firstNameRef = useRef(null);

  useEffect(() => {
    const target = { phone: phoneRef, code: codeRef, username: usernameRef, name: firstNameRef }[step];
    target.current?.focus();
  }, [step]);

  useEffect(() => {
    if (resendIn <= 0) return undefined;
    const timer = setTimeout(() => setResendIn(value => Math.max(0, value - 1)), 1000);
    return () => clearTimeout(timer);
  }, [resendIn]);

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

  function submitPhone(e) {
    e.preventDefault();
    issueCode(false);
  }

  async function submitCode(e) {
    e.preventDefault();
    if (code.length !== 6) { setError('کد تأیید باید ۶ رقم باشد'); return; }

    setBusyAction('verify');
    setError('');
    try {
      const result = await verifyOtp(phone, code);
      if (result.requiresSignup) {
        setSignupToken(result.signupToken);
        setIsNewUser(true);
        setStep('username');
      } else {
        onAuthenticated(result.user);
      }
    } catch (err) {
      setError(err.message ?? 'خطا در اتصال به سرور');
    } finally {
      setBusyAction(null);
    }
  }

  function submitUsername(e) {
    e.preventDefault();
    if (!USERNAME_PATTERN.test(username.trim())) {
      setError('نام کاربری باید ۲ تا ۳۰ کاراکتر و فقط حروف انگلیسی، عدد و _ باشد');
      usernameRef.current?.focus();
      return;
    }
    setError('');
    setStep('name');
  }

  async function submitName(e) {
    e.preventDefault();
    const given  = firstName.trim();
    const family = lastName.trim();
    if (!NAME_PATTERN.test(given)) {
      setError('نام باید حداقل ۲ حرف باشد و عدد نداشته باشد');
      firstNameRef.current?.focus();
      return;
    }
    if (family && !NAME_PATTERN.test(family)) {
      setError('نام خانوادگی باید حداقل ۲ حرف باشد و عدد نداشته باشد');
      return;
    }

    setBusyAction('signup');
    setError('');
    try {
      const user = await completeSignup(signupToken, {
        username:  username.trim(),
        firstName: given,
        lastName:  family || undefined,
      });
      onAuthenticated(user);
    } catch (err) {
      // A 401 means the verification window closed, so the code has to be
      // requested again from the first screen.
      if (err.status === 401) {
        setSignupToken('');
        setUsername('');
        setFirstName('');
        setLastName('');
        setIsNewUser(false);
        setCode('');
        setTestCode('');
        setResendIn(0);
        setStep('phone');
      }
      setError(err.message ?? 'خطا در اتصال به سرور');
    } finally {
      setBusyAction(null);
    }
  }

  function changePhone() {
    if (busy) return;
    setStep('phone');
    setCode('');
    setSignupToken('');
    setUsername('');
    setFirstName('');
    setLastName('');
    setIsNewUser(false);
    setTestCode('');
    setResendIn(0);
    setError('');
  }

  const heading = HEADINGS[step];
  const steps = isNewUser ? SIGN_UP_STEPS : SIGN_UP_STEPS.slice(0, 2);
  const previewName = [firstName.trim(), lastName.trim()].filter(Boolean).join(' ');

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

          <StepTracker steps={steps} current={step} />

          {step === 'phone' && (
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
                شماره، هویت تو در OpenBridge است. اگر حسابی نداشته باشی، بعد از تأیید کد،
                در دو مرحله‌ی بعد نام کاربری و نامت را انتخاب می‌کنی.
              </p>
            </form>
          )}

          {step === 'code' && (
            <form onSubmit={submitCode} className="auth-form" noValidate>
              <div className="auth-target-row">
                <span className="auth-target">
                  کد تأیید برای <strong dir="ltr">{phone}</strong> صادر شد.
                </span>
                <button type="button" className="auth-link" onClick={changePhone} disabled={busy}>
                  تغییر شماره
                </button>
              </div>

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
                ) : (
                  <>
                    <i className="fas fa-arrow-left" aria-hidden="true" />
                    {isNewUser ? 'ادامه ثبت‌نام' : 'تأیید و ورود'}
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
                      ? `ارسال دوباره تا ${toFa(resendIn)} ثانیه`
                      : 'ارسال دوباره کد'}
                </button>
              </div>
            </form>
          )}

          {step === 'username' && (
            <form onSubmit={submitUsername} className="auth-form" noValidate>
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
                    aria-describedby={error ? 'auth-error' : 'auth-username-hint'}
                  />
                </div>
                <p className="auth-hint" id="auth-username-hint">
                  فقط حروف انگلیسی، عدد و _ (۲ تا ۳۰ کاراکتر). بعداً می‌توانی عوضش کنی.
                </p>
              </div>

              {error && (
                <div className="auth-error" id="auth-error" role="alert">
                  <i className="fas fa-circle-exclamation" aria-hidden="true" />
                  <span>{error}</span>
                </div>
              )}

              <button className="btn btn-primary auth-submit" type="submit">
                <i className="fas fa-arrow-left" aria-hidden="true" />
                ادامه
              </button>

              <button type="button" className="auth-link auth-switch" onClick={changePhone}>
                انصراف و تغییر شماره
              </button>
            </form>
          )}

          {step === 'name' && (
            <form onSubmit={submitName} className="auth-form" noValidate>
              <div className="auth-preview">
                <Avatar src={null} name={previewName} size={56} />
                <div className="auth-preview-text">
                  <strong>{previewName || 'نام نمایشی تو'}</strong>
                  <span dir="ltr">@{username.trim()}</span>
                </div>
              </div>
              <p className="auth-hint">
                تصویر پروفایل تو تا وقتی عکس ندازی، همین حرف اول نامت است.
              </p>

              <div className="field">
                <label htmlFor="auth-first-name">نام</label>
                <div className="field-control">
                  <i className="fas fa-user field-icon" aria-hidden="true" />
                  <input
                    id="auth-first-name"
                    ref={firstNameRef}
                    type="text"
                    name="firstName"
                    autoComplete="given-name"
                    required
                    value={firstName}
                    onChange={e => { setFirstName(e.target.value); setError(''); }}
                    placeholder="مثلاً علی"
                    maxLength={50}
                    disabled={busy}
                    aria-invalid={!!error}
                    aria-describedby={error ? 'auth-error' : undefined}
                  />
                </div>
              </div>

              <div className="field">
                <label htmlFor="auth-last-name">
                  نام خانوادگی
                  <span className="field-optional">اختیاری</span>
                </label>
                <div className="field-control">
                  <i className="fas fa-user field-icon" aria-hidden="true" />
                  <input
                    id="auth-last-name"
                    type="text"
                    name="lastName"
                    autoComplete="family-name"
                    value={lastName}
                    onChange={e => { setLastName(e.target.value); setError(''); }}
                    placeholder="مثلاً رضایی"
                    maxLength={50}
                    disabled={busy}
                    aria-invalid={!!error}
                    aria-describedby={error ? 'auth-error' : 'auth-last-hint'}
                  />
                </div>
                <p className="auth-hint" id="auth-last-hint">
                  اگر نمی‌خواهی نام خانوادگی نمایش داده شود، خالی بگذار.
                </p>
              </div>

              {error && (
                <div className="auth-error" id="auth-error" role="alert">
                  <i className="fas fa-circle-exclamation" aria-hidden="true" />
                  <span>{error}</span>
                </div>
              )}

              <button className="btn btn-primary auth-submit" type="submit" disabled={busy}>
                {busyAction === 'signup' ? (
                  <>
                    <i className="fas fa-circle-notch spin" aria-hidden="true" />
                    در حال ساخت حساب…
                  </>
                ) : (
                  <>
                    <i className="fas fa-user-plus" aria-hidden="true" />
                    ساخت حساب و ورود
                  </>
                )}
              </button>

              <button type="button" className="auth-link auth-switch" onClick={() => setStep('username')}>
                بازگشت به نام کاربری
              </button>
            </form>
          )}
        </div>
      </main>
    </div>
  );
}
