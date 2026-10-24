// Acting on a whole message: edit, delete for everyone, delete for me.
//
// These are the three paths where the server stays the authority over a
// plaintext transcript — it validates the caller against the row it already
// has, rewrites or empties that row, and tells every participant's room what
// changed. Encrypted chats have no such row, so the last case here proves the
// server refuses to become one.
require('reflect-metadata');

const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');

process.env.NODE_ENV = process.env.NODE_ENV || 'test';
process.env.JWT_SECRET = process.env.JWT_SECRET || 'openbridge-test-secret-at-least-32-characters-long';
process.env.AUTH_OTP_REQUEST_LIMIT = process.env.AUTH_OTP_REQUEST_LIMIT || '50';
process.env.AUTH_OTP_VERIFY_LIMIT = process.env.AUTH_OTP_VERIFY_LIMIT || '50';
process.env.AUTH_SIGNUP_LIMIT = process.env.AUTH_SIGNUP_LIMIT || '50';

const { NestFactory } = require('@nestjs/core');
const { ValidationPipe } = require('@nestjs/common');
const { io } = require('socket.io-client');
const { PrismaClient } = require('@prisma/client');
const { AppModule } = require('../dist/app.module');
const { isOriginAllowed } = require('../dist/config/env');

const API_PREFIX = '/api';

const suffix = `${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`;
const createdUserIds = [];
const otpPhones = [];
const sockets = {};

let app;
let prisma;
let origin;
let group;

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

// History orders by createdAt alone, so two messages written in the same
// millisecond could come back in either order. A test that asserts an order
// leaves a beat between its sends.
const tick = (ms = 12) => new Promise(resolve => setTimeout(resolve, ms));

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
      firstName:   'Actions',
      lastName:    label,
    },
  });
  assert.equal(created.status, 201, `signup ${label}`);
  createdUserIds.push(created.data.user.id);
  return created.data;
}

function connectSocket(token) {
  return new Promise(resolve => {
    const socket = io(origin, { auth: { token }, transports: ['websocket'], reconnection: false, timeout: 5000 });
    const timer = setTimeout(() => resolve({ socket, connected: false }), 8000);
    socket.on('connect', () => { clearTimeout(timer); resolve({ socket, connected: true }); });
    socket.on('connect_error', () => { clearTimeout(timer); resolve({ socket, connected: false }); });
  });
}

function emitAck(socket, event, payload, ms = 6000) {
  return new Promise(resolve => {
    const timer = setTimeout(() => resolve({ timeout: true }), ms);
    socket.emit(event, payload, result => { clearTimeout(timer); resolve(result); });
  });
}

function waitEvent(socket, event, ms = 1500) {
  return new Promise(resolve => {
    const handler = data => {
      clearTimeout(timer);
      socket.off(event, handler);
      resolve(data);
    };
    const timer = setTimeout(() => {
      socket.off(event, handler);
      resolve(null);
    }, ms);
    socket.on(event, handler);
  });
}

// The target message's own broadcast may still be in flight, so a reply test
// waits for the text it sent rather than the first envelope on the socket.
function waitMessageText(socket, text, ms = 4000) {
  return new Promise(resolve => {
    const handler = data => {
      if (data?.text !== text) return;
      clearTimeout(timer);
      socket.off('message:new', handler);
      resolve(data);
    };
    const timer = setTimeout(() => {
      socket.off('message:new', handler);
      resolve(null);
    }, ms);
    socket.on('message:new', handler);
  });
}

// A group message, sent through the socket the way a client sends it, and
// returned as the id every later action will name.
async function sendGroupText(who, text) {
  const ack = await emitAck(who, 'message:send', { conversationId: group.id, type: 'text', text });
  assert.equal(ack.ok, true, `group send: ${text}`);
  return ack.id;
}

async function groupHistory(token) {
  const response = await api(`/messages/groups/${group.id}`, { token });
  assert.equal(response.status, 200, 'group history');
  return response.data;
}

async function groupUnread(token) {
  const response = await api('/messages/groups', { token });
  assert.equal(response.status, 200, 'group list');
  return response.data.find(g => g.id === group.id).unread;
}

