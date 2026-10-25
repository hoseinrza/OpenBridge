const test = require('node:test');
const assert = require('node:assert/strict');
const { mkdtemp, readFile, writeFile, rm } = require('node:fs/promises');
const { tmpdir } = require('node:os');
const { join } = require('node:path');

process.env.JWT_SECRET = 'test-secret-at-least-32-characters-long-000';
process.env.CONTENT_KEY = 'Y2ktb25seS1jb250ZW50LWtleS0zMi1ieXRlcy0wMDA=';

const { ContentCrypto } = require('../dist/common/content-crypto.service.js');
const {
  sealStoredFile,
  readStoredFile,
  parseByteRange,
} = require('../dist/uploads/file-store.js');

const cipher = new ContentCrypto();
const NAME = 'c2f1a0e4-5b6d-4c7e-8f90-112233445566.png';
const BYTES = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0x00, 0x01, 0x02, 0xff]);

async function withTempFile(bytes, run) {
  const dir = await mkdtemp(join(tmpdir(), 'obx-upload-'));
  const path = join(dir, NAME);
  await writeFile(path, bytes);
  try {
    return await run(path, dir);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

test('an uploaded file is sealed on disk and opens back to its bytes', async () => {
  await withTempFile(BYTES, async (path) => {
    await sealStoredFile(path, NAME, cipher);

    const stored = await readFile(path);
    assert.equal(stored.subarray(0, 4).toString('ascii'), 'OBX1');
    assert.equal(stored.includes(BYTES), false);

    assert.deepEqual(await readStoredFile(path, NAME, cipher), BYTES);
  });
});

test('a file written before sealing stays readable', async () => {
  await withTempFile(BYTES, async (path) => {
    assert.deepEqual(await readStoredFile(path, NAME, cipher), BYTES);
  });
});

test('a sealed file cannot be opened under another name', async () => {
  await withTempFile(BYTES, async (path) => {
    await sealStoredFile(path, NAME, cipher);
    await assert.rejects(() => readStoredFile(path, 'other.png', cipher));
  });
});

test('a single byte range is parsed for media seeking', () => {
  assert.deepEqual(parseByteRange('bytes=0-3', 10), { start: 0, end: 3 });
  assert.deepEqual(parseByteRange('bytes=5-', 10), { start: 5, end: 9 });
  assert.deepEqual(parseByteRange('bytes=-4', 10), { start: 6, end: 9 });
  assert.equal(parseByteRange(undefined, 10), null);
  assert.deepEqual(parseByteRange('bytes=8-20', 10), { start: 8, end: 9 });
  assert.equal(parseByteRange('bytes=50-60', 10), 'unsatisfiable');
  assert.equal(parseByteRange('items=0-3', 10), null);
  assert.equal(parseByteRange('bytes=0-3,5-6', 10), null);
});
