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
  const quote = msg.replyTo;
  return {
    id:           msg.id,
    type:         (msg.type ?? 'TEXT').toLowerCase(),
    text:         msg.text ?? '',
    src:          msg.fileUrl ? resolveUrl(msg.fileUrl) : undefined,
    // Kept beside the signed address because forwarding re-sends this row as a
    // new message, and the server signs the stored path for the new chat.
    fileUrl:      msg.fileUrl ?? null,
    name:         msg.fileName,
    size:         msg.fileSize,
    // What the sender's microphone said its own recording lasted. A bubble reads
    // this number instead of asking the container, which is the one field a
    // browser-written voice file is not certain to carry.
    durationMs:   Number.isInteger(msg.durationMs) ? msg.durationMs : null,
    // A stored row has nowhere to keep a waveform, so a plaintext recording draws
    // a pattern instead. Only an encrypted sender can carry the real bars.
    peaks:        null,
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
    editedAt:     msg.editedAt ? new Date(msg.editedAt).getTime() : null,
    // The quote is a snapshot the server joined into this row, so opening a
    // chat never needs a second request per reply.
    reply:        quote
      ? {
        id:         quote.id,
        senderName: quote.sender?.name ?? null,
        preview:    quote.deleted
          ? 'پیام حذف شد'
          : (quote.text || quote.fileName || 'پیام'),
        type:       (quote.type ?? 'TEXT').toLowerCase(),
        deleted:    Boolean(quote.deleted),
      }
      : null,
    forwardedFrom: msg.forwardedFrom ?? null,
    reactions:    groupReactions(msg.reactions, myId),
  };
}

// A message deleted for everyone is still a row on the server, with its content
// removed, because another device may want to say so. This client says nothing:
// the row is dropped as it is read, so no placeholder is ever drawn and a
// reload of the same chat gives back the same timeline it had before the
// message existed.
function fromServer(msgs, myId) {
  return msgs.filter(m => !m.deleted).map(m => normalize(m, myId));
}

// How long a deleted row is kept mounted while it collapses. It has to outlast
// the exit animation the bubble runs — one `--dur`, currently 180ms — or the row
// would be gone before the messages under it had slid up into its place.
const MESSAGE_EXIT_MS = 240;

// A decrypted message carries no profile data, because the server never saw the
// message it belongs to — the active peer supplies the name the bubble shows.
// An attachment carries only a descriptor: the bytes are fetched and opened by
// the bubble itself, so nothing readable is held in this list.
// Which bubble an opened attachment draws. The rule is the MIME type the sender
// wrote into its own descriptor, because an encrypted conversation gives the
// server nothing to go on but those bytes — except for a recording, where even
// the MIME lies: a voice note and a song are both audio. Only the flag the
// sender's own microphone set can tell them apart here; a descriptor that predates
// the flag is told apart by its length, which is what isRecording reads.
function attachmentKind(mime, voice) {
  if (voice) return 'voice';
  if (mime?.startsWith('image/')) return 'image';
  if (mime?.startsWith('audio/')) return 'audio';
  return 'file';
}