function findMessage(messages, id) {
  return messages.find(m => m.id === id);
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
  // Not in the group at all, so the outsider cases are about a real account
  // rather than a made-up id.
  const dave = await createUser('dave');
  global.__ctx = { alice, bob, carol, dave };

  const created = await api('/messages/groups', {
    method: 'POST',
    token:  alice.token,
    body:   { name: `Actions group ${suffix}`, memberIds: [bob.user.id, carol.user.id] },
  });
  assert.equal(created.status, 201, 'group creation');
  group = created.data;

  for (const [name, session] of Object.entries({ alice, bob, carol, dave })) {
    const connected = await connectSocket(session.token);
    assert.equal(connected.connected, true, `${name} socket`);
    sockets[name] = connected.socket;
  }
  // Alice's second window: an action on her own message has to reach the other
  // device of the same account, not only the peers.
  const aliceAgain = await connectSocket(alice.token);
  assert.equal(aliceAgain.connected, true, 'alice second socket');
  sockets.aliceDeviceTwo = aliceAgain.socket;
});

after(async () => {
  for (const socket of Object.values(sockets)) socket?.disconnect();
  if (prisma) {
    if (otpPhones.length) await prisma.otpCode.deleteMany({ where: { phone: { in: otpPhones } } });
    if (createdUserIds.length) {
      await prisma.conversation.deleteMany({
        where: { participants: { some: { userId: { in: createdUserIds } } } },
      });
      await prisma.user.deleteMany({ where: { id: { in: createdUserIds } } });
    }
    await prisma.$disconnect();
  }
  await app?.close();
});

test('the sender edits their text and every window of every member is told', async () => {
  const { alice, bob } = global.__ctx;
  const id = await sendGroupText(sockets.alice, 'original wording');

  const announced = waitEvent(sockets.bob, 'message:edited');
  const fromOtherDevice = waitEvent(sockets.aliceDeviceTwo, 'message:edited');
  const ack = await emitAck(sockets.alice, 'message:edit', { messageId: id, text: '  corrected wording  ' });

  assert.equal(ack.ok, true, 'edit accepted');
  assert.equal(ack.message.text, 'corrected wording', 'trimmed text comes back');
  assert.equal(ack.message.deleted, false, 'an edit is not a deletion');
  assert.ok(ack.message.editedAt, 'the edit is stamped');
  assert.equal(ack.message.id, id, 'same message');

  const toBob = await announced;
  assert.equal(toBob?.id, id, 'peer told which message');
  assert.equal(toBob?.text, 'corrected wording', 'peer told the new text');
  assert.ok(toBob?.editedAt, 'peer told it was edited');
  const toSelf = await fromOtherDevice;
  assert.equal(toSelf?.text, 'corrected wording', "sender's other device converges");

  for (const token of [alice.token, bob.token]) {
    const history = await groupHistory(token);
    assert.equal(findMessage(history, id).text, 'corrected wording', 'history serves the new text');
    assert.ok(findMessage(history, id).editedAt, 'history marks it edited');
  }

  const row = await prisma.message.findUnique({ where: { id }, select: { deletedAt: true } });
  assert.equal(row.deletedAt, null, 'an edit is not a deletion in the database');
});

test('a direct edit names the other participant so an open chat can place it', async () => {
  const { alice, bob } = global.__ctx;
  const sent = await emitAck(sockets.alice, 'message:send', {
    toId: bob.user.id, type: 'text', text: 'direct original',
  });
  assert.equal(sent.ok, true, 'direct seed');

  const announced = waitEvent(sockets.bob, 'message:edited');
  const edit = await emitAck(sockets.alice, 'message:edit', { messageId: sent.id, text: 'direct corrected' });
  assert.equal(edit.ok, true, 'edit accepted');

  const wire = await announced;
  assert.equal(wire?.text, 'direct corrected', 'peer told the new text');
  // Without this field the peer's open direct chat cannot recognise the edit as
  // belonging to it and drops the update.
  assert.equal(wire?.receiverId, bob.user.id, 'the broadcast names the other side of the chat');
});

test('an edit is refused for anyone but the sender, and for anything but live text', async () => {
  const { bob, dave } = global.__ctx;
  const textId = await sendGroupText(sockets.alice, 'only I rewrite this');

  const byPeer = await emitAck(sockets.bob, 'message:edit', { messageId: textId, text: 'not mine to change' });
  assert.equal(byPeer.ok, false, 'a peer cannot edit');
  assert.match(byPeer.error, /فرستنده/, 'and says whose message it was');

  const byOutsider = await emitAck(sockets.dave, 'message:edit', { messageId: textId, text: 'not my chat' });
  assert.equal(byOutsider.ok, false, 'a non-member cannot edit');
  assert.match(byOutsider.error, /عضو/, 'and is refused as a non-member');

  const imageId = (await emitAck(sockets.alice, 'message:send', {
    conversationId: group.id, type: 'image', fileUrl: '/uploads/placeholder.png', fileName: 'p.png', fileSize: 12,
  })).id;
  const editImage = await emitAck(sockets.alice, 'message:edit', { messageId: imageId, text: 'a caption is not an edit' });
  assert.equal(editImage.ok, false, 'only text messages are editable');
  assert.match(editImage.error, /متنی/, 'and the refusal names the kind');

  const empty = await emitAck(sockets.alice, 'message:edit', { messageId: textId, text: '   ' });
  assert.equal(empty.ok, false, 'whitespace is not a message');

  const tooLong = await emitAck(sockets.alice, 'message:edit', { messageId: textId, text: 'x'.repeat(4001) });
  assert.equal(tooLong.ok, false, 'the send limit is also the edit limit');

  const unknown = await emitAck(sockets.alice, 'message:edit', { messageId: 'no-such-id', text: 'anything' });
  assert.equal(unknown.ok, false, 'an id the server does not have is refused');

  // Nothing above changed anything: the text is still the one its sender wrote.
  const history = await groupHistory(bob.token);
  assert.equal(findMessage(history, textId).text, 'only I rewrite this', 'refused edits leave no trace');
});

