// Client-level gate for the parts of the protocol the app actually calls:
// message payloads (reply/forward), and the edit/delete controls that travel as
// their own envelopes. The MLS math is covered by gate.test.mjs; here the
// crypto is real and only the server is a Map.
import test from 'node:test';
import assert from 'node:assert/strict';
import { createE2eeClient } from './client.js';
import { packMessage, parseMessage, packControl, parseControl } from './payloads.js';

// ------------------------------------------------------------------ payloads

test('a message payload round-trips its quote and forward label', () => {
  const packed = packMessage({
    text: 'سلام',
    reply: { id: 'm-1', senderName: 'باب', preview: 'پیام قبلی', type: 'text' },
    forward: { fromName: 'کارول' },
  });
  assert.deepEqual(parseMessage(packed), {
    text: 'سلام',
    reply: { id: 'm-1', senderName: 'باب', preview: 'پیام قبلی', type: 'text' },
    forward: { fromName: 'کارول' },
  });
});

test('a message without extras is not wrapped, and hostile values are trimmed', () => {
  assert.equal(parseMessage('سلام'), null);
  assert.equal(parseMessage(JSON.stringify({ k: 'other', t: 'x' })), null);
  const packed = packMessage({
    text: 'x'.repeat(5000),
    reply: { id: 'i'.repeat(100), senderName: 'n'.repeat(200), preview: 'p'.repeat(400), type: 'wat' },
  });
  const parsed = parseMessage(packed);
  assert.equal(parsed.text.length, 4000);
  assert.equal(parsed.reply.id.length, 64);
  assert.equal(parsed.reply.senderName.length, 80);
  assert.equal(parsed.reply.preview.length, 180);
  assert.equal(parsed.reply.type, 'text');
  assert.equal(parsed.forward, null);
});

test('a control payload is strict about its operation and target', () => {
  assert.deepEqual(parseControl(packControl({ op: 'edit', targetSeq: 7, text: 'تازه' })), {
    op: 'edit', targetSeq: 7, text: 'تازه',
  });
  assert.deepEqual(parseControl(packControl({ op: 'delete', targetSeq: 7, scope: 'me' })), {
    op: 'delete', targetSeq: 7, scope: 'me',
  });
  assert.throws(() => packControl({ op: 'edit', targetSeq: 7, text: '  ' }));
  assert.throws(() => packControl({ op: 'delete', targetSeq: 0 }));
  assert.equal(parseControl('{"k":"openbridge.control.v1","op":"edit","t":0,"x":"a"}'), null);
});

// ------------------------------------------------------------------- server

function memoryStore() {
  const map = new Map();
  return {
    async get(key) { return map.has(key) ? structuredClone(map.get(key)) : null; },
    async set(key, value) { map.set(key, structuredClone(value)); },
    async remove(key) { map.delete(key); },
    async list(prefix) {
      return [...map.entries()]
        .filter(([key]) => key.startsWith(prefix))
        .map(([, value]) => structuredClone(value));
    },
  };
}

