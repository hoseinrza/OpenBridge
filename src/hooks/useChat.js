import { useCallback, useEffect, useRef, useState } from 'react';
import {
  apiCall, fetchGroupMessages, fetchMessages, resolveUrl, uploadFile,
} from '../services/api.js';
import { uploadEncrypted } from '../services/attachments.js';
import { packAttachment } from '../../shared/e2ee/attachments.js';
import { e2eeConnected, getE2ee, initE2ee, onE2eeConnection } from '../services/e2ee.js';
import { connectSocket, emitWithAck } from '../services/socket.js';

// How a direct conversation is carried on this device:
//   checking     the flag has not been read from the server yet
//   open         MLS group is held here; text is encrypted before it leaves
//   plain        ordinary plaintext, and a reason when encryption was refused
//   unavailable  the conversation is encrypted but this device holds no keys
const timeIn = (value) => new Date(value).toLocaleTimeString('fa-IR', { hour: '2-digit', minute: '2-digit' });

// Reactions arrive as the rows behind them, one per person per message, because
// a chip has to know whether *this* device is one of the people holding it:
// tapping your own reaction removes it and tapping a different emoji replaces
// it. Grouping by emoji keeps the set equal to the people who reacted, never to
// the number of taps — and no count is shown, so a tap can't "add" anything.
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
    id:           msg.id,
    type:         (msg.type ?? 'TEXT').toLowerCase(),
    text:         msg.text ?? '',
    src:          msg.fileUrl ? resolveUrl(msg.fileUrl) : undefined,
    name:         msg.fileName,
    size:         msg.fileSize,
    side:         msg.senderId === myId ? 'mine' : 'other',
    senderId:     msg.senderId,
    receiverId:   msg.receiverId,
    conversationId: msg.conversationId,
    sender:       msg.sender?.displayName ?? msg.sender?.username,
    avatar:       msg.sender?.avatar ? resolveUrl(msg.sender.avatar) : null,
    time:         timeIn(msg.createdAt),
    createdAt:    new Date(msg.createdAt).getTime(),
    read:         msg.read,
    encrypted:    false,
    reactions:    groupReactions(msg.reactions, myId),
  };
}

