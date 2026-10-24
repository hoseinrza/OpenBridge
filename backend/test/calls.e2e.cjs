'use strict';

// Call lifecycle e2e. No LiveKit server is required: token minting is local, and
// room administration stays disabled because LIVEKIT_API_URL is deliberately
// absent, so nothing here reaches the network.

const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const { randomUUID } = require('node:crypto');

process.env.NODE_ENV = process.env.NODE_ENV || 'test';
process.env.JWT_SECRET = process.env.JWT_SECRET || 'openbridge-test-secret-at-least-32-characters-long';
process.env.LIVEKIT_URL = 'ws://127.0.0.1:7880';
process.env.LIVEKIT_API_KEY = 'test-api-key';
process.env.LIVEKIT_API_SECRET = 'test-api-secret-at-least-32-characters';
// Room administration is intentionally left unset: the test must never call a
// real media server, and tokens still work without it.
delete process.env.LIVEKIT_API_URL;

process.env.AUTH_OTP_REQUEST_LIMIT = '80';
process.env.AUTH_OTP_REQUEST_PHONE_LIMIT = '10';
process.env.AUTH_OTP_VERIFY_LIMIT = '80';
process.env.AUTH_SIGNUP_LIMIT = '80';

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
let alice;
let bob;
let eve;
let dave;

function freshPhone() {
  const tail = String(Math.floor(Math.random() * 1e9)).padStart(9, '0');
  return `09${tail}`;
}

async function api(path, { method = 'GET', token, body, headers = {} } = {}) {
  const res = await fetch(`${origin}${API_PREFIX}${path}`, {
    method,
    headers: {
      ...(body ? { 'Content-Type': 'application/json' } : {}),
      ...(token ? { Authorization: `Bearer ${token}` } : {}),
      ...headers,
    },
    body: body ? JSON.stringify(body) : undefined,
  });
  const data = await res.json().catch(() => ({}));
  return { status: res.status, data };
}

async function createUser(label) {
  const phone = freshPhone();
  otpPhones.push(phone);
  const requested = await api('/auth/otp/request', { method: 'POST', body: { phone } });
  assert.equal(requested.status, 200, `otp request ${label}`);
  assert.equal(requested.data.isNewUser, true);

  const verified = await api('/auth/otp/verify', { method: 'POST', body: { phone, code: requested.data.testCode } });
  assert.equal(verified.status, 200, `otp verify ${label}`);
  assert.equal(verified.data.requiresSignup, true);

  const created = await api('/auth/signup', {
    method: 'POST',
    body: {
      signupToken: verified.data.signupToken,
      username: `obc_${suffix}_${label}`,
      firstName: 'Call',
      lastName: label,
    },
  });
  assert.equal(created.status, 201, `signup ${label}`);
  createdUserIds.push(created.data.user.id);
  return created.data;
}

function connectSocket(token) {
  return new Promise((resolve) => {
    const socket = io(origin, {
      auth: { token },
      transports: ['websocket'],
      reconnection: false,
      timeout: 5000,
    });
    const timer = setTimeout(() => resolve({ socket, connected: false, reason: 'timeout' }), 6000);
    socket.on('connect', () => {
      clearTimeout(timer);
      resolve({ socket, connected: true });
    });
    socket.on('connect_error', (error) => {
      clearTimeout(timer);
      resolve({ socket, connected: false, reason: error.message });
    });
  });
}

function emitAck(socket, event, payload, ms = 5000) {
  return new Promise((resolve) => {
    const timer = setTimeout(() => resolve({ timeout: true }), ms);
    socket.emit(event, payload, (result) => {
      clearTimeout(timer);
      resolve(result ?? { timeout: true });
    });
  });
}

