// Real cryptography over the real server: two MLS clients, one backend.
//
// The delivery-layer suite (security.e2e.cjs) deliberately uses fake base64
// blobs, because that service must not care what it carries. This file is the
// other half: it runs the actual client core from shared/e2ee against the
// booted API and proves the claim the whole design rests on — messages reach
// the peer as text and reach the server as ciphertext nobody holding only the
// database can read.
require('reflect-metadata');

const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');

process.env.NODE_ENV = process.env.NODE_ENV || 'test';
process.env.JWT_SECRET = process.env.JWT_SECRET || 'openbridge-test-secret-at-least-32-characters-long';
process.env.AUTH_OTP_REQUEST_LIMIT = process.env.AUTH_OTP_REQUEST_LIMIT || '50';
process.env.AUTH_OTP_VERIFY_LIMIT = process.env.AUTH_OTP_VERIFY_LIMIT || '50';
process.env.AUTH_SIGNUP_LIMIT = process.env.AUTH_SIGNUP_LIMIT || '50';
// A real KeyPackage is ~700 bytes of base64 and a Welcome with its ratchet tree
// is over a kilobyte, so the caps have to fit genuine MLS material here.
process.env.E2EE_CLAIM_LIMIT = process.env.E2EE_CLAIM_LIMIT || '40';
process.env.E2EE_REGISTER_LIMIT = process.env.E2EE_REGISTER_LIMIT || '300';
process.env.E2EE_MAX_PACKAGES_PER_DEVICE = process.env.E2EE_MAX_PACKAGES_PER_DEVICE || '12';

const { NestFactory } = require('@nestjs/core');
const { ValidationPipe } = require('@nestjs/common');
const { io } = require('socket.io-client');
const { PrismaClient } = require('@prisma/client');
const { AppModule } = require('../dist/app.module');
const { isOriginAllowed } = require('../dist/config/env');

const API_PREFIX = '/api';
// The client core is ESM and lives with the web app it is written for; a CJS
// test reaches it through dynamic import so one copy serves both.
const SHARED = '../../shared/e2ee/';

const suffix = `${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`;
const createdUserIds = [];
const otpPhones = [];
const live = [];

let app;
let prisma;
let origin;
let core;

