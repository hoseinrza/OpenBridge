import { createHmac, timingSafeEqual } from 'crypto';
import { JWT_SECRET } from '../config/env';

// Uploaded files are private. API responses hand out short-lived signed URLs
// instead of exposing the uploads directory directly, so <img>/<video> can
// load them without putting the user's JWT in a URL.
const TTL_SECONDS = (() => {
  const raw = Number(process.env.FILE_URL_TTL_SECONDS ?? 7 * 24 * 60 * 60);
  return Number.isFinite(raw) && raw > 0 ? Math.floor(raw) : 7 * 24 * 60 * 60;
})();

const SIGNING_SECRET = process.env.FILE_URL_SECRET?.trim() || JWT_SECRET;

const UPLOAD_PATH = /^\/uploads\/([A-Za-z0-9._-]{1,120})$/;

function signature(filename: string, expiresAt: number) {
  return createHmac('sha256', SIGNING_SECRET)
    .update(`${filename}:${expiresAt}`)
    .digest('hex');
}

export function signedFileUrl(rawUrl: string | null | undefined): string | null {
  if (!rawUrl) return null;
  if (rawUrl.startsWith('http')) return rawUrl;

  const [path] = rawUrl.split('?');
  const match = UPLOAD_PATH.exec(path);
  if (!match) return rawUrl;

  const filename = match[1];
  const expiresAt = Math.floor(Date.now() / 1000) + TTL_SECONDS;
  return `${path}?exp=${expiresAt}&sig=${signature(filename, expiresAt)}`;
}

export function verifyFileSignature(filename: string, expiresAtRaw: string, sig: string): boolean {
  if (!/^[A-Za-z0-9._-]{1,120}$/.test(filename)) return false;

  const expiresAt = Number(expiresAtRaw);
  if (!Number.isInteger(expiresAt) || expiresAt < Math.floor(Date.now() / 1000)) return false;
  if (typeof sig !== 'string' || !/^[a-f0-9]{64}$/.test(sig)) return false;

  const expected = Buffer.from(signature(filename, expiresAt), 'hex');
  const provided = Buffer.from(sig, 'hex');
  return expected.length === provided.length && timingSafeEqual(expected, provided);
}
