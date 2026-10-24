// Two small JSON envelopes that travel inside an MLS application message.
//
// The server never sees either one in readable form. They are shared by every
// client so a phone opens what a browser wrote, and they deliberately carry
// only copied values: a reply quote is a snapshot, not a pointer the receiver
// has to fetch.

export const MESSAGE_MARKER = 'openbridge.message.v1';
export const CONTROL_MARKER = 'openbridge.control.v1';

const MAX_TEXT = 4000;
const MAX_PREVIEW = 180;
const MAX_NAME = 80;
const MAX_ID = 64;
const QUOTE_TYPES = new Set(['text', 'image', 'file', 'audio', 'voice', 'video']);

function clean(value, max) {
  return typeof value === 'string' ? value.slice(0, max) : '';
}

/** The quote shown above a reply, or null when there is nothing to quote. */
export function sanitizeQuote(quote) {
  if (!quote || typeof quote !== 'object') return null;
  const id = clean(quote.id, MAX_ID);
  if (!id) return null;
  return {
    id,
    senderName: clean(quote.senderName, MAX_NAME) || null,
    preview:    clean(quote.preview, MAX_PREVIEW) || null,
    type:       QUOTE_TYPES.has(quote.type) ? quote.type : 'text',
  };
}

export function sanitizeForward(forward) {
  if (!forward || typeof forward !== 'object') return null;
  const fromName = clean(forward.fromName, MAX_NAME);
  return fromName ? { fromName } : null;
}

/** A text message that may carry a reply quote and/or a forward label. */
export function packMessage({ text, reply, forward }) {
  if (typeof text !== 'string' || !text.length) throw new Error('متن پیام خالی است');
  const payload = { k: MESSAGE_MARKER, t: text.slice(0, MAX_TEXT) };
  const quoted = sanitizeQuote(reply);
  const forwarded = sanitizeForward(forward);
  if (quoted) payload.r = quoted;
  if (forwarded) payload.f = forwarded;
  return JSON.stringify(payload);
}

export function parseMessage(text) {
  if (typeof text !== 'string' || !text.startsWith('{"k":"')) return null;
  let payload;
  try { payload = JSON.parse(text); } catch { return null; }
  if (!payload || payload.k !== MESSAGE_MARKER) return null;
  const value = clean(payload.t, MAX_TEXT);
  if (!value) return null;
  return {
    text:    value,
    reply:   sanitizeQuote(payload.r),
    forward: sanitizeForward(payload.f),
  };
}

/**
 * edit: only the original sender, only text.
 * delete: `everyone` for the sender; `me` is a control that other accounts
 * ignore and other devices of the same account apply as a local hide.
 */
export function packControl({ op, targetSeq, text, scope }) {
  if (op !== 'edit' && op !== 'delete') throw new Error('عملیات کنترل نامعتبر است');
  if (!Number.isInteger(targetSeq) || targetSeq <= 0) throw new Error('پیام هدف نامعتبر است');

  const payload = { k: CONTROL_MARKER, op, t: targetSeq };
  if (op === 'edit') {
    const value = clean(text, MAX_TEXT).trim();
    if (!value) throw new Error('متن ویرایش خالی است');
    payload.x = value;
  } else {
    payload.s = scope === 'me' ? 'me' : 'everyone';
  }
  return JSON.stringify(payload);
}

export function parseControl(text) {
  if (typeof text !== 'string' || !text.startsWith('{"k":"')) return null;
  let payload;
  try { payload = JSON.parse(text); } catch { return null; }
  if (!payload || payload.k !== CONTROL_MARKER) return null;
  if (!Number.isInteger(payload.t) || payload.t <= 0) return null;

  if (payload.op === 'edit') {
    const value = clean(payload.x, MAX_TEXT).trim();
    return value ? { op: 'edit', targetSeq: payload.t, text: value } : null;
  }
  if (payload.op === 'delete') {
    return {
      op:         'delete',
      targetSeq:  payload.t,
      scope:      payload.s === 'me' ? 'me' : 'everyone',
    };
  }
  return null;
}
