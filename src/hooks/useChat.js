import { useState, useEffect, useCallback, useRef } from 'react';
import { fetchMessages, uploadFile } from '../services/api.js';

const SOCKET_URL = (import.meta.env.VITE_API_URL ?? 'https://openbridge-api.onrender.com/api').replace('/api', '');

function nowFa() {
  return new Date().toLocaleTimeString('fa-IR', { hour: '2-digit', minute: '2-digit' });
}

function normalize(msg, myId) {
  return {
    id:        msg.id,
    type:      (msg.type ?? 'TEXT').toLowerCase(),
    text:      msg.text ?? '',
    src:       msg.fileUrl ? `${SOCKET_URL}${msg.fileUrl}` : undefined,
    name:      msg.fileName,
    size:      msg.fileSize,
    side:      msg.senderId === myId ? 'mine' : 'other',
    sender:    msg.sender?.username,
    avatar:    msg.sender?.avatar ?? '/images/user.png',
    time:      new Date(msg.createdAt).toLocaleTimeString('fa-IR', { hour: '2-digit', minute: '2-digit' }),
    read:      msg.read,
    reactions: (msg.reactions ?? []).reduce(
      (acc, r) => ({ ...acc, [r.emoji]: (acc[r.emoji] ?? 0) + 1 }),
      {},
    ),
  };
}

export const isMockUser = (user) => user?.id?.startsWith('local-');

export function useChat(targetUser, currentUser, onIncoming) {
  const [messages,  setMessages]  = useState([]);
  const [isTyping,  setIsTyping]  = useState(false);
  const socketRef      = useRef(null);
  const typingTimerRef = useRef(null);
  const mockModeRef    = useRef(false);
  const onIncomingRef  = useRef(onIncoming);
  onIncomingRef.current = onIncoming;

  // ── Socket connection (real backend) ─────────────────
  useEffect(() => {
    const token = localStorage.getItem('chatapp_token');
    // No token or mock user → stay in mock mode
    if (!token || !currentUser || isMockUser(currentUser)) {
      mockModeRef.current = true;
      return;
    }

    let socket;
    import('socket.io-client').then(({ io }) => {
      socket = io(SOCKET_URL, {
        auth:       { token },
        transports: ['websocket'],
        timeout:    4000,
      });
      socketRef.current  = socket;
      mockModeRef.current = false;

      // Mark the currently-open conversation as read (covers messages that
      // arrived before this connection, e.g. while the app was closed)
      if (targetUser) socket.emit('messages:read', { fromId: targetUser.id });

      socket.on('connect_error', () => { mockModeRef.current = true; });

      socket.on('message:new', (msg) => {
        if (
          (msg.senderId === currentUser.id && msg.receiverId === targetUser?.id) ||
          (msg.senderId === targetUser?.id && msg.receiverId === currentUser.id)
        ) {
          setMessages(prev => [...prev, normalize(msg, currentUser.id)]);
        }
        if (msg.senderId === targetUser?.id) {
          socket.emit('messages:read', { fromId: targetUser.id });
        }
        // Let the parent know about every incoming message (even ones outside
        // the active conversation) so it can refresh the conversation list
        if (msg.senderId === currentUser.id || msg.receiverId === currentUser.id) {
          onIncomingRef.current?.(msg);
        }
      });

      socket.on('message:read', () => {
        setMessages(prev => prev.map(m => m.side === 'mine' ? { ...m, read: true } : m));
      });

      socket.on('typing:start', ({ fromId }) => {
        if (fromId === targetUser?.id) setIsTyping(true);
      });

      socket.on('typing:stop', ({ fromId }) => {
        if (fromId === targetUser?.id) setIsTyping(false);
      });

      socket.on('reaction:added', ({ messageId, emoji }) => {
        setMessages(prev => prev.map(m => {
          if (m.id !== messageId) return m;
          const r = { ...m.reactions };
          r[emoji] = (r[emoji] ?? 0) + 1;
          return { ...m, reactions: r };
        }));
      });
    }).catch(() => { mockModeRef.current = true; });

    return () => { socket?.disconnect(); socketRef.current = null; };
  }, [currentUser?.id, targetUser?.id]);

  // ── Load history (real backend) ──────────────────────
  useEffect(() => {
    if (!targetUser || !currentUser) return;
    setMessages([]);
    if (isMockUser(currentUser)) return; // mock mode, no history

    fetchMessages(targetUser.id)
      .then(msgs => setMessages(msgs.map(m => normalize(m, currentUser.id))))
      .catch(() => {}); // silently ignore if backend is down
  }, [targetUser?.id, currentUser?.id]);

  // ── Send ─────────────────────────────────────────────
  const sendMessage = useCallback(async (payload) => {
    const msg = typeof payload === 'string' ? { type: 'text', text: payload } : payload;
    if (msg.type === 'text' && !msg.text?.trim()) return;

    // ── Mock mode ──
    if (mockModeRef.current || !socketRef.current) {
      const msgId = Date.now();
      setMessages(prev => [...prev, {
        id: msgId, type: msg.type || 'text',
        text: msg.text || '',
        src:  msg.type !== 'text' ? msg.src : undefined,
        name: msg.name, size: msg.size,
        side: 'mine', time: nowFa(), read: false, reactions: {},
      }]);
      setTimeout(() => {
        setMessages(prev => prev.map(m => m.id === msgId ? { ...m, read: true } : m));
      }, 1800);
      return;
    }

    // ── Real backend ──
    const socket = socketRef.current;
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
      return;
    }

    socket.emit('message:send', { toId: targetUser.id, type: 'TEXT', text: msg.text });
    clearTimeout(typingTimerRef.current);
    socket.emit('typing:stop', { toId: targetUser.id });
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
    if (mockModeRef.current || !socketRef.current) {
      setMessages(prev => prev.map(m => {
        if (m.id !== msgId) return m;
        const r = { ...m.reactions };
        r[emoji] = (r[emoji] ?? 0) + 1;
        return { ...m, reactions: r };
      }));
      return;
    }
    socketRef.current.emit('reaction:add', { messageId: msgId, emoji, toId: targetUser?.id });
  }, [targetUser]);

  const clearMessages = useCallback(() => setMessages([]), []);

  return { messages, isTyping, sendMessage, notifyTyping, addReaction, clearMessages };
}
