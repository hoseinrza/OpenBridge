import { useState } from 'react';
import Modal from '../ui/Modal.jsx';
import Avatar from '../ui/Avatar.jsx';

const REACTIONS = ['👍', '❤️', '😂', '😮', '😢'];

function formatSize(bytes) {
  if (!bytes) return '';
  if (bytes < 1024)        return `${bytes} بایت`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} کیلوبایت`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} مگابایت`;
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

function BubbleContent({ message, searchQuery, onOpenImage }) {
  if (message.type === 'image') {
    return (
      <div className="bubble bubble-image">
        <button
          type="button"
          className="msg-image-btn"
          onClick={() => onOpenImage(message)}
          aria-label="بازکردن تصویر در اندازه کامل"
        >
          <img src={message.src} alt={message.text || 'تصویر ارسالی'} className="msg-image" />
        </button>
      </div>
    );
  }

  if (message.type === 'file') {
    return (
      <a
        className="bubble bubble-file"
        href={message.src}
        download={message.name || undefined}
        target="_blank"
        rel="noopener noreferrer"
        aria-label={`دانلود ${message.name || 'فایل'}`}
      >
        <span className="bubble-file-icon" aria-hidden="true">
          <i className="fas fa-file-arrow-down" />
        </span>
        <span className="bubble-file-info">
          <span className="bubble-file-name" title={message.name}>{message.name || 'فایل'}</span>
          <span className="bubble-file-size">{formatSize(message.size)}</span>
        </span>
        <i className="fas fa-download bubble-file-dl" aria-hidden="true" />
      </a>
    );
  }

  return (
    <div className="bubble">
      <Highlight text={message.text} query={searchQuery} />
    </div>
  );
}

export default function MessageGroup({
  message, first = true, last = true, isGroup = false, onReact, searchQuery,
}) {
  const [hovered, setHovered] = useState(false);
  const [barOpen, setBarOpen] = useState(false);
  const [lightbox, setLightbox] = useState(false);
  const isMine = message.side === 'mine';
  const barVisible = hovered || barOpen;
  // Reactions live in the server's message table, and an encrypted message has
  // no row there to react to — so the affordance is not offered for it.
  const reactable = !message.encrypted;

  const reactions = message.reactions ?? [];
  const mine = new Set(reactions.filter(r => r.mine).map(r => r.emoji));

  function pickReaction(emoji) {
    onReact?.(message.id, emoji);
    setBarOpen(false);
  }

  return (
    <div
      className={`msg-wrapper ${isMine ? 'mine' : 'other'} ${first ? 'first' : ''} ${last ? 'last' : ''}`}
      onMouseEnter={() => setHovered(true)}
      onMouseLeave={() => setHovered(false)}
      onFocusCapture={() => setHovered(true)}
      onBlurCapture={e => {
        if (!e.currentTarget.contains(e.relatedTarget)) setHovered(false);
      }}
    >
      {reactable && barVisible && (
        <div className="reaction-bar" role="group" aria-label="انتخاب واکنش">
          {REACTIONS.map(emoji => (
            <button
              key={emoji}
              type="button"
              className={`reaction-btn ${mine.has(emoji) ? 'active' : ''}`}
              aria-pressed={mine.has(emoji)}
              aria-label={`${emoji}، ${mine.has(emoji) ? 'واکنش تو — برای برداشتن بزن' : 'افزودن'}`}
              onClick={() => pickReaction(emoji)}
            >
              {emoji}
            </button>
          ))}
        </div>
      )}

      <div className="msg-group">
        {!isMine && (
          last ? (
            <Avatar
              src={message.avatar}
              name={message.sender || 'کاربر'}
              size={30}
              className="msg-avatar"
            />
          ) : (
            <span className="msg-avatar-spacer" aria-hidden="true" />
          )
        )}

        <div className="msg-bubbles">
          {!isMine && isGroup && first && (
            <div className="msg-sender">{message.sender || 'کاربر'}</div>
          )}

          <BubbleContent
            message={message}
            searchQuery={searchQuery}
            onOpenImage={() => setLightbox(true)}
          />

          <div className="msg-footer">
            <time className="msg-time" dateTime={new Date(message.createdAt).toISOString()}>
              {message.time}
            </time>

            {message.encrypted && (
              <span className="msg-lock" title="این پیام فقط روی دستگاه شما و طرف مقابل رمزگشایی می‌شود">
                <i className="fas fa-lock" aria-hidden="true" />
                <span className="sr-only">رمزنگاری سرتاسری</span>
              </span>
            )}

            {reactable && (
              <button
                type="button"
                className="msg-react-toggle"
                aria-label="افزودن واکنش"
                aria-expanded={barVisible}
                onClick={() => setBarOpen(open => !open)}
              >
                <i className="far fa-face-smile" aria-hidden="true" />
              </button>
            )}

            {isMine && (
              <span
                className={`msg-receipt ${message.read ? 'read' : ''}`}
                title={message.read ? 'خوانده شد' : 'ارسال شد'}
              >
                <i className={`fas ${message.read ? 'fa-check-double' : 'fa-check'}`} aria-hidden="true" />
                <span className="sr-only">{message.read ? 'خوانده شد' : 'ارسال شد'}</span>
              </span>
            )}
          </div>

          {reactions.length > 0 && (
            <div className="msg-reactions" role="group" aria-label="واکنش‌ها">
              {reactions.map(({ emoji, mine: held }) => (
                <button
                  key={emoji}
                  type="button"
                  className={`msg-reaction ${held ? 'mine' : ''}`}
                  onClick={() => pickReaction(emoji)}
                  aria-pressed={held}
                  aria-label={held ? `برداشتن واکنش ${emoji}` : `افزودن واکنش ${emoji}`}
                  title={held ? 'برای برداشتن واکنش دوباره بزن' : 'واکنش نشان بده'}
                >
                  {emoji}
                </button>
              ))}
            </div>
          )}
        </div>
      </div>

      {lightbox && (
        <Modal
          onClose={() => setLightbox(false)}
          labelledBy="image-preview-title"
          className="image-lightbox"
        >
          <h2 id="image-preview-title" className="sr-only">پیش‌نمایش تصویر</h2>
          <img src={message.src} alt={message.text || 'تصویر ارسالی'} className="lightbox-image" />
          <div className="lightbox-actions">
            <a
              className="btn btn-secondary"
              href={message.src}
              download
              target="_blank"
              rel="noopener noreferrer"
            >
              <i className="fas fa-download" aria-hidden="true" />
              دانلود تصویر
            </a>
            <button type="button" className="btn btn-secondary" onClick={() => setLightbox(false)}>
              بستن
            </button>
          </div>
        </Modal>
      )}
    </div>
  );
}
