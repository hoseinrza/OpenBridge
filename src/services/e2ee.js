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
