'use strict';

// Liveness stays static; readiness must prove Postgres is reachable. The test
// boots the real AppModule against the local test database and takes the
// Prisma connection away to see the probe fail.

const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');

process.env.NODE_ENV = process.env.NODE_ENV || 'test';
process.env.JWT_SECRET = process.env.JWT_SECRET || 'openbridge-test-secret-at-least-32-characters-long';
process.env.CONTENT_KEY = process.env.CONTENT_KEY || 'Y2ktb25seS1jb250ZW50LWtleS0zMi1ieXRlcy0wMDA=';

const { NestFactory } = require('@nestjs/core');
const { AppModule } = require('../dist/app.module');
const { PrismaService } = require('../dist/prisma/prisma.service');

let app;
let prisma;
let origin;

before(async () => {
  app = await NestFactory.create(AppModule, { logger: false });
  app.setGlobalPrefix('api');
  await app.listen(0);
  origin = `http://127.0.0.1:${app.getHttpServer().address().port}`;
  prisma = app.get(PrismaService);
});

after(async () => {
  await app?.close();
});

test('liveness answers without touching the database', async () => {
  const res = await fetch(`${origin}/api/health`);
  assert.equal(res.status, 200);
  assert.deepEqual(await res.json(), { status: 'ok', service: 'chatapp-backend' });
});

test('readiness passes while the database answers and fails when it does not', async () => {
  const up = await fetch(`${origin}/api/health/ready`);
  assert.equal(up.status, 200);
  assert.deepEqual(await up.json(), { status: 'ok', db: 'up' });

  // $disconnect() is not an outage: Prisma reconnects on the next query. Fail
  // the query itself so the probe's error path is what gets exercised.
  const realQuery = prisma.$queryRaw;
  prisma.$queryRaw = async () => {
    throw new Error('connect ECONNREFUSED 10.0.0.1:5432');
  };
  try {
    const down = await fetch(`${origin}/api/health/ready`);
    assert.equal(down.status, 503);
    const body = await down.json();
    assert.deepEqual(body, { status: 'error', db: 'down' }, 'no driver detail escapes');
    assert.ok(!JSON.stringify(body).includes('10.0.0.1'), 'the host never reaches the client');
  } finally {
    prisma.$queryRaw = realQuery;
  }

  const recovered = await fetch(`${origin}/api/health/ready`);
  assert.equal(recovered.status, 200, 'the probe recovers with the connection');
});
