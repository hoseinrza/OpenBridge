import { useCallback, useEffect, useState } from 'react';
import { listSessions, revokeSession } from '../../services/api.js';
import Modal from '../ui/Modal.jsx';
import './SessionsModal.css';

function describeDevice(userAgent) {
  const ua = userAgent ?? '';
  const tablet = /iPad|Tablet/i.test(ua);
  const mobile = !tablet && /Android|iPhone|iPod|Mobi/i.test(ua);

  let browser = '';
  if (/Edg\//.test(ua)) browser = 'Edge';
  else if (/OPR\//.test(ua)) browser = 'Opera';
  else if (/Firefox\//.test(ua) || /FxiOS\//.test(ua)) browser = 'Firefox';
  else if (/CriOS\//.test(ua)) browser = 'Chrome';
  else if (/Chrome\//.test(ua)) browser = 'Chrome';
  else if (/Safari\//.test(ua)) browser = 'Safari';

  let os = '';
  if (/Windows NT/.test(ua)) os = 'Windows';
  else if (/Android/.test(ua)) os = 'Android';
  else if (/iPhone|iPad|iPod/.test(ua)) os = 'iOS';
  else if (/Mac OS X/.test(ua)) os = 'macOS';
  else if (/Linux/.test(ua)) os = 'Linux';

  return {
    icon: tablet ? 'fa-tablet-screen-button' : mobile ? 'fa-mobile-screen-button' : 'fa-desktop',
    name: [browser, os].filter(Boolean).join(' · ') || 'دستگاه ناشناس',
  };
}

function when(value) {
  if (!value) return 'نامشخص';
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return 'نامشخص';
  return date.toLocaleString('fa-IR', { dateStyle: 'medium', timeStyle: 'short' });
}

export default function SessionsModal({ onClose, onRevoked }) {
  const [data, setData] = useState(null);
  const [error, setError] = useState('');
  const [confirmId, setConfirmId] = useState(null);
  const [busyId, setBusyId] = useState(null);

  const load = useCallback(async () => {
    try {
      setError('');
      setData(await listSessions());
    } catch (err) {
      setError(err.message || 'فهرست دستگاه‌ها خوانده نشد');
      setData({ sessions: [], canRevokeOthers: false, revokeCooldownDays: 30 });
    }
  }, []);

  // Deferred by a tick so the first fetch is not a synchronous setState inside
  // the effect body, which React flags as a cascading render.
  useEffect(() => {
    const timer = setTimeout(load, 0);
    return () => clearTimeout(timer);
  }, [load]);

  const sessions = data?.sessions ?? null;
  const otherCount = (sessions ?? []).filter(session => !session.current).length;
  const blocked = data?.canRevokeOthers === false;

  async function handleRevoke(session) {
    setBusyId(session.id);
    setError('');
    try {
      await revokeSession(session.id);
      setConfirmId(null);
      setData(prev => (prev
        ? { ...prev, sessions: prev.sessions.filter(item => item.id !== session.id) }
        : prev));
      onRevoked?.(session);
    } catch (err) {
      setError(err.message || 'خروج این دستگاه ناموفق بود');
    } finally {
      setBusyId(null);
    }
  }

  return (
    <Modal onClose={onClose} labelledBy="sessions-title" className="sessions-modal">
      <header className="sessions-head">
        <h2 id="sessions-title">دستگاه‌های فعال</h2>
        <button type="button" className="icon-btn" onClick={onClose} aria-label="بستن فهرست دستگاه‌ها">
          <i className="fas fa-xmark" aria-hidden="true" />
        </button>
      </header>

      <div className="sessions-scroll">
        <p className="sessions-intro">
          هر دستگاهی که با شمارهٔ شما وارد شود، همین گفتگوها و فایل‌ها را می‌بیند.
          دستگاهی را که نمی‌شناسید از همین‌جا خارج کنید.
        </p>

        {blocked && otherCount > 0 && (
          <div className="sessions-hint" role="status">
            <i className="fas fa-hourglass-half" aria-hidden="true" />
            این دستگاه تازه وارد شده است؛ تا {(data?.revokeCooldownDays ?? 30).toLocaleString('fa-IR')} روز
            نمی‌تواند دستگاه‌های دیگر را خارج کند.
          </div>
        )}

        {error && (
          <div className="sessions-error" role="alert">
            <i className="fas fa-triangle-exclamation" aria-hidden="true" />
            {error}
          </div>
        )}

        {sessions === null && (
          <div className="sessions-empty" role="status">
            <i className="fas fa-spinner fa-spin" aria-hidden="true" />
            در حال خواندن دستگاه‌ها…
          </div>
        )}

        {sessions !== null && sessions.length === 0 && !error && (
          <div className="sessions-empty">دستگاه فعالی پیدا نشد.</div>
        )}

        <ul className="session-list">
          {(sessions ?? []).map(session => {
            const device = describeDevice(session.userAgent);
            const locked = !session.current && blocked;
            const confirming = confirmId === session.id;
            return (
              <li key={session.id} className={`session-row ${session.current ? 'is-current' : ''}`}>
                <span className="session-icon" aria-hidden="true">
                  <i className={`fas ${device.icon}`} />
                </span>

                <div className="session-main">
                  <div className="session-title">
                    <span className="session-name">{device.name}</span>
                    {session.current && <span className="session-chip">این دستگاه</span>}
                    <span className={`session-state ${session.online ? 'is-online' : ''}`}>
                      <span className="session-dot" aria-hidden="true" />
                      {session.online ? 'آنلاین' : 'آفلاین'}
                    </span>
                  </div>

                  <div className="session-meta">
                    <span className="session-ip" dir="ltr">{session.ip ?? 'IP نامشخص'}</span>
                    <span>آخرین فعالیت: {when(session.lastUsedAt)}</span>
                    <span>ورود: {when(session.createdAt)}</span>
                  </div>

                  {confirming ? (
                    <div className="session-confirm" role="group" aria-label="تأیید خروج دستگاه">
                      <span>از حساب خارج شود؟</span>
                      <button
                        type="button"
                        className="btn btn-secondary"
                        onClick={() => setConfirmId(null)}
                        disabled={busyId === session.id}
                      >
                        انصراف
                      </button>
                      <button
                        type="button"
                        className="btn btn-primary"
                        onClick={() => handleRevoke(session)}
                        disabled={busyId === session.id}
                      >
                        {busyId === session.id
                          ? <><i className="fas fa-spinner fa-spin" aria-hidden="true" /> خروج…</>
                          : 'خروج'}
                      </button>
                    </div>
                  ) : (
                    <button
                      type="button"
                      className="session-revoke"
                      onClick={() => setConfirmId(session.id)}
                      disabled={session.current || locked || busyId === session.id}
                      title={locked ? 'این دستگاه تازه وارد شده و هنوز اجازهٔ خروج بقیه را ندارد' : undefined}
                    >
                      <i className="fas fa-right-from-bracket" aria-hidden="true" />
                      {session.current ? 'دستگاه فعلی' : 'خروج این دستگاه'}
                    </button>
                  )}
                </div>
              </li>
            );
          })}
        </ul>
      </div>
    </Modal>
  );
}
