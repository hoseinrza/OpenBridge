import { useEffect, useRef, useState } from 'react';
import { updateProfile, uploadFile, resolveUrl, uploadPath } from '../../services/api.js';
import { isIranMobile } from '../../utils/phone.js';
import Avatar from '../ui/Avatar.jsx';
import Modal from '../ui/Modal.jsx';
import './ProfileModal.css';

const STATUS_TEXT = { online: 'آنلاین', idle: 'غیرفعال', dnd: 'مشغول', offline: 'آفلاین' };

function joinedAt(dateStr) {
  if (!dateStr) return null;
  return new Date(dateStr).toLocaleDateString('fa-IR', { year: 'numeric', month: 'long', day: 'numeric' });
}

export default function ProfileModal({ user, isOwn, onClose, onSaved }) {
  const [editing,  setEditing]  = useState(false);
  const [name,     setName]     = useState(user.name);
  const [username, setUsername] = useState(user.username ?? '');
  const [bio,      setBio]      = useState(user.bio ?? '');
  const [avatar,   setAvatar]   = useState(user.avatar);
  const [saving,       setSaving]       = useState(false);
  const [uploading,    setUploading]    = useState(false);
  const [error,        setError]        = useState('');
  const fileInputRef = useRef(null);
  const nameInputRef = useRef(null);
  const phoneAccount = isIranMobile(user.username ?? '');

  useEffect(() => {
    if (editing) nameInputRef.current?.focus();
  }, [editing]);

  async function handleAvatarPick(e) {
    const file = e.target.files?.[0];
    e.target.value = '';
    if (!file) return;

    setError('');
    setUploading(true);
    try {
      const uploaded = await uploadFile(file);
      setAvatar(resolveUrl(uploaded.url));
    } catch (err) {
      setError(err.message || 'آپلود تصویر ناموفق بود');
    } finally {
      setUploading(false);
    }
  }

  async function handleSave(e) {
    e?.preventDefault();
    const trimmedName     = name.trim();
    const trimmedUsername = username.trim();
    if (!trimmedName) { setError('نام نمایشی نمی‌تواند خالی باشد'); return; }
    if (!phoneAccount && (trimmedUsername.length < 2 || !/^[a-zA-Z0-9_]+$/.test(trimmedUsername))) {
      setError('نام کاربری باید فقط شامل حروف انگلیسی، عدد و _ باشد');
      return;
    }
    setError('');
    setSaving(true);
    try {
      const body = { displayName: trimmedName, bio: bio.trim() };
      // Only persist real uploads; resolveUrl()/fallback images are display
      // URLs and would be rejected by the server's avatar validation.
      const avatarUpload = uploadPath(avatar);
      if (avatarUpload?.startsWith('/uploads/')) body.avatar = avatarUpload;
      // Legacy accounts may still have a non-English username; only send it
      // when the user actually changes it so the new rule doesn't block them.
      if (!phoneAccount && trimmedUsername !== user.username) body.username = trimmedUsername;
      await updateProfile(body);
      onSaved?.({ name: trimmedName, username: trimmedUsername, bio: bio.trim(), avatar });
      setEditing(false);
    } catch (err) {
      setError(err.message || 'ذخیره تغییرات ناموفق بود');
    } finally {
      setSaving(false);
    }
  }

  function handleCancelEdit() {
    setName(user.name);
    setUsername(user.username ?? '');
    setBio(user.bio ?? '');
    setAvatar(user.avatar);
    setError('');
    setEditing(false);
  }

  return (
    <Modal onClose={onClose} labelledBy="profile-title" className="profile-modal">
      <header className="profile-head">
        <h2 id="profile-title">{editing ? 'ویرایش پروفایل' : 'پروفایل'}</h2>
        <button type="button" className="icon-btn" onClick={onClose} aria-label="بستن پروفایل">
          <i className="fas fa-xmark" aria-hidden="true" />
        </button>
      </header>

      <div className="profile-scroll">
        <div className="profile-avatar-wrap">
          <Avatar src={avatar} name={name || user.name} size={88} />
          {editing && (
            <>
              <button
                type="button"
                className="profile-avatar-edit"
                onClick={() => fileInputRef.current?.click()}
                aria-label="تغییر تصویر پروفایل"
                disabled={uploading}
              >
                <i className={uploading ? 'fas fa-spinner fa-spin' : 'fas fa-camera'} aria-hidden="true" />
              </button>
              <input
                ref={fileInputRef}
                type="file"
                accept="image/*"
                hidden
                onChange={handleAvatarPick}
              />
            </>
          )}
        </div>

        {editing ? (
          <form className="profile-form" onSubmit={handleSave}>
            <div className="field">
              <label className="field-label" htmlFor="profile-name">نام نمایشی</label>
              <input
                id="profile-name"
                ref={nameInputRef}
                className="field-input"
                value={name}
                maxLength={50}
                onChange={e => setName(e.target.value)}
              />
            </div>

            <div className="field">
              <label className="field-label" htmlFor={phoneAccount ? 'profile-phone' : 'profile-username'}>
                {phoneAccount ? 'شماره موبایل' : 'نام کاربری'}
              </label>
              {phoneAccount ? (
                <>
                  <input
                    id="profile-phone"
                    className="field-input"
                    value={username}
                    dir="ltr"
                    readOnly
                    aria-describedby="profile-phone-hint"
                  />
                  <span className="field-hint" id="profile-phone-hint">
                    شماره موبایل حساب قابل تغییر نیست.
                  </span>
                </>
              ) : (
                <>
                  <input
                    id="profile-username"
                    className="field-input"
                    value={username}
                    maxLength={30}
                    onChange={e => setUsername(e.target.value)}
                    dir="ltr"
                    autoComplete="username"
                  />
                  <span className="field-hint">فقط حروف انگلیسی، عدد و _</span>
                </>
              )}
            </div>

            <div className="field">
              <label className="field-label" htmlFor="profile-bio">درباره من</label>
              <textarea
                id="profile-bio"
                className="field-input profile-textarea"
                value={bio}
                maxLength={150}
                placeholder="چند کلمه درباره خودت بنویس…"
                onChange={e => setBio(e.target.value)}
              />
            </div>

            {error && (
              <div className="field-error" role="alert">
                <i className="fas fa-triangle-exclamation" aria-hidden="true" />
                {error}
              </div>
            )}

            <div className="profile-actions">
              <button type="button" className="btn btn-secondary" onClick={handleCancelEdit} disabled={saving}>
                انصراف
              </button>
              <button type="submit" className="btn btn-primary" disabled={saving || uploading}>
                {saving ? <><i className="fas fa-spinner fa-spin" aria-hidden="true" /> ذخیره…</> : 'ذخیره تغییرات'}
              </button>
            </div>
          </form>
        ) : (
          <>
            <div className="profile-name">{user.name}</div>
            {user.username && <div className="profile-username" dir="ltr">@{user.username}</div>}

            <div className={`profile-status status-${user.status ?? 'offline'}`}>
              <span className="profile-status-dot" aria-hidden="true" />
              {STATUS_TEXT[user.status] ?? 'آفلاین'}
            </div>

            {user.bio && <p className="profile-bio">{user.bio}</p>}

            {user.createdAt && (
              <div className="profile-joined">
                <i className="fas fa-calendar-day" aria-hidden="true" />
                عضو از {joinedAt(user.createdAt)}
              </div>
            )}

            {error && (
              <div className="field-error" role="alert">
                <i className="fas fa-triangle-exclamation" aria-hidden="true" />
                {error}
              </div>
            )}

            {isOwn && (
              <button type="button" className="btn btn-primary profile-edit-btn" onClick={() => setEditing(true)}>
                <i className="fas fa-pen" aria-hidden="true" />
                ویرایش پروفایل
              </button>
            )}
          </>
        )}
      </div>
    </Modal>
  );
}
