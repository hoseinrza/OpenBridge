require('reflect-metadata');

const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const { spawnSync } = require('node:child_process');
const { unlink } = require('node:fs/promises');
const { tmpdir } = require('node:os');
const { join } = require('node:path');

process.env.NODE_ENV = process.env.NODE_ENV || 'test';
process.env.JWT_SECRET = process.env.JWT_SECRET || 'openbridge-test-secret-at-least-32-characters-long';
// Keep the login throttle small enough to exercise it without flooding.
process.env.AUTH_LOGIN_LIMIT = process.env.AUTH_LOGIN_LIMIT || '3';
process.env.AUTH_LOGIN_USERNAME_LIMIT = process.env.AUTH_LOGIN_USERNAME_LIMIT || '3';
process.env.AUTH_REGISTER_LIMIT = process.env.AUTH_REGISTER_LIMIT || '20';

const { NestFactory } = require('@nestjs/core');
const { ValidationPipe } = require('@nestjs/common');
const { JwtService } = require('@nestjs/jwt');
const { io } = require('socket.io-client');
const { PrismaClient } = require('@prisma/client');
const { AppModule } = require('../dist/app.module');
const { isOriginAllowed } = require('../dist/config/env');

const API_PREFIX = '/api';
const PNG_1X1 = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==',
  'base64',
);

const suffix = `${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`;
const createdUserIds = [];
const uploadedFiles = [];
const sockets = {};

let app;
let prisma;
let origin;
let group;
let messageId;

async function api(path, { method = 'GET', token, body, headers = {} } = {}) {
  const response = await fetch(`${origin}${API_PREFIX}${path}`, {
    method,
    headers: {
      'Content-Type': 'application/json',
      ...headers,
      ...(token ? { Authorization: `Bearer ${token}` } : {}),
    },
    body: body ? JSON.stringify(body) : undefined,
  });
  const data = await response.json().catch(() => ({}));
  return { status: response.status, data, headers: response.headers };
}

async function register(label) {
  const result = await api('/auth/register', {
    method: 'POST',
    body: {
      username: `obt_${suffix}_${label}`,
      displayName: `Security ${label}`,
      password: 'TestPass123!',
    },
  });
  assert.equal(result.status, 201, `register ${label}`);
  assert.equal(typeof result.data.token, 'string', 'access token');
  assert.equal(typeof result.data.refreshToken, 'string', 'refresh token');
  createdUserIds.push(result.data.user.id);
  return result.data;
}

function connectSocket(token) {
  return new Promise(resolve => {
    const socket = io(origin, { auth: { token }, transports: ['websocket'], reconnection: false, timeout: 5000 });
    const timer = setTimeout(() => resolve({ socket, connected: false, reason: 'timeout' }), 6000);
    socket.on('connect', () => {
      clearTimeout(timer);
      resolve({ socket, connected: true });
    });
    socket.on('connect_error', error => {
      clearTimeout(timer);
      resolve({ socket, connected: false, reason: error.message });
    });
  });
}

function emitAck(socket, event, payload, ms = 4000) {
  return new Promise(resolve => {
    const timer = setTimeout(() => resolve({ timeout: true }), ms);
    socket.emit(event, payload, result => {
      clearTimeout(timer);
      resolve(result);
    });
  });
}