test('delete for everyone empties the row and reaches every member', async () => {
  const { alice, bob, carol } = global.__ctx;
  const id = await sendGroupText(sockets.alice, 'this one goes away');
  await emitAck(sockets.bob, 'reaction:add', { messageId: id, emoji: '👍' });
  await emitAck(sockets.alice, 'reaction:add', { messageId: id, emoji: '❤️' });

  const updatedBefore = await prisma.conversation.findUnique({
    where: { id: group.id }, select: { updatedAt: true },
  });

  const toBob = waitEvent(sockets.bob, 'message:deleted');
  const toCarol = waitEvent(sockets.carol, 'message:deleted');
  const ack = await emitAck(sockets.alice, 'message:delete', { messageId: id, scope: 'everyone' });

  assert.equal(ack.ok, true, 'the sender deletes for everyone');
  assert.equal(ack.scope, 'everyone', 'scope echoes back');
  assert.equal(ack.conversationId, group.id, 'the conversation comes from the row');

  for (const event of [await toBob, await toCarol]) {
    assert.equal(event?.messageId, id, 'every member is told which message');
    assert.equal(event?.scope, 'everyone', 'and that it is gone for all of them');
  }

  for (const token of [alice.token, bob.token, carol.token]) {
    const tombstone = findMessage(await groupHistory(token), id);
    assert.ok(tombstone, 'the row keeps its place in the timeline');
    assert.equal(tombstone.deleted, true, 'and is a tombstone for everyone');
    assert.equal(tombstone.text, null, 'no text survives');
    assert.equal(tombstone.fileUrl, null, 'no file survives');
    assert.equal(tombstone.fileName, null, 'no name survives');
    assert.equal(tombstone.reactions.length, 0, 'and no reactions');
  }

  const row = await prisma.message.findUnique({ where: { id }, select: { text: true, fileUrl: true, deletedAt: true } });
  assert.ok(row.deletedAt, 'the deletion is stamped');
  assert.equal(row.text, null, 'the stored text is gone, not only hidden');
  assert.equal(row.fileUrl, null, 'and so is the stored file');
  assert.equal(await prisma.reaction.count({ where: { messageId: id } }), 0, 'reactions are gone from the database');
  assert.equal(await prisma.messageRead.count({ where: { messageId: id } }), 0, 'read receipts are gone too');

  const updatedAfter = await prisma.conversation.findUnique({
    where: { id: group.id }, select: { updatedAt: true },
  });
  assert.equal(String(updatedAfter.updatedAt), String(updatedBefore.updatedAt), 'a delete is not new activity');

  // A tombstone is not a message any more: nothing may be done to it.
  assert.equal((await emitAck(sockets.alice, 'message:edit', { messageId: id, text: 'back again' })).ok, false, 'no edit');
  assert.equal((await emitAck(sockets.bob, 'reaction:add', { messageId: id, emoji: '🎉' })).ok, false, 'no reaction');
  assert.equal((await emitAck(sockets.bob, 'message:delete', { messageId: id, scope: 'me' })).ok, false, 'no second delete');
});

