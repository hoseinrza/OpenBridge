# OpenBridge Security Model

Last updated: 2026-10-25

## Content encryption: a server-held key

OpenBridge encrypts message content **at rest**, not end to end. The API itself
seals message text and every uploaded file with a key derived from one
server-held master secret, `CONTENT_KEY`, and opens it again for an authorized
member of the conversation on read. The server holds that secret, so **the
server can read all message content.** That is the deliberate cost of the
architecture chosen on 2026-10-24 and recorded in
`docs/superpowers/specs/2026-10-24-server-key-multidevice-design.md`: every
device signed into an account can read every conversation of that account,
including history written before the device existed.

- `backend/src/common/content-crypto.ts` derives one AES-256-GCM key per
  conversation (`HKDF-SHA256(CONTENT_KEY, salt "conversation:<id>", info
  "openbridge-content-v1")`) and one per file (salt `"file:<stored filename>"`,
  info `"openbridge-file-v1"`). The conversation id and the generated filename
  are salts, not secrets; no key is stored per row.
- Text lands in `messages.text` as `obx1.<iv>.<tag>.<ciphertext>` (base64url).
  Files land in `uploads/` as the magic `OBX1` + a 12-byte IV + a 16-byte tag +
  the ciphertext. A value without the marker predates sealing and is served as
  it is, so old rows and old files stay readable.
- Text is sealed on send and on edit; every read path (history, quotes, chat
  previews, the shared-links scan) opens it. The link search can no longer be a
  SQL predicate for that reason — rows are decrypted in batches and scanned in
  the API.
- `CONTENT_KEY` is required and must base64-decode, canonically, to exactly 32
  bytes. A missing, short or malformed value stops the process at boot rather
  than letting it write plaintext. It must never be rotated: every derived key
  changes with it, and content sealed under the old value cannot be opened again.
- A database dump, a backup or a storage volume obtained without `CONTENT_KEY`
  still does not yield the content. The protection is against theft of the
  storage, not against the application.

Message type, `fileName`, `fileSize`, `durationMs`, sender, timestamps, the
file's stored name and the signed download URL stay plaintext columns or bytes.
Group name and membership, conversation participants, timing and message sizes
remain server-visible metadata, exactly as before.

**The legacy MLS tail.** Conversations encrypted under the earlier `ts-mls`
scheme keep their content in `e2ee_envelopes` rows and in client-encrypted
`enc-<uuid>.bin` blobs that the server cannot open. Only a web device that still
holds that conversation's MLS state can decrypt them, and when it opens the chat
it hands the plaintext back once: `POST
/api/messages/:conversationId/legacy-import` takes up to
`LEGACY_IMPORT_BATCH` items per request and re-seals them as ordinary rows, and
`GET /api/messages/:conversationId/legacy-status` reports `total`, `imported`,
`pending`, `seqs` and `nextAfterSeq`. The row's author and time come from the
envelope, never from the caller, and `Message.legacyEnvelopeId` is unique, so a
retry stores nothing twice. A legacy message imported with an attachment keeps
the sender's descriptor — blob id, key and nonce — in `Message.legacyAttachment`,
so after that import the server holds those file keys too and a reader decrypts
the blob from the message rather than from MLS.

Until an envelope is imported it is readable on no device of this build except a
web device holding the MLS state; `MessageList.jsx` reports how many are still
pending instead of implying they are lost. `shared/e2ee` exists only for this
hand-back: no new chat message travels over MLS, although a keyed web device
still appends `CONTROL` envelopes (`e2ee:append`) to edit or delete a legacy row
that was never imported.

`docs/engineering/E2EE_DESIGN.md` keeps the MLS design as a historical record;
its §12 states what replaced it. No custom cryptography was ever introduced for
MLS — `shared/e2ee/provider.js` is glue over `ts-mls`, `hpke` and
`@panva/hpke-noble`, and the library gate still runs as `npm run test:e2ee`.

## Calls

- **Media in a conversation flagged `e2ee` is encrypted with a key the API
  issues.** At call creation the service reads that flag and generates one key
  per call with `randomBytes(32).toString('base64')`. It lives only on the
  in-memory `CallRecord.mediaKey`: never persisted, never logged, absent from
  every `CallView` and every socket event, and returned only by `POST
  /api/calls/:callId/token` to a request that says `client: 'web'`, in the body
  (`url`, `token`, `expiresIn`, `callId`, `room`, `e2ee`, `mediaKey`). Every web
  participant of one call receives the same bytes.
