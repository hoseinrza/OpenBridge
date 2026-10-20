require('reflect-metadata');

const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const { spawnSync } = require('node:child_process');
const { unlink } = require('node:fs/promises');
const net = require('node:net');
const { tmpdir } = require('node:os');
const { join } = require('node:path');
const { EICAR } = require('./fixtures');

process.env.NODE_ENV = process.env.NODE_ENV || 'test';
process.env.JWT_SECRET = process.env.JWT_SECRET || 'openbridge-test-secret-at-least-32-characters-long';
// The suite opens several sessions and finishes several sign-ups; keep the
// throttles wide enough not to interfere, except the per-phone bucket, which
// the throttling test exercises on purpose.
process.env.AUTH_OTP_REQUEST_LIMIT = process.env.AUTH_OTP_REQUEST_LIMIT || '50';
process.env.AUTH_OTP_REQUEST_PHONE_LIMIT = process.env.AUTH_OTP_REQUEST_PHONE_LIMIT || '6';
process.env.AUTH_OTP_VERIFY_LIMIT = process.env.AUTH_OTP_VERIFY_LIMIT || '50';
process.env.AUTH_SIGNUP_LIMIT = process.env.AUTH_SIGNUP_LIMIT || '50';

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
const otpPhones = [];
const uploadedFiles = [];
const sockets = {};

let app;
let prisma;
let origin;
let group;
let messageId;
let clamStub;
let clamScanCount = 0;

// Minimal clamd stand-in speaking INSTREAM: replies FOUND for EICAR tests and
// OK otherwise. It lets the upload path exercise the real network protocol.
function startClamStub() {
  const server = net.createServer(socket => {
    let buffer = Buffer.alloc(0);
    let payload = Buffer.alloc(0);
    let commandSeen = false;

    socket.on('data', chunk => {
      buffer = Buffer.concat([buffer, chunk]);
      if (!commandSeen) {
        const end = buffer.indexOf(0);
        if (end === -1) return;
        buffer = buffer.subarray(end + 1);
        commandSeen = true;
      }
      while (buffer.length >= 4) {
        const length = buffer.readUInt32BE(0);
        if (length === 0) {
          buffer = buffer.subarray(4);
          clamScanCount += 1;
          const infected = payload.includes(EICAR);
          socket.end(Buffer.from(infected ? 'stream: Eicar-Test-Signature FOUND\0' : 'stream: OK\0'));
          return;
        }
        if (buffer.length < 4 + length) return;
        payload = Buffer.concat([payload, buffer.subarray(4, 4 + length)]);
        buffer = buffer.subarray(4 + length);
      }
    });
  });
  return new Promise(resolve => {
    server.listen(0, '127.0.0.1', () => resolve({ server, port: server.address().port }));
  });
}

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

function freshPhone() {
  // 09 + nine digits, the canonical form the API stores.
  return `09${String(Math.floor(Math.random() * 1e9)).padStart(9, '0')}`;
}

// Completes the whole sign-up: request a code, verify it, then finish the
// username and name steps. Returns the session payload.
async function createUser(label, { username, firstName = 'Security', lastName = label, phone = freshPhone() } = {}) {
  otpPhones.push(phone);
  const requested = await api('/auth/otp/request', { method: 'POST', body: { phone } });
  assert.equal(requested.status, 200, `otp request ${label}`);
  assert.equal(requested.data.isNewUser, true, `new number for ${label}`);

  const verified = await api('/auth/otp/verify', {
    method: 'POST',
    body:     { phone, code: requested.data.testCode },
  });
  assert.equal(verified.status, 200, `otp verify ${label}`);
  assert.equal(verified.data.requiresSignup, true, `sign-up token for ${label}`);

  const created = await api('/auth/signup', {
    method: 'POST',
    body:   {
      signupToken: verified.data.signupToken,
      username:    username ?? `obt_${suffix}_${label}`,
      firstName,
      lastName,
    },
  });
  assert.equal(created.status, 201, `signup ${label}`);
  createdUserIds.push(created.data.user.id);
  return created.data;
}

