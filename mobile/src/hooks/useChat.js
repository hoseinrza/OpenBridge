import { useCallback, useEffect, useRef, useState } from 'react';
import { io } from 'socket.io-client';
import { storage } from '../services/storage';
import { fetchMessages, resolveUrl } from '../services/api';

const SOCKET_URL = (process.env.EXPO_PUBLIC_API_URL ?? 'http://localhost:3000/api').replace(/\/api\/?$/, '');

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
    avatar:    resolveUrl(msg.sender?.avatar),
    time:      new Date(msg.createdAt).toLocaleTimeString('fa-IR', { hour: '2-digit', minute: '2-digit' }),
    read:      msg.read,
    reactions: (msg.reactions ?? []).reduce(
      (acc, r) => ({ ...acc, [r.emoji]: (acc[r.emoji] ?? 0) + 1 }),
      {},
    ),
  };
}

// Real Socket.IO connection only — unlike the web app's hook, there's no
// local "mock mode" fallback here (a mobile account is always a real one).
export function useChat(peer, currentUser, onIncoming) {
  const [messages,  setMessages]  = useState([]);
  const [isTyping,  setIsTyping]  = useState(false);
  const [connected, setConnected] = useState(false);
  const socketRef      = useRef(null);
  const typingTimerRef = useRef(null);
  const onIncomingRef  = useRef(onIncoming);
  onIncomingRef.current = onIncoming;

  // ── Socket connection ─────────────────────────────────
  useEffect(() => {
    if (!currentUser) return;
    let socket;
    let cancelled = false;

    storage.getToken().then((token) => {
      if (cancelled || !token) return;

      socket = io(SOCKET_URL, {
        auth:       { token },
        transports: ['websocket'],
        timeout:    4000,
      });
      socketRef.current = socket;

      socket.on('connect',       () => setConnected(true));
      socket.on('disconnect',    () => setConnected(false));
      socket.on('connect_error', () => setConnected(false));

      // Covers messages that arrived while this screen wasn't open.
      if (peer) socket.emit('messages:read', { fromId: peer.id });

      socket.on('message:new', (msg) => {
        if (
          (msg.senderId === currentUser.id && msg.receiverId === peer?.id) ||
          (msg.senderId === peer?.id && msg.receiverId === currentUser.id)
        ) {
          setMessages(prev => [...prev, normalize(msg, currentUser.id)]);
        }
        if (msg.senderId === peer?.id) {
          socket.emit('messages:read', { fromId: peer.id });
        }
        if (msg.senderId === currentUser.id || msg.receiverId === currentUser.id) {
          onIncomingRef.current?.(msg);
        }
      });

      socket.on('message:read', () => {
        setMessages(prev => prev.map(m => m.side === 'mine' ? { ...m, read: true } : m));
      });

      socket.on('typing:start', ({ fromId }) => { if (fromId === peer?.id) setIsTyping(true); });
      socket.on('typing:stop',  ({ fromId }) => { if (fromId === peer?.id) setIsTyping(false); });

      socket.on('reaction:added', ({ messageId, emoji }) => {
        setMessages(prev => prev.map(m => {
          if (m.id !== messageId) return m;
          const r = { ...m.reactions };
          r[emoji] = (r[emoji] ?? 0) + 1;
          return { ...m, reactions: r };
        }));
      });
    });

    return () => {
      cancelled = true;
      socket?.disconnect();
      socketRef.current = null;
      setConnected(false);
    };
  }, [currentUser?.id, peer?.id]);

  // ── Load history ──────────────────────────────────────
  useEffect(() => {
    if (!peer || !currentUser) return;
    setMessages([]);
    fetchMessages(peer.id)
      .then(msgs => setMessages(msgs.map(m => normalize(m, currentUser.id))))
      .catch(() => {});
  }, [peer?.id, currentUser?.id]);

  // ── Send ──────────────────────────────────────────────
  const sendMessage = useCallback((text) => {
    const trimmed = text?.trim();
    if (!trimmed || !socketRef.current || !peer) return;
    socketRef.current.emit('message:send', { toId: peer.id, type: 'TEXT', text: trimmed });
    clearTimeout(typingTimerRef.current);
    socketRef.current.emit('typing:stop', { toId: peer.id });
  }, [peer]);

  // ── Typing notification ──────────────────────────────
  const notifyTyping = useCallback(() => {
    if (!socketRef.current || !peer) return;
    socketRef.current.emit('typing:start', { toId: peer.id });
    clearTimeout(typingTimerRef.current);
    typingTimerRef.current = setTimeout(() => {
      socketRef.current?.emit('typing:stop', { toId: peer.id });
    }, 2000);
  }, [peer]);

  // ── Reaction (wired up in Phase 7) ────────────────────
  const addReaction = useCallback((msgId, emoji) => {
    socketRef.current?.emit('reaction:add', { messageId: msgId, emoji, toId: peer?.id });
  }, [peer]);

  return { messages, isTyping, connected, sendMessage, notifyTyping, addReaction };
}
