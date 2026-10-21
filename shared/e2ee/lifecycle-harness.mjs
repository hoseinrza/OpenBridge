// MLS lifecycle harness shared by the gate tests. It is test scaffolding, not
// product code: it asserts the protocol properties OpenBridge would depend on,
// with each party driven by a caller-supplied CiphersuiteImpl so that the same
// run can be "all pure" or "web provider <-> pure provider".
import {
  createApplicationMessage,
  createCommit,
  createGroup,
  decodeGroupState,
  defaultCapabilities,
  defaultLifetime,
  encodeGroupState,
  decodeMlsMessage,
  encodeMlsMessage,
  emptyPskIndex,
  generateKeyPackage,
  joinGroup,
  processPrivateMessage,
  zeroOutUint8Array,
} from 'ts-mls';
import { getGroupMembers } from 'ts-mls/clientState.js';

const enc = new TextEncoder();
const dec = new TextDecoder();

const bundle = (m) => encodeMlsMessage(m, 0);

function unbundle(bytes, expected) {
  const [msg] = decodeMlsMessage(bytes, 0);
  if (msg.wireformat !== expected) throw new Error(`expected ${expected}, got ${msg.wireformat}`);
  return msg;
}

function identityOf(member) {
  const credential = member.credential;
  const raw = credential.basic?.identity ?? credential.identity;
  return raw ? dec.decode(raw) : '';
}

export async function runMlsLifecycle(impls) {
  const checks = {};
  const party = async (name) => {
    const credential = { credentialType: 'basic', identity: enc.encode(name) };
    const kp = await generateKeyPackage(credential, defaultCapabilities(), defaultLifetime, [], impls[name]);
    return { name, ...kp };
  };
  const [alice, bob, carol] = await Promise.all([party('alice'), party('bob'), party('carol')]);

  const send = async (state, from, text) => {
    const r = await createApplicationMessage(state, enc.encode(text), impls[from]);
    r.consumed.forEach(zeroOutUint8Array);
    return {
      state: r.newState,
      bytes: bundle({ privateMessage: r.privateMessage, wireformat: 'mls_private_message', version: 'mls10' }),
    };
  };
  const receive = async (state, to, bytes) => {
    const r = await processPrivateMessage(state, unbundle(bytes, 'mls_private_message').privateMessage, emptyPskIndex, impls[to]);
    r.consumed.forEach(zeroOutUint8Array);
    return { state: r.newState, text: dec.decode(r.message) };
  };

  // create -> add -> Welcome -> join, then resume from serialized state
  let aliceState = await createGroup(enc.encode('conv-lifecycle'), alice.publicPackage, alice.privatePackage, [], impls.alice);
  const bobKp = unbundle(bundle({ keyPackage: bob.publicPackage, wireformat: 'mls_key_package', version: 'mls10' }), 'mls_key_package').keyPackage;
  const commit = await createCommit(
    { state: aliceState, cipherSuite: impls.alice },
    { extraProposals: [{ proposalType: 'add', add: { keyPackage: bobKp } }] },
  );
  aliceState = commit.newState;
  commit.consumed.forEach(zeroOutUint8Array);

  const welcomeBytes = bundle({ welcome: commit.welcome, wireformat: 'mls_welcome', version: 'mls10' });
  const bobState = await joinGroup(
    unbundle(welcomeBytes, 'mls_welcome').welcome,
    bob.publicPackage,
    bob.privatePackage,
    emptyPskIndex,
    impls.bob,
    aliceState.ratchetTree,
  );
  checks.welcomeJoin = bobState.groupContext.epoch === aliceState.groupContext.epoch;

  const [restored] = decodeGroupState(encodeGroupState(aliceState), 0);
  checks.stateSerialization = restored.groupContext.epoch === aliceState.groupContext.epoch;

  // both directions, because one provider may seal and the other open
  const t0 = performance.now();
  const sent = await send(aliceState, 'alice', 'سلام از آلیس');
  const got = await receive(bobState, 'bob', sent.bytes);
  checks.bobDecryptsAlice = got.text === 'سلام از آلیس';
  const reply = await send(got.state, 'bob', 'message from bob');
  const got2 = await receive(sent.state, 'alice', reply.bytes);
  checks.aliceDecryptsBob = got2.text === 'message from bob';
  const encryptDecryptMs = (performance.now() - t0) / 2;

  // per-sender generation chain: in-order works, replay and staleness fail
  const b1 = await send(reply.state, 'bob', 'one');
  const b2 = await send(b1.state, 'bob', 'two');
  const d1 = await receive(got2.state, 'alice', b1.bytes);
  let duplicateRejected = false;
  try { await receive(d1.state, 'alice', b1.bytes); } catch { duplicateRejected = true; }
  checks.duplicateRejected = duplicateRejected;
  const d2 = await receive(d1.state, 'alice', b2.bytes);
  checks.inOrderDelivery = d2.text === 'two';
  let staleGenerationRejected = false;
  try { await receive(d2.state, 'alice', b1.bytes); } catch { staleGenerationRejected = true; }
  checks.staleGenerationRejected = staleGenerationRejected;

  // membership change: removed member must not decrypt the new epoch
  const carolKp = unbundle(bundle({ keyPackage: carol.publicPackage, wireformat: 'mls_key_package', version: 'mls10' }), 'mls_key_package').keyPackage;
  const c1 = await createCommit(
    { state: d2.state, cipherSuite: impls.alice },
    { extraProposals: [{ proposalType: 'add', add: { keyPackage: carolKp } }] },
  );
  const carolWelcome = unbundle(bundle({ welcome: c1.welcome, wireformat: 'mls_welcome', version: 'mls10' }), 'mls_welcome').welcome;
  let carolState = await joinGroup(
    carolWelcome,
    carol.publicPackage,
    carol.privatePackage,
    emptyPskIndex,
    impls.carol,
    c1.newState.ratchetTree,
  );
  const bobLeaf = getGroupMembers(carolState).findIndex((m) => m && identityOf(m) === 'bob');
  const c2 = await createCommit(
    { state: carolState, cipherSuite: impls.carol },
    { extraProposals: [{ proposalType: 'remove', remove: { removed: bobLeaf } }] },
  );
  carolState = c2.newState;
  c2.consumed.forEach(zeroOutUint8Array);
  const afterRemove = await send(carolState, 'carol', 'secret for remaining members');
  let bobRejected = false;
  try { await receive(b2.state, 'bob', afterRemove.bytes); } catch { bobRejected = true; }
  checks.removedMemberCannotDecrypt = bobRejected;

  const sample = await createApplicationMessage(carolState, enc.encode('x'.repeat(200)), impls.carol);
  return {
    checks,
    metrics: {
      encryptDecryptMs,
      stateRoundTripBytes: encodeGroupState(c1.newState).length,
      welcomeBytes: welcomeBytes.length,
      appMessageOverheadFor200Chars:
        bundle({ privateMessage: sample.privateMessage, wireformat: 'mls_private_message', version: 'mls10' }).length - 200,
    },
  };
}