function waitEvent(socket, event, ms = 5000) {
  return new Promise((resolve) => {
    const handler = (data) => {
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

function decodeJwt(token) {
  const [header, payload] = token.split('.');
  assert.ok(header && payload, 'a JWT with a payload');
  return JSON.parse(Buffer.from(payload, 'base64url').toString('utf8'));
}

function callToken(callId, token, body = { client: 'web' }) {
  return api(`/calls/${callId}/token`, { method: 'POST', token, body });
}

before(async () => {
  app = await NestFactory.create(AppModule, { logger: false, rawBody: true });
  app.set('trust proxy', 1);
  app.setGlobalPrefix('api');
  app.useGlobalPipes(new ValidationPipe({ whitelist: true, transform: true }));
  app.enableCors({
    origin: (requestOrigin, callback) => callback(null, isOriginAllowed(requestOrigin)),
    credentials: true,
  });
  await app.listen(0);

  const address = app.getHttpServer().address();
  origin = `http://127.0.0.1:${address.port}`;
  prisma = new PrismaClient();

  alice = await createUser('alice');
  bob = await createUser('bob');
  eve = await createUser('eve');

  for (const [name, user] of Object.entries({ alice, bob, eve })) {
    const connected = await connectSocket(user.token);
    assert.equal(connected.connected, true, `${name} socket`);
    sockets[name] = connected.socket;
  }

  // A direct conversation must exist before a call may ring. Sending one
  // message is the same path the UI uses.
  const sent = await emitAck(sockets.alice, 'message:send', {
    toId: bob.user.id,
    type: 'text',
    text: 'call test seed',
  });
  assert.equal(sent.ok, true, 'direct conversation seed');
});

after(async () => {
  for (const socket of Object.values(sockets)) {
    try { socket?.disconnect(); } catch { /* ignore */ }
  }
  try {
    await prisma?.user.deleteMany({ where: { id: { in: createdUserIds } } });
  } catch { /* ignore cleanup errors */ }
  await app?.close();
  await prisma?.$disconnect();
});

test('direct call: ring, authorization, token grants, end', async () => {
  const callId = randomUUID();
  const incoming = waitEvent(sockets.bob, 'call:incoming');
  const ack = await emitAck(sockets.alice, 'call:invite', {
    callId,
    toId: bob.user.id,
    type: 'video',
  });
  assert.equal(ack.ok, true, 'invite accepted');
  assert.equal(ack.callId, callId);
  assert.equal(ack.e2ee, false, 'seed conversation is plaintext');

  const ring = await incoming;
  assert.ok(ring, 'callee was rung');
  assert.equal(ring.callId, callId);
  assert.equal(ring.from.id, alice.user.id);
  assert.equal(ring.type, 'video');
  assert.equal(ring.kind, 'direct');

  const early = await callToken(callId, alice.token);
  assert.equal(early.status, 409, 'caller cannot join before an answer');

  const accepted = waitEvent(sockets.alice, 'call:accepted');
  const answer = await emitAck(sockets.bob, 'call:accept', { callId });
  assert.equal(answer.ok, true, 'callee accepted');
  const acceptedEvent = await accepted;
  assert.equal(acceptedEvent?.callId, callId);
  assert.equal(acceptedEvent?.userId, bob.user.id);

  const bobToken = await callToken(callId, bob.token);
  assert.equal(bobToken.status, 201);
  assert.equal(bobToken.data.e2ee, false);
  assert.equal(bobToken.data.url, 'ws://127.0.0.1:7880');
  const claims = decodeJwt(bobToken.data.token);
  assert.equal(claims.sub, bob.user.id, 'identity is the authenticated user');
  assert.equal(claims.video.room, `ob_${callId}`);
  assert.equal(claims.video.roomJoin, true);
  assert.equal(claims.video.canPublish, true);
  assert.equal(claims.video.canSubscribe, true);
  assert.equal(claims.video.canPublishData, false);
  assert.equal(claims.video.roomAdmin, undefined, 'no admin grant');
  assert.ok(!JSON.stringify(bobToken.data).includes('test-api-secret'), 'API secret never reaches the client');

  const aliceToken = await callToken(callId, alice.token);
  assert.equal(aliceToken.status, 201);
  assert.equal(decodeJwt(aliceToken.data.token).sub, alice.user.id);

  const intruder = await callToken(callId, eve.token);
  assert.equal(intruder.status, 403, 'an unrelated user cannot get a room token');

  const duplicate = await emitAck(sockets.bob, 'call:accept', { callId });
  assert.equal(duplicate.ok, true);
  assert.equal(duplicate.duplicate, true, 'duplicate accept is idempotent');

  // Rejecting an answered call is not a transition; it must not turn a live
  // room into a rejected one. The end button is the only way out.
  const lateReject = await emitAck(sockets.bob, 'call:reject', { callId });
  assert.equal(lateReject.ok, true);
  assert.equal(lateReject.duplicate, true);

  const ended = waitEvent(sockets.bob, 'call:ended');
  const hangup = await emitAck(sockets.alice, 'call:end', { callId });
  assert.equal(hangup.ok, true);
  const endedEvent = await ended;
  assert.equal(endedEvent?.callId, callId);
  assert.equal(endedEvent?.reason, 'hangup');

  const afterEnd = await callToken(callId, bob.token);
  assert.equal(afterEnd.status, 409, 'no token after the call ended');
});

test('reject ends the ring for both sides and is idempotent', async () => {
  const callId = randomUUID();
  const incoming = waitEvent(sockets.bob, 'call:incoming');
  const ack = await emitAck(sockets.alice, 'call:invite', { callId, toId: bob.user.id, type: 'audio' });
  assert.equal(ack.ok, true);
  assert.ok(await incoming);

  const ended = waitEvent(sockets.alice, 'call:ended');
  const rejected = await emitAck(sockets.bob, 'call:reject', { callId });
  assert.equal(rejected.ok, true);
  const endedEvent = await ended;
  assert.equal(endedEvent?.reason, 'rejected');

  const duplicate = await emitAck(sockets.bob, 'call:reject', { callId });
  assert.equal(duplicate.ok, true);
  assert.equal(duplicate.duplicate, true);

  // A late accept on a terminal call is answered without reviving it. Its
  // token endpoint still refuses, which the first test covers after end.
  const late = await emitAck(sockets.bob, 'call:accept', { callId });
  assert.equal(late.ok, true);
  assert.equal(late.duplicate, true);
  assert.equal(late.ended, true);
});

test('cancel ends the ring for the callee', async () => {
  const callId = randomUUID();
  const incoming = waitEvent(sockets.bob, 'call:incoming');
  const ack = await emitAck(sockets.alice, 'call:invite', { callId, toId: bob.user.id, type: 'audio' });
  assert.equal(ack.ok, true);
  assert.ok(await incoming);

  const ended = waitEvent(sockets.bob, 'call:ended');
  const cancelled = await emitAck(sockets.alice, 'call:cancel', { callId });
  assert.equal(cancelled.ok, true);
  const endedEvent = await ended;
  assert.equal(endedEvent?.reason, 'cancelled');
});

test('an offline user is not rung and no call record is made', async () => {
  dave = await createUser('dave');
  const callId = randomUUID();
  const ack = await emitAck(sockets.alice, 'call:invite', { callId, toId: dave.user.id, type: 'audio' });
  assert.equal(ack.ok, false);
  assert.match(ack.error, /در دسترس/);
});

test('E2EE direct call requires matching key fingerprints and refuses mobile', async () => {
  const carol = await createUser('carol');
  const frank = await createUser('frank');
  const carolSocket = await connectSocket(carol.token);
  const frankSocket = await connectSocket(frank.token);
  assert.equal(carolSocket.connected, true);
  assert.equal(frankSocket.connected, true);
  sockets.carol = carolSocket.socket;
  sockets.frank = frankSocket.socket;

  const conversation = await prisma.conversation.create({
    data: {
      isGroup: false,
      e2ee: true,
      participants: {
        create: [{ userId: carol.user.id }, { userId: frank.user.id }],
      },
    },
  });
  assert.ok(conversation.id);

  const fingerprint = 'A'.repeat(43);
  const missing = await emitAck(sockets.carol, 'call:invite', {
    callId: randomUUID(), toId: frank.user.id, type: 'video',
  });
  assert.equal(missing.ok, false, 'an encrypted call without a fingerprint is refused');

  const callId = randomUUID();
  const incoming = waitEvent(frankSocket.socket, 'call:incoming');
  const ack = await emitAck(sockets.carol, 'call:invite', {
    callId, toId: frank.user.id, type: 'video', keyFingerprint: fingerprint,
  });
  assert.equal(ack.ok, true);
  assert.equal(ack.e2ee, true);
  const ring = await incoming;
  assert.equal(ring?.e2ee, true);
  assert.equal(ring?.keyFingerprint, fingerprint);
  assert.equal(Object.prototype.hasOwnProperty.call(ring, 'key'), false, 'the key itself never travels');

  const wrong = await emitAck(sockets.frank, 'call:accept', {
    callId, keyFingerprint: 'B'.repeat(43),
  });
  assert.equal(wrong.ok, false, 'a mismatched epoch is refused');

  const accepted = await emitAck(sockets.frank, 'call:accept', { callId, keyFingerprint: fingerprint });
  assert.equal(accepted.ok, true);

  const mobile = await callToken(callId, frank.token, { client: 'mobile', keyFingerprint: fingerprint });
  assert.equal(mobile.status, 403, 'mobile cannot join without an MLS key');

  const noFingerprint = await callToken(callId, frank.token, { client: 'web' });
  assert.equal(noFingerprint.status, 403);

  const tokenResponse = await callToken(callId, frank.token, { client: 'web', keyFingerprint: fingerprint });
  assert.equal(tokenResponse.status, 201);
  assert.equal(tokenResponse.data.e2ee, true);
  assert.equal(Object.prototype.hasOwnProperty.call(tokenResponse.data, 'keyFingerprint'), false);
  assert.ok(!JSON.stringify(tokenResponse.data).includes('test-api-secret'));

  await emitAck(sockets.carol, 'call:end', { callId });
});

test('group call authorizes membership and ends when the last member leaves', async () => {
  const groupResponse = await api('/messages/groups', {
    method: 'POST',
    token: alice.token,
    body: { name: `Call group ${suffix}`, memberIds: [bob.user.id] },
  });
  assert.equal(groupResponse.status, 201);
  const groupId = groupResponse.data.id;

  const outsider = await emitAck(sockets.eve, 'call:group-start', {
    callId: randomUUID(), conversationId: groupId, type: 'audio',
  });
  assert.equal(outsider.ok, false, 'a non-member cannot start a group call');

  const callId = randomUUID();
  const incoming = waitEvent(sockets.bob, 'call:incoming');
  const ack = await emitAck(sockets.alice, 'call:group-start', {
    callId, conversationId: groupId, type: 'audio',
  });
  assert.equal(ack.ok, true);
  assert.equal(ack.e2ee, false);

  const ring = await incoming;
  assert.ok(ring);
  assert.equal(ring.kind, 'group');
  assert.equal(ring.conversationId, groupId);
  assert.equal(ring.group?.id, groupId);

  const callerToken = await callToken(callId, alice.token);
  assert.equal(callerToken.status, 201, 'the initiator opens the room while it rings');

  const accepted = await emitAck(sockets.bob, 'call:accept', { callId });
  assert.equal(accepted.ok, true);

  const bobToken = await callToken(callId, bob.token);
  assert.equal(bobToken.status, 201);

  const ended = waitEvent(sockets.alice, 'call:ended');
  const left = await emitAck(sockets.bob, 'call:end', { callId });
  assert.equal(left.ok, true);
  const endedEvent = await ended;
  assert.equal(endedEvent?.reason, 'empty', 'the last other participant leaving ends the room');
});

test('webhook rejects an unsigned body and a forged signature', async () => {
  const body = JSON.stringify({ event: 'room_finished', room: { name: 'ob_test' } });
  const unsigned = await fetch(`${origin}${API_PREFIX}/calls/webhook`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body,
  });
  assert.equal(unsigned.status, 401);

  const forged = await fetch(`${origin}${API_PREFIX}/calls/webhook`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: 'Bearer not-a-real-livekit-signature',
    },
    body,
  });
  assert.equal(forged.status, 401);
});

test('session revocation blocks a new room token', async () => {
  await prisma.session.updateMany({
    where: { userId: dave.user.id },
    data: { revokedAt: new Date() },
  });
  const response = await callToken(randomUUID(), dave.token);
  assert.equal(response.status, 401);
});
