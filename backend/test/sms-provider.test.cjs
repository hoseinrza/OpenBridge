// Delivering an OTP through a real gateway, ported from the shape the tamwise
// API uses: one provider interface, a factory that picks it from the
// environment, and a call that fails loudly without ever naming the number.
//
// Nothing here opens a socket or a database. The gateway is stubbed, and the
// boot rules that must be enforced before a user ever tries to sign in are
// checked by starting the real entrypoint in a child process.
require('reflect-metadata');

const { test } = require('node:test');
const assert = require('node:assert/strict');
const { spawnSync } = require('node:child_process');
const { join } = require('node:path');
const { tmpdir } = require('node:os');

process.env.JWT_SECRET = 'openbridge-test-secret-at-least-32-characters-long';
process.env.CONTENT_KEY = 'Y2ktb25seS1jb250ZW50LWtleS0zMi1ieXRlcy0wMDA=';
const KEY = 'test-kavenegar-key-abcdef';
const PHONE = '09121234567';
const PERSIAN_PHONE = PHONE.replace(/\d/g, (digit) => String.fromCharCode(0x06f0 + Number(digit)));

// OTP_TEST_MODE is decided the first time config/env is imported, so the flags are
// set here to the one combination under which a gateway is consulted at all:
// no test mode. Under NODE_ENV=test every case below would take the
// pre-provider branch and assert nothing.
process.env.NODE_ENV = 'production';
process.env.SMS_PROVIDER = 'kavenegar';
process.env.KAVENEGAR_API_KEY = KEY;
process.env.KAVENEGAR_OTP_TEMPLATE = 'verify';

function freshRequire(id) {
  delete require.cache[require.resolve(id)];
  return require(id);
}

// config/env freezes SMS_PROVIDER and the KAVENEGAR_* values at import, and the
// provider reads those frozen constants instead of process.env, so a case that
// needs different values re-imports them while the environment still holds them.
// The provider is built inside that window and only the instance is used
// afterwards, so no assertion can observe a half-restored environment.
function withKavenegar(extra, run) {
  const previous = { ...process.env };
  Object.assign(process.env, { SMS_PROVIDER: 'kavenegar', KAVENEGAR_API_KEY: KEY }, extra);
  let provider;
  try {
    freshRequire('../dist/config/env.js');
    const { KavenegarSmsProvider } = freshRequire('../dist/common/kavenegar-sms.provider.js');
    provider = new KavenegarSmsProvider();
  } finally {
    for (const key of Object.keys(process.env)) delete process.env[key];
    Object.assign(process.env, previous);
  }
  return run(provider);
}

// Imported before the freshRequire churn above ever runs, so the service under
// test keeps the environment frozen at the flags at the top of this file.
const { AuthService } = require('../dist/auth/auth.service.js');

function stubFetch(handler) {
  const previous = global.fetch;
  const calls = [];
  global.fetch = async (url, init) => {
    calls.push({ url, init });
    return handler({ url, init });
  };
  return { calls, restore: () => { global.fetch = previous; } };
}

function okJson(body = { return: { status: 200, message: 'ok' } }) {
  return { ok: true, status: 200, json: async () => body };
}

test('every accepted phone spelling reaches the gateway as 0xxxxxxxxx', () => {
  const { toKavenegarReceptor } = require('../dist/common/sms-provider.interface.js');
  for (const input of ['09121234567', '+989121234567', '00989121234567', '989121234567', '9121234567', PERSIAN_PHONE]) {
    assert.equal(toKavenegarReceptor(input), '09121234567', input);
  }
});

test('maskPhone keeps a number unusable but correlatable', () => {
  const { maskPhone } = require('../dist/common/sms-provider.interface.js');
  assert.equal(maskPhone('09121234567'), '0912****4567');
  assert.equal(maskPhone('1234567'), '****');
  assert.ok(!maskPhone(PHONE).includes('123'));
});

test('a configured OTP template uses verify/lookup and carries no sender', async () => {
  await withKavenegar({ KAVENEGAR_OTP_TEMPLATE: 'verify' }, async (provider) => {
    const { calls, restore } = stubFetch(() => okJson());
    try {
      await provider.sendOtp(PHONE, '123456');
      assert.equal(calls.length, 1);
      assert.match(calls[0].url, new RegExp(`^https://api\\.kavenegar\\.com/v1/${KEY}/verify/lookup\\.json$`));
      assert.equal(calls[0].init.method, 'POST');
      const form = new URLSearchParams(calls[0].init.body);
      assert.equal(form.get('receptor'), PHONE);
      assert.equal(form.get('token'), '123456');
      assert.equal(form.get('template'), 'verify');
      assert.equal(form.get('sender'), null);
      assert.ok(calls[0].init.signal, 'the request must be time-bounded');
    } finally {
      restore();
    }
  });
});

test('without a template it falls back to sms/send with the sender line', async () => {
  // The template default at the top of this file has to be cleared here:
  // verify/lookup wins whenever it is set, and this case is about the other path.
  await withKavenegar({ KAVENEGAR_OTP_TEMPLATE: '', KAVENEGAR_SENDER: '10008663' }, async (provider) => {
    const { calls, restore } = stubFetch(() => okJson());
    try {
      await provider.sendOtp('+989121234567', '000001');
      assert.match(calls[0].url, /\/sms\/send\.json$/);
      const form = new URLSearchParams(calls[0].init.body);
      assert.equal(form.get('receptor'), PHONE, 'international spelling normalized');
      assert.equal(form.get('sender'), '10008663');
      assert.match(form.get('message'), /000001/);
    } finally {
      restore();
    }
  });
});