// A decrypted message carries no profile data, because the server never saw the
// message it belongs to — the active peer supplies the name the bubble shows.
// An attachment carries only a descriptor: the bytes are fetched and opened by
// the bubble itself, so nothing readable is held in this list.
function normalizeEncrypted(message, peer) {
  const created = new Date(message.at).getTime();
  const attachment = message.attachment ?? null;
  return {
    id:             `e2ee-${message.seq}`,
    type:           attachment ? (attachment.mime?.startsWith('image/') ? 'image' : 'file') : 'text',
    text:           message.text,
    attachment,
    name:           attachment?.name ?? null,
    size:           attachment?.size ?? null,
    side:           message.mine ? 'mine' : 'other',
    senderId:       message.senderId,
    conversationId: message.conversationId,
    sender:         message.mine ? undefined : peer?.name,
    avatar:         message.mine ? null : (peer?.avatar ? resolveUrl(peer.avatar) : null),
    time:           timeIn(created),
    createdAt:      created,
    encrypted:      true,
    reactions:      [],
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

// The one answer that means "there is nobody to invite": a peer whose devices
// have never registered key material. Everything else — a broken package, a
// refused group, a missing envelope — is a problem to report, not a reason to
// quietly send readable text.
const peerWithoutKeys = (error) => error?.code === 'no-keys' || error?.status === 404;

export function useChat(targetUser, currentUser, onIncoming) {
  const [messages,     setMessages]     = useState([]);
  const [typingPeer,   setTypingPeer]   = useState(null);
  const [connected,    setConnected]    = useState(false);
  const [secureUp,     setSecureUp]     = useState(() => e2eeConnected());
  const [secure,       setSecure]       = useState(null);
  const [historyState, setHistoryState] = useState('idle'); // idle | loading | ready | error
  const [historyError, setHistoryError] = useState('');
  const [historyNonce, setHistoryNonce] = useState(0);

  const currentUserId  = currentUser?.id;
  const targetId       = targetUser?.id;
  const socketRef      = useRef(null);
  const typingTimerRef = useRef(null);
  const targetRef      = useRef(targetUser);
  const currentUserRef = useRef(currentUser);
  const onIncomingRef  = useRef(onIncoming);
  const secureRef      = useRef(null);
  const openingRef     = useRef(false);
  const refreshHistoryRef = useRef(() => {});
  const encryptedSendRef  = useRef(() => Promise.resolve({ ok: true }));
  const attachmentSendRef = useRef(() => Promise.reject(new Error('رمزنگاری فایل آماده نیست')));

  // Keep refs in sync after render; writing refs during render is unsafe.
  useEffect(() => {
    targetRef.current      = targetUser;
    currentUserRef.current = currentUser;
    onIncomingRef.current  = onIncoming;
    secureRef.current      = secure;

    // Pull anything that was persisted while the socket was down and merge it
    // with live state. Only for conversations carried in plaintext: an encrypted
    // stream catches up through the MLS client, never through the message table.
    refreshHistoryRef.current = () => {
      const target = targetRef.current;
      const me     = currentUserRef.current;
      if (!target || !me) return;
      fetchTargetMessages(target)
        .then(msgs => setMessages(prev => mergeMessages(prev, msgs.map(m => normalize(m, me.id)))))
        .catch(() => {});
    };

    encryptedSendRef.current = async (target, text) => {
      const client = await initE2ee({ id: currentUserRef.current.id });
      const conversationId = secureRef.current?.conversationId
        ?? (await client.openDirect(target.id)).conversationId;
      await client.send(conversationId, text);
      const history = await client.history(conversationId);
      setSecure({ mode: 'open', conversationId, error: null });
      setMessages(prev => mergeMessages(prev, history.map(m => normalizeEncrypted(m, target))));
      clearTimeout(typingTimerRef.current);
      socketRef.current?.emit('typing:stop', targetPayload(target));
      return { ok: true };
    };

    // The order is the safety of this path: the group exists before a byte is
    // uploaded, so a peer with no keys to invite never leaves an orphan blob on
    // the server, and the file is encrypted before anything is sent at all.
    attachmentSendRef.current = async (target, file) => {
      const client = await initE2ee({ id: currentUserRef.current.id });
      const conversationId = secureRef.current?.conversationId
        ?? (await client.openDirect(target.id)).conversationId;
      const { id, key, iv } = await uploadEncrypted(file, conversationId);
      await client.send(conversationId, packAttachment({
        blob: id,
        name: file.name,
        mime: file.type || 'application/octet-stream',
        size: file.size,
        key,
        iv,
      }));
      const history = await client.history(conversationId);
      setSecure({ mode: 'open', conversationId, error: null });
      setMessages(prev => mergeMessages(prev, history.map(m => normalizeEncrypted(m, target))));
      clearTimeout(typingTimerRef.current);
      socketRef.current?.emit('typing:stop', targetPayload(target));
      return { ok: true };
    };
  });

  // ── Socket connection (one per signed-in user, not per conversation) ──
  useEffect(() => {
    const token = localStorage.getItem('chatapp_token');
    if (!token || !currentUserId) return undefined;

    const socket = connectSocket();
    socketRef.current = socket;

    socket.on('connect', () => {
      setConnected(true);
      const target = targetRef.current;
      const status = secureRef.current;
      if (target) socket.emit('messages:read', readPayload(target));
      if (status?.mode === 'open') {
        // An encrypted stream catches up on its own connection, and its read
        // mark is a sequence number rather than a message id.
        getE2ee()?.markRead(status.conversationId).catch(() => {});
      } else if (target) {
        // The plaintext history is behind by whatever arrived while the socket
        // was down, so re-read it.
        refreshHistoryRef.current();
      }
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

    // A read receipt names the person who read it (direct) or the conversation
    // they read (group); an encrypted stream is covered by the same mark, whose
    // meaning is "this peer's device applied everything up to now".
    socket.on('message:read', ({ by, conversationId }) => {
      const target = targetRef.current;
      if (!target) return;
      if (isGroup(target) ? conversationId !== target.id : by !== target.id) return;
      setMessages(prev => prev.map(m => (m.side === 'mine' ? { ...m, read: true } : m)));
    });

    socket.on('typing:start', ({ fromId, conversationId }) => {
      const target = targetRef.current;
      if (!target) return;
      if (isGroup(target)) {
        if (conversationId !== target.id || fromId === currentUserRef.current?.id) return;
        const participant = target.participants?.find(p => p.id === fromId);
        setTypingPeer(participant ?? { name: 'یکی از اعضا', avatar: null });
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

    // The server sends the whole set of rows for the message, never a delta,
    // so removing and replacing a reaction look like every other change.
    socket.on('reaction:changed', ({ messageId, reactions }) => {
      setMessages(prev => prev.map(m => (
        m.id === messageId ? { ...m, reactions: groupReactions(reactions, currentUserId) } : m
      )));
    });

    return () => {
      socket.disconnect();
      socketRef.current = null;
      setConnected(false);
    };
  }, [currentUserId]);

  // ── Encrypted transport status (its own connection, see services/e2ee.js) ──
  useEffect(() => {
    if (!currentUserId) return undefined;
    setSecureUp(e2eeConnected());
    return onE2eeConnection(setSecureUp);
  }, [currentUserId]);

  // ── Decide how this conversation is carried, and join it if it is open ──
  useEffect(() => {
    const target = targetRef.current;
    if (!target || isGroup(target) || !currentUserId) {
      setSecure(null);
      return undefined;
    }

    let cancelled = false;
    setSecure({ mode: 'checking' });
    openingRef.current = true;

    (async () => {
      const client = await initE2ee({ id: currentUserId });
      const probe = await apiCall(`messages/e2ee/direct/${target.id}`);
      if (cancelled) return;
      if (!probe.e2ee || !probe.conversationId) {
        setSecure({ mode: 'plain' });
        return;
      }
      try {
        // Reading the stream is what joins the group: the Welcome is envelope
        // one, so a device that has never seen this chat needs nothing else.
        await client.openDirect(target.id);
        const caught = await client.catchUp(probe.conversationId);
        if (cancelled) return;
        const history = await client.history(probe.conversationId);
        if (cancelled) return;
        setSecure({ mode: 'open', conversationId: probe.conversationId, error: caught.error });
        setMessages(prev => mergeMessages(prev, history.map(m => normalizeEncrypted(m, target))));
      } catch (error) {
        if (cancelled) return;
        setSecure({
          mode: 'unavailable',
          conversationId: probe.conversationId,
          reason: error.message || 'این گفتگو روی این دستگاه رمزگشایی نمی‌شود',
        });
      }
    })().finally(() => {
      openingRef.current = false;
    });

    return () => { cancelled = true; };
  }, [targetId, currentUserId, historyNonce]);

  // ── Decrypted messages that arrive while the chat is open ──
  useEffect(() => {
    if (!currentUserId) return undefined;
    let stop = null;
    initE2ee({ id: currentUserId })
      .then((client) => {
        stop = client.onMessage((incoming) => {
          const target = targetRef.current;
          const status = secureRef.current;
          if (!isGroup(target)) {
            if (status?.conversationId === incoming.conversationId) {
              setMessages(prev => mergeMessages(prev, [normalizeEncrypted(incoming, target)]));
              // Reading it here is the only fact behind a read mark.
              if (!incoming.mine) getE2ee()?.markRead(incoming.conversationId).catch(() => {});
            } else if (status?.mode === 'plain' && !openingRef.current) {
              // The peer encrypted this chat a moment ago; re-probe so the
              // header, the composer and the store agree about it.
              setHistoryNonce(n => n + 1);
            }
          }
          // Encrypted traffic never appears in the plaintext stream, so the
          // chat list is refreshed from here as well.
          onIncomingRef.current?.();
        });
      })
      .catch(() => {});
    return () => stop?.();
  }, [currentUserId]);

  // Mark the conversation as read whenever the active chat changes.
  useEffect(() => {
    const target = targetRef.current;
    if (!target) return;
    if (secure?.mode === 'open') {
      getE2ee()?.markRead(secure.conversationId).catch(() => {});
      return;
    }
    if (secure?.mode === 'unavailable') return;
    if (socketRef.current) socketRef.current.emit('messages:read', readPayload(target));
  }, [targetId, secure]);

  // ── Load the plaintext part of the history ────────────
  useEffect(() => {
    const target = targetRef.current;
    if (!target || !currentUserId) return undefined;

    let cancelled = false;
    setHistoryState('loading');
    setHistoryError('');

    fetchTargetMessages(target)
      .then(msgs => {
        if (cancelled) return;
        setMessages(prev => mergeMessages(prev, msgs.map(m => normalize(m, currentUserId))));
        setHistoryState('ready');
      })
      .catch(err => {
        if (cancelled) return;
        setHistoryState('error');
        setHistoryError(err.message || 'دریافت پیام‌ها ناموفق بود');
      });

    return () => { cancelled = true; };
  }, [targetId, currentUserId, historyNonce]);

  const retryHistory = useCallback(() => setHistoryNonce(n => n + 1), []);

  // ── Send ─────────────────────────────────────────────
  const sendMessage = useCallback(async (payload) => {
    const msg = typeof payload === 'string' ? { type: 'text', text: payload } : payload;
    if (msg.type === 'text' && !msg.text?.trim()) return { ok: false, error: '' };

    const target = targetRef.current;
    if (!target) return { ok: false, error: 'گفتگویی باز نیست' };
    const status = secureRef.current;

    if (status?.mode === 'unavailable') return { ok: false, error: status.reason };
    if (status?.mode === 'checking') {
      // Sending now would put readable text into a conversation the server may
      // already have marked encrypted, which is a send the server must refuse.
      return { ok: false, error: 'لحظه‌ای صبر کن، وضعیت رمزنگاری این گفتگو در حال بررسی است' };
    }
    // A direct text message is encrypted whenever this device can do it, and
    // opening the group is what makes the conversation encrypted for good.
    if (msg.type === 'text' && !isGroup(target)
      && (status?.mode === 'open' || status?.mode === 'plain')) {
      try {
        return await encryptedSendRef.current(target, msg.text.trim());
      } catch (error) {
        if (!peerWithoutKeys(error)) {
          return { ok: false, error: error.message || 'رمزنگاری یا ارسال پیام ناموفق بود' };
        }
        setSecure(prev => ({ ...(prev ?? {}), mode: 'plain', reason: error.message }));
      }
    }

    // A file follows the same rule as text: once the conversation carries
    // envelopes, the bytes are encrypted on this device before they are sent,
    // and there is no plaintext attachment path left to fall back into.
    if (msg._file && (status?.mode === 'open'
      || (!isGroup(target) && status?.mode === 'plain'))) {
      try {
        return await attachmentSendRef.current(target, msg._file);
      } catch (error) {
        if (!peerWithoutKeys(error)) {
          return { ok: false, error: error.message || 'رمزنگاری یا ارسال فایل ناموفق بود' };
        }
        setSecure(prev => ({ ...(prev ?? {}), mode: 'plain', reason: error.message }));
      }
    }

    const socket = socketRef.current;
    if (!socket?.connected) {
      return { ok: false, error: 'اتصال به سرور برقرار نیست؛ چند لحظه بعد دوباره تلاش کن' };
    }

    if (msg._file) {
      let uploaded;
      try {
        uploaded = await uploadFile(msg._file);
      } catch (err) {
        return { ok: false, error: err.message || 'آپلود فایل ناموفق بود' };
      }
      try {
        await emitWithAck(socket, 'message:send', {
          ...targetPayload(target),
          type:     uploaded.type,
          fileUrl:  uploaded.url,
          fileName: uploaded.name,
          fileSize: uploaded.size,
        });
      } catch (err) {
        return { ok: false, error: err.message };
      }
      return { ok: true };
    }

    try {
      await emitWithAck(socket, 'message:send', {
        ...targetPayload(target),
        type: 'TEXT',
        text: msg.text.trim(),
      });
    } catch (err) {
      return { ok: false, error: err.message };
    }

    clearTimeout(typingTimerRef.current);
    socket.emit('typing:stop', targetPayload(target));
    return { ok: true };
  }, []);

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
  // One tap adds, a second tap on the same emoji removes it, and a different
  // emoji replaces it. The server makes that decision and broadcasts the
  // resulting rows back to every participant, this device included.
  const toggleReaction = useCallback((msgId, emoji) => {
    if (!socketRef.current) return;
    socketRef.current.emit('reaction:add', {
      messageId: msgId,
      emoji,
      ...targetPayload(targetUser),
    });
  }, [targetUser]);

  const clearMessages = useCallback(() => {
    setMessages([]);
    setTypingPeer(null);
    setSecure(null);
    setHistoryState('idle');
    setHistoryError('');
  }, []);

  const open = secure?.mode === 'open';
  const unavailable = secure?.mode === 'unavailable' ? secure.reason : null;
  // Which connection a send needs depends on how this conversation is carried,
  // so the composer waits for the right one instead of the chat socket alone.
  const transportUp = open ? secureUp : connected;

  return {
    messages, isTyping: !!typingPeer, typingPeer,
    connected: transportUp,
    historyState: secure?.mode === 'checking' ? 'loading' : (unavailable ? 'error' : historyState),
    historyError: unavailable ?? historyError,
    retryHistory,
    encrypted: open,
    // The notice at the top of a chat says different things for a chat that is
    // encrypted, one that will be on the first send, and one that cannot be.
    secureMode: secure?.mode ?? null,
    // Why a chat that could be encrypted is not, shown whenever it is not.
    encryptionNote: secure?.mode === 'plain' ? (secure.reason ?? null) : null,
    blockedReason: unavailable,
    sendMessage, notifyTyping, toggleReaction, clearMessages,
  };
}
