import Modal from '../ui/Modal.jsx';
import { useTheme } from '../../hooks/useTheme.js';
import './Settings.css';

export default function SettingsPanel({ currentUser, onClose, onEditProfile, onLogoutRequest }) {
  const { theme, setTheme } = useTheme();

  return (
    <Modal onClose={onClose} labelledBy="settings-title" className="settings-modal">
      <header className="settings-head">
        <h2 id="settings-title">تنظیمات</h2>
        <button type="button" className="icon-btn" onClick={onClose} aria-label="بستن تنظیمات">
          <i className="fas fa-xmark" aria-hidden="true" />
        </button>
      </header>

      <div className="settings-body">
        <section className="settings-section" aria-labelledby="settings-theme">
          <h3 id="settings-theme">ظاهر</h3>
          <div className="settings-row">
            <span className="settings-row-text">
              <span className="settings-label">حالت نمایش</span>
              <span className="settings-hint">فقط روی همین دستگاه ذخیره می‌شود</span>
            </span>
            <div className="settings-segment" role="group" aria-label="حالت نمایش">
              <button
                type="button"
                className={`settings-seg${theme === 'light' ? ' active' : ''}`}
                aria-pressed={theme === 'light'}
                onClick={() => setTheme('light')}
              >
                روشن
              </button>
              <button
                type="button"
                className={`settings-seg${theme === 'dark' ? ' active' : ''}`}
                aria-pressed={theme === 'dark'}
                onClick={() => setTheme('dark')}
              >
                تیره
              </button>
            </div>
          </div>
        </section>

        <section className="settings-section" aria-labelledby="settings-account">
          <h3 id="settings-account">حساب</h3>
          <dl className="settings-facts">
            <div className="settings-fact">
              <dt>نام</dt>
              <dd>{currentUser.name}</dd>
            </div>
            <div className="settings-fact">
              <dt>نام کاربری</dt>
              <dd dir="ltr">@{currentUser.username}</dd>
            </div>
            {currentUser.phone && (
              <div className="settings-fact">
                <dt>شماره</dt>
                <dd dir="ltr">{currentUser.phone}</dd>
              </div>
            )}
          </dl>
          <button type="button" className="btn btn-secondary settings-action" onClick={onEditProfile}>
            ویرایش پروفایل
          </button>
        </section>

        <section className="settings-section">
          <button type="button" className="btn btn-danger settings-action" onClick={onLogoutRequest}>
            خروج از حساب
          </button>
        </section>
      </div>
    </Modal>
  );
}