// Signs an existing account in with a fresh code and returns its new session.
async function signInByOtp(phone) {
  const requested = await api('/auth/otp/request', { method: 'POST', body: { phone } });
  assert.equal(requested.status, 200, 'otp request for an existing account');
  assert.equal(requested.data.isNewUser, false, 'existing account detected');

  const verified = await api('/auth/otp/verify', {
    method: 'POST',
    body:     { phone, code: requested.data.testCode },
  });
  assert.equal(verified.status, 200, 'otp verify for an existing account');
  return verified.data;
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
  clamStub = await startClamStub();
  process.env.UPLOAD_SCAN_ENABLED = 'true';
  process.env.CLAMAV_HOST = '127.0.0.1';
  process.env.CLAMAV_PORT = String(clamStub.port);

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

  const alice = await createUser('alice');
  const bob = await createUser('bob');
  const eve = await createUser('eve');

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

  if (prisma) {
    if (otpPhones.length) {
      await prisma.otpCode.deleteMany({ where: { phone: { in: otpPhones } } });
    }
    if (createdUserIds.length) {
      await prisma.conversation.deleteMany({ where: { participants: { some: { userId: { in: createdUserIds } } } } });
      await prisma.user.deleteMany({ where: { id: { in: createdUserIds } } });
    }
    await prisma.$disconnect();
  }
  for (const filename of uploadedFiles) {
    await unlink(join(process.cwd(), 'uploads', filename)).catch(() => {});
  }
  await new Promise(resolve => clamStub?.server.close(resolve));
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
  assert.equal((await api('/users/me', {
    method: 'PATCH',
    token: alice.token,
    body: { firstName: 'Ali 123' },
  })).status, 400, 'digits are not a name');
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

  const infected = await upload(alice.token, Buffer.from(EICAR), 'text/plain', 'eicar.txt');
  assert.equal(infected.status, 400, 'malware rejected');
  assert.equal(infected.data.message, 'فایل آلوده است');

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
  assert.ok(clamScanCount >= 2, 'clean and infected uploads both reached clamd');
});

test('CORS rejects unknown origins and allows configured dev origins', async () => {
  const evil = await fetch(`${origin}${API_PREFIX}`, { headers: { Origin: 'https://evil.example.com' } });
  assert.equal(evil.headers.get('access-control-allow-origin'), null);

  const local = await fetch(`${origin}${API_PREFIX}`, { headers: { Origin: 'http://localhost:5173' } });
  assert.equal(local.headers.get('access-control-allow-origin'), 'http://localhost:5173');
});

test('refresh tokens rotate and session revocation is immediate', async () => {
  const { alice, bob } = global.__ctx;

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

  // Two more sign-ins for the same account give two more live sessions.
  const loginB = await signInByOtp(alice.user.phone);
  const loginC = await signInByOtp(alice.user.phone);

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

  assert.equal((await api('/auth/logout', { method: 'POST', token: loginB.token })).status, 200);
  assert.equal((await api('/users/me', { token: loginB.token })).status, 401, 'logged-out access token');
  assert.equal((await api('/auth/refresh', {
    method: 'POST',
    body: { refreshToken: loginB.refreshToken },
  })).status, 401, 'logged-out refresh token');

  const revokedSocket = await connectSocket(loginB.token);
  await new Promise(resolve => setTimeout(resolve, 300));
  assert.equal(revokedSocket.socket.connected, false, 'revoked session cannot open a socket');
  revokedSocket.socket.disconnect();

  const sessionsC = await api('/auth/sessions', { token: loginC.token });
  const currentC = sessionsC.data.find(session => session.current);
  assert.ok(currentC, 'current session id');
  assert.equal((await api(`/auth/sessions/${currentC.id}`, {
    method: 'DELETE',
    token: alice.token,
  })).status, 200);
  assert.equal((await api('/users/me', { token: loginC.token })).status, 401, 'revoked access token');
  assert.equal((await api('/auth/refresh', {
    method: 'POST',
    body: { refreshToken: loginC.refreshToken },
  })).status, 401, 'revoked refresh token');
});