// The smallest server that behaves like the real one where these tests look:
// devices with a package pool, one direct conversation per pair, and an
// append-only envelope log whose sequence starts at one.
function memoryServer() {
  const devices = new Map();
  const conversations = new Map();
  const directs = new Map();
  let convCount = 0;
  let envelopeCount = 0;

  function conversation(id) {
    const found = conversations.get(id);
    if (!found) throw new Error(`unknown conversation ${id}`);
    return found;
  }

  function addEnvelope(conversationId, senderId, content, kind) {
    const target = conversation(conversationId);
    if (!target.members.has(senderId)) throw new Error('sender is not a member');
    const seq = target.envelopes.length + 1;
    const envelope = {
      conversationId,
      id: `env-${++envelopeCount}`,
      seq,
      senderId,
      content,
      kind: kind ?? 'MESSAGE',
      createdAt: new Date(1_700_000_000_000 + seq * 1000).toISOString(),
    };
    target.envelopes.push(envelope);
    return { id: envelope.id, seq };
  }

  function transportFor(userId) {
    return {
      async api(path, { method = 'GET', body } = {}) {
        if (path === 'e2ee/devices' && method === 'POST') {
          const mine = devices.get(userId) ?? new Map();
          if (!mine.has(body.clientId)) mine.set(body.clientId, []);
          devices.set(userId, mine);
          return { ok: true };
        }
        if (path === 'e2ee/devices' && method === 'GET') {
          return [...(devices.get(userId) ?? new Map())]
            .map(([clientId, pool]) => ({ clientId, availableKeyPackages: pool.length }));
        }
        const own = /^e2ee\/devices\/([^/]+)\/key-packages$/.exec(path);
        if (own && method === 'POST') {
          const mine = devices.get(userId) ?? new Map();
          mine.set(own[1], [...(mine.get(own[1]) ?? []), ...body.packages]);
          devices.set(userId, mine);
          return { ok: true };
        }
        const claim = /^e2ee\/users\/([^/]+)\/key-packages$/.exec(path);
        if (claim && method === 'GET') {
          const their = devices.get(claim[1]);
          const packages = [...(their ?? new Map()).values()].flat();
          // A claimed package is gone: the same one must never enter two groups.
          if (their) for (const [clientId] of their) their.set(clientId, []);
          if (!packages.length) {
            const error = new Error('no keys');
            error.status = 404;
            throw error;
          }
          return { packages };
        }
        const probe = /^messages\/e2ee\/direct\/([^/]+)$/.exec(path);
        if (probe && method === 'GET') {
          const id = directs.get([userId, probe[1]].sort().join(':'));
          return id ? { e2ee: true, conversationId: id } : { e2ee: false };
        }
        if (path === 'messages/e2ee/direct' && method === 'POST') {
          const key = [userId, body.userId].sort().join(':');
          let id = directs.get(key);
          if (!id) {
            id = `conv-${++convCount}`;
            directs.set(key, id);
            conversations.set(id, { id, members: new Set([userId, body.userId]), envelopes: [] });
          }
          return { conversationId: id };
        }
        throw new Error(`unhandled ${method} ${path}`);
      },
      append: async (conversationId, content, kind) => addEnvelope(conversationId, userId, content, kind),
      fetchEnvelopes: async (conversationId, afterSeq, take) =>
        conversation(conversationId).envelopes.filter((entry) => entry.seq > afterSeq).slice(0, take),
      markRead: async () => ({ ok: true }),
      onEnvelope: () => () => {},
    };
  }

  return {
    transportFor,
    envelopes: (conversationId) => conversation(conversationId).envelopes,
    lastEnvelope(conversationId) {
      const all = conversation(conversationId).envelopes;
      return all[all.length - 1];
    },
  };
}

async function pair() {
  const server = memoryServer();
  const alice = await createE2eeClient({ store: memoryStore(), transport: server.transportFor('alice'), me: { id: 'alice' } });
  const bob = await createE2eeClient({ store: memoryStore(), transport: server.transportFor('bob'), me: { id: 'bob' } });
  await Promise.all([alice.ready(), bob.ready()]);

  const opened = await alice.openDirect('bob');
  const conversationId = opened.conversationId;
  // The Welcome is the first envelope; the peer joins from it the way the socket
  // would hand it over.
  await bob.receive(server.envelopes(conversationId)[0]);
  return { server, alice, bob, conversationId };
}

// ------------------------------------------------------------------- client

