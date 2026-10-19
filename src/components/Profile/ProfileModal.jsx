import { useRef, useState } from 'react';
import { updateProfile, uploadFile, resolveUrl } from '../../services/api.js';
import './ProfileModal.css';

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
  const [saving,  setSaving]    = useState(false);
  const [error,   setError]     = useState('');
  const fileInputRef = useRef(null);

  async function handleAvatarPick(e) {
    const file = e.target.files?.[0];
    e.target.value = '';
    if (!file) return;

    setError('');
    try {
      const uploaded = await uploadFile(file);
      setAvatar(resolveUrl(uploaded.url));
    } catch {
      setError('آپلود تصویر ناموفق بود');
    }
  }

  async function handleSave() {
    const trimmedName     = name.trim();
    const trimmedUsername = username.trim();
    if (!trimmedName) { setError('نام نمایشی نمی‌تواند خالی باشد'); return; }
    if (trimmedUsername.length < 2 || !/^[a-zA-Z0-9_]+$/.test(trimmedUsername)) {
      setError('نام کاربری باید فقط شامل حروف انگلیسی، عدد و _ باشد');
      return;
    }
    setError('');
    setSaving(true);
    try {
      const body = { displayName: trimmedName, bio: bio.trim(), avatar };
      // Legacy accounts may still have a non-English username; only send it
      // when the user actually changes it so the new rule doesn't block them.
      if (trimmedUsername !== user.username) body.username = trimmedUsername;
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
    <div className="profile-overlay" onClick={onClose}>
      <div className="profile-modal" onClick={e => e.stopPropagation()}>
        <button className="profile-close" onClick={onClose}>
          <i className="fas fa-xmark" />
        </button>

        <div className="profile-avatar-wrap">
          <img src={avatar} alt={name} className="profile-avatar" />
          <span className={`status ${user.status}`} />
          {editing && (
            <>
              <button className="profile-avatar-edit" onClick={() => fileInputRef.current?.click()} title="تغییر تصویر">
                <i className="fas fa-camera" />
              </button>
              <input ref={fileInputRef} type="file" accept="image/*" hidden onChange={handleAvatarPick} />
            </>
          )}
        </div>

        {editing ? (
          <div className="profile-form">
            <label className="profile-label">نام نمایشی</label>
            <input
              className="profile-input"
              value={name}
              maxLength={50}
              onChange={e => setName(e.target.value)}
            />

            <label className="profile-label">نام کاربری (فقط انگلیسی، عدد و _)</label>
            <input
              className="profile-input ltr"
              value={username}
              maxLength={30}
              onChange={e => setUsername(e.target.value)}
              dir="ltr"
            />

            <label className="profile-label">درباره من</label>
            <textarea
              className="profile-input profile-textarea"
              value={bio}
              maxLength={150}
              placeholder="چند کلمه درباره خودت بنویس..."
              onChange={e => setBio(e.target.value)}
            />

            {error && <div className="profile-error">{error}</div>}

            <div className="profile-actions">
              <button className="profile-btn ghost" onClick={handleCancelEdit} disabled={saving}>انصراف</button>
              <button className="profile-btn primary" onClick={handleSave} disabled={saving}>
                {saving ? <i className="fas fa-spinner fa-spin" /> : 'ذخیره'}
              </button>
            </div>
          </div>
        ) : (
          <>
            <div className="profile-name">{user.name}</div>
            {user.username && <div className="profile-username" dir="ltr">@{user.username}</div>}
            <div className="profile-status">
              <span className={`status-dot ${user.status}`} />
              {user.status === 'online' ? 'آنلاین' : user.status === 'idle' ? 'غیرفعال' : 'آفلاین'}
            </div>

            {user.bio && <div className="profile-bio">{user.bio}</div>}

            {user.createdAt && (
              <div className="profile-joined">
                <i className="fas fa-calendar-day" /> عضویت از {joinedAt(user.createdAt)}
              </div>
            )}

            {isOwn && (
              <button className="profile-btn primary edit-trigger" onClick={() => setEditing(true)}>
                <i className="fas fa-pen" /> ویرایش پروفایل
              </button>
            )}
          </>
        )}
      </div>
    </div>
  );
}
