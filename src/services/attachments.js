import { fromBase64 } from '../../shared/e2ee/wire.js';
import { fetchEncryptedFile } from './api.js';

// The browser half of a legacy encrypted attachment.
//
// This is read-only now. Attachments written since server-key content are
// sealed and served by the API itself, so the only files that still need this
// path are the ones whose key travelled inside an MLS message.
//
// A decrypted file becomes an object URL, which is the only way an <img> or a
// download link can show bytes that never had a public address. Those URLs are
// counted: one is revoked once the last view of it goes away, so a long chat
// full of pictures does not pin a pile of decrypted files in memory.

const CACHE_MAX = 24;

const cache = new Map();

async function aesKey(rawBytes, usage) {
  return crypto.subtle.importKey('raw', rawBytes, { name: 'AES-GCM' }, false, [usage]);
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
