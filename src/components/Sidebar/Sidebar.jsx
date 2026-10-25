import { useEffect, useMemo, useRef, useState } from 'react';
import Avatar from '../ui/Avatar.jsx';
import Modal from '../ui/Modal.jsx';
import ThemeToggle from '../ui/ThemeToggle.jsx';
import SettingsPanel from '../Settings/SettingsPanel.jsx';
import { formatConversationTime } from '../../utils/time.js';
import './Sidebar.css';

const STATUS_TEXT = { online: 'آنلاین', idle: 'غیرفعال', dnd: 'مشغول', offline: 'آفلاین' };
const LONG_PRESS_MS = 480;
const MENU_WIDTH = 200;
const MENU_HEIGHT = 64;

function previewText(preview) {
  switch (preview.type) {
    case 'image': return 'عکس';
    case 'video': return 'ویدیو';
    case 'audio':
    case 'voice': return 'پیام صوتی';
    case 'file':  return preview.fileName || 'فایل';
    default:      return preview.text || 'پیام';
  }
}

export default function Sidebar({
  users,
  activeUserId,
  onSelectUser,
  currentUser,
  onLogout,
  onOpenProfile,
  onOpenChatProfile,
  onNewChat,
  loading = false,
  error = false,
  onRetry,
  onDeleteConversation,
}) {
  const [query, setQuery] = useState('');
  const [confirmLogout, setConfirmLogout] = useState(false);
  const [settingsOpen, setSettingsOpen] = useState(false);
  // The row menu is opened by right-click on desktop and by holding the row on
  // a touch screen; it holds the row it belongs to plus the point it opened at.
  const [menuTarget, setMenuTarget] = useState(null); // { id, name, x, y }
  const [confirmDelete, setConfirmDelete] = useState(null); // { id, name }
  const holdTimer = useRef(null);
  const heldAt = useRef(0);

  const filtered = useMemo(() => {
    const q = query.trim().toLowerCase();
    if (!q) return users;
    return users.filter(user => {
      const name = user.name?.toLowerCase() ?? '';
      const username = user.username?.toLowerCase() ?? '';
      return name.includes(q) || username.includes(q);
    });
  }, [users, query]);

  // A menu opened by a touch has no mouse to click away from, so any press,
  // key, scroll or resize closes it. `pointerdown` rather than `mousedown`:
  // the press that opened the menu already happened, and a lifted finger also
  // emits a compatibility mousedown that would close it at once.
  useEffect(() => {
    if (!menuTarget) return undefined;
    const close = () => setMenuTarget(null);
    const onKey = event => { if (event.key === 'Escape') close(); };
    window.addEventListener('pointerdown', close);
    window.addEventListener('keydown', onKey);
    window.addEventListener('scroll', close, true);
    window.addEventListener('resize', close);
    return () => {
      window.removeEventListener('pointerdown', close);
      window.removeEventListener('keydown', onKey);
      window.removeEventListener('scroll', close, true);
      window.removeEventListener('resize', close);
    };
  }, [menuTarget]);

  useEffect(() => () => clearTimeout(holdTimer.current), []);

  function handleSelect(user) {
    if (window.innerWidth <= 768) setQuery('');
    onSelectUser?.(user);
  }

  function menuAt(user, x, y) {
    if (user.kind === 'group' || !onDeleteConversation) return;
    setMenuTarget({
      id:   user.id,
      name: user.name,
      x:    Math.max(8, Math.min(x, window.innerWidth - MENU_WIDTH - 8)),
      y:    Math.max(8, Math.min(y, window.innerHeight - MENU_HEIGHT - 8)),
    });
  }

  function openMenu(event, user) {
    if (user.kind === 'group' || !onDeleteConversation) return;
    event.preventDefault();
    menuAt(user, event.clientX, event.clientY);
  }

  function startHold(event, user) {
    if (event.pointerType === 'mouse' || user.kind === 'group') return;
    const { clientX, clientY } = event;
    clearTimeout(holdTimer.current);
    holdTimer.current = setTimeout(() => {
      holdTimer.current = null;
      heldAt.current = Date.now();
      menuAt(user, clientX, clientY);
    }, LONG_PRESS_MS);
  }

  function cancelHold() {
    clearTimeout(holdTimer.current);
    holdTimer.current = null;
  }

  // The finger that opened the menu also ends its press on the row, and that
  // release would otherwise count as a tap and open the chat behind the menu.
  function swallowRelease(event) {
    if (Date.now() - heldAt.current < 800) {
      event.preventDefault();
      event.stopPropagation();
    }
  }

  function askDelete() {
    if (!menuTarget) return;
    setConfirmDelete({ id: menuTarget.id, name: menuTarget.name });
    setMenuTarget(null);
  }

  function confirmDeleteNow() {
    const target = confirmDelete;
    setConfirmDelete(null);
    if (target) onDeleteConversation?.(target);
  }

  return (
    <aside className="sidebar">
      {menuTarget && (
        <div
          className="row-context-menu"
          style={{ left: menuTarget.x, top: menuTarget.y }}
          role="menu"
          aria-label={`گزینه‌های گفتگو با ${menuTarget.name}`}
          onPointerDown={event => event.stopPropagation()}
        >
          <button
            type="button"
            className="row-menu-btn danger"
            onClick={askDelete}
            role="menuitem"
          >
            <i className="fas fa-trash" aria-hidden="true" /> حذف گفتگو
          </button>
        </div>
      )}
      <header className="sidebar-header">
        <div className="sidebar-brand">
          <img src="/logo.svg" alt="" className="sidebar-logo" width="34" height="34" />
          <span className="sidebar-brand-name">OpenBridge</span>
        </div>

        <button
          type="button"
          className="icon-btn sidebar-new"
          title="گفتگو یا گروه جدید"
          aria-label="گفتگو یا گروه جدید"
          onClick={onNewChat}
        >
          <i className="fas fa-pen-to-square" aria-hidden="true" />
        </button>
      </header>

      <div className="sidebar-search">
        <i className="fas fa-magnifying-glass" aria-hidden="true" />
        <input
          type="search"
          value={query}
          onChange={e => setQuery(e.target.value)}
          placeholder="جستجوی گفتگو…"
          aria-label="جستجوی گفتگو"
          autoComplete="off"
        />
        {query && (
          <button
            type="button"
            className="sidebar-search-clear"
            onClick={() => setQuery('')}
            aria-label="پاک‌کردن جستجو"
          >
            <i className="fas fa-xmark" aria-hidden="true" />
          </button>
        )}
      </div>

      <div className="sidebar-section">
        <span>گفتگوها</span>
      </div>

      {error && (
        <div className="sidebar-note" role="alert">
          <i className="fas fa-triangle-exclamation" aria-hidden="true" />
          <span>به‌روزرسانی فهرست ناموفق بود</span>
          <button type="button" className="sidebar-note-retry" onClick={onRetry}>
            تلاش دوباره
          </button>
        </div>
      )}

      <div className="users-list" role="list">
        {loading && users.length === 0 && (
          <div className="sidebar-skeleton" aria-hidden="true">
            {[0, 1, 2, 3].map(i => (
              <div key={i} className="skeleton-item">
                <span className="skeleton-avatar" />
                <span className="skeleton-lines">
                  <span className="skeleton-line" style={{ width: `${58 - i * 6}%` }} />
                  <span className="skeleton-line short" style={{ width: `${34 + i * 4}%` }} />
                </span>
              </div>
            ))}
          </div>
        )}

        {filtered.map(user => {
          const isGroup = user.kind === 'group';
          const active = activeUserId === user.id;
          const preview = user.preview ? previewText(user.preview) : '';
          const meta = preview
            ? (isGroup && user.preview.senderName ? `${user.preview.senderName}: ${preview}` : preview)
            : user.encrypted
              ? 'رمزنگاری‌شده'
              : (isGroup ? 'هنوز پیامی نیست' : (STATUS_TEXT[user.status] ?? ''));

          return (
            <div
              key={user.id}
              role="listitem"
              className={`user-item ${active ? 'active' : ''}`}
              aria-current={active ? 'true' : undefined}
              onContextMenu={event => openMenu(event, user)}
              onClickCapture={swallowRelease}
              onPointerDown={event => startHold(event, user)}
              onPointerUp={cancelHold}
              onPointerLeave={cancelHold}
              onPointerCancel={cancelHold}
              onPointerMove={cancelHold}
            >
              <button
                type="button"
                className="user-item-avatar"
                onClick={() => onOpenChatProfile?.(user)}
                title={`بازکردن پروفایل ${user.name}`}
                aria-label={`بازکردن پروفایل ${user.name}`}
              >
                <Avatar
                  src={user.avatar}
                  name={user.name}
                  size={42}
                  group={isGroup}
                  status={isGroup ? undefined : user.status}
                />
              </button>

              <button
                type="button"
                className="user-item-open"
                onClick={() => handleSelect(user)}
              >
                <span className="user-item-body">
                  <span className="user-item-top">
                    <span className="user-name" title={user.name}>{user.name}</span>
                    {user.updatedAt && (
                      <span className="user-time">{formatConversationTime(user.updatedAt)}</span>
                    )}
                  </span>
                  <span className="user-item-bottom">
                    <span className="user-meta" title={meta}>{meta}</span>
                    {user.unread > 0 && (
                      <span className="badge" aria-label={`${user.unread} پیام خوانده‌نشده`}>
                        {user.unread > 99 ? '۹۹+' : user.unread}
                      </span>
                    )}
                  </span>
                </span>
              </button>
            </div>
          );
        })}

        {!loading && !error && users.length === 0 && (
          <div className="sidebar-empty">
            <i className="far fa-comments" aria-hidden="true" />
            <p>هنوز گفتگویی نداری. یک نفر را جستجو کن یا گروه بساز.</p>
            <button type="button" className="btn btn-secondary sidebar-empty-btn" onClick={onNewChat}>
              <i className="fas fa-user-plus" aria-hidden="true" />
              شروع گفتگوی جدید
            </button>
          </div>
        )}

        {users.length > 0 && filtered.length === 0 && (
          <div className="sidebar-empty sidebar-empty-search">
            <i className="fas fa-magnifying-glass" aria-hidden="true" />
            <p>گفتگویی با «{query.trim()}» پیدا نشد</p>
            <button type="button" className="btn btn-ghost sidebar-empty-btn" onClick={() => setQuery('')}>
              پاک‌کردن جستجو
            </button>
          </div>
        )}
      </div>

      <footer className="sidebar-footer">
        <button
          type="button"
          className="my-info"
          onClick={onOpenProfile}
          title="پروفایل من"
          aria-label="بازکردن پروفایل من"
        >
          <Avatar src={currentUser.avatar} name={currentUser.name} size={34} status={currentUser.status} />
          <span className="my-info-text">
            <span className="my-name">{currentUser.name}</span>
            {currentUser.username && <span className="my-username" dir="ltr">@{currentUser.username}</span>}
          </span>
        </button>

        <div className="footer-actions">
          <button
            type="button"
            className="icon-btn"
            title="تنظیمات"
            aria-label="تنظیمات"
            onClick={() => setSettingsOpen(true)}
          >
            <i className="fas fa-gear" aria-hidden="true" />
          </button>
          <ThemeToggle />
          <button
            type="button"
            className="icon-btn danger"
            title="خروج"
            aria-label="خروج از حساب"
            onClick={() => setConfirmLogout(true)}
          >
            <i className="fas fa-arrow-right-from-bracket" aria-hidden="true" />
          </button>
        </div>
      </footer>

      {settingsOpen && (
        <SettingsPanel
          currentUser={currentUser}
          onClose={() => setSettingsOpen(false)}
          onEditProfile={() => { setSettingsOpen(false); onOpenProfile?.(); }}
          onLogoutRequest={() => { setSettingsOpen(false); setConfirmLogout(true); }}
        />
      )}

      {confirmLogout && (
        <Modal onClose={() => setConfirmLogout(false)} labelledBy="logout-title" className="confirm-modal">
          <div className="confirm-body">
            <div className="confirm-icon" aria-hidden="true">
              <i className="fas fa-arrow-right-from-bracket" />
            </div>
            <h2 id="logout-title">خروج از حساب</h2>
            <p>از حساب OpenBridge خارج می‌شوی؟ برای ادامه باید دوباره وارد شوی.</p>
          </div>
          <div className="confirm-actions">
            <button type="button" className="btn btn-secondary" onClick={() => setConfirmLogout(false)}>
              انصراف
            </button>
            <button type="button" className="btn btn-danger" onClick={onLogout}>
              خروج
            </button>
          </div>
        </Modal>
      )}

      {confirmDelete && (
        <Modal
          onClose={() => setConfirmDelete(null)}
          labelledBy="delete-chat-title"
          className="confirm-modal"
        >
          <div className="confirm-body">
            <div className="confirm-icon" aria-hidden="true">
              <i className="fas fa-trash" />
            </div>
            <h2 id="delete-chat-title">حذف گفتگو</h2>
            <p>
              گفتگو با «{confirmDelete.name}» و همهٔ پیام‌هایش برای هر دو طرف پاک می‌شود.
              این کار برگشت‌پذیر نیست.
            </p>
          </div>
          <div className="confirm-actions">
            <button type="button" className="btn btn-secondary" onClick={() => setConfirmDelete(null)}>
              انصراف
            </button>
            <button type="button" className="btn btn-danger" onClick={confirmDeleteNow}>
              حذف گفتگو
            </button>
          </div>
        </Modal>
      )}
    </aside>
  );
}
