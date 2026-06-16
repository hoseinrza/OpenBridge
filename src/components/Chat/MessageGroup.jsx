import { useState } from 'react';

const REACTIONS = ['👍', '❤️', '😂', '😮', '😢'];

function formatSize(bytes) {
  if (bytes < 1024)        return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

function Highlight({ text, query }) {
  if (!query || !text) return text;
  const escaped = query.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const parts = text.split(new RegExp(`(${escaped})`, 'gi'));
  return parts.map((part, i) =>
    part.toLowerCase() === query.toLowerCase()
      ? <mark key={i} className="search-highlight">{part}</mark>
      : part
  );
}

function BubbleContent({ message, searchQuery }) {
  if (message.type === 'image') {
    return (
      <div className="bubble bubble-image">
        <img src={message.src} alt="تصویر ارسالی" className="msg-image" />
      </div>
    );
  }
  if (message.type === 'file') {
    return (
      <div className="bubble bubble-file">
        <i className="fas fa-file bubble-file-icon" />
        <div className="bubble-file-info">
          <span className="bubble-file-name">{message.name}</span>
          <span className="bubble-file-size">{formatSize(message.size)}</span>
        </div>
        <i className="fas fa-download bubble-file-dl" />
      </div>
    );
  }
  return (
    <div className="bubble">
      <Highlight text={message.text} query={searchQuery} />
    </div>
  );
}

export default function MessageGroup({ message, onReact, searchQuery }) {
  const [showBar, setShowBar] = useState(false);
  const isMine = message.side === 'mine';

  return (
    <div
      className={`msg-wrapper ${isMine ? 'mine' : 'other'}`}
      onMouseEnter={() => setShowBar(true)}
      onMouseLeave={() => setShowBar(false)}
    >
      {showBar && (
        <div className={`reaction-bar ${isMine ? 'bar-mine' : 'bar-other'}`}>
          {REACTIONS.map(emoji => (
            <button
              key={emoji}
              className="reaction-btn"
              onClick={() => onReact(message.id, emoji)}
            >
              {emoji}
            </button>
          ))}
        </div>
      )}

      <div className="msg-group">
        {!isMine && (
          <img
            src={message.avatar || '/images/user.png'}
            alt={message.sender}
            className="msg-avatar"
          />
        )}

        <div className="msg-bubbles">
          {!isMine && <div className="msg-sender">{message.sender}</div>}

          <BubbleContent message={message} searchQuery={searchQuery} />

          <div className="msg-footer">
            <span className="msg-time">{message.time}</span>
            {isMine && (
              <span className={`msg-receipt ${message.read ? 'read' : ''}`}>
                <i className="fas fa-check-double" />
              </span>
            )}
          </div>

          {message.reactions && Object.keys(message.reactions).length > 0 && (
            <div className="msg-reactions">
              {Object.entries(message.reactions).map(([emoji, count]) => (
                <button
                  key={emoji}
                  className="msg-reaction"
                  onClick={() => onReact(message.id, emoji)}
                >
                  {emoji} <span>{count}</span>
                </button>
              ))}
            </div>
          )}
        </div>
      </div>
    </div>
  );
}
