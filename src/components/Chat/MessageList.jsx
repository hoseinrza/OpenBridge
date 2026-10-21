import { useEffect, useMemo, useRef, useState } from 'react';
import MessageGroup from './MessageGroup.jsx';
import Avatar from '../ui/Avatar.jsx';
import { dayKey, formatDayLabel } from '../../utils/time.js';
import './MessageList.css';

const GROUP_GAP = 5 * 60 * 1000;

function buildRows(messages) {
  const rows = [];
  let prevMsg = null;
  let prevDay = null;
  let prevEncrypted = null;

  messages.forEach((msg, index) => {
    const day = dayKey(msg.createdAt);
    if (day !== prevDay) {
      rows.push({ type: 'day', key: day, label: formatDayLabel(msg.createdAt) });
      prevMsg = null;
      prevDay = day;
    }
    // One conversation crosses this line at most once, and only because the
    // plaintext rows that came before it are still on this device.
    if (msg.encrypted && prevEncrypted === false) {
      rows.push({ type: 'secure', key: `secure-${msg.id}` });
    }
    prevEncrypted = msg.encrypted;

    const next = messages[index + 1];
    const samePrev = prevMsg
      && prevMsg.senderId === msg.senderId
      && msg.createdAt - prevMsg.createdAt < GROUP_GAP;
    const sameNext = next
      && next.senderId === msg.senderId
      && next.createdAt - msg.createdAt < GROUP_GAP
      && dayKey(next.createdAt) === day;

    rows.push({ type: 'msg', msg, first: !samePrev, last: !sameNext });
    prevMsg = msg;
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

// The line at the top of a chat has to say what this device really does with
// this conversation, so every case gets its own sentence: the chats that are
// protected, the ones that will be with the first message, and the ones this
// device cannot protect at all — never one sentence stretched to fit all three.
function e2eeNotice({ encrypted, secureMode, isGroup, reason }) {
  if (encrypted) {
    return {
      tone: 'on',
      text: 'پیام، تصویر و فایل این گفتگو فقط روی دستگاه شما و دستگاه طرف مقابل رمزگشایی می‌شود؛ سرور هیچ‌وقت آن‌ها را نمی‌بیند.',
    };
  }
  if (isGroup) {
    return { tone: 'off', text: 'گروه‌ها هنوز سرتاسری رمزنگاری نمی‌شوند؛ پیام‌های این گفتگو روی سرور هم خوانده می‌شوند.' };
  }
  if (secureMode === 'checking') {
    return { tone: 'pending', text: 'در حال بررسی است که این گفتگو روی این دستگاه رمزنگاری می‌شود.' };
  }
  if (secureMode === 'unavailable') {
    return { tone: 'off', text: `این گفتگو روی این دستگاه رمزگشایی نمی‌شود${reason ? ` — ${reason}` : ''}.` };
  }
  if (reason) {
    return { tone: 'off', text: `این گفتگو فعلاً سرتاسری رمزنگاری نمی‌شود — ${reason}.` };
  }
  return { tone: 'pending', text: 'اولین پیام این گفتگو از همین دستگاه رمزنگاری می‌شود؛ از آن لحظه سرور نه متن و نه فایل شما را می‌بیند.' };
}

export default function MessageList({
  messages, activeUser, onReact, searchQuery,
  encrypted, secureMode, encryptionNote,
  historyState, historyError, onRetryHistory,
}) {
  const listRef   = useRef(null);
  const bottomRef = useRef(null);
  const atBottomRef = useRef(true);
  const prevCountRef = useRef(0);
  const prevLastIdRef = useRef(null);
  const [atBottom, setAtBottom] = useState(true);
  const [seenCount, setSeenCount] = useState(0);
  const isGroup = activeUser.kind === 'group';

  const rows = useMemo(() => buildRows(messages), [messages]);
  const notice = e2eeNotice({
    encrypted,
    secureMode,
    isGroup,
    reason: (secureMode === 'unavailable' ? historyError : encryptionNote) || '',
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
              <i className={`fas ${notice.tone === 'off' ? 'fa-lock-open' : 'fa-lock'}`} aria-hidden="true" />
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
              <i className="fas fa-lock" aria-hidden="true" />
              <span>از این پیام به بعد، متن فقط روی دستگاه شما و طرف مقابل رمزگشایی می‌شود</span>
            </div>
          ) : (
            <MessageGroup
              key={row.msg.id}
              message={row.msg}
              first={row.first}
              last={row.last}
              isGroup={isGroup}
              onReact={onReact}
              searchQuery={searchQuery}
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
    </div>
  );
}
