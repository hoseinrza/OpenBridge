# OpenBridge Security Model

Last updated: 2026-10-19

## E2EE status: not implemented

OpenBridge is **not end-to-end encrypted**. Message text and attachments are
stored in plaintext in PostgreSQL/on the API server. The server (and anyone
with database or server access) can read every message. TLS protects traffic
in transit only; it is not a substitute for E2EE.

No custom cryptography has been introduced. If E2EE is added later, it must be
built on a maintained protocol implementation, with client-side key storage,
multi-device support, key verification, and an explicit migration path for
existing plaintext history. A protocol evaluation and phased design proposal
(no implementation) is in `docs/engineering/E2EE_DESIGN.md`.

## Confidentiality model

| Data                         | Where it lives                  | Who can read it                          |
|------------------------------|---------------------------------|------------------------------------------|
| Message text                 | PostgreSQL `messages.text`      | Server operators and DB access           |
| Attachments                  | API server `uploads/` directory | Server operators / disk access           |
| Usernames, display names     | PostgreSQL                      | Any authenticated user (`/api/users`)    |
| Password hashes (bcrypt)     | PostgreSQL                      | Server operators                         |
| JWTs                         | Browser localStorage / SecureStore (mobile) | User's device; bearer of the session |

The API never returns password hashes. User search exposes username, display
name, avatar, bio, status, and creation date to any authenticated user.

## Authentication

- Passwords are hashed with bcrypt (cost 10); plaintext passwords are never stored.
- JWTs are HS256, signed with `JWT_SECRET`, and expire after `JWT_EXPIRES_IN` (default 7 days).
- `JWT_SECRET` is required. The API refuses to start without it and, in
  production, requires at least 32 characters. There is no predictable fallback.
- HTTP uses `Authorization: Bearer <token>`; Socket.IO uses the same token in
  the handshake `auth.token`.
- Token claims are limited to `sub`; the user is loaded from the database on
  every authenticated request, so deleted accounts lose access immediately.
- Login and registration are throttled per client IP and per username
  (defaults: 10 logins/15 min per IP, 5 per username, 5 registrations/hour per
  IP). `TRUST_PROXY` must be set when behind a reverse proxy so the real client
  IP is used.
- Every login creates a server-side `Session` row. Access JWTs carry its id
  and are rejected as soon as the row is revoked, so logout invalidates the
  token immediately instead of waiting for JWT expiry.
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
| Compromised server / DB           | Can read all message content and attachments. E2EE does not exist. |
| Stolen unlocked device            | Has the active session until it is revoked or expires; the owner can list and revoke sessions from another signed-in device. |
| XSS or malicious same-origin JS   | Can read plaintext and the token from localStorage and act as the user. This is a fundamental limitation of web E2EE as well. |
| Removed group member             | Loses access to future messages and API events; previously issued signed attachment URLs remain valid until they expire. |

## Known limitations

- No E2EE; the server can read message content.
- Refresh-token reuse detection is not implemented: a replayed old refresh
  token is rejected but does not automatically revoke its session. Web stores
  both tokens in `localStorage`, so XSS can exfiltrate them; mobile keeps them
  in SecureStore.
- HTTP auth throttling is in-memory and per-process (10 logins/15 min per IP,
  5 per username, 5 registrations/hour per IP by default), so multi-instance
  deployments would need a shared store such as Redis.
- Socket rate limiting and presence are in-memory, so they are per-process and
  reset on restart; a multi-instance deployment needs a shared store.
- Signed attachment URLs are bearer capabilities: anyone with the URL can use it
  until expiry. Authorization is enforced when the URL is issued, not on each
  download. Removed members may retain valid URLs for up to the TTL.
- Malware scanning is disabled unless a clamd instance is configured; the
  default deployment does not scan uploads.
- Message edit/delete and account deletion workflows are not implemented.
- Database rows and attachment files are stored unencrypted at rest.
- Web lint is clean and CI runs lint plus the production build alongside the
  backend security suite. The CI database is ephemeral; no deployment is
  performed by CI.
