// The MLS client core: everything between the crypto library and a chat app.
//
// It owns three things and touches nothing else: local key material (device
// identity, key-package pool, per-conversation group state), the strict order
// MLS requires for the bytes that arrive from the server, and the plaintext
// cache the interface reads from. The server is represented by `transport`,
// which only ever moves opaque strings, so the same core runs in a browser tab
// with IndexedDB and in a test with a Map.
//
// Nothing here is platform-specific: no Buffer, no btoa, no crypto.subtle, no
// window. That is what lets Expo/Hermes reuse it unchanged.
import {
  createApplicationMessage,
  createCommit,
  createGroup,
  decodeGroupState,
  defaultCapabilities,
  encodeGroupState,
  decodeMlsMessage,
  defaultLifetime,
  emptyPskIndex,
  encodeMlsMessage,
  generateKeyPackage,
  getCiphersuiteFromName,
  joinGroup,
  mlsExporter,
  processPrivateMessage,
  zeroOutUint8Array,
} from 'ts-mls';
import { getGroupMembers } from 'ts-mls/clientState.js';
import { makeKeyPackageRef } from 'ts-mls/keyPackage.js';
import { defaultClientConfig } from 'ts-mls/clientConfig.js';
import { pureCryptoProvider, SUPPORTED_CIPHERSUITES } from './provider.js';
import { parseAttachment } from './attachments.js';
import { decodeUtf8, encodeUtf8, fromBase64, toBase64 } from './wire.js';

export const DEFAULT_CIPHERSUITE = SUPPORTED_CIPHERSUITES[0];

const GROUP_ID_BYTES = 8;
const CLIENT_ID_BYTES = 16;
const FETCH_PAGE = 50;
// Mirrors E2EE_MAX_ENVELOPE_CHARS on the server. A Welcome carries the whole
// ratchet tree, so an oversized one is refused here, before the conversation
// exists, rather than after every member has already been added to it.
const MAX_ENVELOPE_CHARS = 16384;
const SEQ_WIDTH = 9;
// How many of our own submitted envelope ids a device remembers, which is how
// it tells its own echo apart from a sibling device that sends under the same
// account identity.
const OWN_IDS = 64;

const DEVICE_KEY = 'device';
const KEY_PACKAGE_PREFIX = 'kp/';
const CONVERSATION_PREFIX = 'conv/';
const MESSAGE_PREFIX = 'msg/';

const KEY_PACKAGE = (keyPackage) => ({ keyPackage, wireformat: 'mls_key_package', version: 'mls10' });
const WELCOME = (welcome) => ({ welcome, wireformat: 'mls_welcome', version: 'mls10' });
const PRIVATE_MESSAGE = (privateMessage) => ({ privateMessage, wireformat: 'mls_private_message', version: 'mls10' });

const pack = (message) => toBase64(encodeMlsMessage(message, 0));
const unpack = (content) => decodeMlsMessage(fromBase64(content), 0)[0];

function fail(code, message) {
  const error = new Error(message);
  error.code = code;
  return error;
}

function toHex(bytes) {
  let out = '';
  for (const byte of bytes) out += byte.toString(16).padStart(2, '0');
  return out;
}

