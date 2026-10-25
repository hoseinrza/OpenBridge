import { readFile, rename, unlink, writeFile } from 'fs/promises';
import { ContentCipher } from '../common/content-crypto';

// On Windows an antivirus or the search indexer can still hold a file it just
// saw for a few dozen milliseconds, and a rename onto it fails with EPERM or
// EACCES. Those three codes mean "wait and try again"; any other one is a real
// failure and goes back to the caller unchanged.
const LOCK_CODES = new Set(['EPERM', 'EACCES', 'EBUSY']);
const RENAME_ATTEMPTS = 4;

async function replaceFile(from: string, to: string): Promise<void> {
  for (let attempt = 1; ; attempt += 1) {
    try {
      await rename(from, to);
      return;
    } catch (error) {
      const code = (error as NodeJS.ErrnoException)?.code;
      if (attempt >= RENAME_ATTEMPTS || !LOCK_CODES.has(code)) throw error;
      await new Promise(resolve => setTimeout(resolve, attempt * 25));
    }
  }
}

/**
 * Seals a file multer has just written, in place. The bytes are renamed into
 * position only once the whole sealed file is on disk, so an interrupted seal
 * cannot leave a half-encrypted attachment behind.
 */
export async function sealStoredFile(path: string, filename: string, cipher: ContentCipher): Promise<void> {
  const sealed = cipher.sealFile(filename, await readFile(path));
  const staging = `${path}.sealing`;
  try {
    await writeFile(staging, sealed);
    await replaceFile(staging, path);
  } catch (error) {
    await unlink(staging).catch(() => {});
    throw error;
  }
}

export async function readStoredFile(path: string, filename: string, cipher: ContentCipher): Promise<Buffer> {
  return cipher.openFile(filename, await readFile(path));
}

export type ByteRange = { start: number; end: number } | 'unsatisfiable' | null;

/**
 * One range, as a media element sends it. Multiple ranges are answered with the
 * whole body: the files here are capped at ten megabytes, and a correct multipart
 * response is not worth the code. An unparseable header is ignored the same way.
 */
export function parseByteRange(header: string | undefined, size: number): ByteRange {
  if (!header) return null;
  const match = /^bytes=(\d*)-(\d*)$/.exec(header.trim());
  if (!match) return null;
  const [, rawStart, rawEnd] = match;
  if (!rawStart && !rawEnd) return null;

  if (!rawStart) {
    // A suffix range asks for the last N bytes.
    const suffix = Number(rawEnd);
    if (!Number.isFinite(suffix) || suffix <= 0) return 'unsatisfiable';
    return { start: Math.max(size - suffix, 0), end: size - 1 };
  }

  const start = Number(rawStart);
  const end = rawEnd ? Number(rawEnd) : size - 1;
  if (!Number.isFinite(start) || !Number.isFinite(end) || start > end) return 'unsatisfiable';
  if (start >= size) return 'unsatisfiable';
  return { start, end: Math.min(end, size - 1) };
}
