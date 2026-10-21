# OpenBridge End-to-End Encryption — Design Proposal

Status: **Phase 3 landed on web — direct chats and groups explicitly created as
encrypted are E2EE there; mobile holds no keys and locks those chats instead of
sending plaintext into them**
Last updated: 2026-10-21

OpenBridge stores plaintext for every conversation that is not marked encrypted
(see `docs/SECURITY.md`). A direct chat opened from the web app, and a group
created with the web client's encryption option, carry only opaque MLS
envelopes: the server cannot read their text, attachment bytes or attachment
names. The mobile client has no key storage and no MLS stack, so it cannot read
those conversations; it shows a lock and refuses to send rather than pretending.
The crypto-adjacent code is `shared/e2ee/provider.js`, interface glue for a
maintained MLS library covered by the gate tests in the same folder; it
implements no primitive. Nothing here should be read as a claim that every
conversation is encrypted today.


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
| Message storage | `messages.text` and `messages.fileUrl` in plaintext, except encrypted conversations, which write only opaque `e2ee_envelopes` rows |
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

### Phase 2b landed (2026-10-21): the web client holds the keys

The client half of a direct conversation is in `shared/e2ee/` (protocol, no
browser APIs) plus `src/services/e2ee.js` (IndexedDB, socket, one client per
tab) and `src/hooks/useChat.js` (what a conversation this device can carry).
`backend/test/e2ee-client.e2e.cjs` (6/6) runs that same core against the real
server with real MLS, and the flow was then driven in a browser across three Vite
origins (5173/5174/5175), one account per origin, so per-origin key isolation
was exercised rather than assumed. Those checks are DOM assertions and Prisma
queries: the environment reported `NATIVE_BROWSER_VIEWPORT_UNAVAILABLE` and
**no screenshot was captured**, so the visual states below still need a review
pass.

- **A signed-in device is an invitable device.** Registering and pooling
  KeyPackages happens at sign-in (`App.jsx`), not at first use. A device that
  only registers when its user opens a chat cannot be invited into the first
  conversation somebody else starts.
- **Keys live in IndexedDB under a per-account database name
  (`openbridge-e2ee-<userId>`)** so one browser tab signed in as somebody else
  cannot read another account's records. Signing out closes the client and the
  envelope socket but never erases the store: the same browser is the same
  device, and dropping its keys would make every conversation it joined
  unreadable for good. Forgetting keys is a deliberate, unimplemented action
  (§10).
- **Negotiation is lazy and read-only.** Opening a chat only probes
  `GET /api/messages/e2ee/direct/:userId`; the MLS group — and with it the
  server's one-way `e2ee` flag — is created by the first send. A chat is never
  flipped to envelope-only on the strength of a page view.
- **Peer capability is checked before the server is told.** `openDirect` claims
  the peer's KeyPackages *first* and stops with `no-keys` if there is nothing to
  invite, so an account whose devices hold no key material can still be
  messaged in plaintext. Claiming first is what keeps that true: the flag flips
  only once a group exists that somebody can decrypt. The header then says
  «بدون رمزنگاری» with the reason instead of silently pretending otherwise.
- **The Welcome is envelope one and the joiner needs nothing else**
  (`ratchetTreeExtension: true`), which is what lets a device that was offline
  when the chat started read it later. Every active device of the peer — and of
  the sender — is added in the same commit.
- **Delivery is ordered per conversation, and a stream that cannot continue says
  so.** `receive`/`catchUp` never throw at the caller: a gap, an unreadable blob
  or an unknown sender is recorded on the conversation (`error`) and the UI
  refuses to send into it. On reconnect every open conversation is walked
  (`catchUpAll`), not only the visible one, because ratchets are per conversation.
- **Own traffic is recognised by envelope id, not by account.** A device keeps
  the ids it submitted; an event carrying one of them advances the mark without
  being decrypted. Matching on the account instead would make a second device of
  the same user unable to read the chat.
