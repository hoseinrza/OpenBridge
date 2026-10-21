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
// The contact-match bucket is kept small so the rate-limit case below can
// exhaust it; every other call in the suite gives itself a fresh client IP.
process.env.CONTACT_MATCH_LIMIT = process.env.CONTACT_MATCH_LIMIT || '3';
// E2EE caps are shrunk so the storage limits are testable without hundreds of
// uploads, and the claim bucket is kept small for its own throttling case.
// Every other E2EE call uses freshIp(), so it never shares a bucket.
process.env.E2EE_CLAIM_LIMIT = process.env.E2EE_CLAIM_LIMIT || '8';
process.env.E2EE_REGISTER_LIMIT = process.env.E2EE_REGISTER_LIMIT || '200';
process.env.E2EE_MAX_DEVICES_PER_USER = process.env.E2EE_MAX_DEVICES_PER_USER || '3';
process.env.E2EE_MAX_PACKAGES_PER_DEVICE = process.env.E2EE_MAX_PACKAGES_PER_DEVICE || '10';
// Envelope caps are shrunk the same way, so an oversized blob costs 3 KB
// instead of the 16 KB the production default allows.
process.env.E2EE_MAX_ENVELOPE_CHARS = process.env.E2EE_MAX_ENVELOPE_CHARS || '2048';

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

// Each contact-match call needs its own bucket, so it gets its own client IP.
let ipSequence = 0;
function freshIp() {
  ipSequence += 1;
  return { 'X-Forwarded-For': `203.0.113.${ipSequence % 240}` };
}

function toPersianDigits(value) {
  return String(value).replace(/\d/g, digit => '۰۱۲۳۴۵۶۷۸۹'[Number(digit)]);
}

// KeyPackages are opaque bytes as far as the server is concerned, so the suite
// uses recognizable base64 instead of real MLS material.
function fakePackage(label) {
  return Buffer.from(`key-package:${label}`).toString('base64');
}

// MLS messages are opaque here too: the delivery service must store and return
// them without understanding them, so recognizable base64 is the right fake.
function fakeEnvelope(label) {
  return Buffer.from(`mls-envelope:${label}`).toString('base64');
}

// Gathers events in arrival order until `count` of them land, or the window
// closes. Ordering assertions need the sequence as received, not a Set.
function collectEvents(socket, event, count, ms = 15_000) {
  return new Promise(resolve => {
    const seen = [];
    const handler = data => {
      seen.push(data);
      if (seen.length === count) finish();
    };
    function finish() {
      clearTimeout(timer);
      socket.off(event, handler);
      resolve(seen);
    }
    const timer = setTimeout(finish, ms);
    socket.on(event, handler);
  });
}

function participant(conversationId, userId) {
  return prisma.conversationParticipant.findUnique({ where: { conversationId_userId: { conversationId, userId } } });
}

// The encrypted chat between alice and bob, resolved the way a client would:
// by asking, never by carrying a conversation id across tests.
async function encryptedDirect(me, peer) {
  const response = await api(`/messages/e2ee/direct/${peer.user.id}`, { token: me.token });
  assert.equal(response.status, 200, 'direct e2ee state');
  assert.equal(response.data.e2ee, true, `${peer.user.username} chat is encrypted`);
  return response.data.conversationId;
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

  const reactionLeak = waitEvent(sockets.bob, 'reaction:changed', 1000);
  const reaction = await emitAck(sockets.eve, 'reaction:add', { messageId, emoji: '💥' });
  assert.equal(reaction.ok, false, 'outsider reaction');
  assert.equal(await reactionLeak, null, 'reaction not broadcast');

  const typingLeak = waitEvent(sockets.bob, 'typing:start', 1000);
  sockets.eve.emit('typing:start', { conversationId: group.id });
  assert.equal(await typingLeak, null, 'typing not relayed');
});

