# OpenBridge End-to-End Encryption — Design Proposal

Status: **protocol chosen (MLS) and the Phase 0 library gate is closed —
E2EE is still not implemented in the product**
Last updated: 2026-10-21

OpenBridge currently stores message text and attachment bytes in plaintext on
the server (see `docs/SECURITY.md`). This document evaluates protocol options
and proposes an implementation path. The only crypto-adjacent code in the repo
is `shared/e2ee/provider.js`, interface glue for a maintained MLS library that
is covered by the gate tests in the same folder; **it implements no primitive,
no message format and no product key storage**, and nothing here should be read
as a claim that messages are encrypted today.

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

*(Resolved the same day: option 1 turned out to need no owned primitive —
see §3.6.)*

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


### 3.6 Gate closed: the mobile path exists and is in the repo (2026-10-21)

Option 1 from §3.5 was resolved without owning a primitive. The chosen shape is
`hpke` 1.1.7 (RFC 9180 key schedule, zero dependencies, maintained) with
`@panva/hpke-noble` 1.1.7 supplying noble-backed `DHKEM(X25519, HKDF-SHA256)`,
`HKDF-SHA256` and `AES-128-GCM`/`AES-256-GCM`/`ChaCha20Poly1305`. `hpke` exposes
extension points (`KEMFactory`/`KDFFactory`/`AEADFactory`) precisely so a
non-WebCrypto runtime can be plugged in, which is what the noble package is for.

The only code OpenBridge owns is `shared/e2ee/provider.js`: it adapts ts-mls's
`Hpke`/`Kdf`/`Signature` interfaces onto that maintained stack, plus
`@noble/curves` Ed25519 pinned to the raw-seed format. ts-mls's own
`makeNobleSignatureImpl` prefers `crypto.subtle` when it exists, which stores
signing keys as PKCS#8 on web and as a raw seed on Hermes — so reusing it would
make key material platform-dependent. Pinning noble gives one key format on
every client.

Proven by `npm run test:e2ee` (also CI job `2b · E2EE library gate`):

| Test | Result |
|------|--------|
| Full MLS lifecycle on `MLS_128_DHKEMX25519_AES128GCM_SHA256_Ed25519`, pure provider | passes |
| Full MLS lifecycle on `MLS_128_DHKEMX25519_CHACHA20POLY1305_SHA256_Ed25519`, pure provider | passes |
| Cross-provider interop, WebCrypto seals → pure opens and pure seals → WebCrypto opens | passes both directions |
| Same lifecycle with `crypto.subtle` replaced by a throwing trap (Hermes condition) | passes |

Interop in both directions is the check that matters: ciphertext produced by the
pure provider is decrypted by ts-mls's WebCrypto path and vice versa, so the
adapter adds no protocol divergence. Measured cost: ~3.6–4.9 ms per
encrypt+decrypt pair, ~2.9–3.0 KB client state for a 3-member group, 342 B
welcome, ~144 B overhead on a 200-character body.

What this does **not** prove:

- It has not run on a phone. The Hermes simulation removes `crypto.subtle` and
  keeps only `getRandomValues`; it does not reproduce Hermes' other gaps (no
  WASM, no `eval`, slower BigInt). The mobile bundle must still be built with
  `expo export` and exercised on a device during Phase 2.
- `@panva/hpke-noble` statically imports `@noble/post-quantum` and every curve.
  Vite tree-shakes it (`sideEffects: false`); Metro does not, so the Android JS
  bundle carries unused post-quantum code. Accepted for now; if the size is a
  problem, ask upstream for subpath exports rather than vendoring a copy.
- Dependency versions are pinned to the tested tree. ts-mls peer-pins
  `@noble/ciphers@2.1.1` while `@panva/hpke-noble` needs `^2.3.0`, so npm nests a
  second copy. Both instances are used by disjoint code paths, which is why
  interop works, but the duplication is real and upgrades must re-run the gate.

**Gate verdict: passed on web, passed on the simulated mobile runtime, not yet
passed on a device.** Phase 1 may start.


