import { useEffect, useRef, useState } from 'react';
import Modal from '../ui/Modal.jsx';
import Avatar from '../ui/Avatar.jsx';
import EncryptedMedia from './EncryptedMedia.jsx';
import { formatSize } from '../../utils/format.js';

const REACTIONS = ['👍', '❤️', '😂', '😮', '😢'];

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

/* Only the inside of a bubble. The bubble itself belongs to the message row so
   that everything the message owns — media, picker, reaction chips, timestamp
   and receipt — is laid out inside one surface. */
function BubbleBody({ message, searchQuery, onOpenImage }) {
  // An encrypted attachment has no address the browser could fetch. Only the
  // descriptor is known here, so the body — including its loading and failure
  // states — belongs to the component that can turn it back into bytes.
  if (message.attachment) {
    return (
      <EncryptedMedia
        attachment={message.attachment}
        kind={message.type}
        name={message.name}
        size={message.size}
        onOpen={onOpenImage}
      />
    );
  }

  if (message.type === 'image') {
    return (
      <button
        type="button"
        className="msg-image-btn"
        onClick={() => onOpenImage(message.src)}
        aria-label="بازکردن تصویر در اندازه کامل"
      >
        <img src={message.src} alt={message.text || 'تصویر ارسالی'} className="msg-image" />
      </button>
    );
  }

  if (message.type === 'file') {
    return (
      <a
        className="bubble-file-link"
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
    <span className="bubble-text">
      <Highlight text={message.text} query={searchQuery} />
    </span>
  );
}

export default function MessageGroup({
  message, first = true, last = true, isGroup = false, onReact, searchQuery,
}) {
  const [barOpen, setBarOpen] = useState(false);
  const [barBelow, setBarBelow] = useState(false);
  const [barOffset, setBarOffset] = useState(0);
  const bubbleRef = useRef(null);
  const toggleRef = useRef(null);
  const pickerRef = useRef(null);
  // The preview holds the address it is showing: for an encrypted picture that
  // is an object URL made by the bubble, which only exists while it is open.
  const [lightbox, setLightbox] = useState(null);
  const isMine = message.side === 'mine';
  // Reactions live in the server's message table, and an encrypted message has
  // no row there to react to — so the affordance is not offered for it.
  const reactable = !message.encrypted;

  const reactions = message.reactions ?? [];
  const mine = new Set(reactions.filter(r => r.mine).map(r => r.emoji));

  useEffect(() => {
    if (!barOpen) return undefined;

    function close() {
      setBarOpen(false);
    }

    function onPointerDown(event) {
      if (!bubbleRef.current?.contains(event.target)) close();
    }

    function onKeyDown(event) {
      if (event.key !== 'Escape') return;
      close();
      toggleRef.current?.focus();
    }

    document.addEventListener('pointerdown', onPointerDown);
    document.addEventListener('keydown', onKeyDown);
    document.addEventListener('scroll', close, true);
    window.addEventListener('resize', close);
    return () => {
      document.removeEventListener('pointerdown', onPointerDown);
      document.removeEventListener('keydown', onKeyDown);
      document.removeEventListener('scroll', close, true);
      window.removeEventListener('resize', close);
    };
  }, [barOpen]);

  useEffect(() => {
    if (barOpen) pickerRef.current?.querySelector('.reaction-btn')?.focus();
  }, [barOpen]);

  function pickReaction(emoji) {
    onReact?.(message.id, emoji);
    setBarOpen(false);
  }

  function togglePicker() {
    if (barOpen) {
      setBarOpen(false);
      return;
    }
    const bubble = bubbleRef.current;
    if (!bubble) return;
    const scroller = bubble.closest('.messages');
    const rect = bubble.getBoundingClientRect();
    const scrollerRect = scroller?.getBoundingClientRect();
    const roomAbove = rect.top - (scrollerRect?.top ?? 0);
    const roomBelow = (scrollerRect?.bottom ?? window.innerHeight) - rect.bottom;
    // A five-button strip is about 168px wide; keep it inside the viewport even
    // when the bubble sits against an edge, and flip below when the message is
    // too close to the top of the scroller for a strip above.
    const pickerWidth = Math.min(168, window.innerWidth - 32);
    const pickerLeft = Math.min(
      Math.max(rect.left, 16),
      Math.max(16, window.innerWidth - 16 - pickerWidth),
    );
    setBarBelow(roomAbove < 56 && roomBelow >= roomAbove);
    setBarOffset(pickerLeft - rect.left);
    setBarOpen(true);
  }

  const bubbleClass = `bubble ${message.type === 'image' ? 'bubble-image' : ''}`;

  return (
    <div className={`msg-wrapper ${isMine ? 'mine' : 'other'} ${first ? 'first' : ''} ${last ? 'last' : ''}`}>
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
          <div
            className={`${bubbleClass}${reactions.length > 0 ? ' has-reactions' : ''}`}
            ref={bubbleRef}
          >
            {!isMine && isGroup && first && (
              <div className="msg-sender">{message.sender || 'کاربر'}</div>
            )}

            <BubbleBody
              message={message}
              searchQuery={searchQuery}
              onOpenImage={setLightbox}
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

            {reactable && (
              <button
                ref={toggleRef}
                type="button"
                className="msg-react-toggle"
                aria-label="افزودن واکنش"
                aria-expanded={barOpen}
                onClick={togglePicker}
              >
                <i className="far fa-face-smile" aria-hidden="true" />
              </button>
            )}

            {reactable && barOpen && (
              <div
                ref={pickerRef}
                className={`reaction-bar${barBelow ? ' below' : ''}`}
                style={{ insetInlineEnd: barOffset }}
                role="group"
                aria-label="انتخاب واکنش"
              >
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
          </div>
        </div>
      </div>

      {lightbox && (
        <Modal
          onClose={() => setLightbox(false)}
          labelledBy="image-preview-title"
          className="image-lightbox"
        >
          <h2 id="image-preview-title" className="sr-only">پیش‌نمایش تصویر</h2>
          <img src={lightbox} alt={message.text || 'تصویر ارسالی'} className="lightbox-image" />
          <div className="lightbox-actions">
            <a
              className="btn btn-secondary"
              href={lightbox}
              download={message.name || 'image'}
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
