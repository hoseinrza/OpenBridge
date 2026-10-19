import { useState, useEffect, useCallback, useRef } from 'react';
import { io } from 'socket.io-client';
import { fetchMessages, uploadFile, resolveUrl } from '../services/api.js';

// Empty/relative → same-origin (nginx reverse-proxies /socket.io to the API).
const SOCKET_URL = (import.meta.env.VITE_API_URL ?? '/api').replace(/\/api\/?$/, '') || undefined;

function normalize(msg, myId) {
  return {
    id:        msg.id,
    type:      (msg.type ?? 'TEXT').toLowerCase(),
    text:      msg.text ?? '',
    src:       msg.fileUrl ? resolveUrl(msg.fileUrl) : undefined,
    name:      msg.fileName,
    size:      msg.fileSize,
    side:      msg.senderId === myId ? 'mine' : 'other',
    sender:    msg.sender?.username,
    avatar:    msg.sender?.avatar ? resolveUrl(msg.sender.avatar) : '/images/user.png',
    time:      new Date(msg.createdAt).toLocaleTimeString('fa-IR', { hour: '2-digit', minute: '2-digit' }),
    createdAt: new Date(msg.createdAt).getTime(),
    read:      msg.read,
    reactions: (msg.reactions ?? []).reduce(
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

export function useChat(targetUser, currentUser, onIncoming) {
  const [messages,  setMessages]  = useState([]);
  const [isTyping,  setIsTyping]  = useState(false);
  const [connected, setConnected] = useState(false);
  const socketRef      = useRef(null);
  const typingTimerRef = useRef(null);
  const targetRef      = useRef(targetUser);
  const currentUserRef = useRef(currentUser);
  const onIncomingRef  = useRef(onIncoming);
  targetRef.current      = targetUser;
  currentUserRef.current = currentUser;
  onIncomingRef.current  = onIncoming;

  // Pull anything that was persisted while the socket was down (messages are
  // not replayed by the server on reconnect) and merge it with live state.
  const refreshHistoryRef = useRef(() => {});
  refreshHistoryRef.current = () => {
    const target = targetRef.current;
    const me     = currentUserRef.current;
    if (!target || !me) return;
    fetchMessages(target.id)
      .then(msgs => {
        setMessages(prev => mergeMessages(prev, msgs.map(m => normalize(m, me.id))));
      })
      .catch(() => {});
  };

  // ── Socket connection (one per signed-in user, not per conversation) ──
  useEffect(() => {
    const token = localStorage.getItem('chatapp_token');
    if (!token || !currentUser) return undefined;

    const socket = io(SOCKET_URL, {
      auth:    { token },
      timeout: 10000,
      // Let Socket.IO fall back to HTTP polling when WebSocket is blocked
      // (some mobile networks / outer proxies do that).
    });
    socketRef.current = socket;

    socket.on('connect', () => {
      setConnected(true);
      const target = targetRef.current;
      if (target) socket.emit('messages:read', { fromId: target.id });
      refreshHistoryRef.current();
    });
    socket.on('disconnect',    () => setConnected(false));
    socket.on('connect_error', () => setConnected(false));

    socket.on('message:new', (msg) => {
      const target = targetRef.current;
      const me     = currentUserRef.current;
      if (!me) return;

      if (
        target && (
          (msg.senderId === me.id && msg.receiverId === target.id) ||
          (msg.senderId === target.id && msg.receiverId === me.id)
        )
      ) {
        setMessages(prev => mergeMessages(prev, [normalize(msg, me.id)]));
      }
      if (target && msg.senderId === target.id) {
        socket.emit('messages:read', { fromId: target.id });
      }
      // Let the parent know about every incoming message (even ones outside
      // the active conversation) so it can refresh the conversation list.
      if (msg.senderId === me.id || msg.receiverId === me.id) {
        onIncomingRef.current?.(msg);
      }
    });

    socket.on('message:read', () => {
      setMessages(prev => prev.map(m => m.side === 'mine' ? { ...m, read: true } : m));
    });

    socket.on('typing:start', ({ fromId }) => {
      if (fromId === targetRef.current?.id) setIsTyping(true);
    });

    socket.on('typing:stop', ({ fromId }) => {
      if (fromId === targetRef.current?.id) setIsTyping(false);
    });

    socket.on('reaction:added', ({ messageId, emoji }) => {
      setMessages(prev => prev.map(m => {
        if (m.id !== messageId) return m;
        const r = { ...m.reactions };
        r[emoji] = (r[emoji] ?? 0) + 1;
        return { ...m, reactions: r };
      }));
    });

    return () => {
      socket.disconnect();
      socketRef.current = null;
      setConnected(false);
    };
  }, [currentUser?.id]);

  // Mark the conversation as read whenever the active peer changes.
  useEffect(() => {
    if (!targetUser || !socketRef.current) return;
    socketRef.current.emit('messages:read', { fromId: targetUser.id });
  }, [targetUser?.id]);

  // ── Load history ──────────────────────────────────────
  useEffect(() => {
    if (!targetUser || !currentUser) return undefined;
    setMessages([]);
    setIsTyping(false);

    let cancelled = false;
    fetchMessages(targetUser.id)
      .then(msgs => {
        if (cancelled) return;
        setMessages(prev => mergeMessages(prev, msgs.map(m => normalize(m, currentUser.id))));
      })
      .catch(() => {});

    return () => { cancelled = true; };
  }, [targetUser?.id, currentUser?.id]);

  // ── Send ─────────────────────────────────────────────
  const sendMessage = useCallback(async (payload) => {
    const msg = typeof payload === 'string' ? { type: 'text', text: payload } : payload;
    if (msg.type === 'text' && !msg.text?.trim()) return false;

    const socket = socketRef.current;
    if (!socket) return false;

    if (msg._file) {
      try {
        const uploaded = await uploadFile(msg._file);
        socket.emit('message:send', {
          toId:     targetUser.id,
          type:     uploaded.type,
          fileUrl:  uploaded.url,
          fileName: uploaded.name,
          fileSize: uploaded.size,
        });
      } catch {}
      return true;
    }

    socket.emit('message:send', { toId: targetUser.id, type: 'TEXT', text: msg.text });
    clearTimeout(typingTimerRef.current);
    socket.emit('typing:stop', { toId: targetUser.id });
    return true;
  }, [targetUser]);

  // ── Typing notification ──────────────────────────────
  const notifyTyping = useCallback(() => {
    if (!socketRef.current || !targetUser) return;
    socketRef.current.emit('typing:start', { toId: targetUser.id });
    clearTimeout(typingTimerRef.current);
    typingTimerRef.current = setTimeout(() => {
      socketRef.current?.emit('typing:stop', { toId: targetUser.id });
    }, 2000);
  }, [targetUser]);

  // ── Reaction ─────────────────────────────────────────
  const addReaction = useCallback((msgId, emoji) => {
    if (!socketRef.current) return;
    socketRef.current.emit('reaction:add', { messageId: msgId, emoji, toId: targetUser?.id });
  }, [targetUser]);

  const clearMessages = useCallback(() => setMessages([]), []);

  return { messages, isTyping, connected, sendMessage, notifyTyping, addReaction, clearMessages };
}