- **A Welcome is consumed at the moment of joining** (`markRead` right after the
  join), because it is not a message anybody can read and would otherwise sit in
  the unread badge as if it were one.
- **Attachments are encrypted on the sender's device; reactions are not offered.**
  A file or picture in an encrypted direct chat is AES-256-GCM sealed in the
  browser before any byte is uploaded, and the key rides inside the MLS payload
  (§6, Attachments). Reactions stay hidden on decrypted bubbles: the server
  cannot see a message id it never received, so there is nothing to react to.
- **Search is local.** The header search filters this device's decrypted cache,
  and its placeholder says so («جستجو در پیام‌های این دستگاه»), because the
  server holds nothing searchable.
- **Read receipts ride on the same mark.** `e2ee:read` moves the participant
  high-water mark and the gateway broadcasts `message:read`, so a delivered
  encrypted message shows "خوانده شد" — a conversation-level fact, not proof
  about individual messages.
- **What the live run proved and what it did not.** Proved in the browser: two
  origins exchanging ciphertext, an offline origin catching up in `seq` order,
  badges and receipts following the marks, the divider appearing once per side,
  and the fallback when the peer has no keys. Not proved: how any of it *looks*.
  `take_screenshot` failed with `NATIVE_BROWSER_VIEWPORT_UNAVAILABLE` in this
  environment, so no encrypted state has had visual QA at the documented
  viewports, and none is claimed here.
- **Phase 4 was proved the same way, in both directions.** A web tab and a Node
  peer running the same shared core exchanged an image each: the peer fetched the
  blob through its signed URL and got the sender's original bytes exactly
  (`bytesMatchOriginal`, 1234 B), the stored ciphertext did not begin with the
  PNG magic, and the response was `application/octet-stream` + `nosniff` +
  `attachment`. The browser then opened the peer's file, authenticated it, and
  produced a blob URL that decoded to 300×240. Because this embedded view never
  paints, the viewport-gated open had to be driven by stubbing
  `IntersectionObserver` and by calling `openAttachment` directly — so the
  decrypt-and-render path is measured, not seen, and the lazy-open behaviour in a
  real painted browser window is still unverified.

### Phase 3 landed (2026-10-21): encrypted groups

A group created with the web client's encryption option is ciphertext from its
first byte. The client builds the MLS group first, claims one KeyPackage per
active device of every selected member (and of its own other devices), and only
then calls `POST /api/messages/e2ee/group`; the Welcome is envelope one. The
server is never asked to create a group whose Welcome the client already knows
will not fit one envelope, so a group never exists in a state nobody can open.

| Surface | Effect |
|---------|--------|
| `POST /api/messages/e2ee/group` | create a group whose `e2ee` flag is set in the same insert as its participants |
| `GET /api/messages/e2ee/group/:conversationId` | read-only `{conversationId, e2ee}` scoped to members; an outsider gets the same answer as an unknown id |
| `GET /api/messages/groups` | carries `e2ee`; unread for an encrypted group counts envelopes above the caller's high-water mark |

Properties the tests assert rather than assume:

- **Every device is invited once.** The Welcome carries the ratchet tree
  (`ratchetTreeExtension`), so a member that was offline when the group was
  created joins later from that one envelope. A member with no pooled
  KeyPackage is refused with `no-keys` *before* the conversation exists; the
  server's neutral 404 from the claim endpoint is translated to that reason.
- **The Welcome is not an unread message.** Joining consumes it with a read
  mark at its own sequence number; only envelopes after the Welcome count.
- **Membership is frozen.** Adding or removing a participant of an encrypted
  group answers `400` until a rekey/commit path exists. A database-only
  membership change would leave the new member unable to decrypt and the
  removed member still holding the old epoch.
- **Size has two bounds.** `E2EE_MAX_GROUP_MEMBERS` (16) caps the member count,
  and the client refuses a Welcome above `E2EE_MAX_ENVELOPE_CHARS` (16 384
  characters) with `welcome-too-large` before it creates anything. Measured
  Welcome size at the gate was about 470 base64 characters per device plus
  framing.
