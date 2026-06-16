import { Link } from 'react-router-dom';
import './Sidebar.css';

export default function Sidebar({ users, activeUserId, onSelectUser, currentUser, onLogout, onOpenProfile, onNewChat, page = 'chat' }) {
  function handleLogout() {
    if (window.confirm('از چت خارج می‌شوید؟')) onLogout();
  }

  return (
    <div className="sidebar">
      <div className="sidebar-header">
        <img src="/images/logo.png" alt="Logo" className="sidebar-logo" />
        <span>ChatRoom</span>

        {page === 'chat' && (
          <button className="icon-btn new-chat-btn" title="گفتگوی جدید" onClick={onNewChat}>
            <i className="fas fa-pen-to-square" />
          </button>
        )}
      </div>

      <div className="users-list">
        <div className="section-label">
          {page === 'video' ? 'در تماس' : 'گفتگوها'} — {users.length}
        </div>

        {users.map(user => (
          <button
            key={user.id}
            className={`user-item ${activeUserId === user.id ? 'active' : ''}`}
            onClick={() => onSelectUser?.(user)}
          >
            <div className="user-avatar">
              <img src={user.avatar} alt={user.name} />
              <span className={`status ${user.status}`} />
            </div>
            <span className="user-name">{user.name}</span>

            {page === 'video' && (
              <i className="fas fa-microphone user-mic" />
            )}
            {page === 'chat' && user.unread > 0 && (
              <span className="badge">{user.unread}</span>
            )}
          </button>
        ))}

        {page === 'chat' && users.length === 0 && (
          <div className="empty-conversations">
            <i className="fas fa-comment-dots" />
            <p>هنوز گفتگویی نداری</p>
            <button className="empty-conversations-btn" onClick={onNewChat}>
              <i className="fas fa-magnifying-glass" /> جستجوی یوزرنیم برای شروع چت
            </button>
          </div>
        )}
      </div>

      <div className="sidebar-footer">
        <button className="my-info as-button" onClick={onOpenProfile} title="پروفایل من">
          <div className="user-avatar sm">
            <img src={currentUser.avatar} alt={currentUser.name} />
            <span className={`status ${currentUser.status}`} />
          </div>
          <span className="my-name">{currentUser.name}</span>
        </button>

        <div className="footer-btns">
          {page === 'chat' ? (
            <Link to="/video" className="icon-btn" title="تماس ویدیویی">
              <i className="fas fa-video" />
            </Link>
          ) : (
            <Link to="/" className="icon-btn" title="بازگشت به چت">
              <i className="fas fa-message" />
            </Link>
          )}
          <button className="icon-btn danger" title="خروج" onClick={handleLogout}>
            <i className="fas fa-right-from-bracket" />
          </button>
        </div>
      </div>
    </div>
  );
}
