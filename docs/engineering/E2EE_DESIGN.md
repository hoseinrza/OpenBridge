# OpenBridge End-to-End Encryption — Design Proposal

Status: **proposal only — E2EE is not implemented**
Last updated: 2026-10-21

OpenBridge currently stores message text and attachment bytes in plaintext on
the server (see `docs/SECURITY.md`). This document evaluates protocol options
and proposes an implementation path. It intentionally contains **no
cryptographic code**; nothing here should be read as a claim that messages are
encrypted today.

## 1. Goals and non-goals

### Goals

- The server, database operators, and backups cannot read message text or
  attachment contents.
- Forward secrecy: compromise of long-term keys does not decrypt past messages.
- Post-compromise security for 1:1 conversations: after a device compromise
  ends, future messages are protected again.
- Multi-device: every signed-in device of every participant can decrypt.
- Membership changes: removed group members cannot read future messages.
- Honest UX: users can see which conversations are encrypted, when encryption
  started, and whether a contact's identity key changed.

### Non-goals (documented, not silently omitted)

- Hiding metadata (who talks to whom, when, message sizes, group membership).
  The server still sees this.
- Protecting against a compromised endpoint (malware, XSS, screen capture).
- Server-side search of encrypted content, push-notification previews, or
  server-side spam/abuse scanning of message bodies.
- Retroactive encryption of existing plaintext history.
- Deniability guarantees beyond what the chosen protocol provides.

## 2. Current state and constraints

| Area | Today |
|------|-------|
| Clients | React web (Vite), Expo React Native mobile |
| Server | NestJS + PostgreSQL + Socket.IO; verifies membership on every event |
| Message storage | `messages.text` and `messages.fileUrl` in plaintext |
| Auth | Short-lived access JWT bound to a server-side session, rotating refresh token |
| Attachments | Server-generated UUID files, signed expiring download URLs |
| Group size | Small (tens of members); groups are currently web-only |

Constraints that shape the design:

1. **Web and mobile must both implement the same protocol.** A conversation is
   only end-to-end encrypted if every participating client encrypts. One
   plaintext client would silently break the guarantee.
2. **No home-grown cryptography.** Only maintained, reviewed protocol
   implementations may be used.
3. **The server must stay usable for authorization.** It still needs sender
   identity, conversation membership, and envelope routing — just not
   plaintext.
4. **Existing plaintext history cannot be encrypted retroactively** without
   the original keys, which do not exist.

## 3. Protocol options

### 3.1 Signal Protocol (X3DH + Double Ratchet, Sender Keys for groups)

- 1:1: X3DH establishes a shared secret asynchronously from a prekey bundle;
  the Double Ratchet then derives per-message keys with forward secrecy and
  post-compromise security.
- Groups: each member maintains a Sender Key (chain key + signing key)
  distributed to other members over pairwise ratchet sessions; group messages
  are encrypted once per sender chain and authenticated with the sender's
  signing key.
- Multi-device is a first-class part of the model: each device is a separate
  address (`userId.deviceId`) with its own identity and prekeys.
- Reference implementation: `libsignal` (Rust core). Official bindings exist
  for Swift, Java/Android, and Node (used by Signal Desktop). There is **no
  officially distributed browser/WASM build**, and no official React Native
  binding; web and Expo would need a self-built WASM artifact and a native
  module wrapper respectively, or a reviewed third-party port.

### 3.2 MLS (RFC 9420)

- Designed for groups: epoch-based key schedule, Commit/Welcome messages,
  forward secrecy and post-compromise security for every member, efficient
  rekeying for large groups.
- Handles 1:1 as a two-member group, so a single protocol covers DMs and
  groups.
- Requires a Delivery Service that orders handshake messages per conversation
  and enforces epoch consistency — meaningful extra server work and new
  failure modes (forked epochs, pending commits).
- Implementations: OpenMLS and mls-rs (Rust), ts-mls (TypeScript). Web can use
  WASM builds; React Native needs WASM or native integration, which is less
  mature than the equivalent Signal bindings.

### 3.3 Comparison

| Criterion | Signal Protocol | MLS |
|-----------|-----------------|-----|
| Async offline setup | X3DH prekey bundles, mature | KeyPackage + Welcome, workable but more moving parts |
| 1:1 | Native, highly reviewed | Two-member group; correct but heavier |
| Groups | Sender Keys; simple, no PCS for sender chains | Native; PCS and efficient rekeying |
| Membership change | Rotate sender keys; removed member excluded going forward | Commit changes epoch; well specified |
| Server complexity | Envelope routing + prekey store | Delivery service with ordered handshake messages |
| Web client maturity | Self-built WASM / reviewed TS port | WASM builds available |
| React Native maturity | Native wrapper required | WASM/native integration required |
| Best fit | Small groups, mobile-first async chat | Large groups, frequent membership churn |

