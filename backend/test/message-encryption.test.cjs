const test = require('node:test');
const assert = require('node:assert/strict');

process.env.JWT_SECRET = 'test-secret-at-least-32-characters-long-000';
process.env.CONTENT_KEY = 'Y2ktb25seS1jb250ZW50LWtleS0zMi1ieXRlcy0wMDA=';

const { MessagesService } = require('../dist/messages/messages.service.js');
const { ContentCrypto } = require('../dist/common/content-crypto.service.js');

const CONVERSATION = '8e03f4a1-6f0c-4c1e-9d92-6f4a1b0c3d21';
const SENDER = 'user-1';
const cipher = new ContentCrypto();

function row(overrides = {}) {
  return {
    id:              'message-1',
    conversationId:  CONVERSATION,
    senderId:        SENDER,
    type:            'TEXT',
    text:            null,
    fileUrl:         null,
    fileName:        null,
    fileSize:        null,
    durationMs:      null,
    replyToId:       null,
    replyTo:         null,
    forwardedFrom:   null,
    editedAt:        null,
    deletedAt:       null,
    createdAt:       new Date('2026-10-25T10:00:00.000Z'),
    reactions:       [],
    sender:          { id: SENDER, username: 'sara', displayName: 'Sara', avatar: null },
    reads:           [],
    hides:           [],
    ...overrides,
  };
}

function fakePrisma({ e2ee = false, history = [], current = null } = {}) {
  const calls = { create: null, update: null };
  const prisma = {
    calls,
    conversation: {
      findUnique: async ({ where }) => ({ id: where.id, e2ee }),
      update:     async () => ({}),
    },
    conversationParticipant: {
      findUnique: async () => ({ role: 'MEMBER' }),
    },
    message: {
      findFirst: async () => ({ id: 'quoted-1' }),
      findMany:  async () => history,
      findUnique: async () => current,
      create: async ({ data }) => {
        calls.create = data;
        return row({ id: 'created-1', ...data });
      },
      update: async ({ data }) => {
        calls.update = data;
        return row({ ...current, ...data });
      },
    },
  };
  // The send is wrapped in a transaction; the in-memory fake has no rollback to
  // offer, so the callback runs against the same tables.
  prisma.$transaction = async (fn) => fn(prisma);
  return prisma;
}

function service(prisma) {
  return new MessagesService(prisma, { publishGroupUpdated() {} }, cipher);
}

test('a sent message is stored sealed and comes back readable', async () => {
  const prisma = fakePrisma();
  const wire = await service(prisma).sendToConversation(CONVERSATION, SENDER, {
    type: 'TEXT',
    text: 'سلام دنیا 👋',
  });

  assert.match(prisma.calls.create.text, /^obx1\./);
  assert.equal(prisma.calls.create.text.includes('سلام'), false);
  assert.equal(wire.text, 'سلام دنیا 👋');
});

test('a legacy encrypted conversation accepts a normal send', async () => {
  const prisma = fakePrisma({ e2ee: true });
  const wire = await service(prisma).sendToConversation(CONVERSATION, SENDER, {
    type: 'TEXT',
    text: 'پیام تازه',
  });

  assert.match(prisma.calls.create.text, /^obx1\./);
  assert.equal(wire.text, 'پیام تازه');
});

test('history decrypts sealed rows and leaves legacy plaintext readable', async () => {
  const sealed = cipher.sealText(CONVERSATION, 'پیام رمزشده');
  const prisma = fakePrisma({
    history: [
      row({ id: 'new', text: sealed, createdAt: new Date('2026-10-25T11:00:00.000Z') }),
      row({ id: 'old', text: 'پیام قدیمی', createdAt: new Date('2026-10-24T11:00:00.000Z') }),
    ],
  });

  const wire = await service(prisma).getConversationMessages(CONVERSATION, SENDER);

  assert.equal(wire[1]?.text, 'پیام رمزشده');
  assert.equal(wire[0]?.text, 'پیام قدیمی');
});

test('an edit is sealed at rest and returned readable', async () => {
  const current = row({ id: 'message-1', text: cipher.sealText(CONVERSATION, 'پیش از ویرایش') });
  const prisma = fakePrisma({ e2ee: true, current });

  const wire = await service(prisma).editMessage('message-1', SENDER, 'پس از ویرایش');

  assert.match(prisma.calls.update.text, /^obx1\./);
  assert.equal(wire.text, 'پس از ویرایش');
});

test('a quoted message is decrypted with the same key', async () => {
  const quoted = {
    id: 'quoted-1', type: 'TEXT', text: cipher.sealText(CONVERSATION, 'نقل قول'),
    fileName: null, deletedAt: null,
    sender: { id: 'user-2', username: 'ali', displayName: 'Ali' },
  };
  const prisma = fakePrisma({ history: [row({ text: 'پاسخ', replyTo: quoted })] });

  const [wire] = await service(prisma).getConversationMessages(CONVERSATION, SENDER);

  assert.equal(wire.replyTo.text, 'نقل قول');
});