- The web client hands `mediaKey` to LiveKit's `ExternalE2EEKeyProvider` with an
  `E2EEWorker`; LiveKit derives frame keys locally, so frames are encrypted
  before they leave the browser and the SFU relays only ciphertext RTP.
- **The API holds the call key, so it can decrypt call media by design** — the
  same trade as message content. `keyFingerprint` (a SHA-256 of an MLS-derived
  key, compared at invite, accept and token) is gone from the requests, the call
  record and view, the socket events and the DTO; there is no MLS exporter, no
  epoch and no comparison of any kind.
- **Encrypted calls fail closed.** Web refuses to continue when the invite ack
  does not report `e2ee: true`, refuses to join when the token's `e2ee`
  disagrees with the ring, and refuses to join when `mediaKey` is missing or
  empty; a failing `setE2EEEnabled(true)` ends the call. An encrypted call whose
  record has no key is answered 503 by the token endpoint, never with an
  unencrypted token. Mobile is answered 403 for a token on an encrypted call,
  and the mobile client rejects an encrypted ring before asking for one. Nothing
  silently downgrades.
- **The lock indicator is earned, not assumed.** It shows only once
  `room.isE2EEEnabled` is true and every remote participant reports
  `isEncrypted`. If that is not reached within 25 seconds (45 for a group) the
  call ends; so does a LiveKit `EncryptionError`, or a participant turning
  encryption off after verification.
- **A call in a conversation that is not flagged `e2ee` gets no key and no frame
  encryption.** It relies on WebRTC DTLS-SRTP in transit, the SFU sees its media,
  and the clients label it «بدون رمزنگاری رسانه» on web and «بدون رمزنگاری» on
  mobile.
- **Mobile cannot join an encrypted call.** The Expo build wires no LiveKit E2EE
  key provider, so it has no way to encrypt or decrypt frames; the refusal is
  about missing encrypted media, not a missing key.
- **Room authorization is server-side.** A room token is minted only for a
  participant of an existing direct conversation or a current group member, only
  after the call reached an answerable state, and only with minimal grants
  (`roomJoin`, `room`, `canPublish`, `canSubscribe`, `canUpdateOwnMetadata:
  false`; no data publishing and no room admin). The LiveKit API secret never
  leaves the API process.
- **Session revocation applies to calls.** Socket operations that grant access
  re-check the session row; the token endpoint uses the normal JWT guard; a
  30-second sweep ends calls whose participants lost every active session.
  Ending a call deletes the room when room administration is configured.
- **Group calls** use the same server authorization and one call key for every
  web participant; there is no epoch and no per-device derivation. A group call
  is capped at `CALL_MAX_GROUP_PARTICIPANTS` (default 20) and an encrypted group
  call at LiveKit's E2EE ceiling of 20. Mobile cannot join an encrypted group
  call.
- **Not persisted:** call history, durations and missed-call badges are not in
  PostgreSQL. Active calls are in-process, so the media key disappears when the
  call ends or the process restarts — and a restart ends the call anyway. The
  next boot deletes leftover `ob_*` rooms. The displayed duration is the client timer.

## Confidentiality model

| Data                         | Where it lives                  | Who can read it                          |
|------------------------------|---------------------------------|------------------------------------------|
| Sealed message text          | PostgreSQL `messages.text` (`obx1.…`) | The API process (it holds `CONTENT_KEY`) and any signed-in device of a conversation member |
| Message text written before sealing | PostgreSQL `messages.text`, no `obx1` prefix | Server operators and DB access |
| Sealed attachment bytes      | API server `uploads/`, `OBX1` header | The API process, through the signed download endpoint; not a disk copy without `CONTENT_KEY` |
| Attachment bytes written before sealing | API server `uploads/` directory | Server operators / disk access |
| Legacy MLS envelopes not yet imported | PostgreSQL `e2ee_envelopes` | Only a web device holding that conversation's MLS state |
| Legacy attachment descriptor, after import | PostgreSQL `messages.legacyAttachment` (blob id, key, nonce) | Server operators and DB access — the server holds those file keys now |
| Legacy client-encrypted blob | API server `uploads/` as `enc-<uuid>.bin`, table `encrypted_blobs` | A device holding the MLS descriptor; after an import, the API too |
| Group name, membership, timestamps, sizes | PostgreSQL         | Server operators and DB access           |
| Usernames, display names     | PostgreSQL                      | Any authenticated user (`/api/users`)    |
| JWTs                         | Browser localStorage / SecureStore (mobile) | User's device; bearer of the session |
| Per-call media key           | API process memory (`CallRecord.mediaKey`), plus the web clients it is returned to | Server operators; every web participant of that call |
| MLS keys and client state    | Browser IndexedDB (`openbridge-e2ee-<userId>`) | That browser; needed to open un-imported legacy history |
| LiveKit room token           | Client memory; short-lived      | That participant; room-scoped grants     |

