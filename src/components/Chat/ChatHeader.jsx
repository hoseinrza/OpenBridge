import { useState, useRef, useEffect } from 'react';

export default function ChatHeader({ user, searchQuery, onSearchChange, onOpenProfile, onBack }) {
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

  return (
    <div className="chat-header">
      {searchOpen ? (
        <div className="search-bar">
          <i className="fas fa-magnifying-glass search-bar-icon" />
          <input
            ref={inputRef}
            type="text"
            value={searchQuery}
            onChange={e => onSearchChange(e.target.value)}
            placeholder="جستجو در پیام‌ها..."
          />
          <button className="icon-btn" onClick={() => setSearchOpen(false)}>
            <i className="fas fa-xmark" />
          </button>
        </div>
      ) : (
        <>
          {onBack && (
            <button className="icon-btn chat-back-btn" onClick={onBack} title="بازگشت به فهرست گفتگوها">
              <i className="fas fa-arrow-right" />
            </button>
          )}

          {isGroup ? (
            <div className="chat-header-info">
              <div className="user-avatar sm group-avatar">
                <i className="fas fa-users" />
              </div>
              <div>
                <div className="chat-peer-name">{user.name}</div>
                <div className="chat-peer-status group-status">{user.memberCount} عضو</div>
              </div>
            </div>
          ) : (
            <button className="chat-header-info as-button" onClick={() => onOpenProfile?.(user)} title="مشاهده پروفایل">
              <div className="user-avatar sm">
                <img src={user.avatar} alt={user.name} />
                <span className={`status ${user.status}`} />
              </div>
              <div>
                <div className="chat-peer-name">{user.name}</div>
                <div className="chat-peer-status">
                  {user.status === 'online' ? 'آنلاین' : user.status === 'idle' ? 'غیرفعال' : 'آفلاین'}
                </div>
              </div>
            </button>
          )}

          <div className="chat-header-actions">
            <button className="icon-btn" title="جستجو" onClick={() => setSearchOpen(true)}>
              <i className="fas fa-magnifying-glass" />
            </button>
          </div>
        </>
      )}
    </div>
  );
}