test('a verified new number finishes sign-up in its own steps', async () => {
  const phone = freshPhone();
  const username = `otp_user_${String(Date.now()).slice(-7)}`;
  otpPhones.push(phone);

  const invalid = await api('/auth/otp/request', {
    method: 'POST',
    body: { phone: '12345' },
  });
  assert.equal(invalid.status, 400, 'invalid phone rejected');

  // The formatted international form must normalize to the stored 09... form.
  const requested = await api('/auth/otp/request', {
    method: 'POST',
    body: { phone: `+98${phone.slice(1)}` },
  });
  assert.equal(requested.status, 200);
  assert.equal(requested.data.phone, phone, 'phone normalized');
  assert.equal(requested.data.isNewUser, true);
  assert.match(requested.data.testCode, /^\d{6}$/);
  assert.ok(requested.data.expiresInSeconds > 0);

  const wrongCode = requested.data.testCode === '000000' ? '111111' : '000000';
  assert.equal((await api('/auth/otp/verify', {
    method: 'POST',
    body: { phone, code: wrongCode },
  })).status, 401, 'wrong code rejected');

  const verified = await api('/auth/otp/verify', {
    method: 'POST',
    body: { phone, code: requested.data.testCode },
  });
  assert.equal(verified.status, 200);
  assert.equal(verified.data.requiresSignup, true, 'new number goes to sign-up');
  assert.equal(typeof verified.data.signupToken, 'string', 'sign-up token issued');
  assert.equal(verified.data.token, undefined, 'no session before the account exists');
  assert.ok(verified.data.signupExpiresInSeconds > 0, 'sign-up window advertised');

  assert.equal((await api('/auth/otp/verify', {
    method: 'POST',
    body: { phone, code: requested.data.testCode },
  })).status, 401, 'code is single use');

  const forged = new JwtService({ secret: 'wrong-secret-wrong-secret-wrong-secret' })
    .sign({ pur: 'signup', phone }, { expiresIn: '5m' });
  assert.equal((await api('/auth/signup', {
    method: 'POST',
    body: { signupToken: forged, username, firstName: 'OTP', lastName: 'User' },
  })).status, 401, 'token signed with another secret is refused');

  // A sign-up token must not be usable as an access token.
  assert.equal((await api('/users/me', { token: verified.data.signupToken })).status, 401, 'not an access token');

  assert.equal((await api('/auth/signup', {
    method: 'POST',
    body: { signupToken: verified.data.signupToken, username: 'ali.ce', firstName: 'OTP', lastName: 'User' },
  })).status, 400, 'invalid username format rejected');

  assert.equal((await api('/auth/signup', {
    method: 'POST',
    body: { signupToken: verified.data.signupToken, username },
  })).status, 400, 'given name is required');

  assert.equal((await api('/auth/signup', {
    method: 'POST',
    body: { signupToken: verified.data.signupToken, username, firstName: 'علی ۲' },
  })).status, 400, 'digits are not a name');

  assert.equal((await api('/auth/signup', {
    method: 'POST',
    body: {
      signupToken: verified.data.signupToken,
      username:    global.__ctx.bob.user.username,
      firstName:   'OTP',
      lastName:    'User',
    },
  })).status, 409, 'duplicate username rejected');

  // The failed attempts above must not have burned the token.
  const created = await api('/auth/signup', {
    method: 'POST',
    body: {
      signupToken: verified.data.signupToken,
      username,
      firstName:   'OTP',
      lastName:    'User',
    },
  });
  assert.equal(created.status, 201);
  assert.equal(created.data.user.username, username, 'user-chosen username stored');
  assert.equal(created.data.user.firstName, 'OTP');
  assert.equal(created.data.user.lastName, 'User');
  assert.equal(created.data.user.displayName, 'OTP User', 'display name derived from both parts');
  assert.equal(created.data.user.phone, phone, 'phone stored on the account');
  assert.equal(typeof created.data.token, 'string');
  assert.equal(typeof created.data.refreshToken, 'string');
  createdUserIds.push(created.data.user.id);

  assert.equal((await api('/auth/signup', {
    method: 'POST',
    body: { signupToken: verified.data.signupToken, username: `${username}_second`, firstName: 'OTP' },
  })).status, 409, 'a spent sign-up token cannot open a second account');

  const me = await api('/users/me', { token: created.data.token });
  assert.equal(me.status, 200);
  assert.equal(me.data.phone, phone, 'own profile includes the phone');
  assert.equal(me.data.firstName, 'OTP', 'own profile includes the name parts');

  // The chosen username stays editable; the phone keeps identifying the account.
  const renamed = await api('/users/me', {
    method: 'PATCH',
    token: created.data.token,
    body: { username: `${username}_renamed` },
  });
  assert.equal(renamed.status, 200, 'chosen username can be renamed');
  assert.equal(renamed.data.username, `${username}_renamed`);

  const relabelled = await api('/users/me', {
    method: 'PATCH',
    token: created.data.token,
    body: { firstName: 'علی', lastName: 'رضایی' },
  });
  assert.equal(relabelled.status, 200, 'name parts can be edited');
  assert.equal(relabelled.data.displayName, 'علی رضایی', 'display name follows the parts');

  const cleared = await api('/users/me', {
    method: 'PATCH',
    token: created.data.token,
    body: { lastName: '' },
  });
  assert.equal(cleared.status, 200, 'family name is optional');
  assert.equal(cleared.data.lastName, null, 'empty family name clears it');
  assert.equal(cleared.data.displayName, 'علی', 'display name keeps the given name');

  const again = await signInByOtp(phone);
  assert.equal(again.user.id, created.data.user.id);
  assert.equal(again.user.username, `${username}_renamed`, 'renamed username preserved');
  assert.equal(again.requiresSignup, undefined, 'existing account signs straight in');

  // Phone numbers are private: directory and search must never expose them.
  const directory = await api('/users', { token: created.data.token });
  assert.equal(directory.status, 200);
  assert.ok(directory.data.every(u => !('phone' in u)), 'user directory hides phone numbers');
  const search = await api(`/users/search?q=${encodeURIComponent('Security')}`, { token: created.data.token });
  assert.equal(search.status, 200);
  assert.ok(search.data.length > 0, 'search returns other users');
  assert.ok(search.data.every(u => !('phone' in u)), 'search hides phone numbers');
});

