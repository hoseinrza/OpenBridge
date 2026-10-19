import { useState, useEffect, useCallback, useRef } from 'react';
import { io } from 'socket.io-client';
import { fetchMessages, fetchGroupMessages, uploadFile, resolveUrl } from '../services/api.js';

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
    sender:    msg.sender?.displayName ?? msg.sender?.username,
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

function isGroup(target) {
  return target?.kind === 'group';
}

function fetchTargetMessages(target) {
  return isGroup(target) ? fetchGroupMessages(target.id) : fetchMessages(target.id);
}

function readPayload(target) {
  return isGroup(target) ? { conversationId: target.id } : { fromId: target.id };
}

function targetPayload(target) {
  return isGroup(target) ? { conversationId: target.id } : { toId: target.id };
}

export function useChat(targetUser, currentUser, onIncoming) {
  const [messages,  setMessages]  = useState([]);
  const [typingPeer, setTypingPeer] = useState(null);
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
    fetchTargetMessages(target)
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
      if (target) socket.emit('messages:read', readPayload(target));
      refreshHistoryRef.current();
    });
    socket.on('disconnect',    () => setConnected(false));
    socket.on('connect_error', () => setConnected(false));

    socket.on('message:new', (msg) => {
      const target = targetRef.current;
      const me     = currentUserRef.current;
      if (!me) return;

      const belongsToActiveGroup = isGroup(target) && msg.conversationId === target.id;
      const belongsToActiveDirect = !isGroup(target) && target && (
        (msg.senderId === me.id && msg.receiverId === target.id) ||
        (msg.senderId === target.id && msg.receiverId === me.id)
      );

      if (belongsToActiveGroup || belongsToActiveDirect) {
        setMessages(prev => mergeMessages(prev, [normalize(msg, me.id)]));
      }
      if (isGroup(target) && msg.conversationId === target.id && msg.senderId !== me.id) {
        socket.emit('messages:read', { conversationId: target.id });
      } else if (!isGroup(target) && target && msg.senderId === target.id) {
        socket.emit('messages:read', { fromId: target.id });
      }
      // Let the parent know about every incoming message (even ones outside
      // the active conversation) so it can refresh the chat list. Group
      // messages carry no receiverId; direct ones always do.
      if (!msg.receiverId || msg.senderId === me.id || msg.receiverId === me.id) {
        onIncomingRef.current?.(msg);
      }
    });

    socket.on('message:read', ({ conversationId }) => {
      const target = targetRef.current;
      if (conversationId && target?.id !== conversationId) return;
      setMessages(prev => prev.map(m => m.side === 'mine' ? { ...m, read: true } : m));
    });

    socket.on('typing:start', ({ fromId, conversationId }) => {
      const target = targetRef.current;
      if (!target) return;
      if (isGroup(target)) {
        if (conversationId !== target.id || fromId === currentUserRef.current?.id) return;
        const participant = target.participants?.find(p => p.id === fromId);
        setTypingPeer(participant ?? { name: 'یکی از اعضا', avatar: '/images/user.png' });
      } else if (fromId === target.id) {
        setTypingPeer(target);
      }
    });

    socket.on('typing:stop', ({ fromId, conversationId }) => {
      const target = targetRef.current;
      if (!target) return;
      if (isGroup(target)) {
        if (conversationId === target.id) setTypingPeer(null);
      } else if (fromId === target.id) {
        setTypingPeer(null);
      }
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

  // Mark the conversation as read whenever the active chat changes.
  useEffect(() => {
    if (!targetUser || !socketRef.current) return;
    socketRef.current.emit('messages:read', readPayload(targetUser));
  }, [targetUser?.id]);

  // ── Load history ──────────────────────────────────────
  useEffect(() => {
    if (!targetUser || !currentUser) return undefined;
    setMessages([]);
    setTypingPeer(null);

    let cancelled = false;
    fetchTargetMessages(targetUser)
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
          ...targetPayload(targetUser),
          type:     uploaded.type,
          fileUrl:  uploaded.url,
          fileName: uploaded.name,
          fileSize: uploaded.size,
        });
      } catch {}
      return true;
    }

    socket.emit('message:send', { ...targetPayload(targetUser), type: 'TEXT', text: msg.text });
    clearTimeout(typingTimerRef.current);
    socket.emit('typing:stop', targetPayload(targetUser));
    return true;
  }, [targetUser]);

  // ── Typing notification ──────────────────────────────
  const notifyTyping = useCallback(() => {
    if (!socketRef.current || !targetUser) return;
    socketRef.current.emit('typing:start', targetPayload(targetUser));
    clearTimeout(typingTimerRef.current);
    typingTimerRef.current = setTimeout(() => {
      socketRef.current?.emit('typing:stop', targetPayload(targetUser));
    }, 2000);
  }, [targetUser]);

  // ── Reaction ─────────────────────────────────────────
  const addReaction = useCallback((msgId, emoji) => {
    if (!socketRef.current) return;
    socketRef.current.emit('reaction:add', {
      messageId: msgId,
      emoji,
      ...targetPayload(targetUser),
    });
  }, [targetUser]);

  const clearMessages = useCallback(() => setMessages([]), []);

  return {
    messages, isTyping: !!typingPeer, typingPeer,
    connected, sendMessage, notifyTyping, addReaction, clearMessages,
  };
}
