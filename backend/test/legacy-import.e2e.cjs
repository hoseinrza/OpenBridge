// The legacy stream, finished once and for all.
//
// An MLS conversation used to hold its history in envelopes the server could
// not read. The unit suite proves the import rules; this one proves the whole
// trip against a real database and a real HTTP surface: a device hands back
// plaintext, the row on disk is sealed, every member can read it, the envelope
// is marked, a retry changes nothing, and what is still ciphertext is reported.

const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');

process.env.NODE_ENV = process.env.NODE_ENV || 'test';
process.env.JWT_SECRET = process.env.JWT_SECRET || 'openbridge-test-secret-at-least-32-characters-long';
process.env.CONTENT_KEY = process.env.CONTENT_KEY || 'Y2ktb25seS1jb250ZW50LWtleS0zMi1ieXRlcy0wMDA=';
process.env.AUTH_OTP_REQUEST_LIMIT = process.env.AUTH_OTP_REQUEST_LIMIT || '50';
process.env.AUTH_OTP_VERIFY_LIMIT = process.env.AUTH_OTP_VERIFY_LIMIT || '50';
process.env.AUTH_SIGNUP_LIMIT = process.env.AUTH_SIGNUP_LIMIT || '50';

const { NestFactory } = require('@nestjs/core');
const { ValidationPipe } = require('@nestjs/common');
const { PrismaClient } = require('@prisma/client');
const { AppModule } = require('../dist/app.module');
const { isOriginAllowed } = require('../dist/config/env');

const API_PREFIX = '/api';
const suffix = `${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`;
const createdUserIds = [];
const otpPhones = [];

let app;
let prisma;
let origin;
let conversationId;
let firstEnvelopeId;

async function api(path, { method = 'GET', token, body } = {}) {
  const response = await fetch(`${origin}${API_PREFIX}${path}`, {
    method,
    headers: {
      'Content-Type': 'application/json',
      ...(token ? { Authorization: `Bearer ${token}` } : {}),
    },
    body: body ? JSON.stringify(body) : undefined,
  });
  return { status: response.status, data: await response.json().catch(() => ({})) };
}

function freshPhone() {
  return `09${String(Math.floor(Math.random() * 1e9)).padStart(9, '0')}`;
}

async function createUser(label) {
  const phone = freshPhone();
  otpPhones.push(phone);
  const requested = await api('/auth/otp/request', { method: 'POST', body: { phone } });
  const verified = await api('/auth/otp/verify', { method: 'POST', body: { phone, code: requested.data.testCode } });
  const created = await api('/auth/signup', {
    method: 'POST',
    body: {
      signupToken: verified.data.signupToken,
      username:    `obx_${suffix}_${label}`,
      firstName:   'Legacy',
      lastName:    label,
    },
  });
  assert.equal(created.status, 201, `signup ${label}`);
  createdUserIds.push(created.data.user.id);
  return created.data;
}

before(async () => {
  app = await NestFactory.create(AppModule, { logger: false });
  app.setGlobalPrefix('api');
  app.useGlobalPipes(new ValidationPipe({ whitelist: true, transform: true }));
  app.enableCors({
    origin: (requestOrigin, callback) => callback(null, isOriginAllowed(requestOrigin)),
    credentials: true,
  });
  await app.listen(0);
  origin = `http://127.0.0.1:${app.getHttpServer().address().port}`;
  prisma = new PrismaClient();

  const alice = await createUser('alice');
  const bob = await createUser('bob');
  const carol = await createUser('carol');
  global.__ctx = { alice, bob, carol };

  // A direct chat that opted into MLS before server-key content existed. Its
  // envelopes are written straight to the table: the import never reads their
  // ciphertext, only the sequence, author and time around it.
  const conversation = await prisma.conversation.create({
    data: {
      isGroup:      false,
      e2ee:         true,
      participants: { create: [{ userId: alice.user.id }, { userId: bob.user.id }] },
    },
  });
  conversationId = conversation.id;

  const first = await prisma.e2eeEnvelope.create({
    data: {
      conversationId,
      senderId:  bob.user.id,
      seq:       1,
      content:   'opaque-history-1',
      kind:      'MESSAGE',
      createdAt: new Date('2026-10-20T10:00:00.000Z'),
    },
  });
  firstEnvelopeId = first.id;
  await prisma.e2eeEnvelope.createMany({
    data: [
      {
        conversationId,
        senderId:  alice.user.id,
        seq:       2,
        content:   'opaque-control',
        kind:      'CONTROL',
        createdAt: new Date('2026-10-20T10:01:00.000Z'),
      },
      {
        conversationId,
        senderId:  bob.user.id,
        seq:       3,
        content:   'opaque-history-3',
        kind:      'MESSAGE',
        createdAt: new Date('2026-10-20T10:02:00.000Z'),
      },
    ],
  });
});

after(async () => {
  if (prisma) {
    if (otpPhones.length) await prisma.otpCode.deleteMany({ where: { phone: { in: otpPhones } } });
    if (createdUserIds.length) {
      await prisma.conversation.deleteMany({ where: { participants: { some: { userId: { in: createdUserIds } } } } });
      await prisma.user.deleteMany({ where: { id: { in: createdUserIds } } });
    }
    await prisma.$disconnect();
  }
  await app?.close();
});

test('status reports what is still only ciphertext, in sequence order', async () => {
  const { alice } = global.__ctx;

  const status = await api(`/messages/${conversationId}/legacy-status`, { token: alice.token });

  assert.equal(status.status, 200, 'status accepted');
  assert.deepEqual(status.data, {
    total:       2,
    imported:    0,
    pending:     2,
    seqs:        [1, 3],
    nextAfterSeq: null,
  }, 'the control envelope is not a message and is not counted');
});

