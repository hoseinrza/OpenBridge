// Byte plumbing for the E2EE client.
//
// The client core has to run in three engines that disagree about which
// conveniences exist: browsers, Node, and Hermes on Expo. Hermes has no
// Buffer, no atob/btoa and no TextEncoder, so the encoders that every
// persisted value and every envelope goes through are implemented here rather
// than borrowed from a host. Only base64 and UTF-8 are hand-written; no
// cryptographic primitive lives in this file.
const ALPHABET = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/';

// Reverse lookup, -1 for anything outside the alphabet. Built once; the
// decoder is on the path of every received message.
const DECODE = (() => {
  const table = new Int8Array(128).fill(-1);
  for (let i = 0; i < ALPHABET.length; i += 1) table[ALPHABET.charCodeAt(i)] = i;
  return table;
})();

/** @param {Uint8Array} bytes */
export function toBase64(bytes) {
  let out = '';
  for (let i = 0; i < bytes.length; i += 3) {
    const b0 = bytes[i];
    const b1 = i + 1 < bytes.length ? bytes[i + 1] : undefined;
    const b2 = i + 2 < bytes.length ? bytes[i + 2] : undefined;
    out += ALPHABET[b0 >> 2];
    out += ALPHABET[((b0 & 0b11) << 4) | (b1 === undefined ? 0 : b1 >> 4)];
    out += b1 === undefined ? '=' : ALPHABET[((b1 & 0b1111) << 2) | (b2 === undefined ? 0 : b2 >> 6)];
    out += b2 === undefined ? '=' : ALPHABET[b2 & 0b111111];
  }
  return out;
}

/**
 * Strict base64: padding, length and alphabet are all checked, because this is
 * the boundary where bytes that came off the network become keys and message
 * numbers. Anything malformed is an error, not a silently truncated array.
 *
 * @param {string} text
 */
export function fromBase64(text) {
  if (typeof text !== 'string' || text.length % 4 !== 0 || !/^[A-Za-z0-9+/]*={0,2}$/.test(text)) {
    throw new Error('base64 نامعتبر است');
  }
  const padding = text.endsWith('==') ? 2 : text.endsWith('=') ? 1 : 0;
  const body = padding ? text.slice(0, text.length - padding) : text;
  const bytes = new Uint8Array(Math.floor((body.length * 3) / 4));
  let bitBuffer = 0;
  let held = 0;
  let at = 0;
  for (let i = 0; i < body.length; i += 1) {
    const value = DECODE[body.charCodeAt(i)];
    if (value < 0) throw new Error('base64 نامعتبر است');
    bitBuffer = (bitBuffer << 6) | value;
    held += 6;
    if (held >= 8) {
      held -= 8;
      bytes[at] = (bitBuffer >> held) & 0xff;
      at += 1;
    }
  }
  // A trailing fragment with bits set would decode to a byte the sender never
  // had, so canonical encoding is part of validity.
  if (held > 0 && (bitBuffer & ((1 << held) - 1)) !== 0) throw new Error('base64 نامعتبر است');
  return bytes;
}

/** @param {string} text */
export function encodeUtf8(text) {
  const parts = [];
  for (const character of text) {
    const point = character.codePointAt(0);
    if (point < 0x80) parts.push(point);
    else if (point < 0x800) parts.push(0b11000000 | (point >> 6), 0b10000000 | (point & 0b111111));
    else if (point < 0x10000) {
      parts.push(0b11100000 | (point >> 12), 0b10000000 | ((point >> 6) & 0b111111), 0b10000000 | (point & 0b111111));
    } else {
      parts.push(
        0b11110000 | (point >> 18),
        0b10000000 | ((point >> 12) & 0b111111),
        0b10000000 | ((point >> 6) & 0b111111),
        0b10000000 | (point & 0b111111),
      );
    }
  }
  return Uint8Array.from(parts);
}

/** @param {Uint8Array} bytes */
export function decodeUtf8(bytes) {
  let out = '';
  let i = 0;
  const take = (count) => {
    let continuation = 0;
    for (let n = 0; n < count; n += 1) {
      const next = bytes[i + 1 + n];
      // 0x80..0xbf is the only shape a continuation byte may have.
      if (next === undefined || (next & 0xc0) !== 0x80) throw new Error('utf-8 نامعتبر است');
      continuation = (continuation << 6) | (next & 0b111111);
    }
    i += count;
    return continuation;
  };
  while (i < bytes.length) {
    const lead = bytes[i];
    if (lead < 0x80) out += String.fromCharCode(lead);
    else if (lead < 0xe0) out += String.fromCharCode(((lead & 0b11111) << 6) | take(1));
    else if (lead < 0xf0) out += String.fromCharCode(((lead & 0b1111) << 12) | take(2));
    else {
      const point = ((lead & 0b111) << 18) | take(3);
      out += String.fromCharCode(0xd800 + ((point - 0x10000) >> 10), 0xdc00 + ((point - 0x10000) & 0x3ff));
    }
    i += 1;
  }
  return out;
}
