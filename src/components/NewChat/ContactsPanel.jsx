import { useState } from 'react';
import { matchContacts, normalizeUser } from '../../services/api.js';
import { normalizeIranMobile } from '../../utils/phone.js';
import Avatar from '../ui/Avatar.jsx';

// Mirrors CONTACT_MATCH_MAX_PHONES on the server; anything longer is trimmed
// rather than sent in several requests, because this is a manual paste box.
const MAX_PHONES = 500;

// The Contact Picker API only exists in Chromium on Android. Elsewhere the
// paste path is what actually works, so the button is hidden instead of being
// wired to something that can never respond.
const canPickDeviceContacts = typeof navigator !== 'undefined'
  && typeof navigator.contacts?.select === 'function';

function numbersFrom(text) {
  // Split only on line/field separators: "0912 345 6789" is one number and the
  // normaliser removes its spaces.
  return text
    .split(/[\n,;]+/)
    .map(value => value.trim())
    .filter(Boolean);
}

export default function ContactsPanel({ mode, selected, onToggle, onSelect }) {
  const [text, setText] = useState('');
  const [checking, setChecking] = useState(false);
  const [error, setError] = useState('');
  const [result, setResult] = useState(null);

  async function check(numbers) {
    const distinct = [...new Set(numbers.map(normalizeIranMobile).filter(Boolean))].slice(0, MAX_PHONES);
    if (!distinct.length) {
      setResult(null);
      setError('هیچ شمارهٔ موبایل ایرانی معتبری در این فهرست نبود.');
      return;
    }

    setChecking(true);
    setError('');
    try {
      const { matches } = await matchContacts(distinct);
      const accounts = matches.map(match => normalizeUser(match.user)).filter(Boolean);
      const matchedPhones = matches.map(match => distinct[match.index]);
      setResult({
        checked: distinct.length,
        accounts,
        missing: distinct.filter(phone => !matchedPhones.includes(phone)),
      });
    } catch (err) {
      setError(err.message || 'بررسی مخاطبین ناموفق بود');
      setResult(null);
    } finally {
      setChecking(false);
    }
  }

  async function handlePick() {
    let picked;
    try {
      picked = await navigator.contacts.select(['tel'], { multiple: true });
    } catch {
      setError('انتخاب مخاطب لغو شد یا مرورگر اجازه نداد.');
      return;
    }
    const numbers = (picked ?? []).flatMap(entry => entry.tel ?? []);
    if (!numbers.length) {
      setError('مخاطبی با شماره انتخاب نشد.');
      return;
    }
    setText(numbers.join('\n'));
    await check(numbers);
  }

  function handleUser(user) {
    if (mode === 'group') onToggle(user);
    else onSelect(user);
  }

  return (
    <div className="newchat-contacts">
      <p className="newchat-contacts-note">
        شماره‌ها فقط برای مقایسه فرستاده می‌شوند؛ در سرور ذخیره نمی‌شوند و نتیجهٔ بررسی برمی‌گردد.
      </p>

      {canPickDeviceContacts && (
        <button type="button" className="btn btn-secondary newchat-contacts-pick" onClick={handlePick}>
          <i className="fas fa-address-book" aria-hidden="true" />
          انتخاب از مخاطبین دستگاه
        </button>
      )}

      <label htmlFor="contacts-paste" className="sr-only">شماره‌های مخاطبین</label>
      <textarea
        id="contacts-paste"
        className="field-input newchat-contacts-input"
        value={text}
        onChange={event => { setText(event.target.value); setError(''); }}
        placeholder={'شماره‌ها را یکی در هر خط بچسبان؛ مثلاً\n۰۹۱۲۳۴۵۶۷۸۹\n+۹۸۹۱۲۳۴۵۶۷۸۹'}
        rows={4}
        dir="ltr"
      />

      <button
        type="button"
        className="btn btn-primary newchat-contacts-check"
        onClick={() => check(numbersFrom(text))}
        disabled={checking || !text.trim()}
      >
        {checking ? (
          <><i className="fas fa-spinner fa-spin" aria-hidden="true" /> در حال بررسی…</>
        ) : (
          <><i className="fas fa-phone-volume" aria-hidden="true" /> بررسی حساب‌ها</>
        )}
      </button>

      {error && (
        <div className="newchat-state error" role="alert">
          <i className="fas fa-triangle-exclamation" aria-hidden="true" />
          {error}
        </div>
      )}

      {result && (
        <>
          <p className="newchat-contacts-summary" role="status">
            {result.checked.toLocaleString('fa-IR')} شماره بررسی شد؛{' '}
            {result.accounts.length.toLocaleString('fa-IR')} حساب پیدا شد.
          </p>

          <div className="newchat-results">
            {result.accounts.map(user => {
              const isSelected = mode === 'group' && selected.some(item => item.id === user.id);
              return (
                <button
                  key={user.id}
                  type="button"
                  className={`newchat-result ${isSelected ? 'selected' : ''}`}
                  onClick={() => handleUser(user)}
                  aria-pressed={mode === 'group' ? isSelected : undefined}
                >
                  <Avatar src={user.avatar} name={user.name} size={38} status={user.status} />
                  <span className="newchat-result-info">
                    <span className="newchat-result-name">{user.name}</span>
                    {user.username && <span className="newchat-result-username" dir="ltr">@{user.username}</span>}
                  </span>
                  {mode === 'group' ? (
                    <span className={`newchat-check ${isSelected ? 'on' : ''}`} aria-hidden="true">
                      <i className={isSelected ? 'fas fa-circle-check' : 'far fa-circle'} />
                    </span>
                  ) : (
                    <i className="fas fa-arrow-left newchat-result-go" aria-hidden="true" />
                  )}
                </button>
              );
            })}
          </div>

          {result.missing.length > 0 && (
            <ul className="newchat-contacts-missing" aria-label="شماره‌های بدون حساب">
              {result.missing.map(phone => (
                <li key={phone} dir="ltr">{phone}</li>
              ))}
            </ul>
          )}
        </>
      )}
    </div>
  );
}