- **The plaintext path stays closed.** `message:send` into a flagged group is
  refused, and attachments in an encrypted group go through the encrypted blob
  endpoint, so their names, types and bytes stay inside ciphertext. Reactions
  are hidden because an encrypted message has no server row to carry them.
- **The probe is inert and member-scoped.** Opening a group never creates or
  flips anything, and a non-member cannot use it to learn whether a guessed
  conversation id is encrypted.

Still missing from groups: membership add/remove with a key rotation, history
sharing for a device that joins after creation, and any client that is not the
web app. Mobile shows a locked conversation instead of attempting one.

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

Landed as Phase 4 on web (`shared/e2ee/attachments.js`, `src/services/attachments.js`,
`backend/src/uploads/uploads.controller.ts`, `EncryptedBlob`):

- One random AES-256-GCM key and one random 96-bit nonce per file, from the
  platform's own authenticated encryption (WebCrypto in the browser, `node:crypto`
  in Node, tag appended so both read the same layout). Only ciphertext is
  uploaded; the plaintext bytes never leave the device and never get a URL.
- The descriptor — blob id, name, MIME, size, key, nonce — is a small JSON object
  that travels as the MLS message payload. So a file's name, type and size exist
  only inside ciphertext: the server stores `enc-<uuid>.bin` and a row with no
  filename, no MIME and no hash of the plaintext.
- Ciphertext has to travel as a blob because an envelope is capped at
  `E2EE_MAX_ENVELOPE_CHARS` (16384 chars, ≈12 KB): a photo inside an envelope
  would be refused by the transport, and a per-recipient ciphertext would be
  stored once per member. One opaque blob plus one small descriptor keeps both
  bounds honest.
- Access is authorized twice, because neither half is enough: the signed URL is
  issued only after a membership check on the blob's conversation, and the bytes
  are served only to a request carrying a valid unexpired HMAC signature.
  Serving is `application/octet-stream` + `nosniff` + `Content-Disposition:
  attachment`, so a browser cannot act on ciphertext it cannot read.
- The server does not and cannot scan these bytes. ClamAV, MIME sniffing, magic
  checks and image recompression all run on the plaintext path and are all
  deliberately absent here — checking opaque ciphertext would be theatre, and
  a "scanned" label on it would be a false claim. The upload rate limit and the
  size cap still apply.
- A decrypted file exists only as a refcounted object URL inside the tab: it is
  opened when the bubble nears the viewport, revoked when the last view of it
  goes away, and a GCM authentication failure means no URL is ever created —
  there is no path that renders changed bytes.

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
   chat. The web client half landed the same day (§6, "Phase 2b landed"): the
   browser now registers a device, pools KeyPackages, builds the two-member MLS
   group and encrypts for real.* **Direct chats opened from the web app are
   therefore end-to-end encrypted**; §11 states the exact remaining gaps.
   What remains is mobile: an Expo client that holds keys, joins the same group
   and refuses to send plaintext into an encrypted chat.
