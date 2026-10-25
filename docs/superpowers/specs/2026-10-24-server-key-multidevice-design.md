# Server-key content encryption for multi-device access

Status: accepted 2026-10-24. Phases 1 (sessions), 2 (content), 3 (legacy
history) and 4 (calls) implemented in `feat/session-devices`.

This supersedes the “no escrow, no server-side recovery” rule in
`docs/engineering/E2EE_DESIGN.md` §4. That document keeps the MLS design as a
historical record; its top note and §12 describe what replaced it.

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

## Legacy history (phase 3)

Implemented in `feat/session-devices`.

- `POST /messages/:conversationId/legacy-import` takes up to
  `LEGACY_IMPORT_BATCH` decrypted items. Each item is matched to an envelope by
  sequence; only `kind = MESSAGE` counts, and the row's author and time come
  from the envelope, never from the caller. Text is sealed with the same
  conversation key as a new send. An attachment carries the sender's descriptor
  verbatim, but its blob must belong to this conversation and its key/nonce must
  decode to 32/12 bytes.
- `Message.legacyEnvelopeId` is unique, so an import is idempotent: a retry
  skips existing rows and still repairs `E2eeEnvelope.migratedAt` after a
  dropped response. Two devices importing the same stream race safely on that
  unique index.
- `GET /messages/:conversationId/legacy-status` reports `total`, `imported`,
  `pending` and the pending sequences (paged by `afterSeq`). There is no
  “unreadable” mark: an envelope nobody has handed back stays pending, and a
  device that later holds the keys can still import it.
- `shared/e2ee` remains the only thing that can open an envelope. The web client
  calls `backfillLegacy` after catch-up, maps its cached history to import items
  (quote ids `e2ee-<seq>` become `replyToSeq`), posts them in batches, refreshes
  the server history, and drops its local copy once a server row carries the
  same `legacySeq`. A device without keys asks only for the status, so the chat
  can say how many messages are waiting instead of implying they are lost.
- Rows imported with an attachment expose `attachment` (descriptor) on the wire
  and keep `legacySeq`; both are `null` for every row written after the switch.

## Calls (phase 4)

Implemented in `feat/session-devices`.

- At call creation the API reads the conversation's `e2ee` flag; when it is set,
  it generates one key with `randomBytes(32)` and stores it on the in-memory
  `CallRecord` as `mediaKey`. The key is never persisted, logged or included in
  a call view.
- The key is returned only by `POST /api/calls/:callId/token`, in the response
  body as `mediaKey`, and only when the request says `client: 'web'`. Every web
  participant of one call receives the same bytes. Socket events and call views
  carry no key material.
- `keyFingerprint` is gone: removed from the invite/accept/token requests, the
  call record and view, socket events, the DTO and the tests. There is no
  fingerprint comparison and no MLS epoch check.
- The web client hands `mediaKey` to LiveKit's `ExternalE2EEKeyProvider`; LiveKit
  derives frame keys locally, so the media server only sees ciphertext RTP.
- The API holds the key and can therefore decrypt call media. This is the same
  deliberate trade as messages: the database, backups and the media server
  cannot read the media, the application can.
- Calls are in-process, so the key disappears when the call ends or the process
  restarts; a restart ends the call anyway. There is no key escrow and no
  recovery path.
- Mobile is refused a token for an encrypted call because the Expo build has no
  encrypted-media support (no LiveKit E2EE). The refusal is about missing
  encrypted media, not a missing MLS key; the `locked` behavior for legacy chats
  is unchanged.
- Copy rule: no surface may say «سرتاسری» or claim end-to-end secrecy. Web call
  labels are «بدون رمزنگاری رسانه», «در حال فعال‌شدن رمزنگاری رسانه»,
  «رمزنگاری رسانه» (title: media is encrypted before sending; the key is held
  by the OpenBridge server) and «رمزنگاری رسانه فعال نشد».
- Mobile call copy says the OpenBridge server holds the key and this build does
  not support encrypted media yet. Mobile chat copy for legacy `e2ee` chats says
  old messages use the previous encryption and this build cannot read them, new
  content is stored encrypted on the server, and the web client is needed once
  for old history.
- The wire field `e2ee` keeps its name; only what it means for calls changed.

## Phases

2. Encrypt/decrypt messages and uploads with the server key; accept normal
   sends into legacy E2EE conversations; switch web clients off MLS for new
   sends. — done.
3. Backfill legacy MLS history: an idempotent endpoint keyed by envelope id,
   client upload of decrypted rows, then mark them migrated. Rows that no
   device can decrypt remain unreadable and are reported, not silently dropped.
   — done.
4. Calls: issue a per-call random key from the server instead of MLS; deliver it
   only with the web room token; remove the fingerprint and MLS key dependency;
   clean up copy on web and mobile. — done.
