import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { updateGroup, uploadFile, resolveUrl, uploadPath, getSharedItems } from '../../services/api.js';
import Avatar from '../ui/Avatar.jsx';
import EncryptedMedia from '../Chat/EncryptedMedia.jsx';
import { formatSize } from '../../utils/format.js';
import './ChatProfilePanel.css';

const STATUS_TEXT = { online: 'آنلاین', idle: 'غیرفعال', dnd: 'مشغول', offline: 'آفلاین' };
const ROLE_TEXT = { OWNER: 'مالک', ADMIN: 'مدیر' };
// The same bounds the server enforces on PATCH /messages/groups/:id, so a draft
// that cannot be saved is caught before the round trip.
const NAME_MIN = 2;
const NAME_MAX = 60;
const DESCRIPTION_MAX = 205;

const SHARED_PAGE = 24;
const SHARED_TABS = [
  { kind: 'media', label: 'رسانه',    icon: 'fa-photo-film',  empty: 'تصویری در این گفتگو نیست' },
  { kind: 'files', label: 'فایل‌ها',  icon: 'fa-file-lines',  empty: 'فایلی در این گفتگو نیست' },
  { kind: 'links', label: 'لینک‌ها',  icon: 'fa-link',        empty: 'لینکی در این گفتگو نیست' },
];
// Members are chat metadata the client already holds, so this tab never fetches
// and a direct chat, which has no list, does not show it at all.
const MEMBERS_TAB = { kind: 'members', label: 'اعضا', icon: 'fa-user-group' };

// The same rule the server applies to a plaintext transcript: a link runs to the
// first space or quote, and the punctuation a sentence puts after it is dropped.
const URL_IN_TEXT = /https?:\/\/[^\s<>"'`]+/gi;
const TRAILING_PUNCTUATION = /[.,;:!?)\]}«»"'`]+$/;

function extractLinks(text) {
  return (text?.match(URL_IN_TEXT) ?? []).map(raw => raw.replace(TRAILING_PUNCTUATION, '')).filter(Boolean);
}

