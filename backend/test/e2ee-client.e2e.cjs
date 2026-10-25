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
process.env.CONTENT_KEY = process.env.CONTENT_KEY || 'Y2ktb25seS1jb250ZW50LWtleS0zMi1ieXRlcy0wMDA=';
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
const { randomBytes, createCipheriv, createDecipheriv, randomFillSync } = require('node:crypto');
const { readFile, unlink } = require('node:fs/promises');
const { join } = require('node:path');
const { AppModule } = require('../dist/app.module');
const { isOriginAllowed } = require('../dist/config/env');

const API_PREFIX = '/api';
// The client core is ESM and lives with the web app it is written for; a CJS
// test reaches it through dynamic import so one copy serves both.
const SHARED = '../../shared/e2ee/';

const suffix = `${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`;
const createdUserIds = [];
const createdBlobIds = [];
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
    const attachments = await import(`${SHARED}attachments.js`);
    core = {
      createE2eeClient: client.createE2eeClient,
      memoryStore: stores.memoryStore,
      packAttachment: attachments.packAttachment,
      parseAttachment: attachments.parseAttachment,
    };
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

// A sender encrypting a file the way the browser does: AES-256-GCM with a
// 32-byte key, a 96-bit nonce and the tag appended to the ciphertext, which is
// exactly the layout WebCrypto produces and the layout every client must read.
function sealFile(plain) {
  const key = randomBytes(32);
  const iv = randomBytes(12);
  const cipher = createCipheriv('aes-256-gcm', key, iv);
  return {
    key: key.toString('base64'),
    iv: iv.toString('base64'),
    cipher: Buffer.concat([cipher.update(plain), cipher.final(), cipher.getAuthTag()]),
  };
}

function openFile({ key, iv }, bytes) {
  const decipher = createDecipheriv('aes-256-gcm', Buffer.from(key, 'base64'), Buffer.from(iv, 'base64'));
  decipher.setAuthTag(bytes.subarray(bytes.length - 16));
  return Buffer.concat([decipher.update(bytes.subarray(0, bytes.length - 16)), decipher.final()]);
}