4. **Phase 3 — groups.** *Landed on web on 2026-10-21 (§6, "Phase 3
   landed").* A group created with the web encryption option is an MLS group
   from its first envelope; every member's devices are invited in one Welcome,
   unread follows the envelope high-water mark, and membership changes are
   refused until a commit/rekey path exists. Still owed: that rekey path,
   history sharing for a device that joins later, and any client other than the
   web app.
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
   active devices support it? — *Answered in practice by Phase 2b, in the
   "default-on" direction: a web client encrypts a direct chat whenever the peer
   has invitable keys, with no toggle, and falls back to plaintext with a visible
   reason when it cannot. Whether that stays automatic once mobile devices
   exist — or becomes opt-in until every platform speaks MLS — is still open,
   and the mobile lock-out in §11 is the cost of the automatic choice.*
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

As of 2026-10-21, after Phase 3 (§6). This is the statement the UI and support
answers must match — nothing else may describe a chat as "encrypted".

**What is encrypted now**

- A **direct conversation opened from the web app between two web devices** is
  end-to-end encrypted. The server stores only opaque `e2ee_envelopes` rows for
  it, and cannot read the text at any access level: no key material leaves the
  browser, so there is no escrow, no server-side search, preview, moderation or
  push payload that could contain message content.
- A **group created with the web client's encryption option** is end-to-end
  encrypted from its first envelope, for every account and device that was
  invited at creation time. The Welcome is envelope one; the group name and
  membership remain server-visible metadata. Adding or removing a member is
  refused until the rekey path exists, so an encrypted group's membership is
  fixed at creation.
- **Files and pictures in an encrypted conversation are encrypted too**, on the
  sender's device, before a single byte is uploaded. The server holds
  `enc-<uuid>.bin` and a row with no filename, no MIME type and no plaintext
  hash; it does not scan them and cannot. The transition is visible on both
  sides: plaintext messages sent before the flag stay in the transcript labeled
  as pre-encryption history, and the encrypted stream continues from there.
- **Every conversation opens with one line that states which of the cases below
  this device is in** (`MessageList.jsx` → `e2eeNotice`). It is a claim about this
  device, so it has distinct sentences and never one stretched across them:
  encrypted direct chat, encrypted group, a direct chat that will be encrypted
  by its first message, a chat whose encryption is still being resolved, a chat
  this device cannot decrypt, and a plaintext group. The composer's paperclip
  and the header chip follow the same state, so no control can imply a
  protection the notice has just denied.

**What is not encrypted**

- **Groups created without the encryption option**, on every client. They use
  the plaintext path and the server reads their content — including group
  attachments, which still go through the old upload with their name and MIME
  type visible.
- **Mobile.** No Expo client holds keys yet, so a mobile device can neither read
  nor write an encrypted direct chat or group.
- **Existing direct conversations that were never opened from the web app after
  Phase 2b landed.** Encryption is negotiated lazily when a web client opens or
  sends in a chat, so a chat nobody has opened since the rollout is still
  plaintext.
- **History written before a conversation was encrypted** — unrecoverable by
  design (§3 constraint 4).

**Interim risk introduced by Phase 2b, narrowed by Phase 3**

A web user who encrypts a chat with a mobile user locks that conversation to
envelopes, and the backend refuses the mobile client's plaintext sends with a
`400`. The phone now says why instead of failing silently: the chat list marks
the row with a lock, the chat screen opens in a locked state with the sentence
"readable and writable only in the web version", and the composer cannot send.
If that chat becomes encrypted while it is already open, the next envelope flips
the screen to locked. The cost is unchanged — the phone still cannot read the
conversation until it ships an MLS client.

**Known limitations of the current web implementation**

- An encrypted group's membership cannot be changed: adding or removing a member
  is refused until an MLS commit/rekey path exists. A group is capped at
  `E2EE_MAX_GROUP_MEMBERS` (16) so its Welcome fits one envelope.
- A device registered after a conversation started cannot decrypt that
  conversation's earlier envelopes: MLS joins the group from a Welcome, and a
  Welcome addresses the devices that existed at creation time. There is no
  history sharing between devices yet.
- No safety numbers / no out-of-band key verification: key adoption is TOFU, so
  a server substituted at first contact would not be detected. Phase 5.
- Reactions are still unavailable inside an encrypted conversation, not
  encrypted: they live in the server's message table and an encrypted message
  has no row there. The affordance is hidden rather than faked.
- An attachment survives only as long as its blob does. There is no pruning or
  export policy for `encrypted_blobs` either, and no server-side malware check —
  the bytes are unreadable to the server by design, so nothing scans them.
- A decrypted file is held in the tab as an object URL, not written to disk, and
  is not cached across reloads: a reopened conversation re-fetches and
  re-authenticates the bytes.
- Search in an encrypted chat covers only this device's local cache, and the UI
  says so.
- Envelope retention is undefined: the server keeps ciphertext forever and there
  is no pruning or export policy yet.
- Losing every device loses the history. Recovery is deliberately absent (§4).