function linkHost(url) {
  return url.replace(/^https?:\/\//, '').split('/')[0];
}

function sharedDate(value) {
  if (!value) return '';
  return new Date(value).toLocaleDateString('fa-IR', { day: 'numeric', month: 'long', year: 'numeric' });
}

// An encrypted chat has nothing on the server to ask, so its lists are built
// from what this device has already decrypted. Newest first, like the server's
// own pages, and a photo is carried as the descriptor its bubble opens.
function localLists(messages) {
  const media = [];
  const files = [];
  const links = [];

  for (const m of messages) {
    const meta = { createdAt: m.createdAt, sender: m.side === 'mine' ? 'شما' : m.sender };
    // A voice message is a message you listen to, not a document you keep, so
    // it lives in the transcript and in none of this panel's lists.
    if (m.attachment && m.type !== 'audio') {
      const item = { ...meta, key: m.id, name: m.name, size: m.size, attachment: m.attachment };
      (m.type === 'image' ? media : files).push(item);
    } else if (m.type === 'image') {
      media.push({ ...meta, key: m.id, src: m.src, name: m.name, size: m.size });
    } else if (m.type === 'file') {
      files.push({ ...meta, key: m.id, src: m.src, name: m.name, size: m.size });
    }
    for (const url of extractLinks(m.text)) links.push({ ...meta, key: `${m.id}-${url}`, url, text: m.text });
  }

  return {
    media: media.reverse(),
    files: files.reverse(),
    links: links.reverse(),
  };
}

function pageState() {
  return { status: 'loading', items: [], cursor: null, error: '' };
}

function joinedAt(dateStr) {
  if (!dateStr) return null;
  return new Date(dateStr).toLocaleDateString('fa-IR', { year: 'numeric', month: 'long', day: 'numeric' });
}

export default function ChatProfilePanel({
  chat, currentUser, encrypted, encryptionNote, messages = [], onClose, onUpdated, onOpenUser,
}) {
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
  const [tab,          setTab]          = useState('media');
  const [pages,        setPages]        = useState({});
  const [viewer,       setViewer]       = useState(null);

  const closeRef = useRef(null);
  const nameRef = useRef(null);
  const fileInputRef = useRef(null);
  const viewerRef = useRef(null);

  const local = useMemo(() => (encrypted ? localLists(messages) : null), [encrypted, messages]);

  // The panel is remounted per chat, so nothing from the previous one survives.
  useEffect(() => { closeRef.current?.focus(); }, []);

  useEffect(() => {
    function onKey(e) {
      if (e.key !== 'Escape') return;
      // A picture being viewed swallows the key first: closing it should not
      // close the panel behind it.
      if (viewer) setViewer(null); else onClose();
    }
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [onClose, viewer]);

  useEffect(() => {
    if (editing) nameRef.current?.focus();
  }, [editing]);

  const loadPage = useCallback(async (kind, before) => {
    setPages(prev => ({ ...prev, [kind]: { ...(prev[kind] ?? pageState()), status: before ? 'more' : 'loading' } }));
    try {
      const data = await getSharedItems(chat.id, kind, before, SHARED_PAGE);
      // Shaped like the lists this device builds for an encrypted chat, so the
      // panel renders one kind of row no matter which produced it.
      const items = data.items.map(item => ({
        ...item,
        key:    item.id,
        // A signed upload path is relative to the API, not to this page.
        src:    item.kind === 'link' ? undefined : resolveUrl(item.url),
        sender: item.sender?.name ?? null,
      }));
      setPages(prev => {
        const was = prev[kind] ?? pageState();
        return {
          ...prev,
          [kind]: {
            status: 'ready',
            items:    before ? [...was.items, ...items] : items,
            cursor:   data.nextCursor ?? null,
            encrypted: data.encrypted,
          },
        };
      });
    } catch (err) {
      setPages(prev => ({
        ...prev,
        [kind]: { ...(prev[kind] ?? pageState()), status: 'error', error: err.message || 'دریافت فهرست ناموفق بود' },
      }));
    }
  }, [chat.id]);

  // A tab is fetched the first time it is opened, never all three at once.
  useEffect(() => {
    if (encrypted || pages[tab] || tab === MEMBERS_TAB.kind) return;
    loadPage(tab);
  }, [tab, encrypted, pages, loadPage]);

  // The dialog is only reachable by keyboard once it holds focus.
  useEffect(() => {
    if (viewer) viewerRef.current?.focus();
  }, [viewer]);

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
  const tabs = isGroup ? [MEMBERS_TAB, ...SHARED_TABS] : SHARED_TABS;
  const onMembers = tab === MEMBERS_TAB.kind;
  const members = chat.participants ?? [];
  const shared = SHARED_TABS.find(entry => entry.kind === tab);
  const page = pages[tab] ?? pageState();
  const sharedItems = encrypted ? (local?.[tab] ?? []) : page.items;
  // A local list is never in flight: it is whatever this device already holds.
  const sharedStatus = encrypted ? 'ready' : page.status;

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

            <section className="panel-shared" aria-label="محتوای گفتگو">
              <div className="panel-tabs" role="tablist" aria-label="دسته‌بندی محتوای گفتگو">
                {tabs.map((entry) => (
                  <button
                    key={entry.kind}
                    type="button"
                    role="tab"
                    id={`panel-tab-${entry.kind}`}
                    aria-selected={tab === entry.kind}
                    className={`panel-tab ${tab === entry.kind ? 'is-active' : ''}`}
                    onClick={() => setTab(entry.kind)}
                  >
                    <i className={`fas ${entry.icon}`} aria-hidden="true" />
                    {entry.label}
                    {entry.kind === MEMBERS_TAB.kind && (
                      <span className="panel-tab-count">{chat.memberCount?.toLocaleString('fa-IR') ?? '۰'}</span>
                    )}
                  </button>
                ))}
              </div>

              <div className="panel-tabpanel" role="tabpanel" aria-labelledby={`panel-tab-${tab}`}>
                {onMembers ? (
                  <ul className="panel-member-list">
                    {members.map((p) => (
                      <li key={p.id} className="panel-member">
                        {/* A member is a person, so the row is a door to them —
                            the same sheet a tap on their avatar in the chat opens. */}
                        <button
                          type="button"
                          className="panel-member-btn"
                          onClick={() => onOpenUser?.({ id: p.id, name: p.name, avatar: p.avatar })}
                        >
                          <Avatar src={p.avatar} name={p.name} size={36} />
                          <span className="panel-member-name" title={p.name}>
                            {p.name}
                            {p.id === currentUser?.id && <span className="panel-member-you">شما</span>}
                          </span>
                        </button>
                        {ROLE_TEXT[p.role] && (
                          <span className={`panel-member-role role-${p.role.toLowerCase()}`}>{ROLE_TEXT[p.role]}</span>
                        )}
                      </li>
                    ))}
                  </ul>
                ) : (
                  <>
                    {encrypted && (
                      <p className="panel-shared-note" role="note">
                        <i className="fas fa-lock" aria-hidden="true" />
                        <span>{isGroup
                          ? 'این فهرست پیام‌هایی است که روی همین دستگاه رمزگشایی شده؛ سرور هیچ‌کدام را نمی‌بیند.'
                          : 'این فهرست فقط پیام‌هایی را نشان می‌دهد که روی همین دستگاه رمزگشایی شده.'}</span>
                      </p>
                    )}

                    {sharedStatus === 'loading' && (
                      <p className="panel-shared-busy" role="status">
                        <i className="fas fa-spinner fa-spin" aria-hidden="true" />
                        در حال بارگذاری…
                      </p>
                    )}

                    {sharedStatus === 'error' && (
                      <div className="panel-shared-error">
                        <span>{page.error}</span>
                        <button type="button" className="btn btn-secondary" onClick={() => loadPage(tab)}>
                          تلاش دوباره
                        </button>
                      </div>
                    )}

                    {sharedStatus === 'ready' && sharedItems.length === 0 && (
                      <p className="panel-shared-empty">{shared.empty}</p>
                    )}

                    {sharedItems.length > 0 && tab === 'media' && (
                      <div className="panel-grid">
                        {sharedItems.map(item => (
                          <MediaCell key={item.key ?? item.id} item={item} onOpen={setViewer} />
                        ))}
                      </div>
                    )}

                    {sharedItems.length > 0 && tab === 'files' && (
                      <ul className="panel-list">
                        {sharedItems.map(item => (
                          <li key={item.key ?? item.id} className="panel-row">
                            <FileRow item={item} />
                          </li>
                        ))}
                      </ul>
                    )}

                    {sharedItems.length > 0 && tab === 'links' && (
                      <ul className="panel-list">
                        {sharedItems.map(item => (
                          <li key={item.key ?? item.id} className="panel-row">
                            <span className="panel-row-icon" aria-hidden="true">
                              <i className="fas fa-link" />
                            </span>
                            <a
                              className="panel-row-main"
                              href={item.url}
                              target="_blank"
                              rel="noopener noreferrer"
                              title={item.text ?? item.url}
                            >
                              <span className="panel-row-title" dir="ltr">{linkHost(item.url)}</span>
                              {item.text && <span className="panel-row-sub">{item.text}</span>}
                              <span className="panel-row-meta">
                                {item.sender ?? '—'} · {sharedDate(item.createdAt)}
                              </span>
                            </a>
                          </li>
                        ))}
                      </ul>
                    )}

                    {!encrypted && page.cursor && (
                      <button
                        type="button"
                        className="btn btn-ghost panel-shared-more"
                        onClick={() => loadPage(tab, page.cursor)}
                        disabled={sharedStatus === 'more'}
                      >
                        <i className={`fas ${sharedStatus === 'more' ? 'fa-spinner fa-spin' : 'fa-chevron-down'}`} aria-hidden="true" />
                        نمایش بیشتر
                      </button>
                    )}
                  </>
                )}
              </div>
            </section>

            {error && (
              <div className="field-error" role="alert">
                <i className="fas fa-triangle-exclamation" aria-hidden="true" />
                {error}
              </div>
            )}
          </>
        )}
      </div>

      {viewer && (
        <div className="panel-viewer" role="dialog" aria-modal="true" aria-label="تصویر در اندازه کامل">
          <button
            type="button"
            className="icon-btn panel-viewer-close"
            ref={viewerRef}
            onClick={() => setViewer(null)}
            aria-label="بستن تصویر"
          >
            <i className="fas fa-xmark" aria-hidden="true" />
          </button>
          <img src={viewer} alt="تصویر ارسالی" className="panel-viewer-image" />
        </div>
      )}
    </aside>
  );
}

