const test = require('node:test');
const assert = require('node:assert/strict');

process.env.JWT_SECRET = 'test-secret-at-least-32-characters-long-000';
process.env.CONTENT_KEY = 'Y2ktb25seS1jb250ZW50LWtleS0zMi1ieXRlcy0wMDA=';

const { MessagesService } = require('../dist/messages/messages.service.js');
const { ContentCrypto } = require('../dist/common/content-crypto.service.js');

const CONVERSATION = '8e03f4a1-6f0c-4c1e-9d92-6f4a1b0c3d21';
const OTHER_CHAT = '1f6f7c1e-2b9d-4a1c-8f3e-7d2a5c9b0e44';
const SENDER = 'user-1';
const AUTHOR = 'user-2';
const BLOB = '9c1d2a3b-4e5f-4a6b-8c7d-9e0f1a2b3c4d';
const BLOB_ELSEWHERE = '0a1b2c3d-4e5f-4a6b-8c7d-9e0f1a2b3c4e';

const KEY = Buffer.alloc(32, 7).toString('base64');
const IV = Buffer.alloc(12, 3).toString('base64');

const cipher = new ContentCrypto();

function envelope(seq, overrides = {}) {
  return {
    id:             `env-${seq}`,
    conversationId: CONVERSATION,
    senderId:       AUTHOR,
    seq,
    kind:           'MESSAGE',
    createdAt:      new Date(`2026-10-20T10:0${seq}:00.000Z`),
    migratedAt:     null,
    ...overrides,
  };
}

function matches(where, row) {
  if (where.conversationId && row.conversationId !== where.conversationId) return false;
  if (where.kind && row.kind !== where.kind) return false;
  if (where.migratedAt === null && row.migratedAt !== null) return false;
  if (where.seq?.in && !where.seq.in.includes(row.seq)) return false;
  if (where.seq?.gt !== undefined && !(row.seq > where.seq.gt)) return false;
  return true;
}

function fakePrisma({
  envelopes = [], existing = [], blobs = [], replies = [], member = true,
} = {}) {
  const calls = { created: [], migrated: [] };
  return {
    calls,
    conversationParticipant: {
      findUnique: async () => (member ? { role: 'MEMBER' } : null),
    },
    e2eeEnvelope: {
      findMany: async ({ where, orderBy, take }) => {
        let rows = envelopes.filter(row => matches(where, row));
        if (orderBy?.seq === 'asc') rows = [...rows].sort((a, b) => a.seq - b.seq);
        return take ? rows.slice(0, take) : rows;
      },
      count: async ({ where }) => envelopes.filter(row => matches(where, row)).length,
      update: async ({ where, data }) => {
        const row = envelopes.find(entry => entry.id === where.id);
        if (row) Object.assign(row, data);
        calls.migrated.push({ id: where.id, ...data });
        return row;
      },
    },
    message: {
      findMany: async ({ where }) => existing.filter(entry => (
        where.legacyEnvelopeId.in.includes(entry.legacyEnvelopeId)
      )),
      findFirst: async ({ where }) => replies.find(entry => (
        entry.conversationId === where.conversationId && entry.legacySeq === where.legacySeq
      )) ?? null,
      create: async ({ data }) => {
        calls.created.push(data);
        return { id: `created-${calls.created.length}`, ...data, reactions: [], reads: [] };
      },
    },
    encryptedBlob: {
      findMany: async ({ where }) => blobs.filter(entry => (
        where.conversationId === entry.conversationId && where.id.in.includes(entry.id)
      )),
    },
  };
}

function service(prisma) {
  return new MessagesService(prisma, { publishGroupUpdated() {} }, cipher);
}

test('an import stores the text sealed, under the envelope’s author and time', async () => {
  const prisma = fakePrisma({ envelopes: [envelope(3)] });

  const result = await service(prisma).importLegacy(CONVERSATION, SENDER, [
    { seq: 3, type: 'text', text: 'سلام از گذشته' },
  ]);

  assert.equal(result.imported, 1);
  const [created] = prisma.calls.created;
  assert.match(created.text, /^obx1\./, 'the imported text is sealed like any other row');
  assert.equal(created.text.includes('سلام'), false, 'and is not readable in the database');
  assert.equal(created.senderId, AUTHOR, 'the author comes from the envelope, never the importer');
  assert.equal(created.conversationId, CONVERSATION);
  assert.equal(created.type, 'TEXT');
  assert.equal(created.legacySeq, 3);
  assert.equal(created.legacyEnvelopeId, 'env-3');
  assert.deepEqual(created.createdAt, new Date('2026-10-20T10:03:00.000Z'), 'the original time is kept');
  assert.ok(prisma.calls.migrated.some(entry => entry.id === 'env-3' && entry.migratedAt instanceof Date));
});

