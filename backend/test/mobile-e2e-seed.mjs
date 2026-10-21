const BASE = process.env.E2E_API_URL ?? 'http://127.0.0.1:3000/api';

async function call(path, { method = 'GET', token, body } = {}) {
  const res = await fetch(`${BASE}${path}`, {
    method,
    headers: {
      'Content-Type': 'application/json',
      ...(token ? { Authorization: `Bearer ${token}` } : {}),
    },
    body: body ? JSON.stringify(body) : undefined,
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) {
    throw new Error(`${method} ${path} -> ${res.status} ${JSON.stringify(data)}`);
  }
  return data;
}

async function waitForHealth(deadlineMs = 60000) {
  const start = Date.now();
  while (Date.now() - start < deadlineMs) {
    try {
      const res = await fetch(`${BASE}/health`);
      if (res.ok) return;
    } catch {
      // The API is still booting.
    }
    await new Promise(resolve => setTimeout(resolve, 1000));
  }
  throw new Error(`Backend at ${BASE} never became healthy`);
}

async function createUser({ phone, username, firstName, lastName }) {
  const requested = await call('/auth/otp/request', { method: 'POST', body: { phone } });
  if (!requested.testCode) {
    throw new Error('OTP test mode is off; the mobile E2E needs NODE_ENV != production');
  }
  const verified = await call('/auth/otp/verify', {
    method: 'POST',
    body: { phone, code: requested.testCode },
  });
  if (verified.requiresSignup) {
    const created = await call('/auth/signup', {
      method: 'POST',
      body: {
        signupToken: verified.signupToken,
        username,
        firstName,
        lastName,
      },
    });
    return { id: created.user.id, token: created.token ?? created.accessToken };
  }
  return { id: verified.user.id, token: verified.token ?? verified.accessToken };
}

// Names must be letters only: SignupDto rejects digits in first/last name.
const users = [
  { phone: '09120000001', username: 'e2e_user_a', firstName: 'Alpha', lastName: 'Tester' },
  { phone: '09120000002', username: 'e2e_user_b', firstName: 'Beta', lastName: 'Tester' },
];

await waitForHealth();
const created = [];
for (const user of users) {
  created.push(await createUser(user));
}
const group = await call('/messages/groups', {
  method: 'POST',
  token: created[0].token,
  body: { name: 'E2E Group', memberIds: [created[1].id] },
});
console.log(`Seeded ${users[0].username} + ${users[1].username} in E2E Group (${group.id ?? 'created'})`);