test('an encrypted reply and forward arrive with their quote and label', async () => {
  const { server, alice, bob, conversationId } = await pair();

  await alice.send(conversationId, {
    text: 'پاسخ',
    reply: { id: 'm-9', senderName: 'باب', preview: 'پیش‌نویس', type: 'text' },
    forward: { fromName: 'کارول' },
  });
  await bob.receive(server.lastEnvelope(conversationId));

  const [message] = await bob.history(conversationId);
  assert.equal(message.text, 'پاسخ');
  assert.deepEqual(message.reply, { id: 'm-9', senderName: 'باب', preview: 'پیش‌نویس', type: 'text' });
  assert.deepEqual(message.forward, { fromName: 'کارول' });
  assert.equal(message.mine, false);

  const [mine] = await alice.history(conversationId);
  assert.equal(mine.text, 'پاسخ');
  assert.equal(mine.mine, true);
});

test('an edit reaches the peer, and a member cannot edit somebody else', async () => {
  const { server, alice, bob, conversationId } = await pair();
  await alice.send(conversationId, 'اصل');
  await bob.receive(server.lastEnvelope(conversationId));
  const [original] = await bob.history(conversationId);

  await alice.editMessage(conversationId, original.seq, 'ویرایش‌شده');
  // The sender's own device applies the control on the ack, without waiting for
  // its echo around the room.
  assert.equal((await alice.history(conversationId))[0].text, 'ویرایش‌شده');

  await bob.receive(server.lastEnvelope(conversationId));
  const [edited] = await bob.history(conversationId);
  assert.equal(edited.text, 'ویرایش‌شده');
  assert.ok(edited.editedAt);

  // Bob aiming at Alice's message changes nothing on Alice's side.
  await bob.editMessage(conversationId, original.seq, 'توسط باب');
  await alice.receive(server.lastEnvelope(conversationId));
  assert.equal((await alice.history(conversationId))[0].text, 'ویرایش‌شده');
  assert.equal((await bob.history(conversationId))[0].text, 'ویرایش‌شده');
});

test('delete for everyone is the author\'s right; delete for me stays local', async () => {
  const { server, alice, bob, conversationId } = await pair();
  await alice.send(conversationId, 'برای حذف');
  await bob.receive(server.lastEnvelope(conversationId));
  const [target] = await bob.history(conversationId);

  // Bob cannot take Alice's message away from her.
  await bob.deleteMessage(conversationId, target.seq, 'everyone');
  await alice.receive(server.lastEnvelope(conversationId));
  assert.equal((await alice.history(conversationId)).length, 1);

  // Bob can hide it from himself, and Alice keeps it.
  await bob.deleteMessage(conversationId, target.seq, 'me');
  assert.equal((await bob.history(conversationId)).length, 0);
  assert.equal(await bob.lastMessage(conversationId), null);
  await alice.receive(server.lastEnvelope(conversationId));
  assert.equal((await alice.history(conversationId)).length, 1);

  // Alice can remove her own message for both sides.
  await alice.deleteMessage(conversationId, target.seq, 'everyone');
  await bob.receive(server.lastEnvelope(conversationId));
  assert.equal((await alice.history(conversationId)).length, 0);
  assert.equal((await bob.history(conversationId)).length, 0);
});

test('controls are envelopes of their own and never enter history or previews', async () => {
  const { server, alice, bob, conversationId } = await pair();
  await alice.send(conversationId, 'یکی');
  await bob.receive(server.lastEnvelope(conversationId));
  await bob.send(conversationId, 'دو');
  await alice.receive(server.lastEnvelope(conversationId));

  const [first] = await alice.history(conversationId);
  await alice.editMessage(conversationId, first.seq, 'یکیِ تازه');
  await bob.receive(server.lastEnvelope(conversationId));

  const envelopes = server.envelopes(conversationId);
  assert.equal(envelopes.at(-1).kind, 'CONTROL');
  assert.equal(envelopes.filter((entry) => entry.kind === 'CONTROL').length, 1);

  const history = await bob.history(conversationId);
  assert.deepEqual(history.map((entry) => entry.text), ['یکیِ تازه', 'دو']);
  assert.equal((await bob.lastMessage(conversationId)).text, 'دو');
  assert.equal((await bob.status(conversationId)).appliedSeq, envelopes.length);
  assert.equal(history.length, 2, 'a control must not add a row');
});