### 3.4 Recommendation

**Primary path: Signal Protocol family** — X3DH + Double Ratchet for direct
conversations, Sender Keys for groups.

Reasons: OpenBridge is an asynchronous mobile/web messenger with small groups,
which is exactly the model the Signal Protocol was designed for. Sender Keys
avoid the delivery-service complexity of MLS while remaining adequate for the
current group sizes. Multi-device fan-out is already part of the model.

**Decision gate before any client work:** prove the client library story on
both platforms. Phase 0 must produce (a) a reproducible `libsignal` WASM build
for the web client and (b) a native Expo module for mobile, passing
cross-platform interop tests. If either is not maintainable, fall back to MLS
(OpenMLS on web via WASM, Rust core wrapped for mobile) — still without
hand-written primitives. This gate is mandatory; a protocol without a
maintainable client implementation is not a plan.

**Sender Keys caveat:** sender chains have forward secrecy but weaker
post-compromise security than Double Ratchet. Mitigate with periodic sender-key
rotation and mandatory rotation on membership change. Revisit MLS if groups
grow large or membership churn becomes common.

### 3.5 Phase 0 gate result (run 2026-10-21)

The gate was executed with real code rather than assumed. Everything below was
measured in Node on a Windows dev machine (`ts-mls` 1.6.4, `@hpke/core` 1.9.0,
`@noble/*`); nothing was run on a phone or in Hermes.

**libsignal: fails the gate as written.** No browser/WASM artifact is published
and there is no React Native binding, so both halves of the required proof
cannot be produced without building and maintaining the toolchain ourselves.

**MLS has a usable pure-JS implementation on web and Node.** With the
`nobleCryptoProvider` and ciphersuite `MLS_128_DHKEMX25519_AES128GCM_SHA256_Ed25519`
(id 1, no extra dependencies), this lifecycle ran and was asserted:

| Check | Result |
|-------|--------|
| create group → add member → welcome → join | works |
| application message both directions | works |
| strictly in-order multi-message stream | works |
| replay of an already-read generation | rejected (`Desired gen in the past`) |
| member removed by commit | cannot decrypt post-removal traffic |
| client state `encodeGroupState`/`decodeGroupState` | works, ~3 KB at 3 members |
| welcome size / traffic overhead | 349 B / ~151 B over a 200-char body |
| encrypt+decrypt per message | ≈2.2 ms in Node (pure JS) |

**Mobile is blocked by one specific thing: WebCrypto.** Hermes has no
`crypto.subtle`. ts-mls's "noble" provider replaces AEAD, hashing and
signatures with `@noble/*`, but the KEM and KDF still come from `@hpke/core`,
whose `DhkemX25519HkdfSha256` calls `subtle.generateKey` and whose
`HkdfSha256`/`Aes128Gcm` are `NativeAlgorithm` wrappers. Deleting
`crypto.subtle` from the global (the honest Hermes simulation) makes the very
first key generation fail. So MLS on mobile needs one of:

