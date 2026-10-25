import { useCallback, useEffect, useRef, useState } from 'react';
import { fetchE2eeState, fetchGroupMessages, fetchMessages, resolveUrl, uploadFile } from '../services/api';
import { useSocket } from '../context/SocketContext';

// One row per person per message: a chip has to know whether this device holds
// it, because tapping your own reaction removes it and a different emoji
// replaces it. Grouping the rows is what keeps the set equal to the people who
// reacted, never to the number of taps.
function groupReactions(rows, myId) {
  const byEmoji = new Map();
  for (const row of rows ?? []) {
    const entry = byEmoji.get(row.emoji) ?? { emoji: row.emoji, mine: false };
    if (row.userId === myId) entry.mine = true;
    byEmoji.set(row.emoji, entry);
  }
  return [...byEmoji.values()];
}

function normalize(msg, myId) {
  return {
    id:             msg.id,
    type:           (msg.type ?? 'TEXT').toLowerCase(),
    text:           msg.text ?? '',
    src:            msg.fileUrl ? resolveUrl(msg.fileUrl) : undefined,
    name:           msg.fileName,
    size:           msg.fileSize,
    // The length the sender measured while recording; a streamed file has no
    // reliable container length, so this number is what the bubble shows.
    durationMs:     msg.durationMs ?? undefined,
    side:           msg.senderId === myId ? 'mine' : 'other',
    senderId:       msg.senderId,
    receiverId:     msg.receiverId,
    conversationId: msg.conversationId,
    sender:         msg.sender?.displayName ?? msg.sender?.username,
    avatar:         resolveUrl(msg.sender?.avatar),
    time:           new Date(msg.createdAt).toLocaleTimeString('fa-IR', { hour: '2-digit', minute: '2-digit' }),
    createdAt:      new Date(msg.createdAt).getTime(),
    read:           msg.read,
    reactions:      groupReactions(msg.reactions, myId),
  };
}

// A message deleted for everyone is still a row on the server with its content
// removed. This app draws nothing in its place: the row is dropped as it is
// read, so the phone never shows an empty bubble for a message that is gone.
function fromServer(msgs, myId) {
  return msgs.filter(m => !m.deleted).map(m => normalize(m, myId));
}

function mergeMessages(prev, incoming) {
  const byId = new Map(prev.map(m => [m.id, m]));
  for (const m of incoming) byId.set(m.id, m);
  return [...byId.values()].sort((a, b) => a.createdAt - b.createdAt);
}

function emitWithAck(socket, event, payload, timeout = 12000) {
  return new Promise((resolve, reject) => {
    socket.timeout(timeout).emit(event, payload, (err, response) => {
      if (err) return reject(new Error('پاسخی از سرور دریافت نشد؛ اتصال را بررسی کن'));
      if (!response?.ok) return reject(new Error(response?.error ?? 'ارسال پیام ناموفق بود'));
      resolve(response);
    });
  });
}