/** The one POST a client makes with a file it has already encrypted. */
async function uploadBlob(session, conversationId, bytes) {
  const form = new FormData();
  form.append('conversationId', conversationId);
  form.append('file', new Blob([bytes], { type: 'application/octet-stream' }), 'blob');
  const response = await fetch(`${origin}${API_PREFIX}/uploads/encrypted`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${session.token}` },
    body: form,
  });
  return { status: response.status, data: await response.json().catch(() => ({})) };
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
    if (createdBlobIds.length) {
      const kept = await prisma.encryptedBlob.findMany({
        where: { id: { in: createdBlobIds } }, select: { filename: true },
      });
      for (const blob of kept) {
        await unlink(join(process.cwd(), 'uploads', blob.filename)).catch(() => {});
      }
    }
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

test('a file is encrypted on the sender, stored as opaque bytes and opened by the peer', async () => {
  const { packAttachment } = await loadCore();
  const sender = await makeClient(await createUser('carol'));
  const peer = await makeClient(await createUser('dan'));
  await Promise.all([sender.client.ready(), peer.client.ready()]);

  const chat = await sender.client.openDirect(peer.session.user.id);

  // A real PNG signature at the front of the plain file: this is exactly the
  // byte sequence a magic-byte check would have caught, and the server never
  // sees it, because what arrives is already ciphertext.
  const pngHeader = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
  const plain = Buffer.alloc(6 * 1024);
  pngHeader.copy(plain, 0);
  randomFillSync(plain, pngHeader.length);
  const sealed = sealFile(plain);

  const uploaded = await uploadBlob(sender.session, chat.conversationId, sealed.cipher);
  assert.equal(uploaded.status, 201, `a member can store a blob (${JSON.stringify(uploaded.data)})`);
  assert.match(uploaded.data.id, /^[0-9a-f-]{36}$/, 'the blob is named by an id, not by a path');
  createdBlobIds.push(uploaded.data.id);

  await sender.client.send(chat.conversationId, packAttachment({
    blob: uploaded.data.id,
    name: 'screenshot.png',
    mime: 'image/png',
    size: plain.length,
    key: sealed.key,
    iv: sealed.iv,
  }));

  const received = await waitUntil(async () => {
    const history = await peer.client.history(chat.conversationId);
    return history.find(message => message.attachment?.blob === uploaded.data.id) ?? null;
  }, 'the peer to decrypt the descriptor');

  assert.equal(received.text, '', 'a picture leaves no readable body in the message list');
  assert.equal(received.attachment.name, 'screenshot.png', 'the name came inside the message, not the database');
  assert.equal(received.attachment.mime, 'image/png');
  assert.equal(received.attachment.size, plain.length, 'the sender sized it before encrypting');

  // The blob id is a name, not a credential: it only opens for a session that
  // really is in the conversation holding it.
  const granted = await api(`/uploads/encrypted/${uploaded.data.id}/url`, { token: peer.session.token });
  assert.equal(granted.status, 200, 'a member is handed a fresh signed url');
  const wire = await fetch(`${origin}${API_PREFIX}${granted.data.url}`);
  const bytes = Buffer.from(await wire.arrayBuffer());
  assert.equal(wire.status, 200, 'the bytes move');
  assert.equal(wire.headers.get('content-type'), 'application/octet-stream', 'ciphertext is never typed');
  assert.equal(wire.headers.get('x-content-type-options'), 'nosniff', 'and never sniffed by a browser');
  assert.equal(wire.headers.get('content-disposition'), 'attachment', 'or opened as one');
  assert.equal(bytes.subarray(0, pngHeader.length).equals(pngHeader), false, 'what came back is not a png');
  assert.equal(bytes.includes(plain.subarray(pngHeader.length, pngHeader.length + 64)), false, 'nor any run of it');

  assert.deepEqual(openFile(received.attachment, bytes), plain, 'the peer gets the sender\'s bytes back');

  // GCM is what turns a changed byte into a refusal: there is no second path
  // that would render the altered file.
  const tampered = Buffer.from(bytes);
  tampered[pngHeader.length] ^= 0x01;
  assert.throws(() => openFile(received.attachment, tampered), 'a file that changed anywhere does not open');

  // What the platform keeps: an opaque blob, its size, and which chat owns it.
  const kept = await prisma.encryptedBlob.findUnique({ where: { id: uploaded.data.id } });
  assert.match(kept.filename, /^enc-[0-9a-f-]{36}\.bin$/, 'a name chosen here, with no client filename in it');
  assert.equal(kept.conversationId, chat.conversationId, 'one conversation holds it');
  assert.equal(kept.ownerId, sender.session.user.id);
  assert.equal(kept.size, sealed.cipher.length, 'only the ciphertext size is known');
  const stored = await readFile(join(process.cwd(), 'uploads', kept.filename));
  assert.deepEqual(stored, sealed.cipher, 'the file on disk is the ciphertext as it was handed over');

  // Neither the descriptor nor the blob it names is readable from storage: the
  // envelope is MLS ciphertext and no plaintext message row was ever written.
  const envelopes = await prisma.e2eeEnvelope.findMany({
    where: { conversationId: chat.conversationId }, orderBy: { seq: 'asc' },
  });
  assert.deepEqual(envelopes.map(envelope => envelope.seq), [1, 2], 'the welcome, then the attachment');
  for (const envelope of envelopes) {
    const raw = Buffer.from(envelope.content, 'base64');
    assert.equal(raw.includes(uploaded.data.id), false, 'the blob id is not carried in the clear');
    assert.equal(raw.includes('screenshot.png'), false, 'nor is the filename');
  }
  assert.equal(await prisma.message.count({ where: { conversationId: chat.conversationId } }), 0,
    'and no readable message row exists to hold any of it');

  // A stranger inside the platform, and a well-shaped id that stores nothing.
  const outsider = await createUser('erin');
  const refused = await api(`/uploads/encrypted/${uploaded.data.id}/url`, { token: outsider.token });
  assert.equal(refused.status, 403, 'an account in no part of this chat is refused');
  const missing = await api('/uploads/encrypted/00000000-0000-4000-8000-000000000000/url', { token: peer.session.token });
  assert.equal(missing.status, 404, 'a blob that was never stored has no url to give');

  // The signature is what authorises the bytes themselves, so the same path
  // without one moves nothing.
  const unsigned = await fetch(`${origin}${API_PREFIX}/uploads/encrypted/${kept.filename}`);
  assert.equal(unsigned.status, 403, 'an unsigned request for a blob file is refused');
  sender.socket.disconnect();
  peer.socket.disconnect();
});

// The descriptor codec on its own, because the number it gained for voice
// messages is the kind that breaks a reader rather than a transport: a phone
// that has never heard of durationMs must still open a recording a browser
// wrote, and a browser that reads an old descriptor must not invent a length.
test('an encrypted attachment descriptor carries a length only when the sender measured one', async () => {
  const { packAttachment, parseAttachment } = await loadCore();
  const blob = '00000000-0000-4000-8000-000000000000';
  const key = randomBytes(32).toString('base64');
  const iv = randomBytes(12).toString('base64');
  const recording = { blob, name: 'voice-message.weba', mime: 'audio/webm', size: 88120, key, iv };

  const voice = parseAttachment(packAttachment({ ...recording, durationMs: 4600 }));
  assert.equal(voice.durationMs, 4600, 'the length survives the write and the read');
  assert.equal(voice.blob, blob, 'and nothing else in the descriptor moved');
  assert.equal(voice.name, 'voice-message.weba');
  assert.equal(voice.size, 88120);

  const unmeasured = parseAttachment(packAttachment(recording));
  assert.equal(unmeasured.durationMs, null, 'a sender that measured nothing leaves the reader blank');

  // A descriptor written before this field existed, and one written by a client
  // that sent something unreadable in it. Both mean "no length", never a crash.
  const legacy = `{"k":"openbridge.attachment.v1","blob":"${blob}","name":"a.weba",`
    + `"mime":"audio/webm","size":10,"key":"${key}","iv":"${iv}"}`;
  assert.equal(parseAttachment(legacy).durationMs, null, 'the old shape still parses');
  for (const broken of ['4600', 46.5, -1]) {
    const forged = JSON.stringify({ k: 'openbridge.attachment.v1', ...recording, durationMs: broken });
    assert.equal(parseAttachment(forged).durationMs, null, `${JSON.stringify(broken)} is not a length`);
  }
});

test('an encrypted attachment descriptor says whether it came from a microphone', async () => {
  const { packAttachment, parseAttachment } = await loadCore();
  const blob = '00000000-0000-4000-8000-000000000000';
  const key = randomBytes(32).toString('base64');
  const iv = randomBytes(12).toString('base64');
  const base = { blob, name: 'voice-message.weba', mime: 'audio/webm', size: 88120, key, iv, durationMs: 4600 };

  const recording = parseAttachment(packAttachment({ ...base, voice: true }));
  assert.equal(recording.voice, true, 'a recording is marked as one');
  assert.equal(recording.durationMs, 4600, 'and keeps the length it travels with');

  const song = parseAttachment(packAttachment({ ...base, name: 'a-song.mp3', mime: 'audio/mpeg' }));
  assert.equal(song.voice, false, 'an uploaded audio file is not a recording');

  // Anything but exactly true means the same as a missing field: a reader never
  // guesses that an unknown attachment came from a microphone, which is also how
  // a descriptor written before this field existed is read.
  for (const forged of ['true', 1, {}, null, undefined]) {
    const text = JSON.stringify({ k: 'openbridge.attachment.v1', ...base, voice: forged });
    assert.equal(parseAttachment(text).voice, false, `${JSON.stringify(forged)} does not make a recording`);
  }
});

test('a conversation that is not encrypted cannot be used as a file host', async () => {
  const { parseAttachment } = await loadCore();
  assert.equal(parseAttachment('hello'), null, 'an ordinary message is not mistaken for a descriptor');
  assert.equal(parseAttachment(`{"k":"openbridge.attachment.v1","blob":"${'0'.repeat(36)}","key":"AAA","iv":"AAA"}`), null,
    'and a descriptor with a bad blob id or short key stays an ordinary message');

  const sender = await createUser('plaina');
  const receiver = await createUser('plainb');
  const { socket, connected } = await connectSocket(sender.token);
  assert.equal(connected, true);
  const ack = await emitAck(socket, 'message:send', { toId: receiver.user.id, type: 'TEXT', text: 'readable' });
  assert.equal(ack.ok, true, 'the two can still exchange plaintext');
  const { conversationId } = await prisma.message.findUnique({
    where: { id: ack.id }, select: { conversationId: true },
  });
  socket.disconnect();

  const attempt = await uploadBlob(sender, conversationId, randomBytes(2048));
  assert.equal(attempt.status, 400, 'an encrypted-blob upload into a plaintext chat is refused');
  assert.equal(await prisma.encryptedBlob.count({ where: { conversationId } }), 0, 'and nothing was stored');

  // Not a member of the chat at all: refused before a byte is written, so this
  // endpoint cannot be used to park files in somebody else's conversation.
  const stranger = await createUser('plainc');
  const trespass = await uploadBlob(stranger, conversationId, randomBytes(2048));
  assert.equal(trespass.status, 403, 'a stranger cannot write into a conversation');
  assert.equal(await prisma.encryptedBlob.count({ where: { conversationId } }), 0, 'and left no blob behind');
});

test('an encrypted group opens for every invited device and only carries ciphertext', async () => {
  const owner = await makeClient(await createUser('gowner'));
  const first = await makeClient(await createUser('gfirst'));
  const second = await makeClient(await createUser('gsecond'));
  // One account with two devices: the single Welcome has to reach both of them.
  const secondPhone = await makeClient(second.session);
  await Promise.all([
    owner.client.ready(),
    first.client.ready(),
    second.client.ready(),
    secondPhone.client.ready(),
  ]);

  const chat = await owner.client.createEncryptedGroupChat(
    'تیم امن',
    [first.session.user.id, second.session.user.id],
  );
  assert.match(chat.id, /-/g, 'the encrypted group is a real conversation');
  assert.equal(chat.e2ee, true, 'and it says so on the wire');

  for (const handle of [first, second, secondPhone]) {
    const opened = await handle.client.openGroup(chat.id);
    assert.equal(opened.e2ee, true, 'the member sees an encrypted group');
    assert.equal(opened.open, true, 'and holds its keys after reading the Welcome');
    const status = await handle.client.status(chat.id);
    assert.deepEqual(
      status.members.sort(),
      [owner.session.user.id, first.session.user.id, second.session.user.id].sort(),
      'the tree knows all three accounts, once each',
    );
  }

  const text = 'این گروه از پیام اول رمزنگاری شده است';
  await owner.client.send(chat.id, text);
  for (const handle of [owner, first, second, secondPhone]) {
    const received = await waitUntil(async () => {
      const history = await handle.client.history(chat.id);
      return history.find(message => message.text === text) ?? null;
    }, 'every device of the group to decrypt the message');
    assert.equal(received.senderId, owner.session.user.id, 'the sender is the account in the tree');
  }

  // What the server can see: one Welcome, one opaque message, and not a single
  // readable row in the message table.
  const envelopes = await prisma.e2eeEnvelope.findMany({
    where: { conversationId: chat.id }, orderBy: { seq: 'asc' },
  });
  assert.deepEqual(envelopes.map(envelope => envelope.seq), [1, 2], 'the Welcome opens the stream');
  for (const envelope of envelopes) {
    const raw = Buffer.from(envelope.content, 'base64');
    assert.equal(raw.includes(text, 'utf8'), false, `envelope ${envelope.seq} carries no text`);
    assert.equal(raw.includes('گروه', 'utf8'), false, `envelope ${envelope.seq} carries no group name`);
  }
  assert.equal(await prisma.message.count({ where: { conversationId: chat.id } }), 0,
    'a group message never becomes a plaintext row');

  // The unread badge of an encrypted group counts envelopes above the member's
  // own high-water mark. The Welcome is consumed at the moment of joining, so
  // only the message sent afterwards is unread. Reading it, which only a device
  // holding the keys can report, clears the rest.
  const listed = await api('/messages/groups', { token: first.session.token });
  const entry = listed.data.find(group => group.id === chat.id);
  assert.equal(entry.e2ee, true, 'the group list marks it encrypted');
  assert.equal(entry.unread, 1, 'the message, not the Welcome it joined from, is unread');
  await first.client.markRead(chat.id);
  const afterRead = await api('/messages/groups', { token: first.session.token });
  assert.equal(afterRead.data.find(group => group.id === chat.id).unread, 0, 'the member\'s mark clears the badge');

  // A plaintext send into the group is refused, because it would be the one
  // readable message in a conversation everyone else reads as ciphertext.
  const plain = await emitAck(first.socket, 'message:send', {
    conversationId: chat.id, type: 'TEXT', text: 'readable',
  });
  assert.equal(plain.ok, false, 'the plaintext path is closed');
  assert.equal(await prisma.message.count({ where: { conversationId: chat.id } }), 0, 'and wrote nothing');

  // Membership is an MLS commit: the database row alone would leave a new member
  // unable to decrypt and a removed member still holding the old keys.
  const fourth = await createUser('gfourth');
  const add = await api(`/messages/groups/${chat.id}/participants`, {
    method: 'POST', token: owner.session.token, body: { userId: fourth.user.id },
  });
  assert.equal(add.status, 400, 'adding to an encrypted group is refused until a rekey exists');
  const remove = await api(`/messages/groups/${chat.id}/participants/${second.session.user.id}`, {
    method: 'DELETE', token: owner.session.token,
  });
  assert.equal(remove.status, 400, 'and so is removing a member');

  // No membership hint for someone outside: the probe answers like an id that
  // does not exist.
  const outsider = await createUser('goutsider');
  const outsiderProbe = await api(`/messages/e2ee/group/${chat.id}`, { token: outsider.token });
  assert.equal(outsiderProbe.status, 200, 'the probe itself answers');
  assert.deepEqual(outsiderProbe.data, { conversationId: null, e2ee: false }, 'without revealing the group');

  // A member with no registered device cannot be invited, and the refusal comes
  // before a conversation exists, so there is no half-built group to clean up.
  const keyless = await createUser('gkeyless');
  const before = await api('/messages/groups', { token: owner.session.token });
  await assert.rejects(
    () => owner.client.createEncryptedGroupChat('بدون کلید', [keyless.user.id]),
    /کلیدی/,
    'a keyless member is refused',
  );
  const after = await api('/messages/groups', { token: owner.session.token });
  assert.equal(after.data.length, before.data.length, 'and no group was created');
});
