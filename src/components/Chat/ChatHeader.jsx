import { useState, useRef, useEffect } from 'react';
import Avatar from '../ui/Avatar.jsx';

const STATUS_TEXT = { online: 'آنلاین', idle: 'غیرفعال', dnd: 'مشغول', offline: 'آفلاین' };

export default function ChatHeader({
  user, encrypted = false, encryptionNote = null, searchQuery, onSearchChange, onOpenProfile, onBack,
}) {
  const [searchOpen, setSearchOpen] = useState(false);
  const inputRef = useRef(null);
  const isGroup = user.kind === 'group';

  useEffect(() => {
    if (searchOpen) {
      inputRef.current?.focus();
    } else {
      onSearchChange('');
    }
  }, [searchOpen, onSearchChange]);

  function closeSearch() {
    setSearchOpen(false);
  }

  return (
    <header className="chat-header">
      {searchOpen ? (
        <div className="chat-search" role="search">
          <i className="fas fa-magnifying-glass chat-search-icon" aria-hidden="true" />
          <input
            ref={inputRef}
            type="text"
            value={searchQuery}
            onChange={e => onSearchChange(e.target.value)}
            onKeyDown={e => { if (e.key === 'Escape') closeSearch(); }}
            placeholder={encrypted
              ? 'جستجو در پیام‌های این دستگاه…'
              : 'جستجو در پیام‌های این گفتگو…'}
            aria-label="جستجو در پیام‌های این گفتگو"
          />
          {searchQuery && (
            <button
              type="button"
              className="icon-btn chat-search-clear"
              onClick={() => onSearchChange('')}
              aria-label="پاک‌کردن جستجو"
            >
              <i className="fas fa-xmark" aria-hidden="true" />
            </button>
          )}
          <button
            type="button"
            className="icon-btn chat-search-close"
            onClick={closeSearch}
            aria-label="بستن جستجو"
          >
            <span>بستن</span>
          </button>
        </div>
      ) : (
        <>
          <div className="chat-header-start">
            {onBack && (
              <button
                type="button"
                className="icon-btn chat-back-btn"
                onClick={onBack}
                aria-label="بازگشت به فهرست گفتگوها"
                title="بازگشت به فهرست گفتگوها"
              >
                <i className="fas fa-arrow-right" aria-hidden="true" />
              </button>
            )}

            {isGroup ? (
              <div className="chat-peer">
                <Avatar src={user.avatar} name={user.name} size={40} group />
                <div className="chat-peer-text">
                  <span className="chat-peer-name" title={user.name}>{user.name}</span>
                  <span className="chat-peer-status group-status">
                    <i className="fas fa-users" aria-hidden="true" />
                    {user.memberCount ?? 0} عضو
                  </span>
                </div>
              </div>
            ) : (
              <button
                type="button"
                className="chat-peer as-button"
                onClick={() => onOpenProfile?.(user)}
                title="مشاهده پروفایل"
              >
                <Avatar src={user.avatar} name={user.name} size={40} status={user.status} />
                <div className="chat-peer-text">
                  <span className="chat-peer-name" title={user.name}>{user.name}</span>
                  <span className={`chat-peer-status status-${user.status ?? 'offline'}`}>
                    {STATUS_TEXT[user.status] ?? 'آفلاین'}
                  </span>
                </div>
              </button>
            )}
          </div>

          <div className="chat-header-actions">
            {encrypted && (
              <span
                className="e2ee-chip is-on"
                title="متن، تصویر و فایل این گفتگو فقط روی دستگاه شما و دستگاه طرف مقابل رمزگشایی می‌شود؛ سرور هیچ‌وقت آن‌ها را نمی‌بیند"
              >
                <i className="fas fa-lock" aria-hidden="true" />
                رمزنگاری سرتاسری
              </span>
            )}
            {!encrypted && !isGroup && encryptionNote && (
              <span className="e2ee-chip is-off" title={encryptionNote}>
                <i className="fas fa-lock-open" aria-hidden="true" />
                بدون رمزنگاری
              </span>
            )}
            <button
              type="button"
              className="icon-btn"
              title="جستجو در پیام‌ها"
              aria-label="جستجو در پیام‌های این گفتگو"
              onClick={() => setSearchOpen(true)}
            >
              <i className="fas fa-magnifying-glass" aria-hidden="true" />
            </button>
          </div>
        </>
      )}
    </header>
  );
}
