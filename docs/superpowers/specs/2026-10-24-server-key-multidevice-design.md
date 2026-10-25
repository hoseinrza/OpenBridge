# Server-key content encryption for multi-device access

Status: accepted 2026-10-24. Phases 1 (sessions) and 2 (content) implemented in
`feat/session-devices`; phases 3–4 pending.

This supersedes the “no escrow, no server-side recovery” rule in
`docs/engineering/E2EE_DESIGN.md` §4. That document still describes the MLS
design that is currently deployed and must be updated when phase 2 ships.

## The requirement

Any device that signs into an account must be able to read every conversation,
including history written before that device existed. Messages stay encrypted
where they are stored. The new device is visible in an “active sessions” sheet
with its IP and last-seen time. An older device may sign other devices out; a
device younger than one month may not sign anyone out.

## Why MLS cannot satisfy it

The current client-side MLS design gives every device its own leaf and only the
devices present in a group can decrypt it. A device that joins later has no key
for earlier epochs and no Welcome back to them, which is exactly the error
“this conversation cannot be decrypted on this device”. Automatic access to
history for a brand-new device requires a key the server can hand out, i.e. a
key the server can also read.

## Decision

Content keys are held by the server.

- One master secret, `CONTENT_KEY`, lives only in the backend environment.
- Each conversation gets a data key derived from the master key and the
  conversation id (HKDF-SHA256). No key material is stored per row.
- Message text and attachments are encrypted with AES-256-GCM on write and
  decrypted for an authenticated, authorized session on read. File bytes are
  encrypted at rest under the same scheme.
- Transport is TLS; authorization is the session check, not possession of a
  key. Any signed-in session of the account can read the conversation.

### What this costs

The server can decrypt content. This is a deliberate trade: convenience and
cross-device history instead of end-to-end secrecy. UI copy must say
“encrypted at rest” and must stop claiming that the server cannot read
messages. The encryption still protects the database, backups and storage
volumes from anyone who obtains them without the application secret.

## Sessions (phase 1)

Implemented in `feat/session-devices`.

- `Session.securitySeenAt` marks, per device, the newest login that device has
  acknowledged. `GET /auth/security-events` lists sessions created after that
  mark, excluding the caller; `POST /auth/security-events/ack` moves the mark.
- `SessionSockets` tracks live sockets per session id, answers presence for
  the sheet, and disconnects a session’s sockets after revocation.
- `GET /auth/sessions` returns the sheet plus `canRevokeOthers`, computed
  server-side from `SESSION_REVOKE_COOLDOWN_DAYS` (default 30).
- `DELETE /auth/sessions/:id` refuses with 403 while the caller is younger than
  the cooldown, except for signing itself out.
- A new login emits `session:new` to the account’s other devices; the web app
  also polls the list so an offline device sees the alert when it returns.

## Content encryption (phase 2)

Implemented in `feat/session-devices`.

- `backend/src/common/content-crypto.ts` holds the format and the key
  derivation; `ContentCrypto` is the Nest provider that reads `CONTENT_KEY` at
  boot. A missing key stops the process instead of writing plaintext.
- Text is stored as `obx1.<iv>.<tag>.<ciphertext>` (base64url); files as magic
  `OBX1` + IV + tag + ciphertext. Anything without the marker is legacy
  plaintext or a legacy encrypted blob and passes through untouched. This is why
  there is no `contentVersion` column: the marker is in the payload.
- Message text is sealed on send and on edit; every read path (history, quotes,
  previews, link search) decrypts. Encrypted conversations accept ordinary sends
  again: a chat can hold MLS envelopes from before and sealed rows from now,
  and its unread count is the sum of both.
- Conversation previews now come from the server for every chat. The client
  still reads its own decrypted history and keeps whichever preview is newer,
  because an MLS-only chat has nothing newer on the server.
- Uploads are scanned as plaintext, then sealed under their stored filename
  before the id is returned. Downloads decrypt before serving and support a
  single byte range, so a recording can still seek. The old
  `/uploads/encrypted/*` paths are untouched for history.
- The web client no longer uses MLS for new sends; `shared/e2ee` remains only to
  read old history.

## Phases

2. Encrypt/decrypt messages and uploads with the server key; accept normal
   sends into legacy E2EE conversations; switch web clients off MLS for new
   sends.
3. Backfill legacy MLS history: an idempotent endpoint keyed by envelope id,
   client upload of decrypted rows, then mark them migrated. Rows that no
   device can decrypt remain unreadable and are reported, not silently dropped.
4. Calls: issue a per-call key from the server instead of MLS; remove the
   remaining MLS key dependency; clean up copy on web and mobile.
