const test = require('node:test');
const assert = require('node:assert/strict');
const { randomBytes } = require('node:crypto');

const {
  createContentCipher,
  loadContentKey,
  FILE_MAGIC,
} = require('../dist/common/content-crypto.js');

const KEY = randomBytes(32);
const CONVERSATION = '6d1f4f0e-2f3a-4b8e-9a51-3e7c2d9b0a11';
const OTHER = '0a2b3c4d-5e6f-4a7b-8c9d-0e1f2a3b4c5d';

test('text round-trips Persian, emoji and newlines', () => {
  const cipher = createContentCipher(KEY);
  const text = 'سلام دنیا 👋\nخط دوم';
  const sealed = cipher.sealText(CONVERSATION, text);

  assert.notEqual(sealed, text);
  assert.match(sealed, /^obx1\./);
  assert.equal(cipher.openText(CONVERSATION, sealed), text);
});

test('the same text in two conversations does not share ciphertext', () => {
  const cipher = createContentCipher(KEY);
  const a = cipher.sealText(CONVERSATION, 'یکسان');
  const b = cipher.sealText(OTHER, 'یکسان');

  assert.notEqual(a, b);
  assert.throws(() => cipher.openText(OTHER, a));
});

test('a tampered payload is refused instead of returning garbage', () => {
  const cipher = createContentCipher(KEY);
  const sealed = cipher.sealText(CONVERSATION, 'محرمانه');
  const [prefix, iv, tag, body] = sealed.split('.');
  const flipped = Buffer.from(body, 'base64url');
  flipped[0] ^= 0xff;
  const broken = [prefix, iv, tag, flipped.toString('base64url')].join('.');

  assert.throws(() => cipher.openText(CONVERSATION, broken));
});

test('legacy plaintext passes through unchanged', () => {
  const cipher = createContentCipher(KEY);
  assert.equal(cipher.openText(CONVERSATION, 'پیام قدیمی'), 'پیام قدیمی');
  assert.equal(cipher.openText(CONVERSATION, null), null);
});

test('another master key cannot open the payload', () => {
  const sealed = createContentCipher(KEY).sealText(CONVERSATION, 'راز');
  const other = createContentCipher(randomBytes(32));

  assert.throws(() => other.openText(CONVERSATION, sealed));
});

test('files round-trip with the magic header and are bound to their name', () => {
  const cipher = createContentCipher(KEY);
  const bytes = randomBytes(700);
  const sealed = cipher.sealFile('report.pdf', bytes);

  assert.equal(sealed.subarray(0, 4).toString('ascii'), FILE_MAGIC);
  assert.deepEqual(cipher.openFile('report.pdf', sealed), bytes);
  assert.throws(() => cipher.openFile('other.pdf', sealed));
});

test('a legacy plaintext file passes through openFile', () => {
  const cipher = createContentCipher(KEY);
  const bytes = Buffer.from('old unencrypted bytes');

  assert.deepEqual(cipher.openFile('old.png', bytes), bytes);
});

test('loadContentKey accepts one 32-byte base64 key and refuses anything else', () => {
  const raw = KEY.toString('base64');
  assert.deepEqual(loadContentKey(raw), KEY);
  assert.throws(() => loadContentKey(undefined));
  assert.throws(() => loadContentKey(''));
  assert.throws(() => loadContentKey(randomBytes(16).toString('base64')));
  assert.throws(() => loadContentKey('not base64 at all!!'));
});
