import { useRef, useState } from 'react';
import { updateProfile, uploadFile, resolveUrl } from '../../services/api.js';
import { isMockUser } from '../../hooks/useChat.js';
import './ProfileModal.css';

function joinedAt(dateStr) {
  if (!dateStr) return null;
  return new Date(dateStr).toLocaleDateString('fa-IR', { year: 'numeric', month: 'long', day: 'numeric' });
}

export default function ProfileModal({ user, isOwn, onClose, onSaved }) {
  const [editing, setEditing]   = useState(false);
  const [name,    setName]      = useState(user.name);
  const [bio,     setBio]       = useState(user.bio ?? '');
  const [avatar,  setAvatar]    = useState(user.avatar);
  const [saving,  setSaving]    = useState(false);
  const [error,   setError]     = useState('');
  const fileInputRef = useRef(null);

  const mock = isMockUser(user) || isMockUser(JSON.parse(localStorage.getItem('chatapp_user') || 'null'));

  async function handleAvatarPick(e) {
    const file = e.target.files?.[0];
    e.target.value = '';
    if (!file) return;
    if (mock) { setAvatar(URL.createObjectURL(file)); return; }

    setError('');
    try {
      const uploaded = await uploadFile(file);
      setAvatar(resolveUrl(uploaded.url));
    } catch {
      setError('آپلود تصویر ناموفق بود');
    }
  }

  async function handleSave() {
    if (!name.trim()) { setError('نام نمی‌تواند خالی باشد'); return; }
    setError('');
    setSaving(true);
    try {
      const patch = { name: name.trim(), bio: bio.trim(), avatar };
      if (!mock) {
        await updateProfile({ username: name.trim(), bio: bio.trim(), avatar });
      }
      onSaved?.(patch);
      setEditing(false);
    } catch (err) {
      setError(err.message || 'ذخیره تغییرات ناموفق بود');
    } finally {
      setSaving(false);
    }
  }

  function handleCancelEdit() {
    setName(user.name);
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
              maxLength={30}
              onChange={e => setName(e.target.value)}
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
