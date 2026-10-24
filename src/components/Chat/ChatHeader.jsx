import { useRef, useEffect } from 'react';
import Avatar from '../ui/Avatar.jsx';

const STATUS_TEXT = { online: 'آنلاین', idle: 'غیرفعال', dnd: 'مشغول', offline: 'آفلاین' };

export default function ChatHeader({
  user, encrypted = false, searchQuery, onSearchChange, searchOpen, onSearchOpenChange,
  onOpenProfile, onBack, onStartCall, callsEnabled = true, callBusy = false,
}) {
  const inputRef = useRef(null);
  const isGroup = user.kind === 'group';

  // Search is open or closed wherever the chat is read from, because the profile
  // panel offers it as an action too — so the flag is held above both.
  useEffect(() => {
    if (searchOpen) {
      inputRef.current?.focus();
    } else {
      onSearchChange('');
    }
  }, [searchOpen, onSearchChange]);

  function closeSearch() {
    onSearchOpenChange(false);
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
              <button
                type="button"
                className="chat-peer as-button"
                onClick={() => onOpenProfile?.(user)}
                title="مشاهده اطلاعات گروه"
              >
                <Avatar src={user.avatar} name={user.name} size={40} group />
                <div className="chat-peer-text">
                  <span className="chat-peer-name" title={user.name}>{user.name}</span>
                  <span className="chat-peer-status group-status">
                    <i className="fas fa-users" aria-hidden="true" />
                    {(user.memberCount ?? 0).toLocaleString('fa-IR')} عضو
                  </span>
                </div>
              </button>
            ) : (
              <button
                type="button"
                className="chat-peer as-button"
                onClick={() => onOpenProfile?.(user)}
                title="مشاهده پروفایل"
              >
                <Avatar src={user.avatar} name={user.name} size={40} />
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
            {onStartCall && (
              <>
                <button
                  type="button"
                  className="icon-btn"
                  onClick={() => onStartCall('audio')}
                  disabled={!callsEnabled || callBusy}
                  title={!callsEnabled
                    ? 'تماس روی این سرور فعال نیست'
                    : callBusy ? 'در تماس دیگری هستید' : 'تماس صوتی'}
                  aria-label="تماس صوتی"
                >
                  <i className="fas fa-phone" aria-hidden="true" />
                </button>
                <button
                  type="button"
                  className="icon-btn"
                  onClick={() => onStartCall('video')}
                  disabled={!callsEnabled || callBusy}
                  title={!callsEnabled
                    ? 'تماس روی این سرور فعال نیست'
                    : callBusy ? 'در تماس دیگری هستید' : 'تماس ویدیویی'}
                  aria-label="تماس ویدیویی"
                >
                  <i className="fas fa-video" aria-hidden="true" />
                </button>
              </>
            )}
            <button
              type="button"
              className="icon-btn"
              title="جستجو در پیام‌ها"
              aria-label="جستجو در پیام‌های این گفتگو"
              onClick={() => onSearchOpenChange(true)}
            >
              <i className="fas fa-magnifying-glass" aria-hidden="true" />
            </button>
          </div>
        </>
      )}
    </header>
  );
}