1. **A pure-JS suite substituted into `@hpke/common`'s interfaces** — DHKEM
   X25519 primitives + HKDF-SHA256 + AES-128-GCM over `@noble/*`, roughly 120
   lines we would own and must keep correct across upgrades. A draft exists in
   this evaluation; **it is not yet proven**, because the reference call path
   (`@hpke/core`'s `CipherSuite.seal`) itself broke under Node 26's WebCrypto,
   so the comparison harness has to be fixed before the adapter can be trusted.
   An alternative is the newer `hpke` + `@panva/hpke-noble` suite, which is
   fully `@noble/*`-based but targets a different (incompatible) interface than
   the one ts-mls consumes.
2. **A native WebCrypto module on mobile** (`react-native-quick-crypto` and
   similar). No owned crypto, but a development build is then required: Expo Go
   cannot run E2EE, and every test on a phone needs a custom build.

`isomorphic-webcrypto` was considered and rejected as a polyfill: it is
effectively unmaintained, and substituting an unreviewed WebCrypto shim under a
protocol library is the wrong place to take risk.

**Two consequences for the server, independent of the mobile decision:**

- MLS is not order-tolerant. A receiver cannot decrypt generation *n+1* before
  *n*, so the "delivery service" requirement in §3.2 is real: the API must hand
  each client a conversation's bundles in one strict order, and clients must
  buffer rather than process concurrently.
- Group state is ~3 KB per member set and grows with members and epoch history.
  It does not fit `expo-secure-store`'s per-item limit, so mobile key + state
  storage needs SQLite/AsyncStorage, which is weaker at rest than the keystore
  §4 assumes.

**Open risk that the gate cannot close:** ts-mls states in its own README that
it has **not had a formal security audit**. The design constraint in §2 ("only
maintained, reviewed protocol implementations") is met at the *protocol* level
(RFC 9420) and by a maintained, CI-covered implementation, but not at the
*implementation-audit* level. Choosing MLS is therefore a decision to run an
unaudited implementation and to fund an external review, not a free win.


## 4. Identity, prekeys, and trust

### Server-stored public material only

Per device, the client generates and uploads:

- identity key pair (Curve25519; used for X3DH and signing),
- signed prekey (rotated periodically, signed by the identity key),
- a batch of one-time prekeys,
- registration id and device id.

The server stores public keys and signatures only. Private keys never leave the
device. One-time prekeys are handed out atomically and deleted/marked used;
when exhausted, clients fall back to the signed prekey and upload more.

### Private key storage

- Web: IndexedDB, with the key material wrapped by a non-extractable AES-GCM
  key stored via WebCrypto where the library permits it. XSS can still use the
  session to decrypt — this is inherent to web E2EE, not fixable by storage
  tricks.
- Mobile: OS keystore (Keychain / Android Keystore) through a native module;
  `expo-secure-store` is useful for small secrets but is not a substitute for
  keystore-backed key operations.

### Trust and verification

- Default trust-on-first-use (TOFU) with a visible warning whenever a
  contact's identity key or device set changes.
- Safety-number / QR verification for 1:1 conversations; verified state is
  stored locally and per contact.
- No key transparency log in the first version. The server could substitute a
  prekey bundle during the TOFU window; verification is the mitigation.

## 5. Multi-device

- Every device registers independently and is a separate encryption recipient.
- Direct messages: the sender encrypts one copy per recipient device (and one
  per own other device for sync).
- Groups: sender keys are distributed to every device of every member over
  pairwise sessions; a group membership change or device addition requires
  redistribution/rotation.
- Device linking (new device) uses a QR flow with an ephemeral key exchange.
  History transfer is out of scope for v1; a new device starts with new
  messages unless a peer-to-peer transfer is added later.

## 6. Message format and server changes

### Envelope

```json
{
  "v": 1,
  "alg": "signal.v1",
  "type": "prekey | whisper | sender-key",
  "conversationId": "…",
  "senderUserId": "…",
  "senderDeviceId": "…",
  "recipientDeviceId": "…",
  "ciphertext": "base64…",
  "clientSentAt": "…"
}
```

The server validates envelope size (existing 256 KB cap), sender identity,
conversation membership, and recipient device ownership. It does not attempt to
parse or decrypt `ciphertext`. Message content columns stay nullable for legacy
plaintext rows only; E2EE messages store no `text`.

### New/changed tables

- `devices`: `id`, `userId`, `identityKey`, `signedPrekey`, `signedPrekeySig`,
  `registrationId`, `createdAt`, `lastSeenAt`, `revokedAt`.
- `one_time_prekeys`: `id`, `deviceId`, `publicKey`, `usedAt` (consumed
  atomically, never reused).
- `message_envelopes`: `id`, `messageId`, `recipientDeviceId`,
  `senderDeviceId`, `type`, `ciphertext`, unique on
  `(messageId, recipientDeviceId)`. Keeping envelopes per device (instead of one
  ciphertext per message) is required for Double Ratchet fan-out; Sender Key
  group messages can reuse one ciphertext row per recipient device for routing
  simplicity.
- `conversations.encryptionMode`: `PLAINTEXT | E2EE`, plus `e2eeStartedAt`.
  Once a conversation is E2EE, the server rejects plaintext sends in it.

### Attachments

- Client generates a random AES-256-GCM key per file, encrypts the bytes, and
  uploads only ciphertext. The MIME type, size, and filename can be encrypted
  as part of the message content if metadata protection is wanted.
- The file key and IV travel inside the message ciphertext, never to the server.
- The existing signed-URL mechanism still controls access to the blob, but the
  blob is useless without the message. ClamAV scanning remains useful for
  transport hygiene but cannot scan encrypted payloads; scanning must happen
  client-side or be accepted as unavailable.

### Metadata and notifications

- Reactions, typing, read receipts, and call signaling stay server-visible
  metadata in v1. If reaction content must be private, reactions can be moved
  into encrypted messages later.
- Push notifications must not include message text or sender-authored previews;
  use a generic "New message" with no content.
- Server-side search is impossible for encrypted conversations; search becomes
  client-side over locally cached plaintext. The UI must say so.

## 7. Migration and rollout

1. **Phase 0 — library gate.** *Run on 2026-10-21; results in §3.5.* libsignal
   fails the gate (no web or Expo artifact). MLS works in web/Node through
   `ts-mls` with a pure-JS provider, but mobile is blocked until either a
   pure-JS HPKE suite is substituted for `@hpke/core`'s WebCrypto KEM/KDF/AEAD
   or mobile moves to development builds with a native WebCrypto module. The
   gate is therefore **not passed on mobile**, and the recommendation in §3.4
   is superseded by §3.5: MLS, not Signal, is the only path with a client
   implementation that exists today. No server changes.
2. **Phase 1 — key infrastructure.** Device registration, prekey upload and
   atomic consumption, public bundle API, device list, revocation. No encryption
   of content yet.
3. **Phase 2 — direct E2EE on web and mobile.** New direct conversations are
   opt-in E2EE. Plaintext history stays labeled "sent before encryption".
   Unsupported clients cannot send into an E2EE conversation; the UI explains
   why.
4. **Phase 3 — groups.** Sender-key distribution, rotation on membership
   change, multi-device fan-out, removal semantics.
5. **Phase 4 — encrypted attachments**, then default-on for new conversations
   once the security review passes.
6. **Phase 5 — hardening.** Key-change UX, safety numbers, encrypted local
   backups (optional), metadata review, external security review.

Rollback: an E2EE conversation can only be downgraded by an explicit,
warning-heavy user action that all participants can see. Silent downgrade is a
security bug.

## 8. Threat model impact

| Adversary | After E2EE (verified keys) |
|-----------|----------------------------|
| Compromised server/DB/backups | Cannot read new message text or attachments; sees metadata and ciphertext. |
| Passive network observer | Already mitigated by TLS; unchanged. |
| Malicious server substituting keys | Detected if safety numbers/QR were verified; TOFU window remains. |
| Stolen unlocked device | Can read local plaintext and use sessions; device revocation and session revocation remain the mitigation. |
| XSS / malicious same-origin JS | Can read plaintext while the page is open and act as the user. Inherent web limitation. |
| Removed group member | Cannot decrypt messages after the key rotation; earlier messages they already received remain readable. |
| Future quantum adversary | Not protected unless PQXDH/post-quantum primitives are added; plan a follow-up. |

## 9. Testing requirements

- Protocol test vectors from the upstream implementation (ratchet, prekey
  message, sender key).
- Cross-client interop: web ↔ mobile ↔ web, including multi-device for one user.
- Out-of-order and skipped-message handling, duplicate delivery idempotency,
  prekey exhaustion fallback.
- Group membership add/remove rotates keys and excludes the removed device;
  device revocation stops future envelopes.
- Tampered ciphertext and tampered attachment fail authentication and never
  render.
- Server test asserting the database contains no plaintext for E2EE messages
  and that logs do not contain content.
- Key-change warning shown on identity change; verified state survives restarts.
- Regression: existing plaintext conversations still work until migrated.

## 10. Open questions

1. Is a self-built WASM `libsignal` artifact acceptable for long-term web
   maintenance, or should we require an audited third-party build?
2. Which React Native integration path is viable for Expo (custom native module
   vs. WASM), and does it work under Hermes? — *Narrowed by §3.5: neither WASM
   nor WebCrypto exists in Hermes, so the choice is a ~120-line pure-JS HPKE
   suite we own and review, or a native module that ends Expo Go support for
   the encrypted build. Still open, and it is a product decision, not a
   technical one.*
3. Is E2EE opt-in per conversation, or default-on for new direct chats once all
   active devices support it?
4. Key backup/recovery: no server escrow (lose devices → lose history) vs. an
   optional passphrase-encrypted backup. Product decision with support
   implications.
5. Should existing plaintext history be exportable/deletable per user before
   E2EE becomes the default?
6. Do reactions, typing, and read receipts need content encryption in v1?
7. PQXDH/post-quantum rollout timeline.
8. Metadata minimization (sealed sender, push payloads, presence) — separate
   project or part of E2EE?
9. Legal/compliance retention requirements for ciphertext and metadata.

## 11. Explicit statement of current behavior

Until every phase above is implemented and verified:

- OpenBridge messages are **not** end-to-end encrypted.
- The server can read all message content and attachments.
- Nothing in the UI may claim otherwise, and no field may be named "encrypted"
  unless it holds protocol ciphertext.