The API never returns password hashes (there are no passwords). User search
exposes username, display name, avatar, bio, status, and creation date to any
authenticated user.

## Authentication

- There are no passwords. Sign-in is a phone number plus a 6-digit one-time
  code, returned in the response only outside production (`OTP_TEST_MODE`)
  until an SMS provider is integrated. Codes are stored only as an HMAC-SHA256
  digest keyed with `JWT_SECRET`, compared in constant time, single-use, expire
  after `OTP_TTL_SECONDS`, and are locked after `OTP_MAX_ATTEMPTS` wrong tries.
- A new number receives a short-lived HS256 signup token (`pur: 'signup'`) and
  finishes on `POST /auth/signup` with a unique username and name parts. A
  signup token is not an access token, and vice versa.
- Access JWTs are HS256, signed with `JWT_SECRET`, expire after
  `JWT_EXPIRES_IN`, and carry both the user id (`sub`) and the server-side
  session id (`sid`). `JWT_SECRET` is required; the API refuses to start without
  it and, in production, requires at least 32 characters.
- HTTP uses `Authorization: Bearer <token>`; Socket.IO uses the same token in
  the handshake `auth.token`.
- The user is loaded from the database on every authenticated request, so a user
  removed there loses access immediately, and a token whose session row is
  revoked is rejected even before EXP.
- OTP requests are throttled per client IP and per phone number with 429 and
  `Retry-After`. `TRUST_PROXY` must be set behind a reverse proxy so the real
  client IP is used.
- Every sign-in creates a server-side `Session` row; logout and device
  revocation stamp it, which invalidates the access token immediately instead
  of waiting for JWT expiry.
- Refresh tokens are 48 random bytes, stored only as SHA-256 hashes, rotate on
  every use, and expire after `REFRESH_TOKEN_TTL_DAYS` (default 30). Clients
  refresh transparently on a 401.
- `GET /api/auth/sessions` lists every active session of the account (IP, user
  agent, created/last-used times, `current`, `online`) plus `canRevokeOthers`
  and `revokeCooldownDays`; `DELETE /api/auth/sessions/:id` revokes any session
  of that account, refuses with 403 while the caller session is younger than
  `SESSION_REVOKE_COOLDOWN_DAYS` (default 30) unless it is signing itself out,
  and disconnects the target's sockets. `POST /api/auth/logout` revokes the
  current one. `GET /api/auth/security-events` lists the account's logins newer
  than this session's mark, `POST /api/auth/security-events/ack` moves the mark,
  and a new login emits `session:new` to the other devices.

## Authorization

- Conversation history, group metadata, membership changes, read receipts,
  typing, reactions, and message sending all verify conversation membership on
  the server.
- Reactions are authorized against the message's real conversation, not a
  client-supplied conversation ID.
- Group roles (`OWNER`, `ADMIN`, `MEMBER`) are stored server-side; clients
  cannot elevate themselves.
- Sender identity is derived from the authenticated socket/HTTP context; client
  supplied user IDs are never trusted as the sender.
- A user cannot create a direct conversation with themselves or a nonexistent user.
- Unsealing is not a separate privilege: every path that opens message text or
  attachment bytes (history, the socket broadcast, the shared-links scan, the
  legacy-import and legacy-status endpoints) verifies conversation membership
  first. The signed download route is the exception — it is authorized when the
  URL is issued, not per request.

## WebSocket hardening

- Every connection validates the JWT signature/algorithm and that its
  server-side session is still active.
- Per-socket rate limits over a 10-second window: message send 30, message edit
  and delete 20 each, MLS envelope append 30 and MLS read marker 20, typing 20,
  read receipts 20, reactions 20; call invite 6, group start 4, accept, reject
  and cancel 20 each, call end 30.