test('an imported message is sealed on disk and keeps its envelope author and time', async () => {
  const { alice, bob } = global.__ctx;
  const plaintext = `سلام از گذشته ${suffix}`;

  const imported = await api(`/messages/${conversationId}/legacy-import`, {
    method: 'POST',
    token:  alice.token,
    body:   { items: [{ seq: 1, type: 'text', text: plaintext }] },
  });

  assert.equal(imported.status, 201, 'import accepted');
  assert.deepEqual(imported.data, { imported: 1, skipped: 0, rejected: 0 });

  const row = await prisma.message.findFirst({
    where:  { conversationId, legacySeq: 1 },
    select: { id: true, text: true, senderId: true, legacyEnvelopeId: true, createdAt: true },
  });
  assert.ok(row, 'the row exists');
  assert.match(row.text, /^obx1\./, 'the imported text is sealed');
  assert.equal(row.text.includes(plaintext), false, 'and is not readable in the database');
  assert.equal(row.senderId, bob.user.id, 'the author is the envelope author, not the importer');
  assert.equal(row.legacyEnvelopeId, firstEnvelopeId);
  assert.equal(row.createdAt.toISOString(), '2026-10-20T10:00:00.000Z', 'the original time is kept');

  const envelope = await prisma.e2eeEnvelope.findUnique({ where: { id: firstEnvelopeId } });
  assert.ok(envelope.migratedAt instanceof Date, 'the envelope is marked as imported');
});

test('both members read the imported message through the API', async () => {
  const { alice, bob } = global.__ctx;
  const plaintext = `سلام از گذشته ${suffix}`;

  for (const member of [alice, bob]) {
    const history = await api(`/messages/groups/${conversationId}`, { token: member.token });
    assert.equal(history.status, 200, 'history accepted');
    const wire = history.data.find(message => message.legacySeq === 1);
    assert.ok(wire, 'the imported row is in the timeline');
    assert.equal(wire.text, plaintext, 'and opens for every member');
    assert.equal(wire.attachment, null, 'a text row carries no descriptor');
    assert.equal(wire.sender.id, bob.user.id, 'shown under its real author');
  }
});

test('sending the same history again stores nothing new', async () => {
  const { alice } = global.__ctx;

  const again = await api(`/messages/${conversationId}/legacy-import`, {
    method: 'POST',
    token:  alice.token,
    body:   { items: [{ seq: 1, type: 'text', text: 'دوباره' }] },
  });

  assert.equal(again.status, 201, 'a retry is accepted');
  assert.deepEqual(again.data, { imported: 0, skipped: 1, rejected: 0 });
  const count = await prisma.message.count({ where: { conversationId, legacySeq: 1 } });
  assert.equal(count, 1, 'still exactly one row');
});

test('controls and unknown sequences are rejected, not imported', async () => {
  const { alice } = global.__ctx;

  const refused = await api(`/messages/${conversationId}/legacy-import`, {
    method: 'POST',
    token:  alice.token,
    body:   {
      items: [
        { seq: 2, type: 'text', text: 'a control is not a message' },
        { seq: 99, type: 'text', text: 'no envelope exists here' },
      ],
    },
  });

  assert.deepEqual(refused.data, { imported: 0, skipped: 0, rejected: 2 });
  assert.equal(await prisma.message.count({ where: { conversationId, legacySeq: { in: [2, 99] } } }), 0);
});

test('a quote points at the row imported from the same stream', async () => {
  const { alice } = global.__ctx;
  const replyText = `پاسخ ${suffix}`;

  const imported = await api(`/messages/${conversationId}/legacy-import`, {
    method: 'POST',
    token:  alice.token,
    body:   { items: [{ seq: 3, type: 'text', text: replyText, replyToSeq: 1 }] },
  });
  assert.deepEqual(imported.data, { imported: 1, skipped: 0, rejected: 0 });

  const reply = await prisma.message.findFirst({ where: { conversationId, legacySeq: 3 }, select: { replyToId: true } });
  const target = await prisma.message.findFirst({ where: { conversationId, legacySeq: 1 }, select: { id: true } });
  assert.equal(reply.replyToId, target.id, 'the quote resolves to the imported row');

  const history = await api(`/messages/groups/${conversationId}`, { token: alice.token });
  const wire = history.data.find(message => message.legacySeq === 3);
  assert.equal(wire.replyTo?.id, target.id, 'the history carries the same quote');
  assert.equal(wire.replyTo?.text, `سلام از گذشته ${suffix}`, 'and its text opens');
});

test('a conversation with nothing left pending answers so', async () => {
  const { alice } = global.__ctx;

  const status = await api(`/messages/${conversationId}/legacy-status`, { token: alice.token });

  assert.deepEqual(status.data, {
    total:       2,
    imported:    2,
    pending:     0,
    seqs:        [],
    nextAfterSeq: null,
  });
});

test('someone outside the conversation may neither import nor read the status', async () => {
  const { carol } = global.__ctx;

  const imported = await api(`/messages/${conversationId}/legacy-import`, {
    method: 'POST',
    token:  carol.token,
    body:   { items: [{ seq: 3, type: 'text', text: 'not mine' }] },
  });
  assert.equal(imported.status, 403, 'import refused');

  const status = await api(`/messages/${conversationId}/legacy-status`, { token: carol.token });
  assert.equal(status.status, 403, 'status refused');
});