test('an expired sign-up token is refused', async () => {
  const phone = freshPhone();
  otpPhones.push(phone);

  const requested = await api('/auth/otp/request', { method: 'POST', body: { phone } });
  assert.equal(requested.status, 200);
  const verified = await api('/auth/otp/verify', {
    method: 'POST',
    body: { phone, code: requested.data.testCode },
  });
  assert.equal(verified.status, 200);

  const expired = new JwtService({ secret: process.env.JWT_SECRET })
    .sign({ pur: 'signup', phone }, { expiresIn: '-1s' });
  const rejected = await api('/auth/signup', {
    method: 'POST',
    body: { signupToken: expired, username: `otp_exp_${String(Date.now()).slice(-7)}`, firstName: 'Expired' },
  });
  assert.equal(rejected.status, 401, 'expired token refused');
  assert.match(rejected.data.message, /مهلت/);

  // Any other purpose in the same signature domain is still refused.
  const wrongPurpose = new JwtService({ secret: process.env.JWT_SECRET })
    .sign({ sub: 'someone', phone }, { expiresIn: '5m' });
  assert.equal((await api('/auth/signup', {
    method: 'POST',
    body: { signupToken: wrongPurpose, username: 'otp_any', firstName: 'Any' },
  })).status, 401, 'access-shaped token is not a sign-up token');
});

