import { useEffect, useMemo, useRef, useState } from 'react';
import MessageGroup from './MessageGroup.jsx';
import ImageLightbox from './ImageLightbox.jsx';
import Avatar from '../ui/Avatar.jsx';
import { dayKey, formatDayLabel } from '../../utils/time.js';
import './MessageList.css';

function buildRows(messages) {
  const rows = [];
  let prevDay = null;
  let prevEncrypted = null;

  messages.forEach((msg) => {
    const day = dayKey(msg.createdAt);
    if (day !== prevDay) {
      rows.push({ type: 'day', key: day, label: formatDayLabel(msg.createdAt) });
      prevDay = day;
    }
    // One conversation crosses this line at most once, and only because the
    // plaintext rows that came before it are still on this device.
    if (msg.encrypted && prevEncrypted === false) {
      rows.push({ type: 'secure', key: `secure-${msg.id}` });
    }
    prevEncrypted = msg.encrypted;

    // Every message is its own row: a message sent a second after another keeps
    // the same spacing as one sent an hour later. Time grouping used to pull
    // same-sender bubbles into a 2px seam, which read as a spacing mistake once
    // the bubbles themselves are rounded.
    rows.push({ type: 'msg', msg, first: true, last: true });
  });

  return rows;
}

function Skeleton() {
  return (
    <div className="msg-skeleton" aria-hidden="true">
      {[68, 46, 58].map((width, i) => (
        <div key={i} className={`skeleton-row ${i % 2 ? 'mine' : ''}`}>
          <span className="skeleton-bubble" style={{ width: `${width}%` }} />
        </div>
      ))}
    </div>
  );
}

// The line at the top of a chat says how this conversation is stored. Content
// is sealed at rest with a key the server holds, so every signed-in device of
// the account can read it.
//
// A chat that predates the switch still has old envelopes. A device holding
// their keys hands them back as it opens the chat, so `legacyPending` is what
// is left: zero means the whole history has been moved over and the chat is
// ordinary from now on, whatever flag it still carries.
const faCount = new Intl.NumberFormat('fa-IR');

function e2eeNotice({ encrypted, secureMode, isGroup, legacyPending }) {
  const storage = isGroup
    ? 'پیام‌ها و فایل‌های این گروه روی سرور رمزگذاری‌شده ذخیره می‌شوند؛ دستگاه‌های واردشده به حساب اعضا می‌توانند آن‌ها را بخوانند.'
    : 'پیام‌ها و فایل‌های این گفتگو روی سرور رمزگذاری‌شده ذخیره می‌شوند؛ دستگاه‌های واردشده به حسابت می‌توانند آن‌ها را بخوانند.';

  if (!encrypted || legacyPending === 0) return { tone: 'on', text: storage };

  const count = Number.isInteger(legacyPending) && legacyPending > 0 ? faCount.format(legacyPending) : null;
  if (secureMode === 'unavailable') {
    return {
      tone: 'pending',
      text: count
        ? `${storage} ${count} پیام قدیمی هنوز فقط با رمزنگاری قبلی ذخیره شده‌اند و این دستگاه کلیدشان را ندارد؛ دستگاهی که کلید دارد باید یک بار این گفتگو را باز کند.`
        : `${storage} پیام‌های قدیمی این گفتگو روی این دستگاه باز نمی‌شوند.`,
    };
  }
  if (count) {
    return {
      tone: 'on',
      text: `${storage} ${count} پیام قدیمی هنوز فقط با رمزنگاری قبلی ذخیره شده‌اند؛ با باز کردن این گفتگو روی دستگاهی که کلیدشان را دارد، به سرور منتقل می‌شوند.`,
    };
  }
  return {
    tone: 'on',
    text: `${storage} پیام‌های قدیمی‌تر با رمزنگاری سرتاسری قبلی ذخیره شده‌اند و فقط روی دستگاه‌هایی که کلیدشان را دارند خوانده می‌شوند.`,
  };
}

