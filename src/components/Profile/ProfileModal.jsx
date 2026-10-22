import { useEffect, useRef, useState } from 'react';
import { updateProfile, uploadFile, resolveUrl, uploadPath } from '../../services/api.js';
import Avatar from '../ui/Avatar.jsx';
import Modal from '../ui/Modal.jsx';
import './ProfileModal.css';

const STATUS_TEXT = { online: 'آنلاین', idle: 'غیرفعال', dnd: 'مشغول', offline: 'آفلاین' };
// Mirrors the backend rule: letters of any script (Persian ZWNJ included),
// spaces, apostrophes and hyphens; at least two characters.
const NAME_PATTERN = /^[\p{L}][\p{L}\p{M}\u200c'’ .-]{1,49}$/u;

// Accounts predating the name split only have a display name, so fall back to
// its first word rather than showing an empty required field.
function nameParts(user) {
  if (user.firstName) {
    return { firstName: user.firstName, lastName: user.lastName ?? '' };
  }
  const parts = String(user.name ?? '').trim().split(/\s+/).filter(Boolean);
  return { firstName: parts[0] ?? '', lastName: parts.slice(1).join(' ') };
}

function joinedAt(dateStr) {
  if (!dateStr) return null;
  return new Date(dateStr).toLocaleDateString('fa-IR', { year: 'numeric', month: 'long', day: 'numeric' });
}

export default function ProfileModal({ user, isOwn, onMessage, onClose, onSaved }) {
  const [editing,  setEditing]  = useState(false);
  const [firstName, setFirstName] = useState(() => nameParts(user).firstName);
  const [lastName,  setLastName]  = useState(() => nameParts(user).lastName);
  const [username, setUsername] = useState(user.username ?? '');
  const [bio,      setBio]      = useState(user.bio ?? '');
  const [avatar,   setAvatar]   = useState(user.avatar);
  const [saving,       setSaving]       = useState(false);
  const [uploading,    setUploading]    = useState(false);
  const [error,        setError]        = useState('');
  const fileInputRef = useRef(null);
  const firstNameRef = useRef(null);
  const phone = user.phone ?? null;
  const previewName = [firstName.trim(), lastName.trim()].filter(Boolean).join(' ') || user.name;

  useEffect(() => {
    if (editing) firstNameRef.current?.focus();
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
    const given      = firstName.trim();
    const family     = lastName.trim();
    const trimmedUsername = username.trim();
    if (!NAME_PATTERN.test(given)) { setError('نام باید حداقل ۲ حرف باشد و عدد نداشته باشد'); return; }
    if (family && !NAME_PATTERN.test(family)) { setError('نام خانوادگی باید حداقل ۲ حرف باشد و عدد نداشته باشد'); return; }
    if (trimmedUsername.length < 2 || !/^[a-zA-Z0-9_]+$/.test(trimmedUsername)) {
      setError('نام کاربری باید فقط شامل حروف انگلیسی، عدد و _ باشد');
      return;
    }
    setError('');
    setSaving(true);
    try {
      const body = { firstName: given, lastName: family, bio: bio.trim() };
      // Only persist real uploads; resolveUrl()/fallback images are display
      // URLs and would be rejected by the server's avatar validation.
      const avatarUpload = uploadPath(avatar);
      if (avatarUpload?.startsWith('/uploads/')) body.avatar = avatarUpload;
      // Legacy accounts may still have a non-English username; only send it
      // when the user actually changes it so the new rule doesn't block them.
      if (trimmedUsername !== user.username) body.username = trimmedUsername;
      await updateProfile(body);
      onSaved?.({
        name: [given, family].filter(Boolean).join(' '),
        firstName: given,
        lastName: family,
        username: trimmedUsername,
        bio: bio.trim(),
        avatar,
      });
      setEditing(false);
    } catch (err) {
      setError(err.message || 'ذخیره تغییرات ناموفق بود');
    } finally {
      setSaving(false);
    }
  }

  function handleCancelEdit() {
    setFirstName(nameParts(user).firstName);
    setLastName(nameParts(user).lastName);
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
          <Avatar src={avatar} name={previewName} size={88} />
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
              <label className="field-label" htmlFor="profile-first-name">نام</label>
              <input
                id="profile-first-name"
                ref={firstNameRef}
                className="field-input"
                value={firstName}
                maxLength={50}
                autoComplete="given-name"
                onChange={e => setFirstName(e.target.value)}
              />
            </div>

            <div className="field">
              <label className="field-label" htmlFor="profile-last-name">
                نام خانوادگی
                <span className="field-optional">اختیاری</span>
              </label>
              <input
                id="profile-last-name"
                className="field-input"
                value={lastName}
                maxLength={50}
                autoComplete="family-name"
                onChange={e => setLastName(e.target.value)}
              />
              <span className="field-hint" id="profile-last-hint">
                خالی بگذاری، فقط نام کوچک نمایش داده می‌شود.
              </span>
            </div>

            <div className="field">
              <label className="field-label" htmlFor="profile-username">نام کاربری</label>
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
            </div>

            {phone && (
              <div className="field">
                <label className="field-label" htmlFor="profile-phone">شماره موبایل</label>
                <input
                  id="profile-phone"
                  className="field-input"
                  value={phone}
                  dir="ltr"
                  readOnly
                  aria-describedby="profile-phone-hint"
                />
                <span className="field-hint" id="profile-phone-hint">
                  شماره موبایل برای ورود ثابت می‌ماند و قابل تغییر نیست.
                </span>
              </div>
            )}

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
            {phone && (
              <div className="profile-username" dir="ltr">
                <i className="fas fa-mobile-screen" aria-hidden="true" style={{ marginInlineEnd: 6 }} />
                {phone}
              </div>
            )}

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

            {/* Somebody else's sheet is not a dead end: the reason to look at a
                person in a group is usually to write to them. */}
            {!isOwn && onMessage && (
              <button
                type="button"
                className="btn btn-primary profile-edit-btn"
                onClick={() => onMessage(user)}
              >
                <i className="fas fa-comment" aria-hidden="true" />
                پیام خصوصی
              </button>
            )}
          </>
        )}
      </div>
    </Modal>
  );
}
