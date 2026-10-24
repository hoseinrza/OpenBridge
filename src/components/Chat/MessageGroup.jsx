import { useEffect, useLayoutEffect, useRef, useState } from 'react';
import Avatar from '../ui/Avatar.jsx';
import EncryptedMedia from './EncryptedMedia.jsx';
import MessageActionsMenu from './MessageActionsMenu.jsx';
import VoiceBubble from './VoiceBubble.jsx';
import { playableFromSrc } from '../../services/voice.js';
import { formatSize } from '../../utils/format.js';

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

  if (message.type === 'audio' || message.type === 'voice') {
    return (
      <VoiceBubble
        id={message.id}
        durationMs={message.durationMs}
        resolve={() => playableFromSrc(message.src)}
        download={message.src}
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

const SWIPE_TRIGGER = 56;
const SWIPE_MAX = 72;

export default function MessageGroup({
  message, first = true, last = true, isGroup = false, onReact, searchQuery,
  onOpenImage, onReply, onForward, onEdit, onDelete, onToast, chatEncrypted = false,
  onOpenProfile, onJumpToMessage,
}) {
  const [menu, setMenu] = useState(null); // { anchor, viaKeyboard } | null
  const [swipeHint, setSwipeHint] = useState(0);
  const wrapperRef = useRef(null);
  const bubbleRef = useRef(null);
  const swipeRef = useRef(null);
  const suppressClickRef = useRef(false);
  const isMine = message.side === 'mine';
  // A row the list has marked as leaving is on its way out: it stops answering
  // taps while it collapses, and the list drops it a beat later.
  const leaving = Boolean(message.leaving);
  const actionable = !leaving;

  const reactions = message.reactions ?? [];
  const mine = new Set(reactions.filter(r => r.mine).map(r => r.emoji));

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
  }

  // The action menu hangs on one of two anchors: where the pointer was when the
  // bubble was right-clicked, or the bubble's own box when it was opened from
  // the keyboard.
  function openMenu(anchor, viaKeyboard) {
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

  // Reply by dragging the bubble to the left, the way the phone app answers a
  // message. The gesture only begins once the movement is clearly horizontal,
  // so a vertical scroll keeps its own interpretation, and only leftward travel
  // counts: the bubble follows the finger up to a stop and springs back if it
  // was not far enough to mean "reply".
  function handlePointerDown(event) {
    if (!actionable) return;
    if (event.pointerType === 'mouse' && event.button !== 0) return;
    if (event.pointerType !== 'mouse' && !event.isPrimary) return;
    swipeRef.current = {
      pointerId: event.pointerId,
      x: event.clientX,
      y: event.clientY,
      active: false,
      dx: 0,
    };
  }

  function handlePointerMove(event) {
    const start = swipeRef.current;
    if (!start || start.pointerId !== event.pointerId) return;
    const dx = event.clientX - start.x;
    const dy = event.clientY - start.y;

    if (!start.active) {
      if (Math.abs(dx) < 10 || Math.abs(dx) <= Math.abs(dy)) return;
      if (dx > 0) {
        swipeRef.current = null;
        return;
      }
      start.active = true;
      try {
        bubbleRef.current?.setPointerCapture?.(event.pointerId);
      } catch {
        // A pointer that has already ended (or a synthetic one) cannot be
        // captured; the drag still follows its own coordinates.
      }
    }

    // Horizontal travel is the gesture's, not the text selection's.
    if (event.cancelable) event.preventDefault();

    // Past the stop the bubble barely moves, so the gesture cannot drag a row
    // across the conversation.
    const pull = -Math.min(SWIPE_MAX, Math.abs(dx));
    start.dx = pull;
    const bubble = bubbleRef.current;
    if (bubble) {
      bubble.style.transition = 'none';
      bubble.style.transform = `translateX(${pull}px)`;
    }
    setSwipeHint(Math.min(1, Math.abs(pull) / SWIPE_TRIGGER));
  }

  function endSwipe(event, cancelled = false) {
    const start = swipeRef.current;
    if (!start || start.pointerId !== event.pointerId) return;
    swipeRef.current = null;

    const bubble = bubbleRef.current;
    if (bubble) {
      bubble.style.transition = 'transform var(--dur) var(--ease)';
      bubble.style.transform = '';
      setTimeout(() => { if (bubble) bubble.style.transition = ''; }, 260);
    }
    setSwipeHint(0);

    if (!start.active) return;
    // The release that ends a drag is not a tap on whatever the drag started
    // on: an image must not open because it was used as a handle. The flag is
    // cleared on the next tick of the clock too, because a touch drag may not
    // produce that click at all and the next real tap must not be eaten.
    suppressClickRef.current = true;
    setTimeout(() => { suppressClickRef.current = false; }, 350);
    if (!cancelled && start.dx <= -SWIPE_TRIGGER) onReply?.(message);
  }

  function handleClickCapture(event) {
    if (!suppressClickRef.current) return;
    suppressClickRef.current = false;
    event.preventDefault();
    event.stopPropagation();
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

  const bubbleClass = `bubble ${message.type === 'image' ? 'bubble-image' : ''}`
    + `${message.type === 'audio' || message.type === 'voice' ? ' bubble-voice' : ''}`;
  const wrapperClass = `msg-wrapper ${isMine ? 'mine' : 'other'} `
    + `${first ? 'first' : ''} ${last ? 'last' : ''} ${leaving ? 'leaving' : ''}`;

  return (
    <div ref={wrapperRef} className={wrapperClass} data-message-id={message.id}>
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
          {/* The arrow lives behind the bubble and is uncovered by the drag,
              reaching full strength only at the point that means "reply". */}
          <span className="swipe-reply" aria-hidden="true" style={{ opacity: swipeHint }}>
            <i className="fas fa-reply" />
          </span>

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
            onDragStart={event => event.preventDefault()}
            onPointerDown={handlePointerDown}
            onPointerMove={handlePointerMove}
            onPointerUp={event => endSwipe(event)}
            onPointerCancel={event => endSwipe(event, true)}
            onClickCapture={handleClickCapture}
          >
            {!isMine && isGroup && first && (
              <button type="button" className="msg-sender" onClick={openProfile}>
                {message.sender || 'کاربر'}
              </button>
            )}

            {message.forwardedFrom && (
              <span className="msg-forwarded">
                <i className="fas fa-share" aria-hidden="true" />
                فروارد از {message.forwardedFrom}
              </span>
            )}

            {message.reply && (
              <button
                type="button"
                className="msg-quote"
                onClick={() => onJumpToMessage?.(message.reply.id)}
                title="رفتن به پیام نقل‌شده"
              >
                <span className="msg-quote-name">{message.reply.senderName || 'کاربر'}</span>
                <span className="msg-quote-text">
                  {message.reply.deleted ? 'پیام حذف شد' : message.reply.preview}
                </span>
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
          onReply={() => onReply?.(message)}
          onForward={() => onForward?.(message)}
          onEdit={onEdit}
          onDelete={scope => onDelete?.(message.id, scope)}
          onToast={onToast}
          onClose={closeMenu}
        />
      )}
    </div>
  );
}
