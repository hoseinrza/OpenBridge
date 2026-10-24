// The shape of an encrypted attachment, shared by every client.
//
// A file never passes through this module. The sender encrypts it on its own
// device, uploads opaque bytes, and then puts a small JSON descriptor into the
// MLS message: which blob holds the ciphertext, what the sender called it, and
// the AES key and nonce that open it. That descriptor is what this file writes
// and reads, so a phone has to be able to open what a browser wrote — which is
// also why it uses nothing but JSON, base64 and the checks below.
//
// The key and nonce are base64 of exactly 32 and 12 bytes: AES-256-GCM with a
// 96-bit nonce, the one combination every platform's authenticated encryption
// offers and the only one this format will accept.
import { fromBase64 } from './wire.js';

export const ATTACHMENT_MARKER = 'openbridge.attachment.v1';

const KEY_BYTES = 32;
const NONCE_BYTES = 12;
const BLOB_ID = /^[0-9a-f]{8}(-[0-9a-f]{4}){3}-[0-9a-f]{12}$/;
const MAX_NAME = 255;

/** Serialises one attachment payload. Refuses a descriptor it could not read back. */
export function packAttachment({ blob, name, mime, size, key, iv, durationMs, voice }) {
  if (typeof blob !== 'string' || !BLOB_ID.test(blob)) throw new Error('شناسه پیوست نامعتبر است');
  if (typeof key !== 'string' || fromBase64(key).length !== KEY_BYTES) throw new Error('کلید پیوست نامعتبر است');
  if (typeof iv !== 'string' || fromBase64(iv).length !== NONCE_BYTES) throw new Error('nonce پیوست نامعتبر است');

  return JSON.stringify({
    k: ATTACHMENT_MARKER,
    blob,
    name: typeof name === 'string' ? name.slice(0, MAX_NAME) : '',
    mime: typeof mime === 'string' ? mime.slice(0, 100) : 'application/octet-stream',
    size: Number.isInteger(size) && size >= 0 ? size : null,
    // A voice note is only worth its length, and a reader that never heard of
    // this field still plays the file — it just cannot say how long it is.
    durationMs: Number.isInteger(durationMs) && durationMs >= 0 ? durationMs : null,
    // Only a recording says so. An uploaded file, and every descriptor written
    // before this existed, carries nothing, so the reader's answer is "not a
    // microphone" rather than a guess.
    ...(voice === true ? { voice: true } : {}),
    key,
    iv,
  });
}

/**
 * Reads one attachment payload, or returns null when the text is an ordinary
 * message. Returning null is the safe answer: a descriptor whose key, nonce or
 * blob id does not validate cannot be fetched or opened, so it is left as the
 * text it arrived as rather than half-trusted.
 */
export function parseAttachment(text) {
  if (typeof text !== 'string' || !text.startsWith('{"k":"')) return null;

  let payload;
  try {
    payload = JSON.parse(text);
  } catch {
    return null;
  }
  if (!payload || payload.k !== ATTACHMENT_MARKER) return null;
  if (typeof payload.blob !== 'string' || !BLOB_ID.test(payload.blob)) return null;
  if (typeof payload.key !== 'string' || typeof payload.iv !== 'string') return null;

  try {
    if (fromBase64(payload.key).length !== KEY_BYTES) return null;
    if (fromBase64(payload.iv).length !== NONCE_BYTES) return null;
  } catch {
    return null;
  }

  return {
    blob: payload.blob,
    name: typeof payload.name === 'string' ? payload.name : '',
    mime: typeof payload.mime === 'string' ? payload.mime : 'application/octet-stream',
    size: Number.isInteger(payload.size) ? payload.size : null,
    // Absent, unreadable or negative all mean the same thing to a reader: this
    // attachment never told us how long it is, so the bubble leaves the number
    // blank instead of inventing one.
    durationMs: Number.isInteger(payload.durationMs) && payload.durationMs >= 0 ? payload.durationMs : null,
    // True only when the sender said so in as many bytes. A missing field, a
    // string, a number — all of them mean this attachment is not a recording.
    voice: payload.voice === true,
    key:  payload.key,
    iv:   payload.iv,
  };
}