## 4. Identity, prekeys, and trust

### Server-stored public material only

Per device, in MLS terms (§3.6 fixed the protocol as MLS, so the Signal
vocabulary below is kept only as history for the parts that still apply):

- a long-lived identity leaf credential (Ed25519 in ciphersuite 1),
- a pool of `KeyPackage`s (HPKE X25519 public key + credential + signature),
  which is what a Welcome message uses to add that device to a group,
- device id and registration metadata.

The server stores public keys and signatures only. Private keys and MLS client
state never leave the device. `KeyPackage`s are handed out atomically and marked
consumed; when a device's pool runs low it uploads more.

### Phase 1 landed (2026-10-21): the public-material API

`backend/src/e2ee/` implements the storage half of the list above, and nothing
else — no content is encrypted yet.

| Endpoint | Effect |
|----------|--------|
| `POST /api/e2ee/devices` | register or refresh the caller's own device, idempotent by the client-generated `clientId` |
| `GET /api/e2ee/devices` | the caller's active devices with their remaining pool size |
| `DELETE /api/e2ee/devices/:clientId` | revoke: stamp `revokedAt`, delete that device's whole pool |
| `POST /api/e2ee/devices/:clientId/key-packages` | append opaque base64 KeyPackages to the caller's own pool |
| `GET /api/e2ee/users/:userId/key-packages` | claim one fresh KeyPackage per active device of the recipient |

Properties the tests in `backend/test/security.e2e.cjs` assert rather than
assume:

- **Nothing private can be stored, by construction.** `devices` and
  `key_packages` have no column that could hold a private key, MLS state or a
  passphrase; the KeyPackage column is one base64 string the server never
  decodes. A request that carries `privateKey`, `state` or a foreign `userId`
  has those fields dropped by the global whitelist pipe, and the row proves it.
- **A package reaches one caller.** Consumption stamps `consumedAt` plus a
  random `claimToken` in one update that re-checks `consumedAt IS NULL`, then
  the claim re-reads only the rows carrying its own token. Losers of the race
  retry for the device's next package or fail; they never see the winner's bytes.
- **All devices or none.** A claim that cannot cover every active device of the
  recipient returns an error instead of a partial bundle, because a missing
  device would mean a group that silently excludes it.
- **Revocation is permanent and local.** A revoked `clientId` cannot
  re-register (a new install must mint a new id), and its pool is deleted, used
  and unused alike. Revoking and deleting run in one transaction so a claim
  that already selected those rows blocks and then matches nothing.
- **No enumeration.** Unknown account, account with no devices, and account
  whose pool is empty all answer with the same 404 and the same text; the
  endpoint is additionally rate limited per client IP.
- **Abandoned claims burn one package per device.** Accepted cost of keeping no
  server-side reservation state; clients refill the pool when it runs low.

### Key custody: no escrow, no server-side recovery

Decided 2026-10-21, and it is a hard constraint rather than a preference: **no
access level, including the platform owner, may be able to read message
content.** Consequences that must be designed in, not worked around:

- No key backup on the server, no recovery endpoint, no admin-readable export,
  no "email me my keys" flow. Lose every device and the history is gone; the UI
  has to say that before it happens.
- No server-side plaintext search, no push payloads containing message text or
  sender-authored previews, no server-side content scanning of encrypted bodies
  or attachments.
- Nothing in the backend may accept, log, or persist a private key, MLS client
  state, or a passphrase that could unlock them. A test must assert the database
  and logs contain no plaintext or key material for E2EE messages.
- Optional *user*-initiated encrypted export (passphrase-protected file the
  user holds) is the only allowed recovery route, and it is Phase 5 work.

### Private key storage

- Web: IndexedDB, with the key material wrapped by a non-extractable AES-GCM
  key stored via WebCrypto where the library permits it. XSS can still use the
  session to decrypt — this is inherent to web E2EE, not fixable by storage
  tricks.