function normalizeEncrypted(message, peer) {
  const created = new Date(message.at).getTime();
  const attachment = message.attachment ?? null;
  // A group message names a participant, not the conversation; a direct one is
  // always from the single peer on the other side.
  const author = isGroup(peer)
    ? peer?.participants?.find(p => p.id === message.senderId)
    : peer;
  return {
    id:             `e2ee-${message.seq}`,
    // The sequence is the encrypted row's identity. Editing, deleting and
    // quoting all address a message by it, because the server holds no id.
    seq:            message.seq,
    type:           attachment ? attachmentKind(attachment.mime, attachment.voice) : 'text',
    text:           message.text,
    attachment,
    name:           attachment?.name ?? null,
    size:           attachment?.size ?? null,
    durationMs:     attachment?.durationMs ?? null,
    peaks:          attachment?.peaks ?? null,
    side:           message.mine ? 'mine' : 'other',
    senderId:       message.senderId,
    conversationId: message.conversationId,
    sender:         message.mine ? undefined : author?.name,
    avatar:         message.mine ? null : (author?.avatar ? resolveUrl(author.avatar) : null),
    time:           timeIn(created),
    createdAt:      created,
    encrypted:      true,
    editedAt:       message.editedAt ? new Date(message.editedAt).getTime() : null,
    // The quote and the forward label travel inside the ciphertext, so they are
    // decoded from the same payload the text came from rather than joined by
    // the server.
    reply:          message.reply ?? null,
    forwardedFrom:  message.forward?.fromName ?? null,
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

// Whether a plaintext row belongs to the chat currently open here. A group is
// named by its conversation id; a direct chat by its two accounts, because in
// that case the open target is a user id rather than a conversation id.
// Every live update that carries a whole message is checked with this, or an
// edit in a chat nobody is looking at would be merged into the wrong list.
function inActiveChat(target, me, msg) {
  if (!target || !me) return false;
  if (isGroup(target)) return msg.conversationId === target.id;
  return (msg.senderId === me.id && msg.receiverId === target.id)
    || (msg.senderId === target.id && msg.receiverId === me.id);
}

// The one answer that means "there is nobody to invite": a peer whose devices
// have never registered key material. Everything else — a broken package, a
// refused group, a missing envelope — is a problem to report, not a reason to
// quietly send readable text.
const peerWithoutKeys = (error) => error?.code === 'no-keys' || error?.status === 404;

// An encrypted row has no server id, so its bubble id carries the sequence the
// controls address. Anything else is a plaintext id.
const encryptedSeq = (id) => {
  const match = /^e2ee-(\d+)$/.exec(id ?? '');
  return match ? Number(match[1]) : null;
};

export function useChat(targetUser, currentUser, onIncoming, onGroupUpdated, onConversationDeleted) {
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
  const onGroupUpdatedRef = useRef(onGroupUpdated);
  const onConversationDeletedRef = useRef(onConversationDeleted);
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
    onGroupUpdatedRef.current = onGroupUpdated;
    onConversationDeletedRef.current = onConversationDeleted;
    secureRef.current      = secure;

    // Pull anything that was persisted while the socket was down and merge it
    // with live state. Only for conversations carried in plaintext: an encrypted
    // stream catches up through the MLS client, never through the message table.
    refreshHistoryRef.current = () => {
      const target = targetRef.current;
      const me     = currentUserRef.current;
      if (!target || !me) return;
      fetchTargetMessages(target)
        .then(msgs => setMessages(prev => mergeMessages(prev, fromServer(msgs, me.id))))
        .catch(() => {});
    };

    encryptedSendRef.current = async (target, text, extra = {}, active = true) => {
      const client = await initE2ee({ id: currentUserRef.current.id });
      const held = active ? secureRef.current?.conversationId : null;
      const opened = held
        ? null
        : await (isGroup(target) ? client.openGroup(target.id) : client.openDirect(target.id));
      // A group is encrypted for its whole life or not at all; an ordinary one
      // has no group state here, so the caller falls back to the plaintext path
      // instead of trying to encrypt into a conversation that never joined one.
      if (!held && opened && opened.e2ee === false) return { ok: false, notEncrypted: true };
      const conversationId = held ?? opened.conversationId;
      await client.send(conversationId, {
        text,
        reply: extra.reply ?? null,
        forward: extra.forward ?? null,
      });
      const history = await client.history(conversationId);
      if (active) {
        setSecure({ mode: 'open', conversationId, error: null });
        setMessages(prev => mergeMessages(prev, history.map(m => normalizeEncrypted(m, target))));
        clearTimeout(typingTimerRef.current);
        socketRef.current?.emit('typing:stop', targetPayload(target));
      }
      return { ok: true };
    };

    // The order is the safety of this path: the group exists before a byte is
    // uploaded, so a peer with no keys to invite never leaves an orphan blob on
    // the server, and the file is encrypted before anything is sent at all.
    attachmentSendRef.current = async (target, file, durationMs, voice, peaks, extra = {}) => {
      const client = await initE2ee({ id: currentUserRef.current.id });
      const opened = secureRef.current?.conversationId
        ? null
        : await (isGroup(target) ? client.openGroup(target.id) : client.openDirect(target.id));
      const conversationId = secureRef.current?.conversationId ?? opened.conversationId;
      const { id, key, iv } = await uploadEncrypted(file, conversationId);
      await client.send(conversationId, packAttachment({
        blob: id,
        name: file.name,
        mime: file.type || 'application/octet-stream',
        size: file.size,
        // Travels inside the envelope rather than as a row: an encrypted
        // conversation has no message table entry for the server to measure.
        durationMs: durationMs ?? null,
        // The same reason the length is here rather than on a row. A descriptor
        // that says nothing about its origin reads as an uploaded file, which is
        // why the composer has to say «microphone» out loud.
        voice: voice === true,
        // The bars the composer's bubble will draw. They ride inside the envelope
        // for the same reason the length does: the server is never told what this
        // recording looked like, so it cannot be a column on a row.
        peaks: peaks ?? null,
        key,
        iv,
        reply: extra.reply ?? null,
        forward: extra.forward ?? null,
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

      const belongsToActive = inActiveChat(target, me, msg);

      if (belongsToActive) {
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
      // A receipt names the account that read. This tab's own mark reaches it
      // too (group reads are broadcast to every participant), and it must not
      // turn the sender's own ticks green.
      if (by === currentUserRef.current?.id) return;
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

    // An edit or a delete changes a row already on screen. The server is the
    // author of both, so nothing is drawn until its broadcast arrives — and the
    // broadcast reaches this device too, which is why a second device of the
    // same account converges without a reload.
    socket.on('message:edited', (msg) => {
      const target = targetRef.current;
      const me     = currentUserRef.current;
      // The sidebar previews the last message of every chat, and an edit or a
      // delete changes what that is — including in a chat nobody has open.
      onIncomingRef.current?.();
      if (!inActiveChat(target, me, msg)) return;
      setMessages(prev => mergeMessages(prev, [normalize(msg, me.id)]));
    });

    // A delete takes the row out of the timeline, on every device and in both
    // scopes: "for everyone" removes it for everybody, "for me" hides it for
    // this account alone. What is left on the server is not drawn — the row
    // collapses where it stood and the messages under it close the gap.
    socket.on('message:deleted', ({ messageId, conversationId, scope }) => {
      onIncomingRef.current?.();
      setMessages(prev => prev.map(m => (
        // "For me" reaches only this account's own devices, and one of them may
        // not be looking at this chat, so the id alone is enough to find it. An
        // "everyone" delete reaches the whole conversation, so the row has to
        // belong to the chat on screen: a delete in one chat must not empty a
        // row of another.
        m.id === messageId && (scope === 'me' || m.conversationId === conversationId)
          ? { ...m, leaving: true }
          : m
      )));
      // The list owns how long the collapsed row stays mounted, so the removal
      // is timed here rather than left to the bubble's animation event — a row
      // whose animation never runs (a background tab, reduced motion) still
      // goes away.
      setTimeout(() => {
        setMessages(prev => prev.filter(m => !(m.id === messageId && m.leaving)));
      }, MESSAGE_EXIT_MS);
    });

    // A group's name, photo and bio are server metadata, so an edit made on any
    // member's device arrives as the whole row rather than a delta.
    socket.on('group:updated', (group) => onGroupUpdatedRef.current?.(group));

    // The other side deleted the chat. Drop the row from the list, and if this
    // window is showing it, close it rather than leave a transcript whose
    // conversation no longer exists.
    socket.on('conversation:deleted', ({ conversationId, memberIds, byId }) => {
      onIncomingRef.current?.();
      onConversationDeletedRef.current?.({ conversationId, memberIds: memberIds ?? [], byId });
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
    if (!target || !currentUserId) {
      setSecure(null);
      return undefined;
    }

    let cancelled = false;
    setSecure({ mode: 'checking' });
    openingRef.current = true;

    (async () => {
      const client = await initE2ee({ id: currentUserId });
      const group = isGroup(target);
      try {
        let conversationId;
        let streamError = null;

        if (group) {
          // A group is ciphertext for its whole life or not at all, so this is
          // a read of an existing MLS group, never a negotiation.
          const opened = await client.openGroup(target.id);
          if (cancelled) return;
          if (!opened.e2ee) {
            setSecure({ mode: 'plain' });
            return;
          }
          conversationId = opened.conversationId;
          streamError = opened.error;
          if (!opened.open && !streamError) {
            throw new Error('این گروه هنوز روی این دستگاه باز نشده است');
          }
        } else {
          const probe = await apiCall(`messages/e2ee/direct/${target.id}`);
          if (cancelled) return;
          if (!probe.e2ee || !probe.conversationId) {
            setSecure({ mode: 'plain' });
            return;
          }
          // Reading the stream is what joins the group: the Welcome is envelope
          // one, so a device that has never seen this chat needs nothing else.
          await client.openDirect(target.id);
          conversationId = probe.conversationId;
        }

        const caught = await client.catchUp(conversationId);
        if (cancelled) return;
        const history = await client.history(conversationId);
        if (cancelled) return;
        setSecure({ mode: 'open', conversationId, error: caught.error ?? streamError });
        setMessages(prev => mergeMessages(prev, history.map(m => normalizeEncrypted(m, target))));
      } catch (error) {
        if (cancelled) return;
        setSecure({
          mode: 'unavailable',
          conversationId: target.id,
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

          // An edit or a delete never adds a row: it changes the row it names.
          // The collapse is the same one a plaintext delete runs, so the two
          // kinds of conversation leave the timeline the same way.
          if (incoming.kind === 'control') {
            if (target && status?.conversationId === incoming.conversationId) {
              const messageId = `e2ee-${incoming.targetSeq}`;
              if (incoming.op === 'edit') {
                const at = new Date(incoming.at).getTime();
                setMessages(prev => prev.map(m => (m.id === messageId
                  ? { ...m, text: incoming.text, editedAt: at }
                  : m)));
              } else {
                setMessages(prev => prev.map(m => (m.id === messageId ? { ...m, leaving: true } : m)));
                setTimeout(() => {
                  setMessages(prev => prev.filter(m => !(m.id === messageId && m.leaving)));
                }, MESSAGE_EXIT_MS);
              }
            }
            // A control in a chat nobody is looking at still changes that
            // chat's preview and its place in the list.
            onIncomingRef.current?.();
            return;
          }

          if (target && status?.conversationId === incoming.conversationId) {
            setMessages(prev => mergeMessages(prev, [normalizeEncrypted(incoming, target)]));
            // Reading it here is the only fact behind a read mark.
            if (!incoming.mine) getE2ee()?.markRead(incoming.conversationId).catch(() => {});
          } else if (status?.mode === 'plain' && !openingRef.current
            && (!isGroup(target) || incoming.conversationId === target.id)) {
            // The conversation was encrypted a moment ago (a direct chat by the
            // first message, a group by its owner); re-probe so the header, the
            // composer and the store agree about it.
            setHistoryNonce(n => n + 1);
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
        setMessages(prev => mergeMessages(prev, fromServer(msgs, currentUserId)));
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
  // `targetOverride` exists for forwarding: the same message is sent to a chat
  // that is not the one on screen, so encryption is worked out for that
  // destination instead of the active chat's state.
  const sendMessage = useCallback(async (payload, targetOverride = null) => {
    const msg = typeof payload === 'string' ? { type: 'text', text: payload } : payload;
    if (msg.type === 'text' && !msg.text?.trim()) return { ok: false, error: '' };

    const target = targetOverride ?? targetRef.current;
    if (!target) return { ok: false, error: 'گفتگویی باز نیست' };
    const active = targetRef.current?.id === target.id;
    const status = active ? secureRef.current : null;
    const extra = { reply: msg.reply ?? null, forward: msg.forward ?? null };

    if (active) {
      if (status?.mode === 'unavailable') return { ok: false, error: status.reason };
      if (status?.mode === 'checking') {
        // Sending now would put readable text into a conversation the server may
        // already have marked encrypted, which is a send the server must refuse.
        return { ok: false, error: 'لحظه‌ای صبر کن، وضعیت رمزنگاری این گفتگو در حال بررسی است' };
      }
    }

    // Text is encrypted whenever this device holds the conversation's keys. A
    // plaintext direct chat is negotiated into one by sending; a group is only
    // ever encrypted by its creator, so a plaintext group stays plaintext. A
    // destination that is not on screen is probed, and its answer decides.
    if (msg.type === 'text' && (!active || status?.mode === 'open'
      || (!isGroup(target) && status?.mode === 'plain'))) {
      try {
        const result = await encryptedSendRef.current(target, msg.text.trim(), extra, active);
        if (!result?.notEncrypted) return result;
      } catch (error) {
        if (!peerWithoutKeys(error) || isGroup(target)) {
          return { ok: false, error: error.message || 'رمزنگاری یا ارسال پیام ناموفق بود' };
        }
        if (active) setSecure(prev => ({ ...(prev ?? {}), mode: 'plain', reason: error.message }));
      }
    }

    // A file follows the same rule as text: once the conversation carries
    // envelopes, the bytes are encrypted on this device before they are sent,
    // and there is no plaintext attachment path left to fall back into.
    if (msg._file && active && (status?.mode === 'open'
      || (!isGroup(target) && status?.mode === 'plain'))) {
      try {
        return await attachmentSendRef.current(
          target, msg._file, msg.durationMs, msg.type === 'voice', msg.peaks, extra,
        );
      } catch (error) {
        if (!peerWithoutKeys(error) || isGroup(target)) {
          return { ok: false, error: error.message || 'رمزنگاری یا ارسال فایل ناموفق بود' };
        }
        setSecure(prev => ({ ...(prev ?? {}), mode: 'plain', reason: error.message }));
      }
    }

    const socket = socketRef.current;
    if (!socket?.connected) {
      return { ok: false, error: 'اتصال به سرور برقرار نیست؛ چند لحظه بعد دوباره تلاش کن' };
    }

    // A quote is a server row id; the id of an encrypted message is a local
    // sequence and means nothing to the message table. When a send has fallen
    // back to plaintext the quote is dropped rather than pointed at nothing.
    const replyToId = msg.reply && encryptedSeq(msg.reply.id) === null
      ? msg.reply.id
      : undefined;
    const forwardedFrom = msg.forward?.fromName ?? undefined;

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
          // The upload only knows what the bytes look like, and a recording looks
          // like any other audio file. What the composer asked for wins.
          type:     msg.type === 'voice' ? 'VOICE' : uploaded.type,
          fileUrl:  uploaded.url,
          fileName: uploaded.name,
          fileSize: uploaded.size,
          durationMs: msg.durationMs ?? null,
          replyToId,
          forwardedFrom,
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
        replyToId,
        forwardedFrom,
      });
    } catch (err) {
      return { ok: false, error: err.message };
    }

    if (active) {
      clearTimeout(typingTimerRef.current);
      socket.emit('typing:stop', targetPayload(target));
    }
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

  // ── Editing and deleting a message the server stores ─────
  // Both wait for the ack, so a refusal leaves the bubble untouched. The change
  // itself then arrives through `message:edited` / `message:deleted`, which is
  // the same path a peer's device sees — this device is never special-cased, so
  // the two can't drift.
  const editMessage = useCallback(async (msgId, text) => {
    const value = typeof text === 'string' ? text.trim() : '';
    if (!value) return { ok: false, error: 'متن ویرایش خالی است' };

    // An encrypted row is rewritten by a control envelope, because the server
    // holds no readable text to replace.
    const seq = encryptedSeq(msgId);
    if (seq !== null) {
      const status = secureRef.current;
      const client = getE2ee();
      if (status?.mode !== 'open' || !status.conversationId || !client) {
        return { ok: false, error: 'کلیدهای این گفتگو در دسترس نیست؛ پیام ویرایش نشد' };
      }
      try {
        await client.editMessage(status.conversationId, seq, value);
      } catch (err) {
        return { ok: false, error: err.message || 'ویرایش پیام ناموفق بود' };
      }
      return { ok: true };
    }

    const socket = socketRef.current;
    if (!socket?.connected) {
      return { ok: false, error: 'اتصال به سرور برقرار نیست؛ پیام ویرایش نشد' };
    }
    try {
      await emitWithAck(socket, 'message:edit', { messageId: msgId, text: value });
    } catch (err) {
      return { ok: false, error: err.message || 'ویرایش پیام ناموفق بود' };
    }
    return { ok: true };
  }, []);

  const deleteMessage = useCallback(async (msgId, scope) => {
    const seq = encryptedSeq(msgId);
    if (seq !== null) {
      const status = secureRef.current;
      const client = getE2ee();
      if (status?.mode !== 'open' || !status.conversationId || !client) {
        return { ok: false, error: 'کلیدهای این گفتگو در دسترس نیست؛ پیام حذف نشد' };
      }
      try {
        await client.deleteMessage(status.conversationId, seq, scope);
      } catch (err) {
        return { ok: false, error: err.message || 'حذف پیام ناموفق بود' };
      }
      return { ok: true };
    }

    const socket = socketRef.current;
    if (!socket?.connected) {
      return { ok: false, error: 'اتصال به سرور برقرار نیست؛ پیام حذف نشد' };
    }
    try {
      await emitWithAck(socket, 'message:delete', { messageId: msgId, scope });
    } catch (err) {
      return { ok: false, error: err.message || 'حذف پیام ناموفق بود' };
    }
    return { ok: true };
  }, []);

  // ── Forward ──────────────────────────────────────────
  // The destination decides how the copy travels: the same send path is used,
  // so a message forwarded into an encrypted chat is encrypted there, and one
  // forwarded into a plaintext chat stays plaintext. A file cannot cross that
  // line: an encrypted attachment's bytes are only readable inside its own
  // conversation, so forwarding one is refused instead of silently broken.
  const forwardMessage = useCallback(async (message, target) => {
    if (!message || !target) return { ok: false, error: 'گفتگوی مقصد مشخص نیست' };
    if (message.leaving) return { ok: false, error: '' };
    const me = currentUserRef.current;
    const sourceName = message.side === 'mine'
      ? (me?.name || me?.displayName || me?.username || null)
      : (message.sender || null);

    if (message.type === 'text') {
      const result = await sendMessage({
        type: 'text',
        text: message.text,
        forward: sourceName ? { fromName: sourceName } : null,
      }, target);
      // A plaintext send announces itself through `message:new`; an encrypted
      // one is its own echo and is skipped, so the destination's preview is
      // refreshed here instead.
      if (result.ok) onIncomingRef.current?.();
      return result;
    }

    if (message.attachment || !message.fileUrl) {
      return { ok: false, error: 'پیوست‌های رمزنگاری‌شده را نمی‌شود فروارد کرد' };
    }

    const client = await initE2ee({ id: currentUserRef.current?.id }).catch(() => null);
    let destinationEncrypted;
    try {
      destinationEncrypted = isGroup(target)
        ? (await client?.openGroup(target.id))?.e2ee === true
        : (await apiCall(`messages/e2ee/direct/${target.id}`))?.e2ee === true;
    } catch {
      return { ok: false, error: 'وضعیت رمزنگاری گفتگوی مقصد بررسی نشد؛ فایل فروارد نشد' };
    }
    if (destinationEncrypted) {
      return { ok: false, error: 'فایل‌ها به گفتگوی رمزنگاری‌شده فروارد نمی‌شوند' };
    }

    const socket = socketRef.current;
    if (!socket?.connected) {
      return { ok: false, error: 'اتصال به سرور برقرار نیست؛ پیام فروارد نشد' };
    }
    try {
      await emitWithAck(socket, 'message:send', {
        ...targetPayload(target),
        type: message.type === 'voice' ? 'VOICE' : message.type.toUpperCase(),
        fileUrl: message.fileUrl,
        fileName: message.name,
        fileSize: message.size,
        durationMs: message.durationMs ?? null,
        forwardedFrom: sourceName ?? undefined,
      });
    } catch (err) {
      return { ok: false, error: err.message || 'فروارد پیام ناموفق بود' };
    }
    onIncomingRef.current?.();
    return { ok: true };
  }, [sendMessage]);

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
    sendMessage, forwardMessage, notifyTyping, toggleReaction, editMessage, deleteMessage, clearMessages,
  };
}
