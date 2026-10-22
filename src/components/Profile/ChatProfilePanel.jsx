import { useEffect, useRef, useState } from 'react';
import { updateGroup, uploadFile, resolveUrl, uploadPath } from '../../services/api.js';
import Avatar from '../ui/Avatar.jsx';
import './ChatProfilePanel.css';

const STATUS_TEXT = { online: 'آنلاین', idle: 'غیرفعال', dnd: 'مشغول', offline: 'آفلاین' };
const ROLE_TEXT = { OWNER: 'مالک', ADMIN: 'مدیر' };
// The same bounds the server enforces on PATCH /messages/groups/:id, so a draft
// that cannot be saved is caught before the round trip.
const NAME_MIN = 2;
const NAME_MAX = 60;
const DESCRIPTION_MAX = 205;

function joinedAt(dateStr) {
  if (!dateStr) return null;
  return new Date(dateStr).toLocaleDateString('fa-IR', { year: 'numeric', month: 'long', day: 'numeric' });
}

export default function ChatProfilePanel({ chat, currentUser, encrypted, encryptionNote, onClose, onUpdated }) {
  const isGroup = chat.kind === 'group';
  const myRole = isGroup
    ? chat.participants?.find(p => p.id === currentUser?.id)?.role ?? 'MEMBER'
    : null;
  const canEdit = isGroup && (myRole === 'OWNER' || myRole === 'ADMIN');

  const [editing,      setEditing]      = useState(false);
  const [name,         setName]         = useState(chat.name ?? '');
  const [description,  setDescription]  = useState(chat.description ?? '');
  const [avatar,       setAvatar]       = useState(chat.avatar ?? null);
  const [removeAvatar, setRemoveAvatar] = useState(false);
  const [saving,       setSaving]       = useState(false);
  const [uploading,    setUploading]    = useState(false);
  const [error,        setError]        = useState('');

  const closeRef = useRef(null);
  const nameRef = useRef(null);
  const fileInputRef = useRef(null);

  // The panel is remounted per chat, so nothing from the previous one survives.
  useEffect(() => { closeRef.current?.focus(); }, []);

  useEffect(() => {
    function onKey(e) { if (e.key === 'Escape') onClose(); }
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [onClose]);

  useEffect(() => {
    if (editing) nameRef.current?.focus();
  }, [editing]);

  function startEditing() {
    setName(chat.name ?? '');
    setDescription(chat.description ?? '');
    setAvatar(chat.avatar ?? null);
    setRemoveAvatar(false);
    setError('');
    setEditing(true);
  }

  async function handleAvatarPick(e) {
    const file = e.target.files?.[0];
    e.target.value = '';
    if (!file) return;

    setError('');
    setUploading(true);
    try {
      const uploaded = await uploadFile(file);
      setAvatar(resolveUrl(uploaded.url));
      setRemoveAvatar(false);
    } catch (err) {
      setError(err.message || 'آپلود تصویر ناموفق بود');
    } finally {
      setUploading(false);
    }
  }

  async function handleSave(e) {
    e.preventDefault();
    const trimmedName = name.trim();
    const trimmedBio = description.trim();

    if (trimmedName.length < NAME_MIN) {
      setError(`نام گروه باید حداقل ${NAME_MIN} کاراکتر باشد`);
      return;
    }
    if (trimmedName.length > NAME_MAX) {
      setError(`نام گروه نباید بیشتر از ${NAME_MAX} کاراکتر باشد`);
      return;
    }
    if (trimmedBio.length > DESCRIPTION_MAX) {
      setError(`توضیح گروه نباید بیشتر از ${DESCRIPTION_MAX} کاراکتر باشد`);
      return;
    }

    // Only what actually changed is sent: an unchanged photo would be rewritten
    // as a fresh path, and an empty body is a request the server refuses.
    const body = {};
    if (trimmedName !== (chat.name ?? '')) body.name = trimmedName;
    if (trimmedBio !== (chat.description ?? '')) body.description = trimmedBio;
    if (removeAvatar) {
      body.avatar = null;
    } else {
      const picked = uploadPath(avatar);
      if (picked?.startsWith('/uploads/') && picked !== uploadPath(chat.avatar)) body.avatar = picked;
    }
    if (!Object.keys(body).length) {
      setError('تغییری برای ذخیره نکردی');
      return;
    }

    setError('');
    setSaving(true);
    try {
      const wire = await updateGroup(chat.id, body);
      onUpdated?.(wire);
      setRemoveAvatar(false);
      setEditing(false);
    } catch (err) {
      setError(err.message || 'ذخیره تغییرات ناموفق بود');
    } finally {
      setSaving(false);
    }
  }

  const displayName = removeAvatar ? null : avatar;

  return (
    <aside className="chat-profile" aria-label={isGroup ? 'اطلاعات گروه' : 'اطلاعات مخاطب'}>
      <header className="panel-head">
        <button
          type="button"
          className="icon-btn"
          ref={closeRef}
          onClick={onClose}
          aria-label="بستن اطلاعات"
        >
          <i className="fas fa-xmark" aria-hidden="true" />
        </button>
        <h2 className="panel-head-title">{editing ? 'ویرایش اطلاعات' : (isGroup ? 'اطلاعات گروه' : 'اطلاعات مخاطب')}</h2>
        {!editing && canEdit && (
          <button type="button" className="icon-btn" onClick={startEditing} aria-label="ویرایش اطلاعات گروه" title="ویرایش">
            <i className="fas fa-pen" aria-hidden="true" />
          </button>
        )}
      </header>

      <div className="panel-scroll">
        <div className="panel-avatar-wrap">
          <Avatar
            src={displayName}
            name={chat.name}
            size={96}
            group={isGroup}
            status={isGroup ? undefined : chat.status}
          />
          {editing && (
            <>
              <button
                type="button"
                className="panel-avatar-edit"
                onClick={() => fileInputRef.current?.click()}
                disabled={uploading}
                aria-label="تغییر تصویر گروه"
              >
                <i className={uploading ? 'fas fa-spinner fa-spin' : 'fas fa-camera'} aria-hidden="true" />
              </button>
              <input ref={fileInputRef} type="file" accept="image/*" hidden onChange={handleAvatarPick} />
            </>
          )}
        </div>

        {editing ? (
          <form className="panel-form" onSubmit={handleSave}>
            <div className="field">
              <label className="field-label" htmlFor="panel-group-name">نام گروه</label>
              <input
                id="panel-group-name"
                ref={nameRef}
                className="field-input"
                value={name}
                maxLength={NAME_MAX}
                onChange={e => setName(e.target.value)}
              />
              <span className="field-hint">
                بین {NAME_MIN.toLocaleString('fa-IR')} تا {NAME_MAX.toLocaleString('fa-IR')} حرف.
              </span>
            </div>

            <div className="field">
              <label className="field-label" htmlFor="panel-group-bio">
                درباره گروه
                <span className="field-optional">اختیاری</span>
              </label>
              <textarea
                id="panel-group-bio"
                className="field-input panel-textarea"
                value={description}
                maxLength={DESCRIPTION_MAX}
                placeholder="مخاطبانت می‌بینند این گروه درباره چیست…"
                onChange={e => setDescription(e.target.value)}
              />
              <span className="field-hint panel-bio-count">
                {description.length.toLocaleString('fa-IR')} از {DESCRIPTION_MAX.toLocaleString('fa-IR')} حرف
              </span>
            </div>

            {chat.avatar && !removeAvatar && (
              <button
                type="button"
                className="btn btn-ghost panel-remove-photo"
                onClick={() => { setRemoveAvatar(true); setAvatar(null); }}
              >
                <i className="fas fa-trash-can" aria-hidden="true" />
                حذف تصویر گروه
              </button>
            )}
            {removeAvatar && (
              <button
                type="button"
                className="btn btn-ghost panel-remove-photo"
                onClick={() => { setRemoveAvatar(false); setAvatar(chat.avatar ?? null); }}
              >
                <i className="fas fa-rotate-left" aria-hidden="true" />
                برگرداندن تصویر فعلی
              </button>
            )}

            {error && (
              <div className="field-error" role="alert">
                <i className="fas fa-triangle-exclamation" aria-hidden="true" />
                {error}
              </div>
            )}

            <div className="panel-actions">
              <button type="button" className="btn btn-secondary" onClick={() => setEditing(false)} disabled={saving}>
                انصراف
              </button>
              <button type="submit" className="btn btn-primary" disabled={saving || uploading}>
                {saving
                  ? <><i className="fas fa-spinner fa-spin" aria-hidden="true" /> ذخیره…</>
                  : 'ذخیره تغییرات'}
              </button>
            </div>
          </form>
        ) : (
          <>
            <div className="panel-name">{chat.name}</div>
            {!isGroup && chat.username && (
              <div className="panel-username" dir="ltr">@{chat.username}</div>
            )}
            {!isGroup && (
              <div className={`panel-status status-${chat.status ?? 'offline'}`}>
                <span className="panel-status-dot" aria-hidden="true" />
                {STATUS_TEXT[chat.status] ?? 'آفلاین'}
              </div>
            )}

            {isGroup && (
              <div className="panel-meta">
                <i className="fas fa-users" aria-hidden="true" />
                {chat.memberCount?.toLocaleString('fa-IR') ?? '۰'} عضو
              </div>
            )}

            {isGroup && chat.description && <p className="panel-bio">{chat.description}</p>}
            {!isGroup && chat.bio && <p className="panel-bio">{chat.bio}</p>}

            {!isGroup && chat.createdAt && (
              <div className="panel-joined">
                <i className="fas fa-calendar-day" aria-hidden="true" />
                عضو از {joinedAt(chat.createdAt)}
              </div>
            )}

            <div className={`panel-encryption ${encrypted ? 'is-on' : 'is-off'}`} title={encrypted
              ? (isGroup
                ? 'متن، تصویر و فایل این گروه فقط روی دستگاه اعضای آن رمزگشایی می‌شود؛ سرور هیچ‌وقت آن‌ها را نمی‌بیند'
                : 'متن، تصویر و فایل این گفتگو فقط روی دستگاه شما و دستگاه طرف مقابل رمزگشایی می‌شود؛ سرور هیچ‌وقت آن‌ها را نمی‌بیند')
              : (encryptionNote ?? 'پیام‌های این گفتگو روی سرور قابل خواندن ذخیره می‌شوند')}>
              <i className={encrypted ? 'fas fa-lock' : 'fas fa-lock-open'} aria-hidden="true" />
              <span>{encrypted ? 'رمزنگاری سرتاسری' : 'بدون رمزنگاری'}</span>
            </div>

            {error && (
              <div className="field-error" role="alert">
                <i className="fas fa-triangle-exclamation" aria-hidden="true" />
                {error}
              </div>
            )}
          </>
        )}

        {isGroup && (
          <section className="panel-members">
            <h3 className="panel-section-title">
              <i className="fas fa-user-group" aria-hidden="true" />
              {`اعضای گروه (${chat.memberCount?.toLocaleString('fa-IR') ?? '۰'})`}
            </h3>
            <ul className="panel-member-list">
              {(chat.participants ?? []).map((p) => (
                <li key={p.id} className="panel-member">
                  <Avatar src={p.avatar} name={p.name} size={36} />
                  <span className="panel-member-name" title={p.name}>
                    {p.name}
                    {p.id === currentUser?.id && <span className="panel-member-you">شما</span>}
                  </span>
                  {ROLE_TEXT[p.role] && (
                    <span className={`panel-member-role role-${p.role.toLowerCase()}`}>{ROLE_TEXT[p.role]}</span>
                  )}
                </li>
              ))}
            </ul>
          </section>
        )}
      </div>
    </aside>
  );
}