async function loadCore() {
  if (!core) {
    const client = await import(`${SHARED}client.js`);
    const stores = await import(`${SHARED}stores.js`);
    core = { createE2eeClient: client.createE2eeClient, memoryStore: stores.memoryStore };
  }
  return core;
}

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
  otpPhones.push(freshPhone());
  const phone = otpPhones[otpPhones.length - 1];
  const requested = await api('/auth/otp/request', { method: 'POST', body: { phone } });
  const verified = await api('/auth/otp/verify', { method: 'POST', body: { phone, code: requested.data.testCode } });
  const created = await api('/auth/signup', {
    method: 'POST',
    body: {
      signupToken: verified.data.signupToken,
      username: `e2e_${suffix}_${label}`,
      firstName: 'Encrypted',
      lastName: label,
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

function emitAck(socket, event, payload, ms = 8000) {
  return new Promise(resolve => {
    const timer = setTimeout(() => resolve({ timeout: true }), ms);
    socket.emit(event, payload, result => { clearTimeout(timer); resolve(result); });
  });
}

async function waitUntil(read, describe, ms = 20_000) {
  const deadline = Date.now() + ms;
  for (;;) {
    const value = await read();
    if (value) return value;
    if (Date.now() > deadline) assert.fail(`timed out waiting for ${describe}`);
    await new Promise(resolve => setTimeout(resolve, 60));
  }
}

/** A stored row, shaped the way the `e2ee:envelope` event delivers it. */
const asEvent = (row, overrides = {}) => ({
  id: row.id,
  conversationId: row.conversationId,
  seq: row.seq,
  senderId: row.senderId,
  content: row.content,
  createdAt: row.createdAt.toISOString(),
  ...overrides,
});

/**
 * One running client: a device store, a socket-backed transport and the shared
 * client core. Two of these for one account are two devices, because the
 * device id lives in the store.
 */
async function makeClient(session, { store } = {}) {
  const { createE2eeClient, memoryStore } = await loadCore();
  const { socket, connected } = await connectSocket(session.token);
  assert.equal(connected, true, 'client socket connects');
  const listeners = new Set();
  socket.on('e2ee:envelope', envelope => listeners.forEach(handler => handler(envelope)));

  // The core hands API-root-relative paths with no leading slash; every caller
  // in this file goes through here so both spellings work.
  const toPath = (path) => `/${String(path).replace(/^\/+/, '')}`;
  const call = async (path, options) => {
    const response = await api(toPath(path), { token: session.token, ...options });
    if (response.status >= 400) {
      throw Object.assign(new Error(response.data.message || `${path} failed`), { status: response.status });
    }
    return response.data;
  };

  const transport = {
    api: (path, options = {}) => call(path, options),
    async append(conversationId, content) {
      const ack = await emitAck(socket, 'e2ee:append', { conversationId, content });
      if (!ack || ack.ok === false) throw new Error(ack?.error || 'append was refused');
      return ack;
    },
    fetchEnvelopes: (conversationId, afterSeq, take) =>
      call(`/messages/${conversationId}/envelopes?afterSeq=${afterSeq}&take=${take}`),
    async markRead(conversationId, upToSeq) {
      const ack = await emitAck(socket, 'e2ee:read', { conversationId, upToSeq });
      if (!ack || ack.ok === false) throw new Error(ack?.error || 'read mark was refused');
      return ack;
    },
    onEnvelope: handler => {
      listeners.add(handler);
      return () => listeners.delete(handler);
    },
  };

  const active = store ?? memoryStore();
  const client = await createE2eeClient({
    store: active,
    transport,
    me: session.user,
    label: `test-${suffix}`,
    // Key generation is the slow part of this suite; a pool of two is enough to
    // cover two devices of one peer and still refill.
    poolSize: 2,
    refillAt: 1,
  });
  const handle = { client, store: active, socket, transport, session, listeners };
  live.push(handle);
  return handle;
}

before(async () => {
  app = await NestFactory.create(AppModule, { logger: false });
  app.setGlobalPrefix('api');
  app.useGlobalPipes(new ValidationPipe({ whitelist: true, transform: true }));
  app.enableCors({ origin: (requestOrigin, callback) => callback(null, isOriginAllowed(requestOrigin)), credentials: true });
  await app.listen(0);
  origin = `http://127.0.0.1:${app.getHttpServer().address().port}`;
  prisma = new PrismaClient();
});

after(async () => {
  for (const handle of live) {
    handle.client.close();
    handle.socket.disconnect();
  }
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

let alice;
let bob;
let conversationId;

test('two clients open an encrypted chat and the server stores only ciphertext', async () => {
  alice = await makeClient(await createUser('alice'));
  bob = await makeClient(await createUser('bob'));

  // Both devices have to be registered and pooled before anyone can be added,
  // so asking for the pool is the first thing a session does.
  assert.equal((await alice.client.devices())[0].availableKeyPackages > 0, true, 'alice has a key pool');
  assert.equal((await bob.client.devices())[0].availableKeyPackages > 0, true, 'bob has a key pool');

  const opened = await alice.client.openDirect(bob.session.user.id);
  conversationId = opened.conversationId;
  assert.match(conversationId, /-/g, 'a conversation id came back');

  // Bob never created anything: the Welcome is envelope number one of a
  // conversation the server already numbered for him.
  const status = await waitUntil(async () => {
    const current = await bob.client.status(conversationId);
    return current.open ? current : null;
  }, 'bob to hold the group');
  assert.deepEqual(status.members.sort(), [alice.session.user.id, bob.session.user.id].sort(), 'the tree knows both identities');

  const text = 'سلام، این فقط بین ماست 🔐';
  const sent = await alice.client.send(conversationId, text);
  assert.equal(sent.seq, 2, 'the first chat message follows the welcome');

  const received = await waitUntil(async () => {
    const history = await bob.client.history(conversationId);
    return history.find(message => message.text === text) ?? null;
  }, 'bob to decrypt the message');
  assert.equal(received.senderId, alice.session.user.id, 'the sender is the one the group knows');
  assert.deepEqual((await alice.client.history(conversationId)).map(message => message.text), [text], 'the sender keeps her own text');

  const rows = await prisma.e2eeEnvelope.findMany({ where: { conversationId }, orderBy: { seq: 'asc' } });
  assert.deepEqual(rows.map(row => row.seq), [1, 2], 'two envelopes, gapless');
  assert.equal(await prisma.message.count({ where: { conversationId } }), 0, 'no plaintext row was ever written');
  for (const row of rows) {
    const bytes = Buffer.from(row.content, 'base64');
    assert.ok(bytes.length > 0, 'the blob is real bytes');
    assert.equal(bytes.includes(text, 'utf8'), false, `envelope ${row.seq} does not carry the text`);
    assert.equal(bytes.includes('سلام', 'utf8'), false, `envelope ${row.seq} does not carry even a word`);
  }

  // What an honest API caller can read is the same opaque blob a database dump
  // gives: the HTTP history endpoint is not a window into content.
  const viaHttp = await api(`/messages/${conversationId}/envelopes`, { token: bob.session.token });
  assert.equal(viaHttp.status, 200, 'the member can list envelopes');
  assert.deepEqual(viaHttp.data.map(envelope => envelope.content), rows.map(row => row.content), 'the same bytes either way');

  // The chat list identifies a direct conversation by the peer account: there
  // is no conversation id and no field that could hold a message.
  const list = await api('/messages/conversations', { token: bob.session.token });
  const entry = list.data.find(conversation => conversation.user.id === alice.session.user.id);
  assert.equal(entry.e2ee, true, 'the chat list says this one is encrypted');
  assert.deepEqual(Object.keys(entry).sort(), ['e2ee', 'unread', 'updatedAt', 'user'], 'and its entry carries no field that could hold text');
});

test('a reloaded device keeps the conversation: state survives storage', async () => {
  // A browser refresh: the same device store, a new socket, a new client object.
  alice.client.close();
  alice.socket.disconnect();
  const previous = alice.store;
  alice = await makeClient(alice.session, { store: previous });

  const status = await alice.client.status(conversationId);
  assert.equal(status.open, true, 'the group was read back from storage');
  assert.equal(status.appliedSeq, 2, 'and the stream position with it');

  const text = 'بعد از ریلود هم کار می‌کند';
  await alice.client.send(conversationId, text);
  await waitUntil(async () => {
    const history = await bob.client.history(conversationId);
    return history.find(message => message.text === text) ?? null;
  }, 'bob to decrypt a message from a resumed sender');
  assert.equal((await alice.client.history(conversationId)).length, 2, 'the resumed sender keeps both of her messages');
});

test('every active device of a user is invited and can read the same chat', async () => {
  const sender = await makeClient(await createUser('msender'));
  const receiver = await makeClient(await createUser('mreceiver'));
  // Every device has to be on the server before the group is written: a device
  // registered afterwards was not addressed in the Welcome and cannot reach
  // back into a conversation that already started.
  const senderSecond = await makeClient(sender.session);
  const receiverSecond = await makeClient(receiver.session);
  await Promise.all([
    sender.client.ready(),
    senderSecond.client.ready(),
    receiver.client.ready(),
    receiverSecond.client.ready(),
  ]);
  assert.equal((await sender.client.devices()).length, 2, 'the sender has two active devices');
  assert.equal((await receiver.client.devices()).length, 2, 'the receiver has two active devices');

  const chat = await sender.client.openDirect(receiver.session.user.id);
  const text = 'هر چهار دستگاه می‌خوانند';
  await sender.client.send(chat.conversationId, text);

  for (const handle of [receiver, receiverSecond, senderSecond]) {
    await waitUntil(async () => {
      const history = await handle.client.history(chat.conversationId);
      return history.find(message => message.text === text) ?? null;
    }, 'every device of both accounts to decrypt');
  }
  // One Welcome carried all four invitations: the server relayed a single opaque
  // envelope and each device found its own key-package reference inside it.
  const rows = await prisma.e2eeEnvelope.findMany({ where: { conversationId: chat.conversationId }, orderBy: { seq: 'asc' } });
  assert.equal(rows.length, 2, 'one welcome for four devices');
  assert.equal((await receiverSecond.client.status(chat.conversationId)).appliedSeq, 2, 'all of them walked to the same mark');
});

test('an envelope that arrives late is fetched in order, and a duplicate is ignored', async () => {
  const solo = await makeClient(alice.session);
  const peer = await makeClient(await createUser('dave'));
  await Promise.all([solo.client.ready(), peer.client.ready()]);
  const chat = await solo.client.openDirect(peer.session.user.id);
  await waitUntil(async () => ((await peer.client.status(chat.conversationId)).open ? true : null), 'peer to join');

  const texts = ['یک', 'دو', 'سه', 'چهار'];
  // The device goes offline after joining, so none of these arrive live: the
  // client has to walk the stream from its own mark.
  peer.client.close();
  for (const text of texts) await solo.client.send(chat.conversationId, text);
  const rows = await prisma.e2eeEnvelope.findMany({ where: { conversationId: chat.conversationId }, orderBy: { seq: 'asc' } });
  assert.equal(rows.length, texts.length + 1, 'welcome plus four messages');
  assert.deepEqual((await peer.client.history(chat.conversationId)).map(m => m.text), [], 'nothing landed while it was away');

  const last = rows[rows.length - 1];
  await peer.client.receive(asEvent(last));
  const history = await peer.client.history(chat.conversationId);
  assert.deepEqual(history.map(message => message.text), texts, 'one event pulled the whole missing run, in order');
  assert.equal((await peer.client.status(chat.conversationId)).appliedSeq, last.seq, 'the mark reached the end');

  await peer.client.receive(asEvent(last));
  assert.equal((await peer.client.history(chat.conversationId)).length, texts.length, 'a replay added nothing');

  await peer.client.receive(asEvent(last, { seq: 400 }));
  assert.equal((await peer.client.status(chat.conversationId)).appliedSeq, last.seq, 'a number from the future moves nothing');

  // A reconnect catches up on every conversation the device holds, not only the
  // one that happens to be on screen, so the core has to be able to list them.
  const held = await peer.client.conversations();
  const entry = held.find(item => item.id === chat.conversationId);
  assert.equal(entry?.open, true, 'the device knows which conversations it holds keys for');
  assert.equal(entry?.appliedSeq, last.seq, 'and how far each of them has been applied');

  // Read state is the one number the server can act on without reading anything.
  await peer.client.markRead(chat.conversationId);  const marked = await prisma.conversationParticipant.findUnique({
    where: { conversationId_userId: { conversationId: chat.conversationId, userId: peer.session.user.id } },
  });
  assert.equal(marked.e2eeReadSeq, last.seq, 'the server holds the mark the client reported');
  const list = await api('/messages/conversations', { token: peer.session.token });
  assert.equal(list.data.find(entry => entry.user.id === solo.session.user.id).unread, 0, 'and the badge clears');
});

test('a relabelled sender and a blob from another conversation are both refused', async () => {
  const writer = await makeClient(await createUser('walter'));
  const reader = await makeClient(await createUser('rita'));
  const outsider = await makeClient(await createUser('nina'));
  await Promise.all([writer.client.ready(), reader.client.ready(), outsider.client.ready()]);

  // A side chat exists only so its bytes can be moved around later.
  const foreign = await writer.client.openDirect(outsider.session.user.id);
  await waitUntil(async () => ((await outsider.client.status(foreign.conversationId)).open ? true : null),
    'the third account to join the side chat');
  await writer.client.send(foreign.conversationId, 'بین والتر و نینا');
  const foreignRow = await prisma.e2eeEnvelope.findFirst({ where: { conversationId: foreign.conversationId, seq: 2 } });

  const chat = await writer.client.openDirect(reader.session.user.id);
  await waitUntil(async () => ((await reader.client.status(chat.conversationId)).open ? true : null), 'reader to join');
  reader.client.close();
  const ack = await writer.client.send(chat.conversationId, 'پیام واقعی برای ریتا');
  const genuine = await prisma.e2eeEnvelope.findUnique({ where: { id: ack.id } });

  // The bytes are the writer's, the name on the row is someone else: showing
  // that as a message would be a forged receipt, so the client refuses it.
  const relabelled = await reader.client.receive(asEvent(genuine, { senderId: outsider.session.user.id }));
  assert.equal(relabelled.kind, 'failed', 'a sender outside the group is not believed');
  assert.equal(relabelled.code, 'unknown-sender', 'and the reason is the membership of the tree');
  assert.equal((await reader.client.history(chat.conversationId)).length, 0, 'nothing was displayed');

  // Same idea from the other side: valid ciphertext, wrong conversation.
  const stolen = await reader.client.receive(asEvent(foreignRow, { conversationId: chat.conversationId }));
  assert.equal(stolen.kind, 'failed', 'a blob from another group does not open here');
  assert.equal((await reader.client.history(chat.conversationId)).length, 0, 'and it becomes a message for nobody');
  assert.equal((await reader.client.status(chat.conversationId)).appliedSeq, 1, 'the stream never moved past the welcome');

  // A device that was never addressed cannot open the Welcome at all.
  const stranger = await makeClient(await createUser('frank'));
  await stranger.client.ready();
  const welcomeRow = await prisma.e2eeEnvelope.findFirst({ where: { conversationId: chat.conversationId, seq: 1 } });
  const refused = await stranger.client.receive(asEvent(welcomeRow));
  assert.equal(refused.kind, 'failed', 'an uninvited device learns nothing from a Welcome');
  assert.equal(refused.code, 'not-added');
  assert.equal((await stranger.client.status(chat.conversationId)).open, false, 'and gets no group');

  // And the honest path still works afterwards: refusing the fakes did not
  // break the real conversation.
  const again = await makeClient(reader.session, { store: reader.store });
  const caught = await again.client.catchUp(chat.conversationId);
  assert.equal(caught.error, null, 'catching up reports no problem');
  assert.equal((await again.client.history(chat.conversationId)).length, 1, 'the genuine message is still there');
});

test('a peer with no keys is refused before its conversation is locked to envelopes', async () => {
  const sender = await makeClient(await createUser('olive'));
  await sender.client.ready();
  // An account that signed up and never opened the app: no device, no pool.
  const silent = await createUser('quiet');

  const failure = await sender.client.openDirect(silent.user.id).then(() => null, (error) => error);
  assert.ok(failure, 'opening a chat with nobody to invite does not succeed');
  assert.equal(
    failure.code ?? (failure.status === 404 ? 'no-keys' : failure.status),
    'no-keys',
    'and the reason is that the peer holds no key material',
  );

  // The invariant this ordering protects: a conversation only starts accepting
  // envelopes once a group exists, so these two can still exchange readable
  // text instead of being stuck in a chat that refuses everything.
  const probe = await api(`/messages/e2ee/direct/${silent.user.id}`, { token: sender.session.token });
  assert.equal(probe.data.e2ee, false, 'the server was never told to encrypt this chat');

  const ack = await emitAck(sender.socket, 'message:send', {
    toId: silent.user.id, type: 'TEXT', text: 'هنوز خوانا',
  });
  assert.equal(ack.ok, true, `plaintext still goes through (${JSON.stringify(ack)})`);
  const row = await prisma.message.findUnique({ where: { id: ack.id }, select: { text: true } });
  assert.equal(row.text, 'هنوز خوانا', 'and it is stored the way the plaintext path stores it');
});