test('expired and over-attempted OTP codes are rejected', async () => {
  const phone = freshPhone();
  otpPhones.push(phone);

  const first = await api('/auth/otp/request', { method: 'POST', body: { phone } });
  assert.equal(first.status, 200);
  await prisma.otpCode.updateMany({
    where: { phone, consumedAt: null },
    data:  { expiresAt: new Date(Date.now() - 1000) },
  });
  assert.equal((await api('/auth/otp/verify', {
    method: 'POST',
    body: { phone, code: first.data.testCode },
  })).status, 401, 'expired code rejected');

  const fresh = await api('/auth/otp/request', { method: 'POST', body: { phone } });
  assert.equal(fresh.status, 200);
  const wrongCode = fresh.data.testCode === '000000' ? '111111' : '000000';
  for (let attempt = 1; attempt <= 5; attempt += 1) {
    assert.equal((await api('/auth/otp/verify', {
      method: 'POST',
      body: { phone, code: wrongCode },
    })).status, 401, `wrong attempt ${attempt} rejected`);
  }

  assert.equal((await api('/auth/otp/verify', {
    method: 'POST',
    body: { phone, code: fresh.data.testCode },
  })).status, 401, 'correct code refused after too many attempts');

  const reset = await api('/auth/otp/request', { method: 'POST', body: { phone } });
  assert.equal(reset.status, 200, 'a new request resets the attempt budget');
  const verified = await api('/auth/otp/verify', {
    method: 'POST',
    body: { phone, code: reset.data.testCode },
  });
  assert.equal(verified.status, 200, 'the next code is accepted again');
  assert.equal(verified.data.requiresSignup, true, 'a new number still has to sign up');
});

test('legacy accounts whose username is their phone still sign in by OTP', async () => {
  const phone = freshPhone();
  otpPhones.push(phone);

  // Rows created before the `phone` column existed used the number as username.
  const legacy = await prisma.user.create({
    data: {
      username:    phone,
      displayName: 'Legacy Phone User',
      firstName:   'Legacy',
      lastName:    'Phone User',
      password:    'legacy-password-123',
    },
    select: { id: true, username: true },
  });
  createdUserIds.push(legacy.id);

  const requested = await api('/auth/otp/request', { method: 'POST', body: { phone } });
  assert.equal(requested.status, 200);
  assert.equal(requested.data.isNewUser, false, 'legacy username-as-phone account detected');

  const verified = await api('/auth/otp/verify', {
    method: 'POST',
    body: { phone, code: requested.data.testCode },
  });
  assert.equal(verified.status, 200);
  assert.equal(verified.data.user.id, legacy.id, 'same account, not a duplicate');
  assert.equal(verified.data.user.username, phone, 'legacy username preserved');
  assert.equal(verified.data.user.phone, phone, 'phone linked to the legacy account');

  // An old row can fill in its name parts from the profile afterwards.
  const renamed = await api('/users/me', {
    method: 'PATCH',
    token: verified.data.token,
    body: { username: 'legacy_handle', firstName: 'نام', lastName: 'خانوادگی' },
  });
  assert.equal(renamed.status, 200);
  assert.equal(renamed.data.displayName, 'نام خانوادگی', 'display name derived from the parts');
});

test('OTP requests are throttled per phone number', async () => {
  const phone = freshPhone();
  const limit = Number(process.env.AUTH_OTP_REQUEST_PHONE_LIMIT);
  otpPhones.push(phone);

  for (let attempt = 1; attempt <= limit; attempt += 1) {
    const result = await api('/auth/otp/request', { method: 'POST', body: { phone } });
    assert.equal(result.status, 200, `request ${attempt} allowed`);
  }

  const blocked = await api('/auth/otp/request', { method: 'POST', body: { phone } });
  assert.equal(blocked.status, 429, `request ${limit + 1} for the same phone is rate limited`);
  assert.equal(blocked.data.message, 'تلاش‌های بیش از حد؛ لطفاً بعداً دوباره تلاش کنید');
  assert.ok(Number(blocked.headers.get('retry-after')) > 0, 'Retry-After header');
});

test('the removed password endpoints are gone', async () => {
  const headers = { 'X-Forwarded-For': '198.51.100.24' };
  for (const path of ['/auth/login', '/auth/register']) {
    const result = await api(path, {
      method: 'POST',
      headers,
      body: { username: 'anyone', password: 'anything', displayName: 'Anyone' },
    });
    assert.equal(result.status, 404, `${path} is no longer routed`);
  }
});