- Mobile: OS keystore (Keychain / Android Keystore) through a native module;
  `expo-secure-store` is useful for small secrets but is not a substitute for
  keystore-backed key operations. Note §3.5: MLS client state is ~3 KB, above
  `expo-secure-store`'s per-item ceiling, so state goes to AsyncStorage/SQLite
  while only the wrapping key, if any, lives in the keystore. That is weaker at
  rest than this section assumes, and is a documented trade-off, not a silent one.

### Trust and verification

- Default trust-on-first-use (TOFU) with a visible warning whenever a
  contact's identity key or device set changes.
- Safety-number / QR verification for 1:1 conversations; verified state is
  stored locally and per contact.
- No key transparency log in the first version. The server could substitute a
  prekey bundle during the TOFU window; verification is the mitigation.

## 5. Multi-device

- Every device registers independently and owns its own `KeyPackage` pool, so it
  is a separate MLS leaf and a separate recipient of Welcomes.
- Direct conversations are two-member groups (or a group per device pair), so
  multi-device is the same commit/welcome path as groups — one leaf per device.
- A new device of an existing member is added by a commit from another device of
  the same user; it then decrypts from that epoch forward, not backwards.
- Device linking (new device) uses a QR flow with an ephemeral key exchange.
  History transfer is out of scope for v1; a new device starts with new
  messages unless a peer-to-peer transfer is added later.

## 6. Message format and server changes

### Envelope

The Signal-shaped envelope below is what this section proposed before §3.6 chose
MLS. MLS changes it in one important way: a group message is a single
application message encrypted to the group's current epoch key, so the server
stores **one blob per message for the whole conversation**, not one per recipient
device. Per-device fan-out is only needed for `Welcome` messages, which arrive as
opaque bytes inside the same stream and are decrypted only by the device whose
KeyPackage they name. What landed is therefore this:

```json
{ "id": "…", "conversationId": "…", "seq": 12, "senderId": "…",
  "content": "base64 MLS PublicMessage / Welcome / Commit", "createdAt": "…" }
```

The server validates envelope size, base64 shape, and conversation membership.
It does not parse, decode, or attempt to authenticate `content`, and it cannot:
MLS authentication is bound to the sender's leaf credential, which the server
never holds.

### Phase 2a landed (2026-10-21): ordered opaque delivery

An encrypted direct conversation is a pair of clients plus a sequencer. The
transport half is in `backend/src/messages/` and `backend/src/chat/chat.gateway.ts`:

| Surface | Effect |
|---------|--------|
| `POST /api/messages/e2ee/direct` | opt a direct chat into E2EE; idempotent, and one-way |
| `GET /api/messages/e2ee/direct/:userId` | read-only `{conversationId, e2ee}`; never creates or flips anything |
| `GET /api/messages/:conversationId/envelopes?afterSeq=&take=` | catch-up stream, oldest first, bounded page |
| `e2ee:append` (socket) | store one blob at the next `seq`, then broadcast it to the participants |
| `e2ee:read` (socket) | move the caller's own high-water mark forward; `{ok, moved}` |
| `e2ee:envelope` (socket event) | the stored envelope, delivered in `seq` order |

Properties asserted by `backend/test/security.e2e.cjs` (32/32):

- **Order is the contract.** MLS refuses a ratchet generation it has not seen,
  so sequence assignment and broadcast happen inside one per-conversation
  critical section: an in-process queue plus a transaction-scoped
  `pg_advisory_xact_lock(hashtext(conversationId))`, with
  `@@unique([conversationId, seq])` as the backstop. Twelve concurrent appends
  from two senders produce 1..12 with no gap and arrive ascending.
- **`seq` is per conversation.** A second encrypted chat starts at 1; appending
  to one never touches another, so the stream is not a cross-conversation counter.
- **Plaintext has no path in.** `message:send` into an `e2ee` conversation is
  refused on both the conversation-id and the peer-id routes; a flagged group
  refuses envelopes *and* plaintext, which is why only Phase 3 may set the flag.
- **Ciphertext is never re-labelled as content.** Envelopes live in their own
  table and are never returned by the plaintext history endpoints.
