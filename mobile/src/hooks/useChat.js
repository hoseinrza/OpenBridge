import { useCallback, useEffect, useRef, useState } from 'react';
import { fetchMessages, resolveUrl } from '../services/api';
import { useSocket } from '../context/SocketContext';

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
    avatar:    resolveUrl(msg.sender?.avatar),
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

export function useChat(peer, currentUser, onIncoming) {
  const { socket, connected } = useSocket();
  const [messages, setMessages] = useState([]);
  const [isTyping, setIsTyping] = useState(false);
  const typingTimerRef = useRef(null);
  const peerRef        = useRef(peer);
  const currentUserRef = useRef(currentUser);
  const onIncomingRef  = useRef(onIncoming);
  peerRef.current        = peer;
  currentUserRef.current = currentUser;
  onIncomingRef.current  = onIncoming;

  // Pull anything persisted while the socket was down (the server doesn't
  // replay missed messages) and merge it with live state.
  const refreshHistoryRef = useRef(() => {});
  refreshHistoryRef.current = () => {
    const p  = peerRef.current;
    const me = currentUserRef.current;
    if (!p || !me) return;
    fetchMessages(p.id)
      .then(msgs => {
        setMessages(prev => mergeMessages(prev, msgs.map(m => normalize(m, me.id))));
      })
      .catch(() => {});
  };

  // ── Socket listeners (connection itself lives in SocketProvider) ──
  useEffect(() => {
    if (!socket) return undefined;

    const onMessage = (msg) => {
      const p  = peerRef.current;
      const me = currentUserRef.current;
      if (!me) return;

      if (
        p && (
          (msg.senderId === me.id && msg.receiverId === p.id) ||
          (msg.senderId === p.id && msg.receiverId === me.id)
        )
      ) {
        setMessages(prev => mergeMessages(prev, [normalize(msg, me.id)]));
      }
      if (p && msg.senderId === p.id) {
        socket.emit('messages:read', { fromId: p.id });
      }
      if (msg.senderId === me.id || msg.receiverId === me.id) {
        onIncomingRef.current?.(msg);
      }
    };

    const onRead = () => {
      setMessages(prev => prev.map(m => m.side === 'mine' ? { ...m, read: true } : m));
    };

    const onTypingStart = ({ fromId }) => {
      if (fromId === peerRef.current?.id) setIsTyping(true);
    };
    const onTypingStop = ({ fromId }) => {
      if (fromId === peerRef.current?.id) setIsTyping(false);
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
    socket.emit('messages:read', { fromId: peer.id });
  }, [peer?.id, socket]);

  // ── Load history ──────────────────────────────────────
  useEffect(() => {
    if (!peer || !currentUser) return undefined;
    setMessages([]);
    setIsTyping(false);

    let cancelled = false;
    fetchMessages(peer.id)
      .then(msgs => {
        if (!cancelled) {
          setMessages(prev => mergeMessages(prev, msgs.map(m => normalize(m, currentUser.id))));
        }
      })
      .catch(() => {});

    return () => { cancelled = true; };
  }, [peer?.id, currentUser?.id]);

  // ── Send ──────────────────────────────────────────────
  const sendMessage = useCallback((text) => {
    const trimmed = text?.trim();
    if (!trimmed || !socket || !peer) return false;

    socket.emit('message:send', { toId: peer.id, type: 'TEXT', text: trimmed });
    clearTimeout(typingTimerRef.current);
    socket.emit('typing:stop', { toId: peer.id });
    return true;
  }, [socket, peer]);

  // ── Typing notification ──────────────────────────────
  const notifyTyping = useCallback(() => {
    if (!socket || !peer) return;
    socket.emit('typing:start', { toId: peer.id });
    clearTimeout(typingTimerRef.current);
    typingTimerRef.current = setTimeout(() => {
      socket.emit('typing:stop', { toId: peer.id });
    }, 2000);
  }, [socket, peer]);

  // ── Reaction ─────────────────────────────────────────
  const addReaction = useCallback((msgId, emoji) => {
    socket?.emit('reaction:add', { messageId: msgId, emoji, toId: peer?.id });
  }, [socket, peer]);

  return { messages, isTyping, connected, sendMessage, notifyTyping, addReaction };
}