test('sending the same history twice imports nothing new and repairs the mark', async () => {
  const prisma = fakePrisma({
    envelopes: [envelope(3)],
    existing:  [{ legacyEnvelopeId: 'env-3' }],
  });

  const result = await service(prisma).importLegacy(CONVERSATION, SENDER, [
    { seq: 3, type: 'text', text: 'دوباره' },
  ]);

  assert.equal(result.imported, 0);
  assert.equal(result.skipped, 1);
  assert.equal(prisma.calls.created.length, 0, 'no duplicate row');
  assert.ok(prisma.calls.migrated.some(entry => entry.id === 'env-3'), 'a half-finished import is repaired');
});

test('unknown sequences and control envelopes are rejected, not guessed at', async () => {
  const prisma = fakePrisma({
    envelopes: [envelope(4, { kind: 'CONTROL' })],
  });

  const result = await service(prisma).importLegacy(CONVERSATION, SENDER, [
    { seq: 9, type: 'text', text: 'no envelope' },
    { seq: 4, type: 'text', text: 'a control is not a message' },
  ]);

  assert.equal(result.imported, 0);
  assert.equal(result.rejected, 2);
  assert.equal(prisma.calls.created.length, 0);
});

test('only a member of the conversation may import', async () => {
  const prisma = fakePrisma({ member: false, envelopes: [envelope(3)] });

  await assert.rejects(
    () => service(prisma).importLegacy(CONVERSATION, SENDER, [{ seq: 3, type: 'text', text: 'x' }]),
    /عضو این گفتگو/,
  );
  assert.equal(prisma.calls.created.length, 0);
});

test('a reply points at the earlier row imported from the same stream', async () => {
  const prisma = fakePrisma({
    envelopes: [envelope(3), envelope(5)],
    replies:   [{ id: 'message-3', conversationId: CONVERSATION, legacySeq: 3 }],
  });

  await service(prisma).importLegacy(CONVERSATION, SENDER, [
    { seq: 5, type: 'text', text: 'پاسخ', replyToSeq: 3 },
  ]);

  assert.equal(prisma.calls.created[0].replyToId, 'message-3');
});

test('a legacy attachment keeps its descriptor, but only a blob of this chat', async () => {
  const attachment = {
    blob: BLOB, name: 'photo.png', mime: 'image/png', size: 1200,
    durationMs: null, voice: false, peaks: null, key: KEY, iv: IV,
  };
  const prisma = fakePrisma({
    envelopes: [envelope(2), envelope(3)],
    blobs:     [{ id: BLOB, conversationId: CONVERSATION }],
  });

  const result = await service(prisma).importLegacy(CONVERSATION, SENDER, [
    { seq: 2, type: 'image', attachment },
    { seq: 3, type: 'file', attachment: { ...attachment, blob: BLOB_ELSEWHERE } },
  ]);

  assert.equal(result.imported, 1);
  assert.equal(result.rejected, 1, 'a blob from another conversation is refused');
  const [created] = prisma.calls.created;
  assert.equal(created.type, 'IMAGE');
  assert.equal(created.text, null);
  assert.deepEqual(created.legacyAttachment, attachment);
});

test('a malformed attachment key is refused instead of stored', async () => {
  const prisma = fakePrisma({
    envelopes: [envelope(2)],
    blobs:     [{ id: BLOB, conversationId: CONVERSATION }],
  });

  const result = await service(prisma).importLegacy(CONVERSATION, SENDER, [{
    seq: 2,
    type: 'audio',
    attachment: {
      blob: BLOB, name: 'song.mp3', mime: 'audio/mpeg', size: 10,
      key: 'not-a-key', iv: IV,
    },
  }]);

  assert.equal(result.imported, 0);
  assert.equal(result.rejected, 1);
  assert.equal(prisma.calls.created.length, 0);
});

test('status counts message envelopes only and lists the ones still pending', async () => {
  const prisma = fakePrisma({
    envelopes: [
      envelope(1, { migratedAt: new Date() }),
      envelope(2),
      envelope(3, { kind: 'CONTROL' }),
      envelope(4, { conversationId: OTHER_CHAT }),
    ],
  });

  const status = await service(prisma).legacyStatus(CONVERSATION, SENDER, {});

  assert.equal(status.total, 2);
  assert.equal(status.imported, 1);
  assert.equal(status.pending, 1);
  assert.deepEqual(status.seqs, [2]);
  assert.equal(status.nextAfterSeq, null);
});