export function useChat(peer, currentUser, onIncoming) {
  const { socket, connected } = useSocket();
  const [messages, setMessages] = useState([]);
  const [isTyping, setIsTyping] = useState(false);
  const [typingName, setTypingName] = useState('');
  const [historyState, setHistoryState] = useState('idle');
  const [historyError, setHistoryError] = useState('');
  const [locked, setLocked] = useState(peer?.encrypted === true);
  const typingTimerRef = useRef(null);
  const peerRef        = useRef(peer);
  const currentUserRef = useRef(currentUser);
  const onIncomingRef  = useRef(onIncoming);
  peerRef.current        = peer;
  currentUserRef.current = currentUser;
  onIncomingRef.current  = onIncoming;

  const isGroup = peer?.kind === 'group';

  const loadHistory = useCallback(async (p = peerRef.current, me = currentUserRef.current) => {
    if (!p || !me) return;
    setHistoryState('loading');
    setHistoryError('');
    try {
      const loader = p.kind === 'group' ? fetchGroupMessages : fetchMessages;
      const msgs = await loader(p.id);
      setMessages(prev => mergeMessages(prev, fromServer(msgs, me.id)));
      setHistoryState('ready');
    } catch (err) {
      setHistoryError(err.message ?? 'دریافت پیام‌ها ناموفق بود');
      setHistoryState('error');
    }
  }, []);

  const retryHistory = useCallback(() => {
    loadHistory();
  }, [loadHistory]);

  // Pull anything persisted while the socket was down (the server doesn't
  // replay missed messages) and merge it with live state.
  const refreshHistoryRef = useRef(() => {});
  refreshHistoryRef.current = () => {
    const p  = peerRef.current;
    const me = currentUserRef.current;
    if (!p || !me) return;
    const loader = p.kind === 'group' ? fetchGroupMessages : fetchMessages;
    loader(p.id)
      .then(msgs => setMessages(prev => mergeMessages(prev, fromServer(msgs, me.id))))
      .catch(() => {});
  };

  // ── Socket listeners (connection itself lives in SocketProvider) ──
  useEffect(() => {
    if (!socket) return undefined;

    const onMessage = (msg) => {
      const p  = peerRef.current;
      const me = currentUserRef.current;
      if (!me) return;

      const belongs = p && (p.kind === 'group'
        ? msg.conversationId === p.id
        : (
            (msg.senderId === me.id && msg.receiverId === p.id) ||
            (msg.senderId === p.id && msg.receiverId === me.id)
          ));

      if (belongs) {
        setMessages(prev => mergeMessages(prev, [normalize(msg, me.id)]));
      }

      if (p && msg.senderId !== me.id) {
        if (p.kind === 'group' && msg.conversationId === p.id) {
          socket.emit('messages:read', { conversationId: p.id });
        } else if (p.kind !== 'group' && msg.senderId === p.id) {
          socket.emit('messages:read', { fromId: p.id });
        }
      }
      if (msg.senderId === me.id || msg.receiverId === me.id) {
        onIncomingRef.current?.(msg);
      }
    };

    const onRead = (payload) => {
      const p = peerRef.current;
      if (!p) return;
      if (p.kind === 'group' ? payload?.conversationId !== p.id : payload?.by !== p.id) return;
      setMessages(prev => prev.map(m => m.side === 'mine' ? { ...m, read: true } : m));
    };

    const onTypingStart = (payload) => {
      const p = peerRef.current;
      if (!p || payload?.fromId === currentUserRef.current?.id) return;
      const matches = p.kind === 'group'
        ? payload?.conversationId === p.id
        : payload?.fromId === p.id;
      if (!matches) return;
      const person = p.kind === 'group'
        ? p.participants?.find(u => u.id === payload.fromId)
        : p;
      setTypingName(person?.name ?? 'کاربر');
      setIsTyping(true);
    };
    const onTypingStop = (payload) => {
      const p = peerRef.current;
      if (!p) return;
      const matches = p.kind === 'group'
        ? payload?.conversationId === p.id
        : payload?.fromId === p.id;
      if (matches) setIsTyping(false);
    };

    // The server sends the whole set of rows for the message, never a delta, so
    // removing and replacing a reaction look like every other change.
    const onReaction = ({ messageId, reactions }) => {
      const myId = currentUserRef.current?.id;
      setMessages(prev => prev.map(m => (
        m.id === messageId ? { ...m, reactions: groupReactions(reactions, myId) } : m
      )));
    };

    // A delete — for everyone or for this account alone — takes the row out of
    // this list. The id is enough: the list only ever holds the open chat, and a
    // delete for me reaches only this account's own devices.
    const onDeleted = ({ messageId }) => {
      setMessages(prev => prev.filter(m => m.id !== messageId));
    };

    // A chat can gain its legacy flag while it is open on this screen: the web
    // peer sends another MLS envelope and the server flips the conversation.
    // Only a device holding the old keys opens those envelopes, so this build
    // closes its composer instead of offering a chat whose history it cannot
    // show. Rows written from now on are sealed server-side and stay readable.
    const onEnvelope = () => {
      const p = peerRef.current;
      if (!p) return;
      fetchE2eeState(p)
        .then(state => { if (state?.e2ee === true) setLocked(true); })
        .catch(() => {});
    };

    const onConnect = () => refreshHistoryRef.current();

    socket.on('message:new', onMessage);
    socket.on('message:read', onRead);
    socket.on('typing:start', onTypingStart);
    socket.on('typing:stop', onTypingStop);
    socket.on('reaction:changed', onReaction);
    socket.on('message:deleted', onDeleted);
    socket.on('e2ee:envelope', onEnvelope);
    socket.on('connect', onConnect);

    return () => {
      socket.off('message:new', onMessage);
      socket.off('message:read', onRead);
      socket.off('typing:start', onTypingStart);
      socket.off('typing:stop', onTypingStop);
      socket.off('reaction:changed', onReaction);
      socket.off('message:deleted', onDeleted);
      socket.off('e2ee:envelope', onEnvelope);
      socket.off('connect', onConnect);
    };
  }, [socket]);

  // The e2ee flag marks a chat holding the old MLS history: only a web client
  // with the old keys opens those envelopes, while rows sealed server-side are
  // readable here like any other chat. A plaintext read mark also cannot clear
  // that legacy unread counter, so this build keeps the composer closed and the
  // probe decides whether the screen and composer may act at all.
  useEffect(() => {
    let cancelled = false;
    setLocked(peer?.encrypted === true);
    if (!peer) return undefined;
    fetchE2eeState(peer)
      .then(state => { if (!cancelled) setLocked(state?.e2ee === true); })
      .catch(() => {});
    return () => { cancelled = true; };
  }, [peer?.id, peer?.encrypted]);

  // Mark the open conversation as read (also runs once the socket is ready).
  useEffect(() => {
    if (!peer || !socket || locked) return;
    socket.emit('messages:read', isGroup ? { conversationId: peer.id } : { fromId: peer.id });
  }, [peer?.id, isGroup, socket, locked]);

  // ── Load history ──────────────────────────────────────
  useEffect(() => {
    if (!peer || !currentUser) return undefined;
    setMessages([]);
    setIsTyping(false);
    loadHistory(peer, currentUser);
    return undefined;
  }, [peer?.id, currentUser?.id, loadHistory]);

  // ── Send ──────────────────────────────────────────────
  const sendMessage = useCallback(async (text) => {
    const trimmed = text?.trim();
    if (!trimmed) return { ok: false, error: 'متن پیام خالی است' };
    if (locked) {
      return { ok: false, error: 'این گفتگو پیام‌های قدیمیِ رمزنگاری‌شده دارد؛ نوشتن در آن از این نسخه فعلاً ممکن نیست' };
    }
    if (!socket || !connected || !peer) {
      return { ok: false, error: 'اتصال به سرور برقرار نیست؛ دوباره تلاش کن' };
    }

    const payload = peer.kind === 'group'
      ? { conversationId: peer.id, type: 'TEXT', text: trimmed }
      : { toId: peer.id, type: 'TEXT', text: trimmed };

    clearTimeout(typingTimerRef.current);
    socket.emit('typing:stop', peer.kind === 'group' ? { conversationId: peer.id } : { toId: peer.id });

    try {
      await emitWithAck(socket, 'message:send', payload);
      return { ok: true };
    } catch (err) {
      return { ok: false, error: err.message };
    }
  }, [socket, connected, peer?.id, peer?.kind, locked]);

  // ── Voice ────────────────────────────────────────────
  // The bytes go to the same endpoint a photo uses, then the message row names
  // that file and carries the length the recorder measured — a streamed audio
  // file has no trustworthy length of its own until it is read to the end.
  const sendVoice = useCallback(async (recording) => {
    if (locked) {
      return { ok: false, error: 'این گفتگو پیام‌های قدیمیِ رمزنگاری‌شده دارد؛ نوشتن در آن از این نسخه فعلاً ممکن نیست' };
    }
    if (!socket || !connected || !peer) {
      return { ok: false, error: 'اتصال به سرور برقرار نیست؛ دوباره تلاش کن' };
    }
    if (!recording?.uri) return { ok: false, error: 'فایل صوتی پیدا نشد' };

    const target = peer.kind === 'group'
      ? { conversationId: peer.id }
      : { toId: peer.id };

    try {
      const file = await uploadFile({
        uri: recording.uri,
        name: recording.name ?? 'voice-message.m4a',
        type: 'audio/mp4',
      });
      await emitWithAck(socket, 'message:send', {
        ...target,
        // A recording is its own kind of message rather than an audio file, so
        // a transcript can tell spoken bytes from a file somebody chose from
        // their library.
        type: 'VOICE',
        fileUrl: file.url,
        fileName: file.name,
        fileSize: file.size,
        durationMs: Math.round(recording.durationMs ?? 0),
      }, 30000);
      return { ok: true };
    } catch (err) {
      return { ok: false, error: err.message ?? 'ارسال پیام صوتی ناموفق بود' };
    }
  }, [socket, connected, peer?.id, peer?.kind, locked]);

  // ── Typing notification ──────────────────────────────
  const notifyTyping = useCallback(() => {
    if (!socket || !peer || locked) return;
    socket.emit('typing:start', peer.kind === 'group' ? { conversationId: peer.id } : { toId: peer.id });
    clearTimeout(typingTimerRef.current);
    typingTimerRef.current = setTimeout(() => {
      socket.emit('typing:stop', peer.kind === 'group' ? { conversationId: peer.id } : { toId: peer.id });
    }, 2000);
  }, [socket, peer?.id, peer?.kind, locked]);

  // ── Reaction ─────────────────────────────────────────
  // One tap adds, a second tap on the same emoji removes it, and a different
  // emoji replaces it — the server owns that decision and answers with the
  // resulting rows, so this device learns the truth like everyone else does.
  const toggleReaction = useCallback((msgId, emoji) => {
    if (!socket) return false;
    socket.emit('reaction:add', { messageId: msgId, emoji });
    return true;
  }, [socket]);

  return {
    messages, isTyping, typingName, connected, locked,
    historyState, historyError, retryHistory,
    sendMessage, sendVoice, notifyTyping, toggleReaction,
  };
}