- Incoming packets are capped at 256 KB.
- Message payloads are validated (allowed types, 4000-character text limit,
  local `/uploads/...` attachment URLs only, 10 MB attachment size limit).
- Caller display metadata for call invitations is loaded from the database, not
  accepted from the client.
- Presence tracks every socket per user, so closing one device does not mark
  the account offline while another device is connected.

## File uploads and downloads

- Uploads require authentication and are limited to 60 per user per hour, 10 MB each.
- A MIME/extension allowlist rejects HTML, SVG, scripts, and executables.
- Image files are checked against magic bytes, not just the declared MIME type.
- Optional ClamAV scanning (`UPLOAD_SCAN_ENABLED=true`, `CLAMAV_HOST`,
  `CLAMAV_PORT`) streams each file to clamd over INSTREAM before the upload is
  accepted. Scan errors fail closed with 503, and infected files are deleted.
  Scanning is off by default because it requires a running clamd instance.
- Stored filenames are server-generated UUIDs; the original name is metadata only.
- Sealing is the last step of an upload, after the type check and the scan, so
  the scanner still sees plaintext bytes. The sealed file is written beside the
  original and renamed into position, so an interrupted seal cannot leave a
  half-encrypted attachment behind; a failed seal deletes the file.
- The uploads directory is no longer served statically.
- API responses issue expiring HMAC-signed URLs (default 7 days,
  `FILE_URL_TTL_SECONDS`); the download endpoint verifies the signature, expiry,
  and filename before serving. The bytes are opened and decrypted in memory, and
  one byte range is served (`206` + `Content-Range`) so a recording can seek; a
  multiple-range request gets the whole body. Responses include
  `X-Content-Type-Options: nosniff`; images and audio are `inline`, everything
  else is an attachment. A file that fails its GCM tag answers like a missing
  one (404).
