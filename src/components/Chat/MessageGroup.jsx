import { useEffect, useLayoutEffect, useRef, useState } from 'react';
import Avatar from '../ui/Avatar.jsx';
import EncryptedMedia from './EncryptedMedia.jsx';
import MessageActionsMenu from './MessageActionsMenu.jsx';
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
        onClick={() => onOpenImage()}
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
  onOpenImage, onEdit, onDelete, onToast, chatEncrypted = false, onOpenProfile,
}) {
  const [barOpen, setBarOpen] = useState(false);
  const [barBelow, setBarBelow] = useState(false);
  const [barOffset, setBarOffset] = useState(0);
  const [menu, setMenu] = useState(null); // { anchor, viaKeyboard } | null
  const wrapperRef = useRef(null);
  const bubbleRef = useRef(null);
  const toggleRef = useRef(null);
  const pickerRef = useRef(null);
  const isMine = message.side === 'mine';
  // A row the list has marked as leaving is on its way out: it stops answering
  // taps while it collapses, and the list drops it a beat later.
  const leaving = Boolean(message.leaving);
  // Reactions live in the server's message table, and an encrypted message has
  // no row there to react to — so the affordance is not offered for it.
  const reactable = !message.encrypted && !leaving;
  const actionable = !leaving;

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

  // A deleted row does not blink out: it collapses from its own height to
  // nothing, so the messages under it slide up into the space instead of
  // jumping. The height is measured here, one frame before anything about the
  // row has changed, because a CSS animation would already be running by the
  // time the row could be asked how tall it is. Duration and easing are read
  // from the tokens the rest of the chat animates with, and the row is kept
  // mounted a little longer than one duration (MESSAGE_EXIT_MS in useChat.js).
  useLayoutEffect(() => {
    if (!leaving) return undefined;
    const el = wrapperRef.current;
    if (!el) return undefined;
    if (window.matchMedia('(prefers-reduced-motion: reduce)').matches) return undefined;
    const tokens = getComputedStyle(el);
    const anim = el.animate([
      { height: `${el.offsetHeight}px`, marginBottom: tokens.marginBottom, opacity: 1 },
      { height: '0px', marginBottom: '0px', opacity: 0 },
    ], {
      duration: Number.parseFloat(tokens.getPropertyValue('--dur')) || 180,
      easing: tokens.getPropertyValue('--ease').trim() || 'ease',
      fill: 'forwards',
    });
    return () => anim.cancel();
  }, [leaving]);

  // The face beside a message is the door to the person behind it, in a group as
  // much as in a direct chat. The avatar and the name line open the same profile,
  // and both hand over only what this row knows: the sheet fills the rest from
  // the server, so a tap answers at once whatever the network is doing.
  function openProfile() {
    onOpenProfile?.({ id: message.senderId, name: message.sender || 'کاربر', avatar: message.avatar });
  }

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

  // The action menu hangs on one of two anchors: where the pointer was when the
  // bubble was right-clicked, or the bubble's own box when it was opened from
  // the keyboard. The picker steps aside for it — one surface per message.
  function openMenu(anchor, viaKeyboard) {
    setBarOpen(false);
    setMenu({ anchor, viaKeyboard });
  }

  function closeMenu() {
    setMenu(null);
  }

  function handleContextMenu(event) {
    if (!actionable) return;
    event.preventDefault();
    openMenu({ left: event.clientX, top: event.clientY, width: 0, height: 0 }, false);
  }

  function handleKeyDown(event) {
    if (!actionable || event.target !== bubbleRef.current) return;
    // F10 with Shift, and the Menu key, are the two keys a browser gives a
    // context menu; neither reaches a bubble by Tab.
    if (event.key === 'ContextMenu' || (event.key === 'F10' && event.shiftKey)) {
      event.preventDefault();
      const rect = bubbleRef.current.getBoundingClientRect();
      openMenu({ left: rect.left, top: rect.top, width: rect.width, height: rect.height }, true);
    }
  }

  // Only a menu opened by hand returns focus when it goes away; one dismissed
  // by the mouse would leave a ring on a bubble nobody meant to select. The
  // hand-back waits for the portal to leave the document, or the bubble would
  // take the focus and lose it again when its menu is unmounted.
  const lastMenu = useRef(null);
  useEffect(() => {
    if (lastMenu.current && !menu && lastMenu.current.viaKeyboard) bubbleRef.current?.focus();
    lastMenu.current = menu;
  }, [menu]);

  const bubbleClass = `bubble ${message.type === 'image' ? 'bubble-image' : ''}`;
  const wrapperClass = `msg-wrapper ${isMine ? 'mine' : 'other'} `
    + `${first ? 'first' : ''} ${last ? 'last' : ''} ${leaving ? 'leaving' : ''}`;

  return (
    <div ref={wrapperRef} className={wrapperClass}>
      <div className="msg-group">
        {!isMine && (
          last ? (
            <button
              type="button"
              className="msg-avatar-btn"
              onClick={openProfile}
              aria-label={`پروفایل ${message.sender || 'کاربر'}`}
              title={`پروفایل ${message.sender || 'کاربر'}`}
            >
              <Avatar src={message.avatar} name={message.sender || 'کاربر'} size={30} />
            </button>
          ) : (
            <span className="msg-avatar-spacer" aria-hidden="true" />
          )
        )}

        <div className="msg-bubbles">
          <div
            className={bubbleClass}
            ref={bubbleRef}
            // A message is an object you can act on, so the keyboard reaches it
            // as a stop of its own and says whose message this is out loud.
            role="group"
            tabIndex={actionable ? 0 : -1}
            aria-label={`${isMine ? 'شما' : (message.sender || 'کاربر')}، ${message.time}`}
            onContextMenu={handleContextMenu}
            onKeyDown={handleKeyDown}
          >
            {!isMine && isGroup && first && (
              <button type="button" className="msg-sender" onClick={openProfile}>
                {message.sender || 'کاربر'}
              </button>
            )}

            <BubbleBody
              message={message}
              searchQuery={searchQuery}
              // The viewer belongs to the list, not the bubble: it walks the
              // whole thread, so it needs every picture and this one's place.
              onOpenImage={() => onOpenImage?.(message.id)}
            />

            {/* The chips answer the text and the clock records it, so the row of
                reactions belongs between them — above the meta line, not under
                it, whatever side the thread runs on. */}
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

            <div className="msg-footer">
              {message.editedAt && (
                <span className="msg-edited">ویرایش‌شده</span>
              )}

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

      {/* The menu lives on the document body and is placed from the anchor, so
          opening it never moves the bubble it belongs to. */}
      {menu && actionable && (
        <MessageActionsMenu
          anchor={menu.anchor}
          message={message}
          chatEncrypted={chatEncrypted}
          held={[...mine]}
          onReact={pickReaction}
          onEdit={onEdit}
          onDelete={scope => onDelete?.(message.id, scope)}
          onToast={onToast}
          onClose={closeMenu}
        />
      )}
    </div>
  );
}