- **Membership is checked before state.** An outsider appending to a guessed
  conversation id gets "you are not a member", never a hint about whether that
  chat is encrypted.
- **Read state is one forward-only mark** (`ConversationParticipant.e2eeReadSeq`)
  per participant, not a row per message: the server cannot tell which
  ciphertexts a client has read, and unread is "peer envelopes above my mark".
  A replayed or nonsense mark cannot rewind it.

### New/changed tables

Landed: `devices`, `key_packages` (§4), `e2ee_envelopes`, `Conversation.e2ee`,
`ConversationParticipant.e2eeReadSeq`.

Still proposed, deliberately not built:

- ~~`one_time_prekeys`~~ / per-recipient `message_envelopes`: superseded by MLS,
  where one ciphertext serves the group and `KeyPackage` pooling covers the
  X3DH-equivalent role. The single `e2ee_envelopes` stream replaces them.
- `conversations.encryptionMode` as an enum plus `e2eeStartedAt`: a boolean is
  enough while one-way opt-in is the only mode change; revisit if a conversation
  ever needs a recorded start time.

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
   `ts-mls` with a pure-JS provider, but mobile was blocked until either a
   pure-JS HPKE suite was substituted for `@hpke/core`'s WebCrypto KEM/KDF/AEAD
   or mobile moved to development builds with a native WebCrypto module. The
   first option was resolved the same day (§3.6): the gate is **passed on web and
   on the simulated mobile runtime**, with a device run still owed inside
   Phase 2. The recommendation in §3.4 is superseded: MLS, not Signal, is the
   protocol OpenBridge uses. No server changes.
2. **Phase 1 — key infrastructure.** *Landed on 2026-10-21 (§4, "Phase 1
   landed").* Device registration, KeyPackage upload and atomic consumption,
   public bundle API, device list, revocation. No encryption of content yet —
   no client uses these endpoints, so messages are still plaintext.
3. **Phase 2 — direct E2EE on web and mobile.** New direct conversations are
   opt-in E2EE. Plaintext history stays labeled "sent before encryption".
   Unsupported clients cannot send into an E2EE conversation; the UI explains
   why. *The server half landed on 2026-10-21 (§6, "Phase 2a landed"): the
   opt-in flag, the ordered opaque envelope stream, the catch-up read, the
   forward-only read mark, and the refusal of plaintext inside an encrypted
   chat.* **No client encrypts anything yet**, so every conversation in
   production is still plaintext and §11 is the accurate statement of behavior.
   What remains is the client: MLS identity + KeyPackage pool in the browser and
   in Expo, a two-member group built from a claimed bundle, and decrypt-into-local-cache.
4. **Phase 3 — groups.** MLS already models a group, so this is commit/welcome
   routing through the ordered delivery service, rekey on membership change,
   removal semantics (a removed leaf cannot open the new epoch), and per-device
   leaves for multi-device.
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

1. ~~libsignal WASM artifact~~ — moot: libsignal failed the gate (§3.5) and MLS
   is the protocol.
2. Which React Native integration path is viable for Expo? — *Answered by
   §3.6: neither WASM nor WebCrypto exists in Hermes, and a pure-JS provider
   built from `hpke` + `@panva/hpke-noble` runs the whole lifecycle with
   `crypto.subtle` trapped, so Expo Go stays supported and no native module is
   needed. Device verification is still owed.*
3. Is E2EE opt-in per conversation, or default-on for new direct chats once all
   active devices support it?
4. ~~Key backup/recovery~~ — decided 2026-10-21: **no server escrow and no
   recovery path at any access level** (§4). Losing every device loses the
   history; the UI must say so. A user-initiated, passphrase-encrypted export is
   the only permitted escape hatch and is Phase 5 work.
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
- The key infrastructure (`/api/e2ee/*`) and the encrypted transport
  (`/api/messages/e2ee/direct`, `e2ee:append`) are live and tested, but no
  shipped client calls them. An `e2ee` conversation flag can today only be set
  by an API request, never from the web or mobile app, so no user-visible chat
  is encrypted.