function waitEvent(socket, event, ms = 1200) {
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

async function upload(token, buffer, type, filename) {
  const form = new FormData();
  form.append('file', new Blob([buffer], { type }), filename);
  const response = await fetch(`${origin}${API_PREFIX}/uploads`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${token}` },
    body: form,
  });
  const data = await response.json().catch(() => ({}));
  if (data.url) uploadedFiles.push(data.url.split('/').pop());
  return { status: response.status, data };
}

before(async () => {
  app = await NestFactory.create(AppModule, { logger: false });
  // Tests send X-Forwarded-For in the throttling case, so trust one proxy hop.
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

  const alice = await register('alice');
  const bob = await register('bob');
  const eve = await register('eve');

  const groupResponse = await api('/messages/groups', {
    method: 'POST',
    token: alice.token,
    body: { name: `Security group ${suffix}`, memberIds: [bob.user.id] },
  });
  assert.equal(groupResponse.status, 201, 'group creation');
  group = groupResponse.data;
  assert.equal(group.participants.length, 2);

  const aliceSocket = await connectSocket(alice.token);
  const bobSocket = await connectSocket(bob.token);
  const eveSocket = await connectSocket(eve.token);
  assert.equal(aliceSocket.connected, true, 'alice socket');
  assert.equal(bobSocket.connected, true, 'bob socket');
  assert.equal(eveSocket.connected, true, 'eve socket');

  sockets.alice = aliceSocket.socket;
  sockets.bob = bobSocket.socket;
  sockets.eve = eveSocket.socket;

  const delivered = waitEvent(sockets.bob, 'message:new', 4000);
  const sent = await emitAck(sockets.alice, 'message:send', {
    conversationId: group.id,
    type: 'text',
    text: 'hello group',
  });
  assert.equal(sent.ok, true, 'group message send');
  const message = await delivered;
  assert.equal(message?.text, 'hello group', 'group message delivered');
  messageId = message.id;

  const directDelivered = waitEvent(sockets.bob, 'message:new', 4000);
  const directSent = await emitAck(sockets.alice, 'message:send', {
    toId: bob.user.id,
    type: 'text',
    text: 'direct hello',
  });
  assert.equal(directSent.ok, true, 'direct message send');
  const directMessage = await directDelivered;
  assert.equal(directMessage?.receiverId, bob.user.id, 'direct message delivered');

  Object.assign(global.__ctx, { alice, bob, eve });
});

after(async () => {
  for (const socket of Object.values(sockets)) socket?.disconnect();

  if (prisma && createdUserIds.length) {
    await prisma.conversation.deleteMany({ where: { participants: { some: { userId: { in: createdUserIds } } } } });
    await prisma.user.deleteMany({ where: { id: { in: createdUserIds } } });
    await prisma.$disconnect();
  }
  for (const filename of uploadedFiles) {
    await unlink(join(process.cwd(), 'uploads', filename)).catch(() => {});
  }
  await app?.close();
});

global.__ctx = {};

test('missing JWT_SECRET fails fast at startup', () => {
  const env = { ...process.env, NODE_ENV: 'production' };
  delete env.JWT_SECRET;
  delete env.FILE_URL_SECRET;
  // Run outside the backend directory so no .env file is loaded.
  const result = spawnSync(process.execPath, [join(__dirname, '..', 'dist', 'main.js')], {
    cwd: tmpdir(),
    env,
    encoding: 'utf8',
    timeout: 15000,
  });
  assert.notEqual(result.status, 0, 'process must exit non-zero');
  assert.match(`${result.stdout}${result.stderr}`, /JWT_SECRET/);
});

test('rejects unauthenticated and forged HTTP requests', async () => {
  const anonymous = await api('/users/me');
  assert.equal(anonymous.status, 401);

  // Sign a structurally valid token with the wrong secret to prove the server
  // actually verifies signatures instead of trusting claims.
  const forged = new JwtService({ secret: 'wrong-secret-wrong-secret-wrong-secret' });
  const token = forged.sign({ sub: global.__ctx.alice.user.id }, { expiresIn: '1h' });
  const response = await api('/users/me', { token });
  assert.equal(response.status, 401);

  // Correctly signed tokens still need an active server-side session.
  const genuine = new JwtService({ secret: process.env.JWT_SECRET });
  const noSession = genuine.sign({ sub: global.__ctx.alice.user.id, sid: '00000000-0000-4000-8000-000000000000' });
  assert.equal((await api('/users/me', { token: noSession })).status, 401, 'unknown session id');
  const noSid = genuine.sign({ sub: global.__ctx.alice.user.id });
  assert.equal((await api('/users/me', { token: noSid })).status, 401, 'missing session id');
});

test('validates group and pagination inputs', async () => {
  const { alice, bob } = global.__ctx;

  assert.equal((await api(`/messages/${alice.user.id}`, { token: alice.token })).status, 400, 'self chat');
  assert.equal((await api(`/messages/${bob.user.id}?take=1000`, { token: alice.token })).status, 400, 'take bound');
  assert.equal((await api(`/messages/${bob.user.id}?skip=-1`, { token: alice.token })).status, 400, 'negative skip');
  assert.equal((await api('/messages/groups/not-a-uuid', { token: alice.token })).status, 400, 'bad group id');
  assert.equal((await api('/messages/groups', {
    method: 'POST',
    token: alice.token,
    body: { name: 'x', memberIds: [bob.user.id] },
  })).status, 400, 'short group name');
  assert.equal((await api('/messages/groups', {
    method: 'POST',
    token: alice.token,
    body: { name: 'Valid name', memberIds: ['not-a-uuid'] },
  })).status, 400, 'invalid member id');
  assert.equal((await api('/users/me', {
    method: 'PATCH',
    token: alice.token,
    body: { avatar: 'javascript:alert(1)' },
  })).status, 400, 'avatar scheme');
});

test('non-members cannot read, write, react or type in a group', async () => {
  const { eve } = global.__ctx;

  assert.equal((await api(`/messages/groups/${group.id}`, { token: eve.token })).status, 403, 'group history');

  const send = await emitAck(sockets.eve, 'message:send', {
    conversationId: group.id,
    type: 'text',
    text: 'intruder',
  });
  assert.equal(send.ok, false, 'outsider send');

  const reactionLeak = waitEvent(sockets.bob, 'reaction:added', 1000);
  const reaction = await emitAck(sockets.eve, 'reaction:add', { messageId, emoji: '💥' });
  assert.equal(reaction.ok, false, 'outsider reaction');
  assert.equal(await reactionLeak, null, 'reaction not broadcast');

  const typingLeak = waitEvent(sockets.bob, 'typing:start', 1000);
  sockets.eve.emit('typing:start', { conversationId: group.id });
  assert.equal(await typingLeak, null, 'typing not relayed');
});

test('participants can react and receive the event', async () => {
  const { alice } = global.__ctx;

  const event = waitEvent(sockets.bob, 'reaction:added', 4000);
  const reaction = await emitAck(sockets.alice, 'reaction:add', { messageId, emoji: '👍' });
  assert.equal(reaction.ok, true);
  const payload = await event;
  assert.equal(payload?.emoji, '👍');
  assert.equal(payload?.conversationId, group.id);
  assert.equal(payload?.userId, alice.user.id);
});

test('socket payloads are validated', async () => {
  const { alice } = global.__ctx;

  const oversized = await emitAck(sockets.alice, 'message:send', { conversationId: group.id, type: 'text', text: 'x'.repeat(4001) });
  assert.equal(oversized.ok, false, 'oversized text');

  const invalidType = await emitAck(sockets.alice, 'message:send', { conversationId: group.id, type: 'HTML', text: 'x' });
  assert.equal(invalidType.ok, false, 'invalid type');

  const selfDm = await emitAck(sockets.alice, 'message:send', { toId: alice.user.id, type: 'text', text: 'self' });
  assert.equal(selfDm.ok, false, 'self DM');

  const invalidFile = await emitAck(sockets.alice, 'message:send', {
    conversationId: group.id,
    type: 'image',
    fileUrl: 'https://evil.example.com/tracker.png',
  });
  assert.equal(invalidFile.ok, false, 'external file URL');
});

test('sockets with invalid tokens are rejected', async () => {
  const invalid = await connectSocket('not-a-jwt');
  // The handshake can briefly succeed before the server-side auth check
  // disconnects the socket, so give the disconnect event a moment to arrive.
  await new Promise(resolve => setTimeout(resolve, 300));
  assert.equal(invalid.socket.connected, false);
  invalid.socket.disconnect();
});

test('uploads are type-checked and only readable through signed URLs', async () => {
  const { alice } = global.__ctx;

  const html = await upload(alice.token, Buffer.from('<html>attack</html>'), 'text/html', 'x.html');
  assert.equal(html.status, 400, 'HTML upload');

  const disguised = await upload(alice.token, Buffer.from('<script>alert(1)</script>'), 'image/png', 'fake.png');
  assert.equal(disguised.status, 400, 'fake PNG');

  const valid = await upload(alice.token, PNG_1X1, 'image/png', 'pixel.png');
  assert.equal(valid.status, 201, 'valid PNG');
  assert.match(valid.data.url, /^\/uploads\/[a-f0-9-]+\.png$/);

  const filename = valid.data.url.split('/').pop();
  const unsigned = await fetch(`${origin}${API_PREFIX}${valid.data.url}`);
  assert.equal(unsigned.status, 403, 'unsigned download');

  const patch = await api('/users/me', {
    method: 'PATCH',
    token: alice.token,
    body: { avatar: valid.data.url },
  });
  assert.equal(patch.status, 200);

  const me = await api('/users/me', { token: alice.token });
  const signedUrl = me.data.avatar;
  assert.match(signedUrl, /^\/uploads\/.+\.png\?exp=\d+&sig=[a-f0-9]{64}$/);

  const signed = await fetch(`${origin}${API_PREFIX}${signedUrl}`);
  assert.equal(signed.status, 200, 'signed download');
  assert.equal(signed.headers.get('content-type'), 'image/png');
  assert.equal(signed.headers.get('x-content-type-options'), 'nosniff');

  const tampered = await fetch(`${origin}${API_PREFIX}${signedUrl.replace(/sig=[a-f0-9]{4}/, 'sig=dead')}`);
  assert.equal(tampered.status, 403, 'tampered signature');

  assert.match(filename, /^[a-f0-9-]+\.png$/);
  assert.equal(uploadedFiles.includes(filename), true);
});

test('CORS rejects unknown origins and allows configured dev origins', async () => {
  const evil = await fetch(`${origin}${API_PREFIX}`, { headers: { Origin: 'https://evil.example.com' } });
  assert.equal(evil.headers.get('access-control-allow-origin'), null);

  const local = await fetch(`${origin}${API_PREFIX}`, { headers: { Origin: 'http://localhost:5173' } });
  assert.equal(local.headers.get('access-control-allow-origin'), 'http://localhost:5173');
});

test('refresh tokens rotate and session revocation is immediate', async () => {
  const { alice, bob } = global.__ctx;
  const username = `obt_${suffix}_alice`;

  const refreshed = await api('/auth/refresh', {
    method: 'POST',
    body: { refreshToken: alice.refreshToken },
  });
  assert.equal(refreshed.status, 200, 'refresh succeeds');
  assert.notEqual(refreshed.data.refreshToken, alice.refreshToken, 'refresh token rotated');
  assert.equal((await api('/users/me', { token: refreshed.data.token })).status, 200, 'new access token works');

  const reused = await api('/auth/refresh', {
    method: 'POST',
    body: { refreshToken: alice.refreshToken },
  });
  assert.equal(reused.status, 401, 'rotated token cannot be reused');

  const loginB = await api('/auth/login', {
    method: 'POST',
    body: { username, password: 'TestPass123!' },
  });
  const loginC = await api('/auth/login', {
    method: 'POST',
    body: { username, password: 'TestPass123!' },
  });
  assert.equal(loginB.status, 200);
  assert.equal(loginC.status, 200);

  const listed = await api('/auth/sessions', { token: alice.token });
  assert.equal(listed.status, 200);
  assert.equal(listed.data.filter(session => session.current).length, 1, 'exactly one current session');
  assert.ok(listed.data.length >= 3, 'all active sessions listed');

  const crossUser = await api('/auth/sessions', { token: bob.token });
  const bobCurrent = crossUser.data.find(session => session.current);
  const crossRevoke = await api(`/auth/sessions/${bobCurrent.id}`, {
    method: 'DELETE',
    token: alice.token,
  });
  assert.equal(crossRevoke.status, 404, 'cannot revoke another user\'s session');

  assert.equal((await api('/auth/logout', { method: 'POST', token: loginB.data.token })).status, 200);
  assert.equal((await api('/users/me', { token: loginB.data.token })).status, 401, 'logged-out access token');
  assert.equal((await api('/auth/refresh', {
    method: 'POST',
    body: { refreshToken: loginB.data.refreshToken },
  })).status, 401, 'logged-out refresh token');

  const revokedSocket = await connectSocket(loginB.data.token);
  await new Promise(resolve => setTimeout(resolve, 300));
  assert.equal(revokedSocket.socket.connected, false, 'revoked session cannot open a socket');
  revokedSocket.socket.disconnect();

  const sessionsC = await api('/auth/sessions', { token: loginC.data.token });
  const currentC = sessionsC.data.find(session => session.current);
  assert.ok(currentC, 'current session id');
  assert.equal((await api(`/auth/sessions/${currentC.id}`, {
    method: 'DELETE',
    token: alice.token,
  })).status, 200);
  assert.equal((await api('/users/me', { token: loginC.data.token })).status, 401, 'revoked access token');
  assert.equal((await api('/auth/refresh', {
    method: 'POST',
    body: { refreshToken: loginC.data.refreshToken },
  })).status, 401, 'revoked refresh token');
});

test('login is throttled per IP and username', async () => {
  // A fresh username and client IP keep this test independent of earlier logins.
  const victim = `obt_${suffix}_throttle`;
  // A dedicated client IP keeps this test independent of earlier logins.
  const headers = { 'X-Forwarded-For': '198.51.100.23' };
  for (let attempt = 1; attempt <= 3; attempt += 1) {
    const result = await api('/auth/login', {
      method: 'POST',
      headers,
      body: { username: victim, password: 'WrongPass123!' },
    });
    assert.equal(result.status, 401, `attempt ${attempt} still reaches password check`);
  }

  const blocked = await api('/auth/login', {
    method: 'POST',
    headers,
    body: { username: victim, password: 'WrongPass123!' },
  });
  assert.equal(blocked.status, 429, 'fourth attempt is rate limited');
  assert.equal(blocked.data.message, 'تلاش‌های بیش از حد؛ لطفاً بعداً دوباره تلاش کنید');
  assert.ok(Number(blocked.headers.get('retry-after')) > 0, 'Retry-After header');
});
