import { useCallback, useEffect, useRef, useState } from 'react';
import { fetchGroupMessages, fetchMessages, resolveUrl } from '../services/api';
import { useSocket } from '../context/SocketContext';

function normalize(msg, myId) {
  return {
    id:             msg.id,
    type:           (msg.type ?? 'TEXT').toLowerCase(),
    text:           msg.text ?? '',
    src:            msg.fileUrl ? resolveUrl(msg.fileUrl) : undefined,
    name:           msg.fileName,
    size:           msg.fileSize,
    side:           msg.senderId === myId ? 'mine' : 'other',
    senderId:       msg.senderId,
    receiverId:     msg.receiverId,
    conversationId: msg.conversationId,
    sender:         msg.sender?.displayName ?? msg.sender?.username,
    avatar:         resolveUrl(msg.sender?.avatar),
    time:           new Date(msg.createdAt).toLocaleTimeString('fa-IR', { hour: '2-digit', minute: '2-digit' }),
    createdAt:      new Date(msg.createdAt).getTime(),
    read:           msg.read,
    reactions:      (msg.reactions ?? []).reduce(
      (acc, r) => ({ ...acc, [r.emoji]: (acc[r.emoji] ?? 0) + 1 }),
      {},
    ),
  };
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
      setMessages(prev => mergeMessages(prev, msgs.map(m => normalize(m, me.id))));
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
      .then(msgs => setMessages(prev => mergeMessages(prev, msgs.map(m => normalize(m, me.id)))))
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

    const onReaction = ({ messageId, emoji }) => {
      setMessages(prev => prev.map(m => {
        if (m.id !== messageId) return m;
        const r = { ...m.reactions };
        r[emoji] = (r[emoji] ?? 0) + 1;
        return { ...m, reactions: r };
      }));
    };

    const onConnect = () => refreshHistoryRef.current();

    socket.on('message:new', onMessage);
    socket.on('message:read', onRead);
    socket.on('typing:start', onTypingStart);
    socket.on('typing:stop', onTypingStop);
    socket.on('reaction:added', onReaction);
    socket.on('connect', onConnect);

    return () => {
      socket.off('message:new', onMessage);
      socket.off('message:read', onRead);
      socket.off('typing:start', onTypingStart);
      socket.off('typing:stop', onTypingStop);
      socket.off('reaction:added', onReaction);
      socket.off('connect', onConnect);
    };
  }, [socket]);

  // Mark the open conversation as read (also runs once the socket is ready).
  useEffect(() => {
    if (!peer || !socket) return;
    socket.emit('messages:read', isGroup ? { conversationId: peer.id } : { fromId: peer.id });
  }, [peer?.id, isGroup, socket]);

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
  }, [socket, connected, peer?.id, peer?.kind]);

  // ── Typing notification ──────────────────────────────
  const notifyTyping = useCallback(() => {
    if (!socket || !peer) return;
    socket.emit('typing:start', peer.kind === 'group' ? { conversationId: peer.id } : { toId: peer.id });
    clearTimeout(typingTimerRef.current);
    typingTimerRef.current = setTimeout(() => {
      socket.emit('typing:stop', peer.kind === 'group' ? { conversationId: peer.id } : { toId: peer.id });
    }, 2000);
  }, [socket, peer?.id, peer?.kind]);

  // ── Reaction ─────────────────────────────────────────
  const addReaction = useCallback((msgId, emoji) => {
    socket?.emit('reaction:add', { messageId: msgId, emoji });
  }, [socket]);

  return {
    messages, isTyping, typingName, connected,
    historyState, historyError, retryHistory,
    sendMessage, notifyTyping, addReaction,
  };
}