test('a reaction is one per person: tapping again lifts it, another emoji replaces it', async () => {
  const { alice, bob } = global.__ctx;

  // Adding sends the whole resulting list to every participant, never a delta,
  // so no client can end up showing more than the people who reacted.
  let changed = waitEvent(sockets.bob, 'reaction:changed', 4000);
  let ack = await emitAck(sockets.alice, 'reaction:add', { messageId, emoji: '👍' });
  assert.equal(ack.ok, true);
  assert.deepEqual(
    ack.reactions?.map(r => [r.userId, r.emoji]),
    [[alice.user.id, '👍']],
    'one row for one person',
  );
  const event = await changed;
  assert.equal(event?.messageId, messageId, 'event names the message');
  assert.equal(event?.conversationId, group.id, 'event names the conversation');
  assert.deepEqual(event?.reactions, ack.reactions, 'broadcast carries the same list');

  // Second tap of the same emoji removes it.
  changed = waitEvent(sockets.bob, 'reaction:changed', 4000);
  ack = await emitAck(sockets.alice, 'reaction:add', { messageId, emoji: '👍' });
  assert.equal(ack.reactions?.length, 0, 'lifted');
  assert.equal((await changed)?.reactions?.length, 0, 'everyone sees it lifted');

  // A different emoji replaces the one held instead of stacking next to it.
  await emitAck(sockets.alice, 'reaction:add', { messageId, emoji: '❤️' });
  ack = await emitAck(sockets.alice, 'reaction:add', { messageId, emoji: '😂' });
  const aliceRows = ack.reactions.filter(r => r.userId === alice.user.id);
  assert.equal(aliceRows.length, 1, 'never more than one reaction per person');
  assert.equal(aliceRows[0].emoji, '😂', 'replaced, not added to');

  // Two people who both pick 😂 are two rows behind one chip — a count of taps
  // can never be built out of one person.
  for (const emoji of ['👍', '❤️', '😂', '👍', '❤️', '😂']) {
    ack = await emitAck(sockets.alice, 'reaction:add', { messageId, emoji });
  }
  assert.equal(ack.reactions.filter(r => r.userId === alice.user.id).length, 1, 'spamming still one row');

  changed = waitEvent(sockets.bob, 'reaction:changed', 4000);
  ack = await emitAck(sockets.bob, 'reaction:add', { messageId, emoji: '😂' });
  assert.equal(ack.reactions?.length, 2, 'two people, two rows');
  assert.equal(ack.reactions.filter(r => r.emoji === '😂').length, 2, 'a chip with two people');
  assert.ok((await changed) !== null, 'bob is told too');

  // The database is the last word: even a write that skips the service cannot
  // give one person a second reaction on the same message.
  await assert.rejects(
    prisma.reaction.create({ data: { userId: alice.user.id, messageId, emoji: '💯' } }),
    (err) => err?.code === 'P2002',
    'unique (userId, messageId)',
  );
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

test('device contacts are matched without exposing phone numbers', async () => {
  const { alice, bob } = global.__ctx;
  const { phone: bobPhone } = await prisma.user.findUnique({ where: { id: bob.user.id }, select: { phone: true } });
  const { phone: alicePhone } = await prisma.user.findUnique({ where: { id: alice.user.id }, select: { phone: true } });

  const notRegistered = freshPhone();
  const storedWithPlus = `+98${bobPhone.slice(1)}`;
  const persianDigits = toPersianDigits(freshPhone());

  // A realistic address book: a landline, the same account written three
  // different ways, numbers nobody owns, and the caller's own number.
  const phones = [
    '02188776655',
    storedWithPlus,
    persianDigits,
    notRegistered,
    alicePhone,
    `0098${bobPhone.slice(1)}`,
    bobPhone,
  ];

  const matched = await api('/users/contacts/match', {
    method: 'POST',
    token:  alice.token,
    headers: freshIp(),
    body:   { phones },
  });
  assert.equal(matched.status, 200, 'contact match');
  // Only distinct valid mobile numbers other than the caller's own are checked.
  assert.equal(matched.data.checked, 3, 'landline, self and duplicates are dropped');
  assert.equal(matched.data.matches.length, 1, 'one account found');
  assert.equal(matched.data.matches[0].index, 1, 'mapped to the first input position of that number');
  assert.equal(matched.data.matches[0].user.id, bob.user.id, 'matched account');

  const payload = JSON.stringify(matched.data);
  assert.ok(!payload.includes(bobPhone), 'matched phone not echoed');
  assert.ok(!payload.includes(notRegistered), 'unmatched phone not echoed');
  assert.ok(!/09\d{9}/.test(payload), 'no Iranian mobile number anywhere in the response');
  assert.equal(matched.data.matches[0].user.phone, undefined, 'profile carries no phone field');
  assert.equal(typeof matched.data.matches[0].user.online, 'boolean', 'presence included');

  // An address book where nobody has an account is an empty result, not an error.
  const nobody = await api('/users/contacts/match', {
    method: 'POST',
    token:  alice.token,
    headers: freshIp(),
    body:   { phones: [notRegistered, '02188776655'] },
  });
  assert.equal(nobody.status, 200);
  assert.deepEqual(nobody.data, { checked: 1, matches: [] });
});

test('contact match input is validated and requires a session', async () => {
  const { alice } = global.__ctx;
  const maxPhones = Number(process.env.CONTACT_MATCH_MAX_PHONES || 500);

  const anonymous = await api('/users/contacts/match', {
    method: 'POST',
    body:   { phones: ['09123456789'] },
  });
  assert.equal(anonymous.status, 401, 'no session, no matching');

  const empty = await api('/users/contacts/match', {
    method: 'POST',
    token:  alice.token,
    headers: freshIp(),
    body:   { phones: [] },
  });
  assert.equal(empty.status, 400, 'an empty address book is a client error');

  const oversized = await api('/users/contacts/match', {
    method: 'POST',
    token:  alice.token,
    headers: freshIp(),
    body:   { phones: Array.from({ length: maxPhones + 1 }, (_, i) => `09${String(i).padStart(9, '0')}`) },
  });
  assert.equal(oversized.status, 400, 'list length is capped');

  const notStrings = await api('/users/contacts/match', {
    method: 'POST',
    token:  alice.token,
    headers: freshIp(),
    body:   { phones: [1234567890] },
  });
  assert.equal(notStrings.status, 400, 'numbers must arrive as strings');

  const missing = await api('/users/contacts/match', {
    method: 'POST',
    token:  alice.token,
    headers: freshIp(),
    body:   {},
  });
  assert.equal(missing.status, 400, 'phones is required');
});

test('contact matching is rate limited per client', async () => {
  const { alice } = global.__ctx;
  const headers = { 'X-Forwarded-For': '198.51.100.77' };
  const limit = Number(process.env.CONTACT_MATCH_LIMIT);

  for (let attempt = 1; attempt <= limit; attempt += 1) {
    const result = await api('/users/contacts/match', {
      method: 'POST',
      token:  alice.token,
      headers,
      body:   { phones: ['09123456789'] },
    });
    assert.equal(result.status, 200, `match ${attempt} allowed`);
  }

  const blocked = await api('/users/contacts/match', {
    method: 'POST',
    token:  alice.token,
    headers,
    body:   { phones: ['09123456789'] },
  });
  assert.equal(blocked.status, 429, 'the endpoint cannot be used to enumerate accounts quickly');
  assert.ok(Number(blocked.headers.get('retry-after')) > 0, 'Retry-After header');
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

// ── E2EE Phase 1: devices and key packages ─────────────────────────
// These cases cover the custody rule (design doc §4): the server holds opaque
// public blobs and must never accept, return or infer private material.

test('device registration stores only the fields the client declares', async () => {
  const { alice, eve } = global.__ctx;
  const clientId = `alice_${suffix}_primary`;

  const injected = await api('/e2ee/devices', {
    method: 'POST',
    token:  alice.token,
    body:   {
      clientId,
      label:      'Desktop',
      userId:     eve.user.id,
      privateKey: 'MIA-private-key-material',
      state:      'MIA-mls-client-state',
    },
  });
  assert.equal(injected.status, 201, 'own device registers');
  assert.deepEqual(Object.keys(injected.data).sort(), [
    'availableKeyPackages', 'clientId', 'createdAt', 'id', 'label', 'lastSeenAt',
  ], 'the response is the declared device view and nothing else');

  const leaked = await prisma.device.count({ where: { userId: eve.user.id } });
  assert.equal(leaked, 0, 'an injected userId cannot register a device on another account');

  const row = await prisma.device.findUnique({
    where: { userId_clientId: { userId: alice.user.id, clientId } },
  });
  assert.ok(row, 'device row exists');
  assert.ok(!JSON.stringify(row).includes('MIA'), 'no private key or client state was stored');

  const again = await api('/e2ee/devices', {
    method: 'POST',
    token:  alice.token,
    body:   { clientId, label: 'لپ‌تاپ' },
  });
  assert.equal(again.status, 201);
  assert.equal(again.data.id, row.id, 'the same install re-registers the same device');
  assert.equal(again.data.label, 'لپ‌تاپ', 'a new label renames it');
  assert.equal((await api('/e2ee/devices', { token: alice.token })).data.length, 1, 'no duplicate device rows');
});

test('device and key-package inputs are validated and capped', async () => {
  const owner = await createUser('caps');
  const perUpload  = Number(process.env.E2EE_MAX_PACKAGES_PER_UPLOAD || 50);
  const perDevice  = Number(process.env.E2EE_MAX_PACKAGES_PER_DEVICE);
  const maxChars   = Number(process.env.E2EE_MAX_PACKAGE_CHARS || 4096);
  const maxDevices = Number(process.env.E2EE_MAX_DEVICES_PER_USER);
  const pool       = `pool_${suffix}`;
  const poolPath   = `/e2ee/devices/${pool}/key-packages`;

  assert.equal((await api('/e2ee/devices', { method: 'POST', body: { clientId: 'abcdefgh' } })).status, 401, 'no session, no device');
  assert.equal((await api('/e2ee/devices', { method: 'POST', token: owner.token, body: { clientId: 'short' } })).status, 400, 'clientId too short');
  assert.equal((await api('/e2ee/devices', { method: 'POST', token: owner.token, body: { clientId: `has spaces` } })).status, 400, 'clientId charset');
  assert.equal((await api('/e2ee/devices', { method: 'POST', token: owner.token, body: { clientId: `label_${suffix}`, label: 'x'.repeat(41) } })).status, 400, 'label length');

  assert.equal((await api(poolPath, { method: 'POST', token: owner.token, body: { packages: [] } })).status, 400, 'empty refill');
  assert.equal((await api(poolPath, { method: 'POST', token: owner.token, body: { packages: ['not base64!!'] } })).status, 400, 'non-base64 package');
  assert.equal((await api(poolPath, {
    method: 'POST',
    token:  owner.token,
    body:   { packages: [Buffer.alloc(Math.floor(maxChars * 3 / 4) + 1).toString('base64')] },
  })).status, 400, 'oversized package');
  assert.equal((await api(poolPath, {
    method: 'POST',
    token:  owner.token,
    body:   { packages: Array.from({ length: perUpload + 1 }, (_, i) => fakePackage(`bulk${i}`)) },
  })).status, 400, 'upload length is capped');
  assert.equal((await api(`/e2ee/devices/never_${suffix}/key-packages`, {
    method: 'POST',
    token:  owner.token,
    body:   { packages: [fakePackage('orphan')] },
  })).status, 404, 'an unknown device cannot be filled');

  assert.equal((await api('/e2ee/devices', { method: 'POST', token: owner.token, body: { clientId: pool } })).status, 201, 'the pool device registers');
  const filled = await api(poolPath, {
    method: 'POST',
    token:  owner.token,
    body:   { packages: Array.from({ length: perDevice }, (_, i) => fakePackage(`fill${i}`)) },
  });
  assert.equal(filled.status, 201, 'the pool fills up to the cap');
  assert.deepEqual(filled.data, { available: perDevice }, 'only the new pool size comes back');
  assert.equal((await api(poolPath, { method: 'POST', token: owner.token, body: { packages: [fakePackage('one too many')] } })).status, 400, 'one package past the cap');

  for (let device = 1; device < maxDevices; device += 1) {
    const result = await api('/e2ee/devices', { method: 'POST', token: owner.token, body: { clientId: `dev_${device}_${suffix}` } });
    assert.equal(result.status, 201, `device ${device} of ${maxDevices} allowed`);
  }
  assert.equal((await api('/e2ee/devices', { method: 'POST', token: owner.token, body: { clientId: `dev_x_${suffix}` } })).status, 409, 'device count is capped');

  const stored = await prisma.keyPackage.count({ where: { device: { userId: owner.user.id } } });
  assert.equal(stored, perDevice, 'only the accepted upload reached the database');
});

test('a key package is handed out to exactly one caller', async () => {
  const { alice, bob } = global.__ctx;
  const clientId = `bob_${suffix}_phone`;
  const uploaded = ['a', 'b', 'c'].map(tag => fakePackage(`${clientId}_${tag}`));
  const claimPath = `/e2ee/users/${bob.user.id}/key-packages`;

  assert.equal((await api('/e2ee/devices', { method: 'POST', token: bob.token, body: { clientId, label: 'گوشی' } })).status, 201);
  const upload = await api(`/e2ee/devices/${clientId}/key-packages`, {
    method: 'POST',
    token:  bob.token,
    body:   { packages: uploaded },
  });
  assert.equal(upload.status, 201);
  assert.deepEqual(upload.data, { available: 3 }, 'the pool size is reported, the contents are not echoed');

  const first = await api(claimPath, { token: alice.token, headers: freshIp() });
  assert.equal(first.status, 200, 'claim');
  assert.equal(first.data.packages.length, 1, 'one package per active device');
  assert.ok(uploaded.includes(first.data.packages[0]), 'stored byte for byte, not re-encoded');

  const second = await api(claimPath, { token: alice.token, headers: freshIp() });
  assert.equal(second.status, 200);
  assert.notEqual(second.data.packages[0], first.data.packages[0], 'the same package is never handed out twice');

  // Two callers race for the last remaining package.
  const [racerA, racerB] = await Promise.all([
    api(claimPath, { token: alice.token, headers: freshIp() }),
    api(claimPath, { token: alice.token, headers: freshIp() }),
  ]);
  assert.deepEqual([racerA.status, racerB.status].sort(), [200, 404], 'exactly one racer gets the last package');
  const winner = racerA.status === 200 ? racerA : racerB;
  const handedOut = new Set([
    first.data.packages[0], second.data.packages[0], winner.data.packages[0],
  ]);
  assert.equal(handedOut.size, 3, 'all three packages were distinct');

  const exhausted = await api(claimPath, { token: alice.token, headers: freshIp() });
  assert.equal(exhausted.status, 404, 'an empty pool is not a usable recipient');
  assert.match(exhausted.data.message, /کلید عمومی/);

  const left = await prisma.keyPackage.count({ where: { device: { clientId }, consumedAt: null } });
  assert.equal(left, 0, 'nothing is left claimable');
});

test('revoking a device removes it from the bundle', async () => {
  const { alice, bob } = global.__ctx;
  const phone  = `bob_${suffix}_phone`;
  const tablet = `bob_${suffix}_tablet`;
  const claimPath = `/e2ee/users/${bob.user.id}/key-packages`;

  assert.equal((await api(`/e2ee/devices/${phone}/key-packages`, {
    method: 'POST',
    token:  bob.token,
    body:   { packages: [fakePackage(`${phone}_r1`), fakePackage(`${phone}_r2`)] },
  })).status, 201, 'the surviving pool refills');
  assert.equal((await api('/e2ee/devices', { method: 'POST', token: bob.token, body: { clientId: tablet } })).status, 201, 'a second device registers');
  assert.equal((await api(`/e2ee/devices/${tablet}/key-packages`, {
    method: 'POST',
    token:  bob.token,
    body:   { packages: [fakePackage(`${tablet}_a`), fakePackage(`${tablet}_b`)] },
  })).status, 201);

  const both = await api(claimPath, { token: alice.token, headers: freshIp() });
  assert.equal(both.status, 200, 'a two-device recipient is claimable');
  assert.equal(both.data.packages.length, 2, 'one package per device, all or nothing');

  const listed = await api('/e2ee/devices', { token: bob.token });
  assert.equal(listed.status, 200);
  assert.equal(listed.data.length, 2);
  assert.deepEqual(Object.keys(listed.data[0]).sort(), [
    'availableKeyPackages', 'clientId', 'createdAt', 'id', 'label', 'lastSeenAt',
  ]);
  assert.ok(!JSON.stringify(listed.data).includes(fakePackage(`${tablet}_a`)), 'the device list carries no key material');

  const revoked = await api(`/e2ee/devices/${tablet}`, { method: 'DELETE', token: bob.token });
  assert.equal(revoked.status, 200, 'revocation');
  assert.equal(revoked.data.removedKeyPackages, 2, 'the whole pool goes with the device, used or unused');
  assert.equal(await prisma.keyPackage.count({ where: { device: { clientId: tablet } } }), 0, 'nothing about a revoked device is retained');
  assert.ok(await prisma.keyPackage.count({ where: { device: { clientId: phone } } }) > 0, 'the delete was scoped to one device');

  const after = await api(claimPath, { token: alice.token, headers: freshIp() });
  assert.equal(after.status, 200, 'the surviving device is still reachable');
  assert.equal(after.data.packages.length, 1, 'the revoked device is no longer part of the bundle');

  assert.deepEqual((await api('/e2ee/devices', { token: bob.token })).data.map(device => device.clientId), [phone], 'the revoked device left the list');

  const resurrect = await api('/e2ee/devices', { method: 'POST', token: bob.token, body: { clientId: tablet } });
  assert.equal(resurrect.status, 409, 'a revoked device id cannot silently come back');
});

test('another account cannot touch these devices', async () => {
  const { alice, bob } = global.__ctx;
  const phone = `bob_${suffix}_phone`;

  assert.equal((await api(`/e2ee/devices/${phone}`, { method: 'DELETE', token: alice.token })).status, 404, 'no foreign revocation');
  assert.equal((await api(`/e2ee/devices/${phone}/key-packages`, {
    method: 'POST',
    token:  alice.token,
    body:   { packages: [fakePackage('intruder')] },
  })).status, 404, 'no foreign pool write');
  assert.equal((await api(`/e2ee/devices/nope_${suffix}`, { method: 'DELETE', token: alice.token })).status, 404, 'an id nobody owns');

  const victim = await prisma.device.findUnique({
    where: { userId_clientId: { userId: bob.user.id, clientId: phone } },
  });
  assert.equal(victim.revokedAt, null, 'the victim device is untouched');
  assert.equal((await api(`/e2ee/devices/${phone}/key-packages`, {
    method: 'POST',
    token:  bob.token,
    body:   { packages: [fakePackage('bob_owns_this')] },
  })).status, 201, 'the owner still controls it');
});

test('the bundle endpoint does not reveal which accounts exist', async () => {
  const { alice, eve } = global.__ctx;

  const noDevice = await api(`/e2ee/users/${eve.user.id}/key-packages`, { token: alice.token, headers: freshIp() });
  const unknown  = await api('/e2ee/users/00000000-0000-4000-8000-000000000000/key-packages', { token: alice.token, headers: freshIp() });
  assert.equal(noDevice.status, 404, 'an account without devices');
  assert.equal(unknown.status, 404, 'an unknown account looks exactly the same');
  assert.equal(unknown.data.message, noDevice.data.message, 'identical error text');
  assert.equal((await api('/e2ee/users/not-a-uuid/key-packages', { token: alice.token, headers: freshIp() })).status, 400, 'the id format is enforced');

  const anonymous = await api('/e2ee/devices');
  assert.equal(anonymous.status, 401, 'no session, no device list');
});

test('key packages cannot be harvested quickly', async () => {
  const { alice, bob } = global.__ctx;
  const headers = { 'X-Forwarded-For': '198.51.100.91' };
  const limit   = Number(process.env.E2EE_CLAIM_LIMIT);
  const claimPath = `/e2ee/users/${bob.user.id}/key-packages`;

  for (let attempt = 1; attempt <= limit; attempt += 1) {
    const result = await api(claimPath, { token: alice.token, headers });
    assert.notEqual(result.status, 429, `claim ${attempt} allowed`);
  }

  const blocked = await api(claimPath, { token: alice.token, headers });
  assert.equal(blocked.status, 429, 'the pool is not a metered faucet');
  assert.ok(Number(blocked.headers.get('retry-after')) > 0, 'Retry-After header');
});

// ── Phase 2a: the server as a sequenced delivery service ──────────────────

test('a direct chat opts into encryption and the chat list says so', async () => {
  const { alice, bob, eve } = global.__ctx;

  const anonymous = await api('/messages/e2ee/direct', { method: 'POST', body: { userId: bob.user.id } });
  assert.equal(anonymous.status, 401, 'no session, no opt-in');

  const self = await api('/messages/e2ee/direct', { method: 'POST', token: alice.token, body: { userId: alice.user.id } });
  assert.equal(self.status, 400, 'there is no encrypted chat with yourself');

  const junk = await api('/messages/e2ee/direct', { method: 'POST', token: alice.token, body: { userId: 'not-a-uuid' } });
  assert.equal(junk.status, 400, 'the peer id format is enforced');

  const ghost = await api('/messages/e2ee/direct', {
    method: 'POST', token: alice.token,
    body: { userId: '00000000-0000-4000-8000-000000000000' },
  });
  assert.equal(ghost.status, 404, 'an unknown peer gets no conversation');

  // A client asks this every time it opens a chat, so probing must be inert.
  const eveBefore = await prisma.conversation.count({ where: { participants: { some: { userId: eve.user.id } } } });
  const probe     = await api(`/messages/e2ee/direct/${eve.user.id}`, { token: alice.token });
  assert.equal(probe.status, 200, 'a chat that does not exist yet is not an error');
  assert.deepEqual(probe.data, { conversationId: null, e2ee: false }, 'there is nothing to encrypt yet');
  assert.equal(
    await prisma.conversation.count({ where: { participants: { some: { userId: eve.user.id } } } }),
    eveBefore,
    'the probe created nothing',
  );

  const enabled = await api('/messages/e2ee/direct', { method: 'POST', token: alice.token, body: { userId: bob.user.id } });
  assert.equal(enabled.status, 201, 'opt-in');
  assert.equal(enabled.data.e2ee, true, 'the answer is the encrypted state');
  const conversationId = enabled.data.conversationId;

  // Either side flips the same conversation, and nobody can flip it back: the
  // flag is one-way, so a downgrade can only ever be an explicit user action.
  const fromPeer = await api('/messages/e2ee/direct', { method: 'POST', token: bob.token, body: { userId: alice.user.id } });
  assert.equal(fromPeer.data.conversationId, conversationId, 'both sides land on the same chat');
  assert.equal((await prisma.conversation.findUnique({ where: { id: conversationId } })).e2ee, true, 'persisted');

  const state = await api(`/messages/e2ee/direct/${bob.user.id}`, { token: alice.token });
  assert.deepEqual(state.data, { conversationId, e2ee: true }, 'read-only state agrees');

  const list = await api('/messages/conversations', { token: bob.token });
  const entry = list.data.find(c => c.user.id === alice.user.id);
  assert.equal(entry?.e2ee, true, 'the chat list carries the flag so the UI can label the conversation');
});

test('an encrypted conversation refuses plaintext and other conversations stay open', async () => {
  const { alice, bob } = global.__ctx;
  const conversationId = await encryptedDirect(alice, bob);
  const before = await prisma.message.count({ where: { conversationId } });

  const byConversation = await emitAck(sockets.alice, 'message:send', { conversationId, type: 'text', text: 'in the clear' });
  assert.equal(byConversation.ok, false, 'plaintext cannot be written into an encrypted chat');
  assert.match(byConversation.error, /رمزنگاری/, 'and the client is told why');

  const byPeer = await emitAck(sockets.alice, 'message:send', { toId: bob.user.id, type: 'text', text: 'in the clear' });
  assert.equal(byPeer.ok, false, 'the peer-id path is the same conversation');

  assert.equal(await prisma.message.count({ where: { conversationId } }), before, 'no plaintext row was written');

  const groupStill = await emitAck(sockets.alice, 'message:send', { conversationId: group.id, type: 'text', text: 'groups are untouched' });
  assert.equal(groupStill.ok, true, 'the refusal is scoped to the encrypted conversation');
});

test('envelopes are numbered with no gaps and delivered in strict order', async () => {
  const { alice, bob } = global.__ctx;
  const conversationId = await encryptedDirect(alice, bob);
  const base = (await prisma.e2eeEnvelope.aggregate({ where: { conversationId }, _max: { seq: true } }))._max.seq ?? 0;

  const received = collectEvents(sockets.bob, 'e2ee:envelope', 12);
  const senders  = [sockets.alice, sockets.bob];
  const acks = await Promise.all(Array.from({ length: 12 }, (_, i) => emitAck(
    senders[i % 2], 'e2ee:append', { conversationId, content: fakeEnvelope(`burst-${i}`) }, 20_000,
  )));

  acks.forEach((ack, i) => assert.equal(ack.ok, true, `append ${i} accepted`));
  assert.deepEqual(
    acks.map(ack => ack.seq).sort((a, b) => a - b),
    Array.from({ length: 12 }, (_, i) => base + 1 + i),
    'one number per envelope, gapless and duplicate-free, however the sends interleave',
  );

  const delivered = await received;
  assert.equal(delivered.length, 12, 'every envelope reached the peer');
  const order = delivered.map(envelope => envelope.seq);
  for (let i = 1; i < order.length; i += 1) {
    assert.ok(order[i] > order[i - 1], `delivery order must ascend (${order.join(',')})`);
  }
  assert.equal(new Set(delivered.map(envelope => envelope.content)).size, 12, 'each blob survived the trip');
});

test('a reconnecting member can pull the stream from any point and outsiders cannot', async () => {
  const { alice, bob, eve } = global.__ctx;
  const conversationId = await encryptedDirect(alice, bob);
  const all  = await prisma.e2eeEnvelope.findMany({ where: { conversationId }, orderBy: { seq: 'asc' } });
  const last = all[all.length - 1];

  const page = await api(`/messages/${conversationId}/envelopes?afterSeq=${last.seq - 6}`, { token: bob.token });
  assert.equal(page.status, 200, 'catch-up read');
  const expected = all.filter(envelope => envelope.seq > last.seq - 6);
  assert.deepEqual(page.data.map(envelope => envelope.seq), expected.map(envelope => envelope.seq), 'oldest first, nothing skipped');
  assert.deepEqual(page.data.map(envelope => envelope.content), expected.map(envelope => envelope.content), 'returned byte for byte');

  const bounded = await api(`/messages/${conversationId}/envelopes?take=3`, { token: alice.token });
  assert.deepEqual(bounded.data.map(envelope => envelope.seq), all.slice(0, 3).map(envelope => envelope.seq), 'a client may page in small chunks');

  assert.equal((await api(`/messages/${conversationId}/envelopes?afterSeq=-1`, { token: alice.token })).status, 400, 'a mark cannot be negative');
  assert.equal((await api(`/messages/${conversationId}/envelopes?afterSeq=1.5`, { token: alice.token })).status, 400, 'and must be a whole number');
  const pageCap = Number(process.env.E2EE_ENVELOPE_PAGE || 200) + 1;
  assert.equal((await api(`/messages/${conversationId}/envelopes?take=${pageCap}`, { token: alice.token })).status, 400, 'one page is bounded');
  assert.equal((await api(`/messages/${conversationId}/envelopes`, { token: eve.token })).status, 403, 'an outsider gets no stream, not even its length');
  assert.equal((await api(`/messages/${conversationId}/envelopes`)).status, 401, 'no session, no envelopes');
  assert.equal((await api('/messages/not-a-uuid/envelopes', { token: alice.token })).status, 400, 'the id format is enforced');

  // The ciphertext stream and the plaintext history stay separate: nothing in
  // the old endpoints exposes the new ones.
  const history = await api(`/messages/${bob.user.id}`, { token: alice.token });
  assert.equal(history.data.length, await prisma.message.count({ where: { conversationId } }), 'history holds only pre-encryption messages');
  assert.ok(!JSON.stringify(history.data).includes(all[0].content), 'envelopes never appear in plaintext history');
});

test('read state in an encrypted chat is one mark that only moves forward', async () => {
  const { alice, bob, eve } = global.__ctx;
  const conversationId = await encryptedDirect(alice, bob);
  const top = (await prisma.e2eeEnvelope.aggregate({ where: { conversationId }, _max: { seq: true } }))._max.seq;

  const sentByPeer = await prisma.e2eeEnvelope.count({ where: { conversationId, senderId: bob.user.id } });
  const before = await api('/messages/conversations', { token: alice.token });
  assert.equal(
    before.data.find(c => c.user.id === bob.user.id)?.unread,
    sentByPeer,
    'unread counts the peer envelopes above my mark',
  );

  const receipt = waitEvent(sockets.bob, 'message:read', 5000);
  const marked = await emitAck(sockets.alice, 'e2ee:read', { conversationId, upToSeq: top });
  assert.deepEqual(marked, { ok: true, moved: true }, 'the receipt is confirmed, not swallowed');
  assert.deepEqual(await receipt, { by: alice.user.id, conversationId }, 'the peer is told, so badges clear like plaintext chats');
  // The ack arrives after the write, so there is nothing left to wait for.
  assert.equal((await participant(conversationId, alice.user.id)).e2eeReadSeq, top, 'the mark is in the database');

  const after = await api('/messages/conversations', { token: alice.token });
  assert.equal(after.data.find(c => c.user.id === bob.user.id)?.unread, 0, 'badges clear');

  // A replayed, late or nonsense receipt must not rewind the mark, and an
  // outsider must not be able to file one at all.
  const replay = await emitAck(sockets.alice, 'e2ee:read', { conversationId, upToSeq: 1 });
  assert.deepEqual(replay, { ok: true, moved: false }, 'a stale mark is accepted as already done, not applied');
  assert.equal((await emitAck(sockets.alice, 'e2ee:read', { conversationId, upToSeq: 'everything' })).ok, false, 'nonsense is refused');
  assert.equal((await emitAck(sockets.eve, 'e2ee:read', { conversationId, upToSeq: 0 })).ok, false, 'a stranger cannot mark my chat read');
  assert.equal((await participant(conversationId, alice.user.id)).e2eeReadSeq, top, 'a mark only ever moves forward');
  assert.equal(
    await prisma.conversationParticipant.count({ where: { conversationId, userId: eve.user.id } }),
    0,
    'an outsider cannot mark a chat they are not in',
  );
});

test('bad blobs are rejected, streams stay separate, and a flagged group carries envelopes only', async () => {
  const { alice, bob, eve } = global.__ctx;
  const conversationId = await encryptedDirect(alice, bob);

  const missing = await emitAck(sockets.alice, 'e2ee:append', { conversationId });
  assert.equal(missing.ok, false, 'an empty envelope is not stored');
  const junk = await emitAck(sockets.alice, 'e2ee:append', { conversationId, content: 'not base64 !!!' });
  assert.equal(junk.ok, false, 'content has to be bytes');
  const oversized = await emitAck(sockets.alice, 'e2ee:append', {
    conversationId,
    content: 'A'.repeat(Number(process.env.E2EE_MAX_ENVELOPE_CHARS) + 1),
  });
  assert.equal(oversized.ok, false, 'and it has to fit');
  const noConversation = await emitAck(sockets.alice, 'e2ee:append', { content: fakeEnvelope('nowhere') });
  assert.equal(noConversation.ok, false, 'a blob with no conversation is refused');

  const outsider = await emitAck(sockets.eve, 'e2ee:append', { conversationId, content: fakeEnvelope('outsider') });
  assert.equal(outsider.ok, false, 'only members may append');
  assert.match(outsider.error, /عضو/, 'the answer is about membership, never about the encryption state');

  // A second encrypted chat numbers its own envelopes from one: sequence is
  // per conversation, so the first stream cannot be measured through it.
  const firstStreamLength = await prisma.e2eeEnvelope.count({ where: { conversationId } });
  const other = await api('/messages/e2ee/direct', { method: 'POST', token: alice.token, body: { userId: eve.user.id } });
  assert.equal(other.status, 201, 'a fresh chat can be encrypted');
  const first = await emitAck(sockets.alice, 'e2ee:append', {
    conversationId: other.data.conversationId,
    content:        fakeEnvelope('first-here'),
  });
  assert.equal(first.seq, 1, 'every conversation starts at one');
  const peerStream = await api(`/messages/${other.data.conversationId}/envelopes`, { token: eve.token });
  assert.deepEqual(peerStream.data.map(envelope => envelope.seq), [1], 'and the other member sees exactly that');
  assert.equal(
    await prisma.e2eeEnvelope.count({ where: { conversationId } }),
    firstStreamLength,
    'appending to one chat never touches another',
  );

  // A flagged group is the same transport with a different membership set:
  // members may append, plaintext stays closed, and an outsider still learns
  // only that they are not a member.
  await prisma.conversation.update({ where: { id: group.id }, data: { e2ee: true } });
  try {
    const groupAppend = await emitAck(sockets.alice, 'e2ee:append', {
      conversationId: group.id,
      content:        fakeEnvelope('group'),
    });
    assert.equal(groupAppend.ok, true, 'a member may append to an encrypted group');
    assert.equal(
      await prisma.e2eeEnvelope.count({ where: { conversationId: group.id } }),
      1,
      'the group stream stores the opaque blob',
    );
    const groupOutsider = await emitAck(sockets.eve, 'e2ee:append', {
      conversationId: group.id,
      content:        fakeEnvelope('group-outsider'),
    });
    assert.equal(groupOutsider.ok, false, 'an outsider still cannot append');
    assert.match(groupOutsider.error, /عضو/);
    const groupPlaintext = await emitAck(sockets.alice, 'message:send', {
      conversationId: group.id, type: 'text', text: 'flagged group',
    });
    assert.equal(groupPlaintext.ok, false, 'a flagged group accepts no plaintext');
    assert.equal(
      await prisma.message.count({ where: { conversationId: group.id, text: 'flagged group' } }),
      0,
      'and wrote no readable row',
    );
  } finally {
    await prisma.e2eeEnvelope.deleteMany({ where: { conversationId: group.id } });
    await prisma.conversation.update({ where: { id: group.id }, data: { e2ee: false } });
  }
  const reopened = await emitAck(sockets.alice, 'message:send', { conversationId: group.id, type: 'text', text: 'back to plaintext' });
  assert.equal(reopened.ok, true, 'the group works again once the flag is off');
});