// Base64url is the spelling the call service stores and compares. The value is
// a SHA-256 digest of the media key, never the key.
function toBase64Url(bytes) {
  return toBase64(bytes).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

function identityOf(leaf) {
  const credential = leaf.credential;
  const raw = credential?.basic?.identity ?? credential?.identity;
  return raw ? decodeUtf8(raw) : '';
}

/**
 * A decrypted payload is either a message or one attachment descriptor. Both are
 * text on the wire — MLS carries bytes, and a descriptor is JSON — so the split
 * happens once here, on the way into the cache, and nothing downstream has to
 * know that a picture arrived as a sentence.
 */
function shapePayload(text) {
  const attachment = parseAttachment(text);
  return attachment ? { text: '', attachment } : { text, attachment: null };
}

/**
 * @param {object} options
 * @param {object} options.store   JSON-only key/value store: get/set/remove/list(prefix)
 * @param {object} options.transport  api(path, {method, body}) — path is relative to the API
 *   root and carries no leading slash; append(conversationId, content);
 *   fetchEnvelopes(conversationId, afterSeq, take); markRead(conversationId, upToSeq);
 *   onEnvelope(handler) returning an unsubscribe function
 * @param {{id: string}} options.me  the signed-in account; MLS credentials carry this id
 */
export async function createE2eeClient({
  store,
  transport,
  me,
  provider = pureCryptoProvider,
  ciphersuite = DEFAULT_CIPHERSUITE,
  poolSize = 8,
  refillAt = 3,
  label = 'web',
}) {
  const impl = await provider.getCiphersuiteImpl(getCiphersuiteFromName(ciphersuite));
  const identity = encodeUtf8(me.id);
  const handlers = new Set();
  // One chain per conversation, so an envelope that arrives while a send is
  // still waiting for its ack cannot interleave with it. MLS state is a ratchet:
  // two concurrent writers would each persist a state derived from the same
  // generation and one of them would be wrong.
  const chains = new Map();

  const conversationKey = (id) => CONVERSATION_PREFIX + id;
  const messageKey = (id, seq) => `${MESSAGE_PREFIX}${id}/${String(seq).padStart(SEQ_WIDTH, '0')}`;
  const now = () => new Date().toISOString();

  // ---------------------------------------------------------------- key material

  async function mintKeyPackage() {
    const generated = await generateKeyPackage(
      { credentialType: 'basic', identity },
      defaultCapabilities(),
      defaultLifetime,
      [],
      impl,
    );
    return {
      ref: toBase64(await makeKeyPackageRef(generated.publicPackage, impl.hash)),
      public: pack(KEY_PACKAGE(generated.publicPackage)),
      // Every field of a PrivateKeyPackage is already raw bytes, so the pool is
      // plain base64 and survives any storage backend.
      private: {
        i: toBase64(generated.privatePackage.initPrivateKey),
        h: toBase64(generated.privatePackage.hpkePrivateKey),
        s: toBase64(generated.privatePackage.signaturePrivateKey),
      },
      mintedAt: now(),
    };
  }

  const publicOf = (entry) => unpack(entry.public).keyPackage;
  const privateOf = (entry) => ({
    initPrivateKey: fromBase64(entry.private.i),
    hpkePrivateKey: fromBase64(entry.private.h),
    signaturePrivateKey: fromBase64(entry.private.s),
  });

  const saveState = (state) => toBase64(encodeGroupState(state));

  function loadState(record) {
    const [decoded] = decodeGroupState(fromBase64(record.state), 0);
    // encodeGroupState does not serialize clientConfig, and the protect path
    // reads state.clientConfig.paddingConfig. Without this the client would
    // happily reload its group and then crash on the first send.
    return { ...decoded, clientConfig: defaultClientConfig };
  }

  // -------------------------------------------------------------------- records

  async function readRecord(conversationId) {
    return store.get(conversationKey(conversationId));
  }

  async function patchRecord(conversationId, patch) {
    const existing = await readRecord(conversationId);
    const base = existing ?? {
      id: conversationId,
      groupId: null,
      state: null,
      appliedSeq: 0,
      readSeq: 0,
      members: [],
      own: [],
      error: null,
    };
    const record = { ...base, ...patch, updatedAt: now() };
    await store.set(conversationKey(conversationId), record);
    return record;
  }

  async function cacheMessage(conversationId, message) {
    await store.set(messageKey(conversationId, message.seq), message);
  }

  function membersOf(state) {
    return [...new Set(getGroupMembers(state).filter(Boolean).map(identityOf).filter(Boolean))];
  }

  // -------------------------------------------------------------- ordering core

  function serialize(conversationId, task) {
    const previous = chains.get(conversationId) ?? Promise.resolve();
    const result = previous.then(task, task);
    const tail = result.then(() => undefined, () => undefined);
    chains.set(conversationId, tail);
    tail.then(() => {
      if (chains.get(conversationId) === tail) chains.delete(conversationId);
    });
    return result;
  }

  async function appendEnvelope(conversationId, content) {
    const ack = await transport.append(conversationId, content);
    if (!ack || typeof ack.seq !== 'number') throw fail('append-failed', 'بسته به سرور نرسید');
    const record = await readRecord(conversationId);
    await patchRecord(conversationId, {
      appliedSeq: Math.max(record?.appliedSeq ?? 0, ack.seq),
      // The ids this device submitted, and no other device of the same account
      // submitted. That list, not the sender's identity, is what marks an event
      // as our own bytes coming back around the room.
      own: [...(record?.own ?? []).slice(-OWN_IDS), ack.id].filter(Boolean),
    });
    return ack;
  }

  async function joinFromWelcome(conversationId, welcome, envelope) {
    const record = await readRecord(conversationId);
    if (record?.state) throw fail('already-open', 'این گفتگو روی این دستگاه از قبل باز است');
    const addressedTo = new Set(welcome.secrets.map((secret) => toBase64(secret.newMember)));
    const pool = await store.list(KEY_PACKAGE_PREFIX);
    // A Welcome names its members by key-package reference, so this is the only
    // way to find which of our pooled private packages may open it. Handing it
    // the wrong one fails with "no matching secret", never with a wrong group.
    const mine = pool.find((entry) => addressedTo.has(entry.ref) && !entry.used);
    if (!mine) throw fail('not-added', 'این دستگاه برای این گفتگو دعوت نشده است');

    const state = await joinGroup(
      welcome,
      publicOf(mine),
      privateOf(mine),
      emptyPskIndex,
      impl,
      undefined,
      undefined,
      defaultClientConfig,
    );
    await store.set(KEY_PACKAGE_PREFIX + mine.ref, { ...mine, used: true });
    await patchRecord(conversationId, {
      groupId: toBase64(state.groupContext.groupId),
      state: saveState(state),
      appliedSeq: envelope.seq,
      members: membersOf(state),
      joinedAt: now(),
      error: null,
    });
    // A Welcome is envelope one but nobody can read it, so leaving it below the
    // server's mark would put it in the unread badge as if it were a message.
    // A failed receipt must not break the join: the group is open either way.
    await markRead(conversationId).catch(() => undefined);
  }

  async function applyEnvelope(conversationId, envelope, record) {
    let message;
    try {
      message = unpack(envelope.content);
    } catch {
      throw fail('bad-envelope', 'بسته‌ی دریافتی خواندن نیست');
    }

    if (record?.own?.includes(envelope.id)) {
      // Our own bytes coming back around the room, recognised by the id this
      // device submitted rather than by the account: a second device of the
      // same user sends under the same identity and must still decrypt. The
      // ratchet already moved when we produced them, so only the mark advances.
      await patchRecord(conversationId, { appliedSeq: envelope.seq, error: null });
      return { kind: 'self', seq: envelope.seq };
    }

    if (message.wireformat === 'mls_welcome') {
      await joinFromWelcome(conversationId, message.welcome, envelope);
      return { kind: 'welcome', seq: envelope.seq };
    }

    if (!record?.state) throw fail('no-group', 'این گفتگو روی این دستگاه کلید ندارد');
    const state = loadState(record);
    const result = await processPrivateMessage(state, message.privateMessage, emptyPskIndex, impl);
    const { text, attachment } = shapePayload(decodeUtf8(result.message));
    result.consumed.forEach(zeroOutUint8Array);

    const members = membersOf(result.newState);
    // The server names the sender; MLS proves that the bytes came from a leaf of
    // this group. Requiring the named sender to be one of those leaves is what
    // stops a relabelled message from being shown as if a friend wrote it.
    if (!members.includes(envelope.senderId)) {
      throw fail('unknown-sender', 'فرستنده‌ی این بسته در عضوهای این گفتگو نیست');
    }

    // Same account, different device: the interface still shows it as "mine",
    // because the person on the other end of that leaf is the user of this app.
    const mine = envelope.senderId === me.id;
    const at = envelope.createdAt ?? now();
    await cacheMessage(conversationId, {
      conversationId,
      seq: envelope.seq,
      id: envelope.id,
      senderId: envelope.senderId,
      text,
      attachment,
      at,
      mine,
    });
    await patchRecord(conversationId, {
      appliedSeq: envelope.seq,
      state: saveState(result.newState),
      members,
      error: null,
    });
    return {
      kind: 'message',
      conversationId,
      seq: envelope.seq,
      senderId: envelope.senderId,
      text,
      attachment,
      at,
      mine,
    };
  }

  // Walks the stream from the last applied envelope upwards, pulling from the
  // server whenever the next number is not already in hand. Hints are envelopes
  // the socket delivered early; using one avoids a round trip for the common
  // case of a live message.
  async function drain(conversationId, hints = []) {
    let queue = hints.filter((envelope) => envelope && typeof envelope.seq === 'number');
    for (;;) {
      const record = await readRecord(conversationId);
      const applied = record?.appliedSeq ?? 0;
      queue = queue.filter((envelope) => envelope.seq > applied);
      const next = queue.find((envelope) => envelope.seq === applied + 1);
      if (!next) {
        const page = await transport.fetchEnvelopes(conversationId, applied, FETCH_PAGE);
        if (!page.length) return record;
        if (page[0].seq !== applied + 1) {
          throw fail('gap', `بسته‌ی شماره ${applied + 1} از سرور نیامد`);
        }
        queue = queue.concat(page);
        continue;
      }
      queue = queue.filter((envelope) => envelope !== next);
      const appliedResult = await applyEnvelope(conversationId, next, record);
      if (appliedResult.kind === 'message') handlers.forEach((handle) => handle(appliedResult));
    }
  }

  async function requireGroup(conversationId) {
    const record = await readRecord(conversationId);
    if (!record?.state) throw fail('no-group', 'این گفتگو روی این دستگاه هنوز کلید ندارد');
    return record;
  }

  /**
   * Derives the LiveKit media key for one call from this conversation's MLS
   * exporter secret.
   *
   * MLS authenticates the epoch and every member of the group; the call id is
   * the exporter context, so a key cannot be replayed into a different call.
   * The returned `key` is handed straight to the local E2EE key provider and is
   * never sent anywhere. Only the SHA-256 `fingerprint` travels, to prove that
   * two devices derived the same key.
   */
  async function exportCallKey(conversationId, callId) {
    if (typeof conversationId !== 'string' || !conversationId) {
      throw fail('conversation', 'گفتگوی این تماس مشخص نیست');
    }
    if (typeof callId !== 'string' || !callId) {
      throw fail('call', 'شناسهٔ این تماس مشخص نیست');
    }
    const record = await requireGroup(conversationId);
    const state = loadState(record);
    const key = await mlsExporter(
      state.keySchedule.exporterSecret,
      'openbridge-call-v1',
      encodeUtf8(`call:${callId}`),
      32,
      impl,
    );
    return {
      key: toBase64(key),
      fingerprint: toBase64Url(await impl.hash.digest(key)),
      epoch: state.groupContext.epoch.toString(),
      groupId: toBase64(state.groupContext.groupId),
    };
  }

  /**
   * Derives a call key for the direct conversation with `peerId`.
   *
   * Deliberately does not call openDirect: that would create an encrypted
   * conversation as a side effect. A call on a plaintext chat returns null and
   * is treated as non-E2EE by the caller.
   */
  async function exportCallKeyForPeer(peerId, callId) {
    await ensureDevice();
    const probe = await transport.api(`messages/e2ee/direct/${peerId}`);
    if (!probe?.e2ee || !probe.conversationId) return null;
    if (!(await readRecord(probe.conversationId))) {
      await serialize(probe.conversationId, () => drain(probe.conversationId));
    }
    return exportCallKey(probe.conversationId, callId);
  }

  /** Derives a call key for an encrypted group, or null for a plaintext one. */
  async function exportCallKeyForGroup(conversationId, callId) {
    await ensureDevice();
    const probe = await transport.api(`messages/e2ee/group/${conversationId}`);
    if (!probe?.e2ee) return null;
    if (!(await readRecord(conversationId))) {
      await openGroup(conversationId);
    }
    await catchUp(conversationId);
    return exportCallKey(conversationId, callId);
  }

  // ------------------------------------------------------------------ key pool

  async function fillPool(clientId) {
    const devices = await transport.api('e2ee/devices');
    const available = devices.find((device) => device.clientId === clientId)?.availableKeyPackages ?? 0;
    if (available >= refillAt) return available;

    const minted = [];
    for (let i = 0; i < poolSize; i += 1) minted.push(await mintKeyPackage());
    for (const entry of minted) {
      await store.set(KEY_PACKAGE_PREFIX + entry.ref, { ...entry, used: false });
    }
    await transport.api(`e2ee/devices/${clientId}/key-packages`, {
      method: 'POST',
      body: { packages: minted.map((entry) => entry.public) },
    });
    return available + minted.length;
  }

  let devicePromise = null;

  async function registerDevice() {
    let device = await store.get(DEVICE_KEY);
    if (!device) {
      device = { clientId: toHex(impl.rng.randomBytes(CLIENT_ID_BYTES)), label, createdAt: now() };
      // Stored before the request: if the network drops, the next attempt reuses
      // this id instead of minting a second device for one installation.
      await store.set(DEVICE_KEY, device);
    }
    await transport.api('e2ee/devices', { method: 'POST', body: { clientId: device.clientId, label } });
    await fillPool(device.clientId);
    return device;
  }

  function ensureDevice() {
    devicePromise ??= registerDevice().catch((error) => {
      devicePromise = null;
      throw error;
    });
    return devicePromise;
  }

  // Started here rather than at first use: a device that has not registered and
  // pooled its keys is invisible, so nobody else can start a chat with this
  // account until it does. Failures are not swallowed — ready() reports them.
  const boot = ensureDevice();
  boot.catch(() => undefined);

  // ----------------------------------------------------------------- public API

  async function claimPackages(userId) {
    const claimed = await transport.api(`e2ee/users/${userId}/key-packages`);
    try {
      return (claimed.packages ?? []).map((content) => unpack(content).keyPackage);
    } catch {
      throw fail('bad-package', 'کلید عمومی دریافتی از سرور خواندن نیست');
    }
  }

  async function createDirectGroup(conversationId, peerPackages) {
    if (await readRecord(conversationId)) return { conversationId, e2ee: true };

    // The rest of my own devices are invited too, so a chat started in the
    // browser is readable on the phone. The device writing the group ignores the
    // secret addressed to itself, because for it this envelope is an echo.
    const packages = [...peerPackages];
    const devices = await transport.api('e2ee/devices');
    if (devices.length > 1) packages.push(...await claimPackages(me.id));

    // A package minted here is used as this client's leaf and never uploaded, so
    // no other conversation can ever be handed the same one.
    const own = await mintKeyPackage();
    const groupId = impl.rng.randomBytes(GROUP_ID_BYTES);
    const opened = await createGroup(groupId, publicOf(own), privateOf(own), [], impl);
    const commit = await createCommit(
      { state: opened, cipherSuite: impl },
      {
        extraProposals: packages.map((keyPackage) => ({ proposalType: 'add', add: { keyPackage } })),
        // Every device of the peer opens the same Welcome, and with the tree
        // inside it a joiner needs nothing but this one envelope.
        ratchetTreeExtension: true,
      },
    );
    commit.consumed.forEach(zeroOutUint8Array);

    await patchRecord(conversationId, {
      groupId: toBase64(groupId),
      state: saveState(commit.newState),
      members: membersOf(commit.newState),
    });
    await appendEnvelope(conversationId, pack(WELCOME(commit.welcome)));
    const members = (await readRecord(conversationId)).members;
    return { conversationId, e2ee: true, members };
  }

  /** Opens (and if needed creates) the encrypted direct conversation with a peer. */
  async function openDirect(peerId) {
    await ensureDevice();
    const probe = await transport.api(`messages/e2ee/direct/${peerId}`);
    if (probe?.e2ee && probe.conversationId) {
      if (!(await readRecord(probe.conversationId))) {
        await serialize(probe.conversationId, () => drain(probe.conversationId));
      }
      return { conversationId: probe.conversationId, e2ee: true };
    }

    // Claiming before the server is told is what keeps the fallback honest: a
    // conversation starts accepting only envelopes the moment this call returns,
    // so it must not flip until a group that somebody can actually decrypt exists.
    // A peer whose devices pooled no keys is therefore reported here, while its
    // chat stays an ordinary plaintext one that still carries messages.
    const packages = await claimPackages(peerId);
    if (!packages.length) throw fail('no-keys', 'این کاربر هنوز کلیدی برای دعوت شدن ندارد');

    const created = await transport.api('messages/e2ee/direct', { method: 'POST', body: { userId: peerId } });
    return serialize(created.conversationId, () => createDirectGroup(created.conversationId, packages));
  }

  /**
   * Creates a group that is encrypted from its first envelope. Every member's
   * devices are invited, plus this account's other devices, so the group is
   * readable everywhere the account is signed in. A member with no key material
   * is refused before the conversation exists: adding somebody the Welcome
   * cannot reach would produce a group that silently excludes them.
   */
  async function createEncryptedGroupChat(name, memberIds) {
    await ensureDevice();
    const unique = [...new Set(Array.isArray(memberIds) ? memberIds : [])]
      .filter((id) => typeof id === 'string' && id && id !== me.id);
    if (!unique.length) throw fail('members', 'حداقل یک عضو دیگر انتخاب کن');

    const packages = [];
    for (const userId of unique) {
      let claimed;
      try {
        claimed = await claimPackages(userId);
      } catch (error) {
        // The claim endpoint answers 404 for "no devices", "empty pool" and
        // "unknown account" alike, so the specific reason a group cannot invite
        // this member is only known here.
        if (error?.status === 404) throw fail('no-keys', 'یکی از اعضا هنوز کلیدی برای دعوت شدن ندارد');
        throw error;
      }
      if (!claimed.length) throw fail('no-keys', 'یکی از اعضا هنوز کلیدی برای دعوت شدن ندارد');
      packages.push(...claimed);
    }
    const devices = await transport.api('e2ee/devices');
    if (devices.length > 1) packages.push(...await claimPackages(me.id));

    const own = await mintKeyPackage();
    const groupId = impl.rng.randomBytes(GROUP_ID_BYTES);
    const opened = await createGroup(groupId, publicOf(own), privateOf(own), [], impl);
    const commit = await createCommit(
      { state: opened, cipherSuite: impl },
      {
        extraProposals: packages.map((keyPackage) => ({ proposalType: 'add', add: { keyPackage } })),
        ratchetTreeExtension: true,
      },
    );
    commit.consumed.forEach(zeroOutUint8Array);

    const welcome = pack(WELCOME(commit.welcome));
    if (welcome.length > MAX_ENVELOPE_CHARS) {
      throw fail('welcome-too-large', 'حجم دعوت این گروه از یک بسته بیشتر می‌شود؛ تعداد اعضا یا دستگاه‌ها را کم کن');
    }

    const conversation = await transport.api('messages/e2ee/group', {
      method: 'POST',
      body: { name, memberIds: unique },
    });
    await patchRecord(conversation.id, {
      groupId: toBase64(groupId),
      state: saveState(commit.newState),
      members: membersOf(commit.newState),
      // Kept until the append is acknowledged: an interrupted create still has
      // the keys and the Welcome, so opening the group can finish the job.
      welcomePending: welcome,
    });
    try {
      await appendEnvelope(conversation.id, welcome);
      await patchRecord(conversation.id, { welcomePending: null });
    } catch {
      // The conversation exists and is ours; openGroup retries the Welcome.
    }

    return { ...conversation, e2ee: true };
  }

  /** Opens an existing encrypted group, joining from its Welcome if needed. */
  async function openGroup(conversationId) {
    await ensureDevice();
    const probe = await transport.api(`messages/e2ee/group/${conversationId}`);
    if (!probe?.e2ee) return { conversationId, e2ee: false };

    const record = await readRecord(conversationId);
    if (record?.welcomePending) {
      const existing = await transport.fetchEnvelopes(conversationId, 0, 1);
      if (!existing.length) await appendEnvelope(conversationId, record.welcomePending);
      await patchRecord(conversationId, { welcomePending: null });
    }

    const caught = await catchUp(conversationId);
    const current = await status(conversationId);
    return {
      conversationId,
      e2ee: true,
      open: current.open,
      appliedSeq: caught.appliedSeq,
      error: caught.error,
    };
  }

  /** Encrypts `text` into the next envelope of a conversation and hands it to the server. */
  async function send(conversationId, text) {
    if (typeof text !== 'string' || !text.length) throw fail('empty', 'پیام خالی است');
    return serialize(conversationId, async () => {
      const record = await requireGroup(conversationId);
      const produced = await createApplicationMessage(loadState(record), encodeUtf8(text), impl);
      let ack;
      try {
        ack = await appendEnvelope(conversationId, pack(PRIVATE_MESSAGE(produced.privateMessage)));
      } catch (error) {
        // Nothing reached the server, so the ratchet must not move either. Keeping
        // the old state is what makes "not sent, try again" true instead of leaving
        // a hole the peer's receiver will refuse to step over.
        produced.consumed.forEach(zeroOutUint8Array);
        throw error;
      }
      await patchRecord(conversationId, { state: saveState(produced.newState) });
      produced.consumed.forEach(zeroOutUint8Array);
      await cacheMessage(conversationId, {
        conversationId,
        seq: ack.seq,
        id: ack.id,
        senderId: me.id,
        ...shapePayload(text),
        at: now(),
        mine: true,
      });
      return ack;
    });
  }

  /**
   * Feeds one `e2ee:envelope` event into the ordered pipeline. This never
   * rejects: a stream that cannot continue records why on the conversation and
   * stops, because applying later envelopes out of order would damage the
   * ratchet and dropping them silently would lose messages.
   */
  async function receive(envelope) {
    if (!envelope || typeof envelope.conversationId !== 'string' || typeof envelope.seq !== 'number') {
      return { kind: 'ignored' };
    }
    try {
      return await serialize(envelope.conversationId, () => drain(envelope.conversationId, [envelope]));
    } catch (error) {
      await patchRecord(envelope.conversationId, {
        error: { seq: envelope.seq, code: error.code ?? 'failed', message: error.message },
      }).catch(() => undefined);
      return { kind: 'failed', seq: envelope.seq, code: error.code ?? 'failed', message: error.message };
    }
  }

  /**
   * Pulls whatever the device missed while it was away. Like receive(), this
   * never throws: a stream with a hole in it is reported on the conversation,
   * which is what the interface shows, instead of an exception nobody can act
   * on. The mark stays where the last applied envelope left it.
   */
  async function catchUp(conversationId) {
    try {
      const record = await serialize(conversationId, () => drain(conversationId));
      return { appliedSeq: record?.appliedSeq ?? 0, error: null };
    } catch (error) {
      const stalled = await readRecord(conversationId);
      const info = { seq: (stalled?.appliedSeq ?? 0) + 1, code: error.code ?? 'failed', message: error.message };
      await patchRecord(conversationId, { error: info }).catch(() => undefined);
      return { appliedSeq: stalled?.appliedSeq ?? 0, error: info };
    }
  }

  async function status(conversationId) {
    const record = await readRecord(conversationId);
    return {
      open: Boolean(record?.state),
      appliedSeq: record?.appliedSeq ?? 0,
      readSeq: record?.readSeq ?? 0,
      members: record?.members ?? [],
      error: record?.error ?? null,
    };
  }

  /** Reports the conversation's own sequence mark, so a badge can be cleared. */
  async function markRead(conversationId) {
    const record = await readRecord(conversationId);
    const seq = record?.appliedSeq ?? 0;
    if (!record || seq <= (record.readSeq ?? 0)) return { seq: record?.readSeq ?? 0, moved: false };
    await transport.markRead(conversationId, seq);
    await patchRecord(conversationId, { readSeq: seq });
    return { seq, moved: true };
  }

  /** Decrypted messages of a conversation, oldest first. Plaintext lives only here. */
  async function history(conversationId) {
    const entries = await store.list(MESSAGE_PREFIX + conversationId + '/');
    return entries.sort((a, b) => a.seq - b.seq);
  }

  /** The newest decrypted message of a conversation, or null. For chat-list previews. */
  async function lastMessage(conversationId) {
    const entries = await store.list(MESSAGE_PREFIX + conversationId + '/');
    return entries.reduce((latest, entry) => (latest === null || entry.seq > latest.seq ? entry : latest), null);
  }

  /**
   * Every conversation this device holds a record for. A reconnect has to walk
   * all of them, not only the one on screen: MLS ratchets are per conversation,
   * so a chat left in the background while the socket was down is just as
   * broken as the visible one if its envelopes are never applied.
   */
  async function conversations() {
    const records = await store.list(CONVERSATION_PREFIX);
    return records.map((record) => ({
      id: record.id,
      open: Boolean(record.state),
      appliedSeq: record.appliedSeq ?? 0,
      error: record.error ?? null,
    }));
  }

  async function devices() {
    await ensureDevice();
    return transport.api('e2ee/devices');
  }

  /**
   * Resolves once this device is registered on the server and has KeyPackages in
   * its pool, i.e. once other people can start an encrypted chat with it.
   */
  async function ready() {
    const device = await ensureDevice();
    return { clientId: device.clientId, ciphersuite };
  }

  /** Forgets every key this client holds. The account keeps working; its old conversations do not. */
  async function reset() {
    const keys = [
      DEVICE_KEY,
      ...(await store.list(KEY_PACKAGE_PREFIX)).map((entry) => KEY_PACKAGE_PREFIX + entry.ref),
      ...(await store.list(CONVERSATION_PREFIX)).map((record) => conversationKey(record.id)),
      ...(await store.list(MESSAGE_PREFIX)).map((message) => messageKey(message.conversationId, message.seq)),
    ];
    for (const key of keys) await store.remove(key);
    devicePromise = null;
  }

  function onMessage(handler) {
    handlers.add(handler);
    return () => handlers.delete(handler);
  }

  const stopSocket = transport.onEnvelope((envelope) => {
    if (!envelope || typeof envelope.conversationId !== 'string') return;
    receive(envelope);
  });

  return {
    catchUp,
    ciphersuite,
    close() {
      stopSocket();
      handlers.clear();
    },
    conversations,
    createEncryptedGroupChat,
    devices,
    exportCallKey,
    exportCallKeyForGroup,
    exportCallKeyForPeer,
    history,
    lastMessage,
    markRead,
    onMessage,
    openDirect,
    openGroup,
    ready,
    receive,
    reset,
    send,
    status,
  };
}