export default function MessageList({
  messages, activeUser, onReact, onReply, onForward, onEdit, onDelete, onToast, searchQuery,
  encrypted, secureMode, legacyPending,
  historyState, historyError, onRetryHistory, onOpenProfile,
}) {
  const listRef   = useRef(null);
  const bottomRef = useRef(null);
  const atBottomRef = useRef(true);
  const prevCountRef = useRef(0);
  const prevLastIdRef = useRef(null);
  const [atBottom, setAtBottom] = useState(true);
  const [seenCount, setSeenCount] = useState(0);
  // One picture in the thread, by id: the ids survive a growing history, and a
  // picture that leaves the list takes the viewer down with it.
  const [openImageId, setOpenImageId] = useState(null);
  const isGroup = activeUser.kind === 'group';

  const rows = useMemo(() => buildRows(messages), [messages]);
  // The viewer walks the pictures of this thread, so a picture on its way out is
  // no longer one of them: walking the thread must not land on a page that is
  // already gone.
  const images = useMemo(() => messages.filter(msg => msg.type === 'image' && !msg.leaving), [messages]);
  const viewerIndex = images.findIndex(img => img.id === openImageId);
  const notice = e2eeNotice({
    encrypted,
    secureMode,
    isGroup,
    legacyPending,
  });
  const newCount = !searchQuery && !atBottom
    ? Math.max(0, messages.length - seenCount)
    : 0;

  useEffect(() => {
    const last = messages[messages.length - 1];
    const grew = messages.length > prevCountRef.current;
    const lastChanged = last?.id !== prevLastIdRef.current;

    if (!searchQuery && grew && lastChanged && (atBottomRef.current || last?.side === 'mine')) {
      bottomRef.current?.scrollIntoView({
        behavior: prevCountRef.current === 0 ? 'auto' : 'smooth',
        block: 'end',
      });
    }

    prevCountRef.current = messages.length;
    prevLastIdRef.current = last?.id;
  }, [messages, searchQuery]);

  useEffect(() => {
    function onResize() {
      if (atBottomRef.current) {
        bottomRef.current?.scrollIntoView({ behavior: 'auto', block: 'end' });
      }
    }
    window.addEventListener('resize', onResize);
    return () => window.removeEventListener('resize', onResize);
  }, []);

  function handleScroll() {
    const el = listRef.current;
    if (!el) return;
    const distance = el.scrollHeight - el.scrollTop - el.clientHeight;
    const isAtBottom = distance < 90;
    atBottomRef.current = isAtBottom;
    setAtBottom(isAtBottom);
    if (isAtBottom) setSeenCount(messages.length);
  }

  function jumpToLatest() {
    bottomRef.current?.scrollIntoView({ behavior: 'smooth', block: 'end' });
    atBottomRef.current = true;
    setAtBottom(true);
    setSeenCount(messages.length);
  }

  // A quote names the message it answers; tapping it walks the thread to that
  // row. Ids are compared, not interpolated into a selector, because an id from
  // a quote is data and not a piece of CSS.
  function jumpToMessage(id) {
    const list = listRef.current;
    if (!list) return;
    const target = [...list.querySelectorAll('[data-message-id]')]
      .find(node => node.dataset.messageId === id);
    target?.scrollIntoView({ behavior: 'smooth', block: 'center' });
  }

  return (
    <div className="messages-wrap">
      <div className="messages" ref={listRef} onScroll={handleScroll} role="log" aria-label="پیام‌ها">
        {!searchQuery && (
          <div className="chat-welcome">
            <Avatar
              src={activeUser.avatar}
              name={activeUser.name}
              size={64}
              group={isGroup}
            />
            <h2>{activeUser.name}</h2>
            {isGroup ? (
              <>
                <p>گروه شامل {activeUser.memberCount ?? 0} عضو</p>
                {activeUser.participants?.length > 0 && (
                  <p className="welcome-members">
                    {activeUser.participants.map(p => p.name).join('، ')}
                  </p>
                )}
              </>
            ) : (
              <p>این شروع گفتگوی شما با {activeUser.name} است</p>
            )}

            {/* What this device really does with the messages of this chat, said
                at the top of every one of them — including the chats it cannot
                protect yet, which are described as exactly that. */}
            <p className={`welcome-e2ee is-${notice.tone}`} role="note">
              <span>{notice.text}</span>
            </p>
          </div>
        )}

        {historyState === 'loading' && messages.length === 0 && <Skeleton />}

        {historyState === 'error' && messages.length === 0 && (
          <div className="history-error" role="alert">
            <i className="fas fa-triangle-exclamation" aria-hidden="true" />
            <p>{historyError || 'دریافت پیام‌ها ناموفق بود'}</p>
            <button type="button" className="btn btn-secondary" onClick={onRetryHistory}>
              <i className="fas fa-rotate-right" aria-hidden="true" />
              تلاش دوباره
            </button>
          </div>
        )}

        {historyState === 'ready' && messages.length === 0 && !searchQuery && (
          <p className="conversation-empty">
            هنوز پیامی رد و بدل نشده — اولین پیام را بنویس.
          </p>
        )}

        {searchQuery && messages.length === 0 && historyState !== 'loading' && (
          <div className="no-results">
            <i className="fas fa-magnifying-glass" aria-hidden="true" />
            <span>پیامی با این عبارت پیدا نشد</span>
          </div>
        )}

        {rows.map(row => (
          row.type === 'day' ? (
            <div key={`day-${row.key}`} className="date-sep">
              <span>{row.label}</span>
            </div>
          ) : row.type === 'secure' ? (
            <div key={row.key} className="secure-sep">
              <span>پیام‌های رمزنگاری‌شدهٔ قدیمی — فقط روی دستگاه‌هایی که کلیدشان را دارند خوانده می‌شوند</span>
            </div>
          ) : (
            <MessageGroup
              key={row.msg.id}
              message={row.msg}
              first={row.first}
              last={row.last}
              isGroup={isGroup}
              onReact={onReact}
              onReply={onReply}
              onForward={onForward}
              onEdit={onEdit}
              onDelete={onDelete}
              onToast={onToast}
              searchQuery={searchQuery}
              onOpenImage={setOpenImageId}
              onOpenProfile={onOpenProfile}
              onJumpToMessage={jumpToMessage}
            />
          )
        ))}

        <div ref={bottomRef} />
      </div>

      {newCount > 0 && (
        <button type="button" className="jump-latest" onClick={jumpToLatest}>
          <i className="fas fa-arrow-down" aria-hidden="true" />
          {newCount.toLocaleString('fa-IR')} پیام تازه
        </button>
      )}

      {viewerIndex >= 0 && (
        <ImageLightbox
          items={images}
          index={viewerIndex}
          onIndex={next => setOpenImageId(images[next].id)}
          onClose={() => setOpenImageId(null)}
        />
      )}
    </div>
  );
}
