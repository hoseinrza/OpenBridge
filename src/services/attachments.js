import { fromBase64, toBase64 } from '../../shared/e2ee/wire.js';
import { fetchEncryptedFile, uploadEncryptedFile } from './api.js';

// The browser half of an encrypted attachment.
//
// AES-256-GCM from the platform's own WebCrypto, one random key per file, one
// random 96-bit nonce per file. The key and nonce go into the message, which is
// encrypted by MLS, so the only place they exist outside a device is inside
// ciphertext this server cannot open. GCM is authenticated, so a file that was
// changed anywhere along the way fails to decrypt instead of rendering wrong
// bytes — that is the whole reason this is GCM and not plain AES.
//
// A decrypted file becomes an object URL, which is the only way an <img> or a
// download link can show bytes that never had a public address. Those URLs are
// counted: one is revoked once the last view of it goes away, so a long chat
// full of pictures does not pin a pile of decrypted files in memory.

const KEY_BYTES = 32;
const NONCE_BYTES = 12;
const CACHE_MAX = 24;

const cache = new Map();

async function aesKey(rawBytes, usage) {
  return crypto.subtle.importKey('raw', rawBytes, { name: 'AES-GCM' }, false, [usage]);
}

/** Encrypts a file's bytes and returns the ciphertext plus the descriptor fields. */
export async function encryptFile(file) {
  const bytes = new Uint8Array(await file.arrayBuffer());
  const keyBytes = crypto.getRandomValues(new Uint8Array(KEY_BYTES));
  const nonce = crypto.getRandomValues(new Uint8Array(NONCE_BYTES));
  const key = await aesKey(keyBytes, 'encrypt');
  const cipher = new Uint8Array(await crypto.subtle.encrypt({ name: 'AES-GCM', iv: nonce }, key, bytes));

  return { cipher, key: toBase64(keyBytes), iv: toBase64(nonce) };
}

/** Uploads ciphertext as a blob of one conversation. The server never sees the plain bytes. */
export async function uploadEncrypted(file, conversationId) {
  const { cipher, key, iv } = await encryptFile(file);
  const { id } = await uploadEncryptedFile(cipher, conversationId);
  return { id, key, iv };
}

function release(blob) {
  const entry = cache.get(blob);
  if (!entry) return;
  entry.refs -= 1;
  if (entry.refs > 0) return;
  cache.delete(blob);
  URL.revokeObjectURL(entry.url);
}

function evictUnheld() {
  for (const [blob, entry] of cache) {
    if (entry.refs === 0) {
      cache.delete(blob);
      URL.revokeObjectURL(entry.url);
      return;
    }
  }
}

/**
 * Fetches, authenticates and decrypts one attachment, then hands back an object
 * URL the caller must release. A key that is not the sender's, or a single byte
 * that changed, makes crypto.subtle.decrypt throw — and a throw here means no
 * URL is ever made, so a tampered file cannot be shown at all.
 */
export async function openAttachment(attachment) {
  const held = cache.get(attachment.blob);
  if (held) {
    held.refs += 1;
    if (cache.size > CACHE_MAX) evictUnheld();
    return { url: held.url, mime: held.mime, release: () => release(attachment.blob) };
  }

  const cipher = await fetchEncryptedFile(attachment.blob);
  const key = await aesKey(fromBase64(attachment.key), 'decrypt');
  const plain = await crypto.subtle.decrypt(
    { name: 'AES-GCM', iv: fromBase64(attachment.iv) },
    key,
    cipher,
  );
  const mime = attachment.mime || 'application/octet-stream';
  const url = URL.createObjectURL(new Blob([plain], { type: mime }));
  cache.set(attachment.blob, { url, mime, refs: 1 });
  if (cache.size > CACHE_MAX) evictUnheld();

  return { url, mime, release: () => release(attachment.blob) };
}
