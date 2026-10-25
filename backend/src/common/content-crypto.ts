import { createCipheriv, createDecipheriv, hkdfSync, randomBytes } from 'crypto';

// Everything written by the application (message text, uploaded bytes) is
// sealed with a key derived from one server-held master secret. The prefix
// lets a reader tell sealed content from rows written before this existed,
// which must stay readable; malformed sealed content is an error, never a
// silent fall-through to showing ciphertext.
const TEXT_PREFIX = 'obx1';
export const FILE_MAGIC = 'OBX1';

const KEY_BYTES = 32;
const IV_BYTES = 12;
const TAG_BYTES = 16;
const HEADER_BYTES = FILE_MAGIC.length + IV_BYTES + TAG_BYTES;
const TEXT_INFO = 'openbridge-content-v1';
const FILE_INFO = 'openbridge-file-v1';

export interface ContentCipher {
  sealText(conversationId: string, text: string): string;
  openText(conversationId: string, payload: string | null | undefined): string | null;
  sealFile(filename: string, bytes: Buffer): Buffer;
  openFile(filename: string, bytes: Buffer): Buffer;
}

/**
 * The master secret arrives as base64 in `CONTENT_KEY`. Refusing a short or
 * malformed value at startup is the whole point: a fallback key would make
 * every deployment silently share a secret the code can guess.
 */
export function loadContentKey(raw: string | undefined): Buffer {
  const value = raw?.trim();
  if (!value) {
    throw new Error('CONTENT_KEY is missing; set it to a base64-encoded 32-byte key');
  }
  const key = Buffer.from(value, 'base64');
  if (key.length !== KEY_BYTES) {
    throw new Error(`CONTENT_KEY must decode to ${KEY_BYTES} bytes, got ${key.length}`);
  }
  // Buffer.from is lenient about junk; a non-canonical encoding means the
  // value was not produced by a key generator.
  const canonical = value.replace(/=+$/, '');
  if (key.toString('base64').replace(/=+$/, '') !== canonical) {
    throw new Error('CONTENT_KEY is not valid base64');
  }
  return key;
}

function derive(master: Buffer, salt: string, info: string): Buffer {
  return Buffer.from(hkdfSync('sha256', master, Buffer.from(salt, 'utf8'), Buffer.from(info, 'utf8'), KEY_BYTES));
}

export function createContentCipher(master: Buffer): ContentCipher {
  if (master.length !== KEY_BYTES) {
    throw new Error(`master key must be ${KEY_BYTES} bytes`);
  }

  // One key per conversation means a leaked key (or a stolen database row)
  // does not open every chat. The conversation id is the salt, not a secret.
  const textKey = (conversationId: string) => derive(master, `conversation:${conversationId}`, TEXT_INFO);
  // Files are keyed by their stored name, which carries a random id, so two
  // uploads of the same bytes do not share a key.
  const fileKey = (filename: string) => derive(master, `file:${filename}`, FILE_INFO);

  return {
    sealText(conversationId, text) {
      const iv = randomBytes(IV_BYTES);
      const cipher = createCipheriv('aes-256-gcm', textKey(conversationId), iv);
      const body = Buffer.concat([cipher.update(text, 'utf8'), cipher.final()]);
      return [
        TEXT_PREFIX,
        iv.toString('base64url'),
        cipher.getAuthTag().toString('base64url'),
        body.toString('base64url'),
      ].join('.');
    },

    openText(conversationId, payload) {
      if (payload === null || payload === undefined) return null;
      if (!payload.startsWith(`${TEXT_PREFIX}.`)) return payload;

      const parts = payload.split('.');
      if (parts.length !== 4) throw new Error('sealed text is malformed');
      const iv = Buffer.from(parts[1], 'base64url');
      const tag = Buffer.from(parts[2], 'base64url');
      if (iv.length !== IV_BYTES || tag.length !== TAG_BYTES) {
        throw new Error('sealed text has an invalid header');
      }

      const decipher = createDecipheriv('aes-256-gcm', textKey(conversationId), iv);
      decipher.setAuthTag(tag);
      return Buffer.concat([
        decipher.update(Buffer.from(parts[3], 'base64url')),
        decipher.final(),
      ]).toString('utf8');
    },

    sealFile(filename, bytes) {
      const iv = randomBytes(IV_BYTES);
      const cipher = createCipheriv('aes-256-gcm', fileKey(filename), iv);
      const body = Buffer.concat([cipher.update(bytes), cipher.final()]);
      return Buffer.concat([Buffer.from(FILE_MAGIC, 'ascii'), iv, cipher.getAuthTag(), body]);
    },

    openFile(filename, bytes) {
      if (bytes.length < FILE_MAGIC.length || bytes.subarray(0, FILE_MAGIC.length).toString('ascii') !== FILE_MAGIC) {
        // Written before this scheme existed; serve it as it is.
        return bytes;
      }
      if (bytes.length < HEADER_BYTES) throw new Error('sealed file is truncated');

      const iv = bytes.subarray(FILE_MAGIC.length, FILE_MAGIC.length + IV_BYTES);
      const tag = bytes.subarray(FILE_MAGIC.length + IV_BYTES, HEADER_BYTES);
      const decipher = createDecipheriv('aes-256-gcm', fileKey(filename), iv);
      decipher.setAuthTag(tag);
      return Buffer.concat([decipher.update(bytes.subarray(HEADER_BYTES)), decipher.final()]);
    },
  };
}
