import { createE2eeClient } from '../../shared/e2ee/client.js';
import { indexedDbStore } from '../../shared/e2ee/stores.js';
import { apiCall } from './api.js';
import { connectSocket, emitWithAck } from './socket.js';

// The web half of end-to-end encryption.
//
// Everything protocol-shaped lives in shared/e2ee so the phone can run the same
// code; this file supplies the two things only a browser has — a persistent
// place for private keys, and a connection that carries opaque envelopes — and
// keeps exactly one client alive per tab.
//
// The envelope connection is deliberately not the chat hook's socket: a message
// for a chat that is not on screen still has to reach its ratchet in order, so
// the pipeline cannot start and stop with a component.
//
// Signing out does not erase the key store. The same browser signing in again is
// the same device, and throwing its keys away would make every conversation it
// has ever joined permanently unreadable — so only the in-memory client goes.

let state = null;
let starting = null;

function makeTransport(socket) {
  return {
    api: (path, options = {}) => apiCall(path, options),
    append: (conversationId, content, kind = 'MESSAGE') =>
      emitWithAck(socket, 'e2ee:append', { conversationId, content, kind }, 20000),
    fetchEnvelopes: (conversationId, afterSeq, take) =>
      apiCall(`messages/${conversationId}/envelopes?afterSeq=${afterSeq}&take=${take}`),
    markRead: (conversationId, upToSeq) => emitWithAck(socket, 'e2ee:read', { conversationId, upToSeq }),
    onEnvelope: (handler) => {
      socket.on('e2ee:envelope', handler);
      return () => socket.off('e2ee:envelope', handler);
    },
  };
}

/**
 * The client for the signed-in account, created once per tab. A different
 * account gets its own database and its own device id, so one account can never
 * read another's records out of the same browser.
 */
export function initE2ee(me) {
  if (state?.me.id === me?.id) return Promise.resolve(state.client);
  if (!me?.id) return Promise.reject(new Error('برای رمزنگاری باید وارد حساب خود شوید'));
  if (starting) return starting;

  starting = (async () => {
    const previous = state;
    const socket = connectSocket();
    const client = await createE2eeClient({
      store: indexedDbStore({ name: `openbridge-e2ee-${me.id}` }),
      transport: makeTransport(socket),
      me,
      label: 'web',
    });
    socket.on('connect', () => {
      // Envelopes are not replayed after a disconnect, and a missed one stops a
      // conversation's stream, so every chat is walked, not only the visible one.
      void catchUpAll();
    });
    if (previous) {
      previous.client.close();
      previous.socket.disconnect();
    }
    state = { me, client, socket };
    return client;
  })().finally(() => { starting = null; });

  return starting;
}

/** The live client, or null while nobody is signed in. */
export function getE2ee() {
  return state?.client ?? null;
}

/**
 * Derives the media key for one call, or null when the conversation is not
 * end-to-end encrypted. The key stays on this device; only the fingerprint is
 * sent, and the server compares fingerprints rather than keys.
 */
export async function exportCallKey(me, chat, callId) {
  const client = await initE2ee(me);
  if (chat?.kind === 'group') {
    return client.exportCallKeyForGroup(chat.conversationId ?? chat.id, callId);
  }
  return client.exportCallKeyForPeer(chat.id, callId);
}

// ── Legacy history backfill ──────────────────────────────────────────────
//
// New messages no longer travel over MLS, but the envelopes written before the
// switch are still the only copy of that history. A device holding a
// conversation's old keys is the only thing that can turn them into text, so it
// hands them back once: the server stores each row sealed like any other and
// marks the envelope, and from then on every signed-in device reads that part
// of the conversation.
//
// This is best-effort by design. Envelopes this device cannot read stay pending
// — the server reports them — and another device can finish the job later.
// Nothing is dropped because one device happened to be missing keys.

const IMPORT_BATCH = 100;
const IMPORT_PAGES = 50;

