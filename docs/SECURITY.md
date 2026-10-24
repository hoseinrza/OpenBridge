# OpenBridge Security Model

Last updated: 2026-10-22

## E2EE status: web direct chats and web-created groups

OpenBridge encrypts two kinds of conversation end to end, both from the web
client:

- a **direct chat** opened from the web app between two web devices, which is
  negotiated into MLS on its first message, and
- a **group** created with the web client's encryption option, which is MLS
  from its first envelope.

For these, message text, attachment bytes, attachment names and MIME types are
readable only on the devices that hold the MLS keys. The server stores opaque
`e2ee_envelopes` rows and opaque `enc-<uuid>.bin` blobs; it never receives a
private key or client state, and there is no escrow or recovery path at any
access level. Group name and membership, conversation participants, timing and
message sizes remain server-visible metadata.

Everything else is still plaintext on the server:

- plaintext direct chats that no web client has opened since the E2EE rollout,
- groups created without the encryption option,
- all mobile clients, which hold no keys; they show encrypted chats as locked
  and refuse to send plaintext into them,
- history written before a conversation was encrypted.

The authoritative behavior statement is `docs/engineering/E2EE_DESIGN.md` §11.
No custom cryptography has been introduced: `shared/e2ee/provider.js` is glue
over `ts-mls`, `hpke` and `@panva/hpke-noble`, and the library gate runs as
`npm run test:e2ee`.

## Calls

- **Web calls in an MLS conversation are end-to-end encrypted.** The media key
  is derived on each device from the conversation's MLS exporter secret and the
  call id (`MLS-Exporter(exporter_secret, "openbridge-call-v1", "call:" + callId,
  32)`). It is handed to LiveKit's key provider locally and is never sent to the
  API, Socket.IO, the SFU, a database or a log.
- The server receives and stores in memory only a SHA-256 fingerprint of that
  key. It is compared at invite, accept and token time; a mismatch (including two
  devices at different MLS epochs) refuses the call. The fingerprint is not
  persisted and is not logged.
- A call advertised as E2EE fails closed: no key means no ring; a missing or
  mismatched fingerprint rejects the accept and the token; the lock indicator
  appears only after `room.isE2EEEnabled` and every remote participant reports
  `isEncrypted`. If that is not true within 25 seconds (45 for a group), the call
  is ended.
- **Plaintext conversations can be called too, but those calls are not E2EE.**
  They rely on WebRTC DTLS-SRTP in transit and are labeled «بدون رمزنگاری
  سرتاسری» in both clients. The SFU can see their media.
- **Mobile calls are plaintext only for now.** The Expo build holds no MLS state,
  so it cannot derive the call key. It refuses an E2EE ring and the server refuses
  a mobile token for an E2EE room; it does not silently downgrade. LiveKit's RN
  E2EE key provider exists, but there is no authenticated key source on mobile
  yet.
- **Room authorization is server-side.** A room token is minted only for a
  participant of an existing direct conversation or a current group member, only
  after the call reached an answerable state, and only with minimal grants
  (`roomJoin`, `canPublish`, `canSubscribe`; no data publishing and no room
  admin). The LiveKit API secret never leaves the API process.
- **Session revocation applies to calls.** Socket operations that grant access
  re-check the session row; the token endpoint uses the normal JWT guard; a
  30-second sweep ends calls whose participants lost every active session.
  Ending a call deletes the room when room administration is configured.
- **Group calls** use the same server authorization and, for an encrypted group,
  the group's MLS exporter. Every invited web device must be at the same epoch.
  Mobile cannot join an encrypted group call.
- **Not persisted:** call history, durations and missed-call badges are not in
  PostgreSQL. Active calls are in-process; an API restart ends them and the next
  boot deletes leftover `ob_*` rooms. The displayed duration is the client timer.

## Confidentiality model

| Data                         | Where it lives                  | Who can read it                          |
|------------------------------|---------------------------------|------------------------------------------|
| Encrypted message text       | PostgreSQL `e2ee_envelopes`     | Devices holding the conversation key only |
| Plaintext message text       | PostgreSQL `messages.text`      | Server operators and DB access           |
| Encrypted attachments        | API server `encrypted_blobs/`   | Devices holding the conversation key only |
| Plaintext attachments        | API server `uploads/` directory | Server operators / disk access           |
| Group name, membership, timestamps, sizes | PostgreSQL         | Server operators and DB access           |
| Usernames, display names     | PostgreSQL                      | Any authenticated user (`/api/users`)    |
| JWTs                         | Browser localStorage / SecureStore (mobile) | User's device; bearer of the session |
| E2EE call media key          | Device memory only              | The two/few call participants            |
| Call key fingerprint         | API process memory (never DB/logs) | Server operators (a hash, not the key) |
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
- The user is loaded from the database on every authenticated request, so
  deleted accounts lose access immediately, and a token whose session row is
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
- `GET /api/auth/sessions` lists active sessions; `DELETE
  /api/auth/sessions/:id` revokes one (own sessions only); `POST
  /api/auth/logout` revokes the current one.

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

## WebSocket hardening

- Every connection validates the JWT signature/algorithm and that its
  server-side session is still active.
- Per-socket rate limits: messages 30/10s, typing 20/10s, read receipts
  20/10s, reactions 20/10s, call signaling 40/10s.
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
- The uploads directory is no longer served statically.
- API responses issue expiring HMAC-signed URLs (default 7 days,
  `FILE_URL_TTL_SECONDS`); the download endpoint verifies the signature, expiry,
  and filename before serving. Responses include `X-Content-Type-Options: nosniff`
  and non-images are sent as attachments.
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
| Compromised server / DB           | Can read plaintext conversations, metadata and all group membership. Cannot read encrypted direct chats or encrypted groups, but can see their ciphertext, routing and sizes, and can substitute keys during the TOFU window. |
| Stolen unlocked device            | Has the active session until it is revoked or expires; the owner can list and revoke sessions from another signed-in device. It also holds that device's E2EE keys. |
| XSS or malicious same-origin JS   | Can read plaintext and the token from localStorage and act as the user, and can use any E2EE keys available to the page. This is a fundamental limitation of web E2EE as well. |
| Removed group member             | For plaintext groups, loses access to future messages and API events; previously issued signed attachment URLs remain valid until they expire. Encrypted groups do not allow membership changes yet, so removal is not possible there. |

## Known limitations

- **Not every conversation is encrypted.** Plaintext direct chats that no web
  client has opened since the rollout, groups created without the encryption
  option, all mobile clients, and pre-encryption history remain readable by the
  server. `docs/engineering/E2EE_DESIGN.md` §11 is the exact statement.
- No safety numbers or out-of-band verification: key adoption is TOFU.
- There is no key escrow or recovery. Losing every device loses encrypted
  history.
- An encrypted group's membership is fixed at creation; adding or removing a
  member is refused until an MLS rekey path exists.
- Mobile holds no E2EE keys and shows encrypted conversations as locked.
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
- Malware scanning is disabled unless a clamd instance is configured; encrypted
  attachments cannot be scanned server-side by design.
- Message edit/delete and account deletion workflows are not implemented.
- Plaintext database rows and plaintext attachment files are stored unencrypted
  at rest; encrypted conversations store only ciphertext.
- Web lint is clean and CI runs lint plus the production build alongside the
  backend security suite. The CI database is ephemeral; no deployment is
  performed by CI.