test('delete for me hides the row from that account alone', async () => {
  const { alice, bob, carol } = global.__ctx;
  const id = await sendGroupText(sockets.alice, 'only bob loses this one');

  const outsider = await emitAck(sockets.dave, 'message:delete', { messageId: id, scope: 'me' });
  assert.equal(outsider.ok, false, 'an outsider cannot hide a message of this chat');
  assert.match(outsider.error, /عضو/, 'and is refused as a non-member');

  const toBob = waitEvent(sockets.bob, 'message:deleted');
  const toAlice = waitEvent(sockets.alice, 'message:deleted', 600);
  const toCarol = waitEvent(sockets.carol, 'message:deleted', 600);
  const ack = await emitAck(sockets.bob, 'message:delete', { messageId: id, scope: 'me' });

  assert.equal(ack.ok, true, 'any participant may hide their own view');
  assert.deepEqual(await toBob, { messageId: id, conversationId: group.id, scope: 'me' }, 'the actor is told');
  assert.equal(await toAlice, null, 'the sender hears nothing');
  assert.equal(await toCarol, null, 'and neither does another member');

  assert.ok(findMessage(await groupHistory(alice.token), id), 'the sender still has it');
  assert.ok(findMessage(await groupHistory(carol.token), id), 'and so does the rest of the group');
  assert.equal(findMessage(await groupHistory(bob.token), id), undefined, 'only bob lost it');

  const hiddenRow = await prisma.message.findUnique({
    where:  { id },
    select: { text: true, deletedAt: true, hides: { select: { userId: true } } },
  });
  assert.equal(hiddenRow.deletedAt, null, 'the row itself is untouched');
  assert.equal(hiddenRow.text, 'only bob loses this one', 'with its text intact');
  assert.deepEqual(hiddenRow.hides, [{ userId: bob.user.id }], 'one hide, for one viewer');

  // An id you hid is not on your screen, so it is not something you can act on.
  assert.equal((await emitAck(sockets.bob, 'reaction:add', { messageId: id, emoji: '👍' })).ok, false, 'no reaction to a hidden row');
  assert.equal((await emitAck(sockets.bob, 'message:edit', { messageId: id, text: 'no' })).ok, false, 'no edit of a hidden row');
  // Alice still owns the message, so hiding it from bob does not disarm her.
  assert.equal((await emitAck(sockets.alice, 'message:delete', { messageId: id, scope: 'everyone' })).ok, true, 'the sender can still delete it');
});

test('a hidden message does not raise a badge and does not spend a page slot', async () => {
  const { alice, bob, carol } = global.__ctx;

  const older = await sendGroupText(sockets.alice, 'first of the page');
  await tick();
  const hidden = await sendGroupText(sockets.alice, 'bob will not see this');
  await tick();
  const newest = await sendGroupText(sockets.alice, 'newest of the page');
  await tick();

  const before = await groupUnread(bob.token);
  assert.ok(before >= 1, 'the unread badge counts what alice just sent');

  assert.equal((await emitAck(sockets.bob, 'message:delete', { messageId: hidden, scope: 'me' })).ok, true, 'hidden for bob');
  const after = await groupUnread(bob.token);
  assert.equal(after, before - 1, 'and the badge drops by exactly that one');
  assert.equal(await groupUnread(carol.token), before, 'carol still counts it');
  assert.equal(await groupUnread(alice.token), 0, 'the sender never counted it');

  // Paging: a page is the two newest rows, returned oldest-first for the UI. If
  // a hidden row still consumed a slot, the first page would carry the gap and
  // the second page would come back one message short.
  const firstPage = await api(`/messages/groups/${group.id}?take=2`, { token: bob.token });
  assert.deepEqual(firstPage.data.map(m => m.id), [older, newest], 'the page skips the hidden row entirely');
  const secondPage = await api(`/messages/groups/${group.id}?take=2&skip=2`, { token: bob.token });
  assert.equal(secondPage.data.length, 2, 'a hidden row does not spend a slot');
  assert.ok(!secondPage.data.some(m => m.id === hidden), 'and never appears on a later page');
});

test('an encrypted direct chat keeps having no plaintext row to edit', async () => {
  const { alice, bob } = global.__ctx;

  const sent = await emitAck(sockets.alice, 'message:send', { toId: bob.user.id, type: 'text', text: 'before encryption' });
  assert.equal(sent.ok, true, 'a plaintext message lands first');

  const enabled = await api('/messages/e2ee/direct', { method: 'POST', token: alice.token, body: { userId: bob.user.id } });
  assert.equal(enabled.status, 201, 'the chat opts into encryption');
  const conversationId = enabled.data.conversationId;

  const edit = await emitAck(sockets.alice, 'message:edit', { messageId: sent.id, text: 'rewritten in the clear' });
  assert.equal(edit.ok, false, 'a legacy row in an encrypted chat is not editable');
  assert.match(edit.error, /رمزنگاری/, 'and the refusal says why');

  // Deleting it is a different matter: the row is already readable, so removing
  // it for everyone is a service the server can actually perform.
  const remove = await emitAck(sockets.alice, 'message:delete', { messageId: sent.id, scope: 'everyone' });
  assert.equal(remove.ok, true, 'delete for everyone still works on a legacy row');

  const history = await api(`/messages/${alice.user.id}`, { token: bob.token });
  assert.equal(history.status, 200, `direct history: ${JSON.stringify(history.data)}`);
  const tombstone = findMessage(history.data, sent.id);
  assert.equal(tombstone.deleted, true, 'the peer reads a tombstone');
  assert.equal(tombstone.text, null, 'with nothing left of the text');

  const row = await prisma.message.findUnique({ where: { id: sent.id }, select: { conversationId: true } });
  assert.equal(row.conversationId, conversationId, 'the conversation came from the row');
});