// The same rule the bubble uses, so an imported recording lands on the same
// shelf it had before: the sender's own flag first, then the MIME it declared.
function attachmentType(attachment) {
  if (attachment.voice === true) return 'voice';
  if (attachment.mime?.startsWith('image/')) return 'image';
  if (attachment.mime?.startsWith('video/')) return 'video';
  if (attachment.mime?.startsWith('audio/')) return 'audio';
  return 'file';
}

function quotedSeq(quote) {
  const match = /^e2ee-(\d+)$/.exec(quote?.id ?? '');
  return match ? Number(match[1]) : null;
}

function importItem(entry) {
  const attachment = entry.attachment ?? null;
  const quote = attachment?.reply ?? entry.reply ?? null;
  const forward = entry.forward ?? attachment?.forward ?? null;
  if (!attachment && !entry.text) return null;

  const item = { seq: entry.seq };
  if (attachment) {
    item.type = attachmentType(attachment);
    // The descriptor travels whole: a reader still fetches and decrypts the
    // file itself, and the key never exists outside this request's ciphertext
    // and the members' devices.
    item.attachment = {
      blob:       attachment.blob,
      name:       attachment.name ?? '',
      mime:       attachment.mime ?? 'application/octet-stream',
      size:       attachment.size ?? null,
      durationMs: attachment.durationMs ?? null,
      voice:      attachment.voice === true,
      peaks:      attachment.peaks ?? null,
      key:        attachment.key,
      iv:         attachment.iv,
      ...(quote ? { reply: quote } : {}),
      ...(forward ? { forward } : {}),
    };
  } else {
    item.type = 'text';
    item.text = entry.text;
  }

  const replyToSeq = quotedSeq(quote);
  if (replyToSeq !== null) item.replyToSeq = replyToSeq;
  if (forward?.fromName) item.forwardedFrom = forward.fromName;
  return item;
}

/**
 * Hands back everything this device decrypted from a conversation's legacy
 * stream. Returns how much was stored and how many envelopes remain pending.
 */
export async function backfillLegacy(me, conversationId) {
  const client = await initE2ee(me);
  const totals = { imported: 0, skipped: 0, rejected: 0, pending: null };
  let afterSeq = 0;

  for (let page = 0; page < IMPORT_PAGES; page += 1) {
    const status = await apiCall(
      `messages/${conversationId}/legacy-status?afterSeq=${afterSeq}&take=${IMPORT_BATCH}`,
    );
    if (!status.seqs?.length) break;

    const held = new Map((await client.history(conversationId)).map(entry => [entry.seq, entry]));
    const items = status.seqs
      .map(seq => held.get(seq))
      .filter(Boolean)
      .map(importItem)
      .filter(Boolean);

    if (items.length) {
      const result = await apiCall(`messages/${conversationId}/legacy-import`, {
        method: 'POST',
        body:   { items },
      });
      totals.imported += result.imported ?? 0;
      totals.skipped  += result.skipped ?? 0;
      totals.rejected += result.rejected ?? 0;
    }

    if (!status.nextAfterSeq) break;
    afterSeq = status.nextAfterSeq;
  }

  // Ask once more so the chat can say how much is still only ciphertext instead
  // of implying everything finished just because this pass ended.
  const remaining = await apiCall(`messages/${conversationId}/legacy-status?take=1`);
  totals.pending = remaining.pending ?? null;
  return totals;
}

/** Walk every conversation this device holds keys for; returns the ones that stalled. */
export async function catchUpAll() {
  const current = state;
  if (!current) return [];
  const held = await current.client.conversations();
  const stalled = [];
  for (const entry of held) {
    if (!entry.open) continue;
    const { error } = await current.client.catchUp(entry.id);
    if (error) stalled.push({ conversationId: entry.id, ...error });
  }
  return stalled;
}

export function closeE2ee() {
  const previous = state;
  state = null;
  if (!previous) return;
  previous.client.close();
  previous.socket.disconnect();
}