// A thumbnail is either bytes this device can address directly or a descriptor
// it has to open itself, and only the second case owns an object URL — so the
// encrypted cell stays the component that makes and releases it.
function MediaCell({ item, onOpen }) {
  if (item.attachment) {
    return (
      <div className="panel-cell">
        <EncryptedMedia
          attachment={item.attachment}
          kind="image"
          name={item.name}
          size={item.size}
          onOpen={onOpen}
        />
      </div>
    );
  }
  return (
    <button
      type="button"
      className="panel-cell"
      onClick={() => onOpen(item.src)}
      aria-label={`بازکردن ${item.name || 'تصویر'} در اندازه کامل`}
    >
      <img src={item.src} alt={item.name || 'تصویر ارسالی'} loading="lazy" />
    </button>
  );
}

function FileRow({ item }) {
  const meta = `${item.sender ?? '—'} · ${sharedDate(item.createdAt)}`;

  if (item.attachment) {
    return (
      <div className="panel-row-stack">
        <EncryptedMedia attachment={item.attachment} kind="file" name={item.name} size={item.size} />
        <span className="panel-row-meta">{meta}</span>
      </div>
    );
  }

  return (
    <>
      <span className="panel-row-icon" aria-hidden="true">
        <i className="fas fa-file-arrow-down" />
      </span>
      <a
        className="panel-row-main"
        href={item.src}
        download={item.name || undefined}
        target="_blank"
        rel="noopener noreferrer"
      >
        <span className="panel-row-title" title={item.name}>{item.name || 'فایل'}</span>
        <span className="panel-row-meta">{formatSize(item.size)} · {meta}</span>
      </a>
    </>
  );
}
