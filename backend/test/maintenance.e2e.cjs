'use strict';

// One housekeeping pass, called directly instead of waiting for the interval.
// It must remove expired one-time codes and dead sessions, keep live ones, and
// leave a recently revoked session alone so the security history can still
// name it.

const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const { randomUUID } = require('node:crypto');

process.env.NODE_ENV = process.env.NODE_ENV || 'test';
process.env.JWT_SECRET = process.env.JWT_SECRET || 'openbridge-test-secret-at-least-32-characters-long';
process.env.CONTENT_KEY = process.env.CONTENT_KEY || 'Y2ktb25seS1jb250ZW50LWtleS0zMi1ieXRlcy0wMDA=';

const { NestFactory } = require('@nestjs/core');
const { AppModule } = require('../dist/app.module');
const { PrismaService } = require('../dist/prisma/prisma.service');
const { MaintenanceService } = require('../dist/maintenance/maintenance.service');

const DAY = 24 * 60 * 60 * 1000;

let app;
let prisma;
let maintenance;
let userId;
const now = new Date();
const codeIds = [];
const sessionIds = [];

before(async () => {
  app = await NestFactory.create(AppModule, { logger: false });
  app.setGlobalPrefix('api');
  await app.listen(0);
  prisma = app.get(PrismaService);
  maintenance = app.get(MaintenanceService);

  const user = await prisma.user.create({
    data: {
      username: `maint_${randomUUID().slice(0, 8)}`,
      firstName: 'Maintenance',
      password: 'not-used-by-this-test',
    },
  });
  userId = user.id;

  const expiredCode = await prisma.otpCode.create({
    data: {
      phone: `09${Date.now().toString().slice(-9)}`,
      codeHash: 'expired-code-hash',
      expiresAt: new Date(now.getTime() - 60_000),
    },
  });
  const liveCode = await prisma.otpCode.create({
    data: {
      phone: `09${(Date.now() + 1).toString().slice(-9)}`,
      codeHash: 'live-code-hash',
      expiresAt: new Date(now.getTime() + 60_000),
    },
  });
  codeIds.push(expiredCode.id, liveCode.id);

  const session = (overrides) => prisma.session.create({
    data: {
      userId,
      refreshHash: randomUUID(),
      expiresAt: new Date(now.getTime() + 7 * DAY),
      ...overrides,
    },
  });
  const expired = await session({ expiresAt: new Date(now.getTime() - DAY) });
  const longRevoked = await session({ revokedAt: new Date(now.getTime() - 60 * DAY) });
  const recentlyRevoked = await session({ revokedAt: new Date(now.getTime() - DAY) });
  const live = await session({});
  sessionIds.push(expired.id, longRevoked.id, recentlyRevoked.id, live.id);
});

after(async () => {
  if (prisma && userId) {
    await prisma.user.deleteMany({ where: { id: userId } }).catch(() => {});
  }
  await prisma?.otpCode.deleteMany({ where: { id: { in: codeIds } } }).catch(() => {});
  await app?.close();
});

test('a maintenance pass prunes expired codes and dead sessions only', async () => {
  const removed = await maintenance.runOnce(now);
  assert.ok(removed, 'the pass reports what it removed');
  assert.ok(removed.otpCodes >= 1, 'the expired code is gone');
  assert.ok(removed.sessions >= 2, 'the expired and long-revoked sessions are gone');

  const remainingCodes = await prisma.otpCode.findMany({
    where: { id: { in: codeIds } },
    select: { id: true },
  });
  const codesLeft = new Set(remainingCodes.map((row) => row.id));
  assert.equal(codesLeft.has(codeIds[0]), false, 'the expired code row is deleted');
  assert.equal(codesLeft.has(codeIds[1]), true, 'a code that can still be used stays');

  const sessions = await prisma.session.findMany({
    where: { id: { in: sessionIds } },
    select: { id: true },
  });
  const left = new Set(sessions.map((row) => row.id));
  assert.equal(left.has(sessionIds[0]), false, 'an expired session is deleted');
  assert.equal(left.has(sessionIds[1]), false, 'a session revoked long ago is deleted');
  assert.equal(left.has(sessionIds[2]), true, 'a recently revoked session is kept for the security history');
  assert.equal(left.has(sessionIds[3]), true, 'a live session is untouched');
});
