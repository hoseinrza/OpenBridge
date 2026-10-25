// What the database holds after a message is sent.
//
// The unit suite proves the cipher itself; this one proves the wiring, because
// the claim being made to users is about the row on disk, not about a function
// returning different bytes. It also covers the conversation shape that Phase 2
// introduced: a chat that once used MLS keeps its old envelopes and now accepts
// ordinary sends, so it holds both kinds at once.

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
const { io } = require('socket.io-client');
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
      firstName:   'Content',
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
  global.__ctx = { alice, bob };

  const aliceSocket = await connectSocket(alice.token);
  const bobSocket = await connectSocket(bob.token);
  assert.equal(aliceSocket.connected, true, 'alice socket');
  assert.equal(bobSocket.connected, true, 'bob socket');
  global.__sockets = { alice: aliceSocket.socket, bob: bobSocket.socket };
});

after(async () => {
  for (const socket of Object.values(global.__sockets ?? {})) socket?.disconnect();
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

test('a stored message is sealed in the database and readable over the API', async () => {
  const { alice, bob } = global.__ctx;
  const plaintext = `a sentence nobody with the database alone may read ${suffix}`;

  const sent = await emitAck(global.__sockets.alice, 'message:send', {
    toId: bob.user.id, type: 'text', text: plaintext,
  });
  assert.equal(sent.ok, true, 'send accepted');

  const row = await prisma.message.findUnique({ where: { id: sent.id }, select: { text: true, conversationId: true } });
  assert.match(row.text, /^obx1\./, 'the row is a sealed payload');
  assert.ok(!row.text.includes(plaintext), 'the plaintext is not in the database');

  const history = await api(`/messages/${alice.user.id}`, { token: bob.token });
  assert.equal(history.status, 200, 'direct history');
  assert.equal(history.data.find(m => m.id === sent.id)?.text, plaintext, 'the peer reads the original text');

  const list = await api('/messages/conversations', { token: bob.token });
  assert.equal(list.status, 200, 'conversation list');
  const chat = list.data.find(c => c.user?.id === alice.user.id);
  assert.equal(chat?.lastMessage?.text, plaintext, 'the preview decrypts too');
});

test('a chat that once used MLS keeps working and seals everything new', async () => {
  const { alice, bob } = global.__ctx;

  const before = `written before the switch ${suffix}`;
  const first = await emitAck(global.__sockets.alice, 'message:send', {
    toId: bob.user.id, type: 'text', text: before,
  });
  assert.equal(first.ok, true, 'first send');

  const enabled = await api('/messages/e2ee/direct', { method: 'POST', token: alice.token, body: { userId: bob.user.id } });
  assert.equal(enabled.status, 201, 'the chat opts into legacy e2ee');
  const conversationId = enabled.data.conversationId;

  const after = `written after the switch ${suffix}`;
  const second = await emitAck(global.__sockets.alice, 'message:send', {
    toId: bob.user.id, type: 'text', text: after,
  });
  assert.equal(second.ok, true, 'a normal send into a legacy e2ee chat is accepted');

  const rows = await prisma.message.findMany({
    where:  { id: { in: [first.id, second.id] } },
    select: { id: true, text: true, conversationId: true },
  });
  const byId = new Map(rows.map(row => [row.id, row]));
  assert.equal(byId.get(first.id).conversationId, conversationId, 'both messages live in that chat');
  assert.equal(byId.get(first.id).text, before, 'the earlier row was already stored in the clear');
  assert.match(byId.get(second.id).text, /^obx1\./, 'the new row is sealed even in a legacy chat');

  const history = await api(`/messages/${alice.user.id}`, { token: bob.token });
  assert.equal(history.status, 200, 'direct history');
  assert.equal(history.data.find(m => m.id === first.id)?.text, before, 'old rows still read');
  assert.equal(history.data.find(m => m.id === second.id)?.text, after, 'new rows read');

  const list = await api('/messages/conversations', { token: bob.token });
  const chat = list.data.find(c => c.user?.id === alice.user.id);
  assert.equal(chat?.e2ee, true, 'the chat still reports itself encrypted');
  assert.equal(chat?.lastMessage?.text, after, 'the newest preview decrypts');
});