test('a row you hid for yourself is not yours to delete for everyone', async () => {
  const { bob } = global.__ctx;
  const id = await sendGroupText(sockets.bob, 'bob wrote this, then hid it');

  assert.equal((await emitAck(sockets.bob, 'message:delete', { messageId: id, scope: 'me' })).ok, true, 'hidden for its own sender');
  assert.equal((await emitAck(sockets.bob, 'message:delete', { messageId: id, scope: 'everyone' })).ok, false, 'and not deletable for everyone from there');
  assert.equal((await emitAck(sockets.bob, 'message:edit', { messageId: id, text: 'no' })).ok, false, 'nor editable');

  // The hide is one row per pair, so asking twice cannot stack a second one.
  assert.equal((await emitAck(sockets.bob, 'message:delete', { messageId: id, scope: 'me' })).ok, true, 'hiding twice is harmless');
  assert.equal(await prisma.messageHide.count({ where: { messageId: id } }), 1, 'and leaves one hide');

  const tombstone = findMessage(await groupHistory(global.__ctx.alice.token), id);
  assert.equal(tombstone.deleted, false, 'the rest of the group still has the live message');
});

test('a reply carries its quote and a forward names its source', async () => {
  const { alice, bob } = global.__ctx;
  const targetId = await sendGroupText(sockets.alice, 'original for reply');

  const announced = waitMessageText(sockets.bob, 'answering you');
  const ack = await emitAck(sockets.alice, 'message:send', {
    conversationId: group.id,
    type: 'text',
    text: 'answering you',
    replyToId: targetId,
  });
  assert.equal(ack.ok, true, 'reply accepted');
  const reply = await announced;
  assert.equal(reply?.replyTo?.id, targetId, 'the peer receives the quoted id');
  assert.equal(reply?.replyTo?.text, 'original for reply', 'and the quote text');
  assert.equal(reply?.replyTo?.sender?.id, alice.user.id, 'and the quoted author');
  assert.equal(reply?.replyTo?.deleted, false);

  for (const token of [alice.token, bob.token]) {
    const history = await groupHistory(token);
    const stored = findMessage(history, ack.id);
    assert.equal(stored.replyTo.id, targetId, 'history serves the quote too');
    assert.equal(stored.replyTo.text, 'original for reply');
  }

  const forwardedSeen = waitMessageText(sockets.bob, 'forwarded words');
  const forwarded = await emitAck(sockets.alice, 'message:send', {
    conversationId: group.id,
    type: 'text',
    text: 'forwarded words',
    forwardedFrom: '  Alice source  ',
  });
  assert.equal(forwarded.ok, true, 'forward accepted');
  const seen = await forwardedSeen;
  assert.equal(seen?.id, forwarded.id);
  assert.equal(seen?.forwardedFrom, 'Alice source', 'the source label is trimmed');
  assert.equal(seen?.text, 'forwarded words', 'the forwarded copy carries the text');
});

test('a reply is refused when its target is in another chat or is a tombstone', async () => {
  const { alice, dave } = global.__ctx;

  const otherChat = await emitAck(sockets.alice, 'message:send', {
    toId: dave.user.id, type: 'text', text: 'a message in another conversation',
  });
  assert.equal(otherChat.ok, true, 'direct seed');
  const cross = await emitAck(sockets.alice, 'message:send', {
    conversationId: group.id, type: 'text', text: 'quoting the wrong chat', replyToId: otherChat.id,
  });
  assert.equal(cross.ok, false, 'a quote cannot reach into another conversation');
  assert.match(cross.error, /نقل‌شده/, 'and says the quoted message was not found');

  const doomed = await sendGroupText(sockets.alice, 'this will be deleted');
  assert.equal((await emitAck(sockets.alice, 'message:delete', { messageId: doomed, scope: 'everyone' })).ok, true);
  const toTombstone = await emitAck(sockets.alice, 'message:send', {
    conversationId: group.id, type: 'text', text: 'quoting a tombstone', replyToId: doomed,
  });
  assert.equal(toTombstone.ok, false, 'a tombstone is not replyable');
});