test('an HTTP error and a non-200 return status are both failures', async () => {
  await withKavenegar({ KAVENEGAR_OTP_TEMPLATE: 'verify' }, async (provider) => {
    const http = stubFetch(() => ({ ok: false, status: 500, json: async () => ({}) }));
    await assert.rejects(provider.sendOtp(PHONE, '123456'), /http=500/);
    http.restore();

    const body = stubFetch(() => okJson({ return: { status: 404, message: 'not found' } }));
    await assert.rejects(provider.sendOtp(PHONE, '123456'), /status=404/);
    body.restore();
  });
});

test('a provider failure names no phone number, key or response body', async () => {
  await withKavenegar({ KAVENEGAR_OTP_TEMPLATE: 'verify' }, async (provider) => {
    const leaking = stubFetch(() => ({
      ok:    false,
      status: 404,
      json:  async () => ({ return: { status: 404, message: `receptor ${PHONE} is invalid` } }),
    }));
    const err = await provider.sendOtp(PHONE, '123456').then(() => null, (e) => e);
    leaking.restore();
    assert.ok(err, 'must reject');
    assert.ok(!err.message.includes(PHONE), `leaked a number: ${err.message}`);
    assert.ok(!err.message.includes(KEY), `leaked the key: ${err.message}`);

    const down = stubFetch(async () => { throw new TypeError(`fetch failed contacting ${KEY}@api.kavenegar.com`); });
    const net = await provider.sendOtp(PHONE, '123456').then(() => null, (e) => e);
    down.restore();
    assert.match(net.message, /request failed: TypeError$/);
    assert.ok(!net.message.includes(KEY), 'the URL with the key must not be re-thrown');
    assert.ok(!net.message.includes(PHONE));
  });
});

// --- AuthService delivery rules --------------------------------------------

function fakePrisma() {
  const state = { created: 0, consumedCalls: 0 };
  return {
    state,
    user: { findFirst: async () => null },
    otpCode: {
      updateMany: async () => { state.consumedCalls++; return { count: 1 }; },
      create:     async () => { state.created++; return {}; },
    },
    $transaction: async (ops) => Promise.all(ops),
  };
}

function serviceWith(sms) {
  const prisma = fakePrisma();
  return { prisma, service: new AuthService(prisma, { sign: () => 'jwt' }, { leaveRoom() {} }, sms) };
}

function stubProvider(impl) {
  return { name: 'kavenegar', ...impl };
}

test('with no gateway and no test mode the endpoint refuses to invent a code', async () => {
  const { prisma, service } = serviceWith(null);
  await assert.rejects(
    service.requestOtp({ phone: PHONE }),
    (error) => error.getStatus() === 503,
  );
  assert.equal(prisma.state.created, 0, 'a refusal must not leave a code behind');
});

test('a delivered code never travels back in the response', async () => {
  const sent = [];
  const { prisma, service } = serviceWith(stubProvider({ sendOtp: async (phone, code) => sent.push({ phone, code }) }));
  const result = await service.requestOtp({ phone: PHONE });
  assert.equal(sent.length, 1);
  assert.match(sent[0].code, /^\d{6}$/);
  assert.equal(result.testCode, undefined, 'testCode must stay with test mode');
  assert.equal(result.ok, true);
  assert.equal(prisma.state.created, 1);
});

test('a refused delivery consumes the code and answers 502', async () => {
  const { prisma, service } = serviceWith(stubProvider({ sendOtp: async () => { throw new Error('kavenegar refused: http=503 status=undefined'); } }));
  const warnings = [];
  service.logger.warn = (message) => warnings.push(message);

  await assert.rejects(service.requestOtp({ phone: PHONE }), (error) => error.getStatus() === 502);
  assert.equal(prisma.state.created, 1, 'the row is written before the send');
  assert.equal(prisma.state.consumedCalls, 2, 'one to retire the previous code, one to retire the undelivered one');
  assert.equal(warnings.length, 1);
  assert.match(warnings[0], /OTP delivery failed via kavenegar for 0912\*\*\*\*4567/);
  assert.ok(!warnings[0].includes(PHONE), `log leaked the number: ${warnings[0]}`);
});

// --- boot-time configuration rules ---------------------------------------

function bootWith(env) {
  return spawnSync(process.execPath, [join(__dirname, '..', 'dist', 'main.js')], {
    cwd: tmpdir(), // outside the backend directory, so no .env is loaded
    env: { ...process.env, NODE_ENV: 'production', PORT: '3987', ...env },
    encoding: 'utf8',
    timeout: 15000,
  });
}

test('kavenegar without an API key fails at boot, not at first sign-in', () => {
  const result = bootWith({ SMS_PROVIDER: 'kavenegar', KAVENEGAR_API_KEY: '', KAVENEGAR_OTP_TEMPLATE: 'verify' });
  assert.notEqual(result.status, 0);
  assert.match(`${result.stdout}${result.stderr}`, /KAVENEGAR_API_KEY/);
});

test('kavenegar with neither a template nor a sender fails at boot', () => {
  const result = bootWith({
    SMS_PROVIDER: 'kavenegar', KAVENEGAR_API_KEY: KEY, KAVENEGAR_OTP_TEMPLATE: '', KAVENEGAR_SENDER: '',
  });
  assert.notEqual(result.status, 0);
  assert.match(`${result.stdout}${result.stderr}`, /KAVENEGAR_OTP_TEMPLATE or KAVENEGAR_SENDER/);
});

test('an unknown SMS_PROVIDER value fails at boot', () => {
  const result = bootWith({ SMS_PROVIDER: 'sms-ir', KAVENEGAR_API_KEY: '' });
  assert.notEqual(result.status, 0);
  assert.match(`${result.stdout}${result.stderr}`, /SMS_PROVIDER must be none or kavenegar/);
});