- A legacy client-encrypted blob's signed URL is handed out only by `POST
  /uploads/encrypted` and `GET /uploads/encrypted/:id/url`, each of which checks
  membership of the blob's conversation; `GET /uploads/encrypted/:filename` then
  serves it as `application/octet-stream` + `nosniff` + `attachment`. A message
  row can never carry such a URL.
- Filenames are validated against path traversal.

## Transport and origins

- CORS is an explicit allowlist (`CORS_ORIGINS`), applied to both HTTP and
  Socket.IO. Native clients and same-origin requests send no `Origin` header and
  are allowed. In production, no cross-origin browser access is allowed unless
  configured. In development, localhost and private-LAN origins are allowed.
- Production deployments must terminate TLS at the reverse proxy or hosting
  platform. The bundled nginx config listens on HTTP only.

## Threat model

| Adversary                         | Outcome with the current design |
|-----------------------------------|---------------------------------|
| Passive network observer          | Cannot read traffic if TLS is enabled. |
| Malicious authenticated client    | Cannot read/join conversations they are not part of; cannot forge senders or roles; cannot upload active content; cannot react to foreign messages. |
| Compromised server / DB           | Reads all message content and every file: the API unseals with `CONTENT_KEY` for any authorized member, so whoever runs the process holds the key to every conversation of every account. Group names, membership, participants, timing and sizes were always readable. This is the accepted cost of the design, not a break in it. |
| Stolen database dump, backup or volume | Sealed rows (`obx1.…`) and sealed files (`OBX1`) stay ciphertext without `CONTENT_KEY`; a dump paired with the deployment's environment is plaintext. Rows and files written before sealing have no marker and are readable either way. |
| Stolen unlocked device            | Has the active session until it is revoked or expires, and with it every conversation of the account — including history written before this device existed, since one key covers the account. The device holds no message keys of its own, but a web device still keeps MLS state in IndexedDB (`openbridge-e2ee-<userId>`) and, with it, the un-imported legacy history. The owner can list and revoke sessions from another signed-in device. |
| XSS or malicious same-origin JS   | Reads everything the session can read and takes the token from `localStorage`, then acts as the user; the page can also drive the legacy import and use the MLS state in IndexedDB. There are no device-held message keys to steal, because there are none, so this is not a smaller hole than the old model. |
| Removed group member             | Loses access to future messages and API events, and to the conversation's content on any later API read, since reads re-check membership. Previously issued signed attachment URLs remain valid until they expire. A conversation flagged `e2ee` cannot have members added or removed at all. |

## Known limitations

- **The server is a content reader, everywhere and always.** One `CONTENT_KEY`
  serves every conversation and every file, and no configuration moves the key
  client-side or turns sealing off. `docs/engineering/E2EE_DESIGN.md` §12 is the
  exact statement of what replaced MLS.
- **`CONTENT_KEY` has no rotation and no recovery.** Every derived key changes
  with it, so rotating it or losing it orphans everything sealed under the old
  value; there is no version column to migrate by and no escrow path. Backing
  the value up is the whole plan.
- **Nothing written before sealing is rewritten.** Rows without the `obx1.`
  marker and files without `OBX1` are served as they are, and no migration
  re-seals them.
- **Un-imported legacy history survives only in one browser.** Envelopes and
  `enc-<uuid>.bin` blobs open nowhere except on a web device holding that
  conversation's MLS state in IndexedDB, and the hand-back runs per conversation
  in `LEGACY_IMPORT_BATCH` chunks. Signing out deliberately keeps that store;
  clearing browser data discards it, and losing the last keyed device makes
  those messages unreadable for good.
- **The `e2ee` flag is one-way, and mobile follows it.** A conversation that was
  ever MLS — an encrypted group, or a direct chat that switched it on — reports
  `e2ee: true` from `GET /api/messages/e2ee/direct/:userId` and
  `/api/messages/e2ee/group/:conversationId` forever, so the phone keeps its
  composer locked even after the legacy stream is fully imported and new
  server-sealed rows are plainly readable.
- **Membership of a conversation flagged `e2ee` cannot change.** Adding or
  removing a participant still answers 400 from `assertMembershipEditable`, the
  MLS-era guard that outlived the reason for it.
- **There is no verification of anything.** No safety numbers, no fingerprints,
  no way to check the per-call media key or the server's key material: clients
  trust what the API returns. Legacy MLS key adoption was trust-on-first-use,
  and control envelopes still ride on that state.
- **The MLS surfaces are still mounted.** `/api/e2ee/devices`, the key-package
  routes, the `e2ee:append` and `e2ee:read` socket events and the
  `e2ee_envelopes` and `encrypted_blobs` tables all still answer, even though no
  new chat message goes through them. They are attack surface until removed.
- Refresh-token reuse detection is not implemented: a replayed old refresh
  token is rejected but does not automatically revoke its session. Web stores
  both tokens in `localStorage`, so XSS can exfiltrate them; mobile keeps them
  in SecureStore.
- HTTP auth throttling is in-memory and per-process, so multi-instance
  deployments would need a shared store such as Redis.
- Socket rate limiting and presence are in-memory, so they are per-process and
  reset on restart; a multi-instance deployment needs a shared store.
- Signed attachment URLs are bearer capabilities: anyone with the URL can use it
  until expiry. Authorization is enforced when the URL is issued, not on each
  download. Removed members may retain valid URLs for up to the TTL.
- Malware scanning is off unless `UPLOAD_SCAN_ENABLED=true` points at a
  reachable clamd, and it covers only the ordinary upload path: `POST
  /uploads/encrypted` skips the MIME table, the magic-byte check and the scanner
  by design, so a client-encrypted blob is stored unscanned.
- Message edit and delete are implemented; account deletion is not. Edits are
  text-only and sender-only and re-seal the replacement. `everyone` deletion is
  sender-only and nulls the row's text, file and reactions; `me` deletion records
  a per-viewer hide and leaves the row for everyone else. No route deletes an
  account or its content.
- Web lint is clean and CI covers the rest: web lint and production build, Prisma
  validate plus `nest build`, the backend e2e suite against a throwaway
  PostgreSQL (`content-crypto`, `message-encryption`, `legacy-import`,
  `upload-encryption`, `security`, `message-actions`, `e2ee-client`, `calls`,
  `content-key`), the `shared/e2ee` library gate, mobile unit tests, an Android
  emulator Maestro job, and a `docker compose` smoke test of the shipped images.
  **The Maestro job does not pass today** (every `main` run since at least
  `e148fee` is red on `2e · Mobile E2E`, 2026-10-25), so it currently proves
  nothing about on-device behavior; see
  `docs/engineering/BETA_READINESS.md` §5.2.
  CI deploys nothing; a separate `deploy.yml` redeploys the VPS over SSH only
  when the `DEPLOY_ENABLED` repository variable is `true` and a CI run that
  started from a push to `main` finished green.
