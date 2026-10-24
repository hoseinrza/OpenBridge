// The attachment descriptor is the only thing every client must agree on: a
// browser writes it, a phone reads it, and the bytes it points at are opaque to
// the server. These tests hold that contract, including the waveform field a
// recording carries so a bubble can be drawn before a single byte is fetched.
import test from 'node:test';
import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import { toBase64 } from './wire.js';
import { packAttachment, parseAttachment } from './attachments.js';

const BLOB = '0f8e2a71-4c3d-4e5f-8a9b-0c1d2e3f4a5b';

function descriptor(over = {}) {
  return packAttachment({
    blob: BLOB,
    name: 'voice-message.weba',
    mime: 'audio/webm',
    size: 20480,
    key: toBase64(randomBytes(32)),
    iv: toBase64(randomBytes(12)),
    ...over,
  });
}

test('a descriptor without a waveform reads back exactly as it was written', () => {
  const opened = parseAttachment(descriptor({ durationMs: 4700, voice: true }));
  assert.equal(opened.durationMs, 4700);
  assert.equal(opened.voice, true);
  assert.equal(opened.peaks, null);
  assert.equal(opened.blob, BLOB);
});

test('a waveform survives the round trip', () => {
  const peaks = Array.from({ length: 40 }, (_, i) => (i * 7) % 100);
  const opened = parseAttachment(descriptor({ durationMs: 1200, voice: true, peaks }));
  assert.deepEqual(opened.peaks, peaks);
});

test('a waveform longer than a bubble draws is cut, not refused', () => {
  const opened = parseAttachment(descriptor({ peaks: Array.from({ length: 200 }, () => 55) }));
  assert.equal(opened.peaks.length, 64);
});

test('a sender that wrote junk about the shape still gets its recording delivered', () => {
  for (const [junk, expected] of [
    [undefined, null],
    [null, null],
    ['loud', null],
    [{}, null],
    [[], null],
    [[1], null],                       // one bar is not a shape
    [[1, 2, 'x'], [1, 2]],             // the unusable entry goes, the shape stays
    [[1, NaN, 3], [1, 3]],
    [[-5, 999], [0, 100]],             // clamped into the range a bar is drawn in
    [[3.6, 4.2], [4, 4]],              // whole numbers, because a phone reads them
  ]) {
    const opened = parseAttachment(descriptor({ peaks: junk }));
    assert.equal(opened.blob, BLOB, `${JSON.stringify(junk)}: the file itself must survive`);
    assert.deepEqual(opened.peaks, expected, `${JSON.stringify(junk)}`);
  }
});

test('an ordinary message is still read as a message', () => {
  assert.equal(parseAttachment('سلام'), null);
  assert.equal(parseAttachment('{"k":"something-else"}'), null);
  assert.equal(parseAttachment('{"k":"openbridge.attachment.v1","blob":"nope"}'), null);
});
