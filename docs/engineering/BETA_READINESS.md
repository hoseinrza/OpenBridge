# OpenBridge — Beta Readiness Baseline

Date: 2026-10-25
Commit: `5ed3ca1` (`main`, version 1.10.0)
Author: engineering audit for the Phase 1 roadmap

This document is the Phase 1 Task 1 deliverable. It records what exists,
what was actually executed, what is known to be broken, and what must be true
before the product can be called a controlled Beta. It distinguishes
**implemented**, **tested**, **partially implemented**, and **deferred**
rather than treating a build passing as a feature working.

It must be updated after every Phase 1 batch with new evidence.

---

## 1. Repository and architecture

| Area | Location | Stack |
|------|----------|-------|
| Backend API | `backend/` | NestJS 10, Prisma 5, PostgreSQL 16, Socket.IO, Passport JWT, LiveKit server SDK |
| Web client | `src/` | React 19, Vite 8, React Router 7, Socket.IO client, LiveKit client |
| Mobile client | `mobile/` | Expo SDK 57, React Native 0.86, React Navigation 7, SecureStore, LiveKit RN |
| Shared MLS core (legacy hand-back) | `shared/e2ee/` | `ts-mls`, `hpke`, `@panva/hpke-noble`, noble curves/hashes/ciphers |
| Media server | `docker-compose.yml` | Self-hosted LiveKit SFU, nginx SPA/proxy |
| Delivery | `.github/workflows/`, `deploy.sh` | GitHub Actions CI, optional SSH CD, compose on a VPS |

Backend modules (`backend/src/app.module.ts`): `auth`, `users`, `messages`,
`chat` (Socket.IO gateway), `uploads`, `e2ee`, `calls`, plus `common`,
`config`, `prisma`, `redis`.

HTTP surface (prefix `/api`):

- `auth`: OTP request/verify, signup, refresh, logout, session list/revoke,
  security events.
- `users`: directory, `/me`, profile update, search, contact matching, by-id.
- `messages`: conversations, groups (create/list/patch/detail/membership),
  direct/group encryption probes, envelope catch-up, legacy import/status,
  history, conversation delete.
- `uploads`: ordinary upload, encrypted-blob upload, signed download, encrypted
  blob URL/serve.
- `e2ee`: device registration/list/revoke, KeyPackage upload/claim.
- `calls`: status, per-call token, active call lookup, LiveKit webhook.
- `health`: `GET /api/health`.

Socket events (`chat`, `calls` gateways): `message:send|edit|delete`,
`e2ee:append|read`, `typing:start|stop`, `messages:read`, `reaction:add`,
`call:invite|group-start|accept|reject|cancel|end`.

Database: PostgreSQL with `users`, `sessions`, `otp_codes`, `devices`,
`key_packages`, `conversations`, `conversation_participants`, `messages`,
`message_reads`, `message_hides`, `reactions`, `e2ee_envelopes`,
`encrypted_blobs`. Schema is applied with `prisma db push`; there is no
migration history directory.

### Encryption model (as implemented today)

OpenBridge is **not end-to-end encrypted**. Message text and uploads are sealed
at rest with a server-held `CONTENT_KEY` (AES-256-GCM, per-conversation and
per-file HKDF keys) and opened by the API for authorized members. The server can
read all content by design. An older MLS-based envelope stream still exists for
legacy history hand-back; no new message uses it. Encrypted call media uses a
per-call key generated and held by the API, delivered only to web clients.
`docs/SECURITY.md` and `docs/engineering/E2EE_DESIGN.md` §12 are authoritative.

---

## 2. Execution environment for this audit

- Windows 11 x64, Git Bash, Node.js 24.18.0.
- Local PostgreSQL reachable at `127.0.0.1:5432`; `backend/.env` points at
  `openbridge` and contains a local `CONTENT_KEY`.
- Root, backend and mobile `node_modules` installed.
- **No Docker** and **no Java/Android SDK/emulator** on this machine, so the
  compose smoke test and the Maestro flow cannot be reproduced locally. CI is
  the only execution path for those, and its logs/artifacts require
  authentication.

---

## 3. Verified checks (commands actually run)

| Command | Result | Notes |
|---------|--------|-------|
| `npm run lint` (root) | **PASS** after fix | Initially 199 errors: ESLint linted the local `graphify-out/vis-network.min.js`; `graphify-out` added to `globalIgnores`. CI never contained that directory, so this was a local/CI divergence, not a CI failure. |
| `npm run build` (root) | **PASS** | Vite, 321 modules. Main JS chunk 1.19 MB (341 kB gzip) triggers the >500 kB warning. |
| `npm run test:e2ee` (root) | **PASS 17/17** | MLS lifecycle on two ciphersuites, cross-provider interop, no-WebCrypto (Hermes) run, payload/attachment codecs. |
| `npm run build` (backend) | **PASS** | `nest build`. |
| `npm run test:e2e` (backend) | **PASS 103/103** (8.7 s) | Against local PostgreSQL. Includes crypto unit tests, content sealing/opening, legacy import, upload encryption/range serving, and the security, message-action, calls, content-key and client-level E2EE suites. |
| `node --test test/security.e2e.cjs` (backend) | **PASS 41/41** (12.7 s) | Re-run for Phase 1.3 with three new cases: single-use/retired OTP codes, the four accepted phone spellings, and a production-mode boot that must answer `503` with no `testCode`. |
| `npm run test:e2e` (backend), after Phase 1.3/1.4 | **PASS 107/107** | The suite grew by the three OTP cases, an offline-then-reconnect case, and an expired-signed-URL assertion inside the uploads case. |
| `npm run test:ci` (mobile) | **PASS 11 suites / 81 tests** | Jest + RNTL. |
| `npx expo export --platform android` (mobile) | **PASS** | Hermes bundle `index-f1388b6c8ec19ef4b17675b00a8087e7.hbc` (4.8 MB) plus assets in `dist-ci`. |
| `npm audit --omit=dev --audit-level=high` (backend) | **PASS** after upgrade | Baseline was 11 findings (1 critical, 4 high, 6 moderate). After `bcrypt@6`, `multer@2.5.0` and the `body-parser`/`qs` overrides the high/critical count is 0; 6 moderate advisories remain on paths this app does not use (§5.1). |
| Docker compose smoke | **NOT RUN** | No Docker on this machine. Last CI run's `4 · Docker images + compose smoke test` job passed. |
| nginx security headers | **NOT RUN locally** | Added in `nginx.conf` for Phase 1.5; the compose step now asserts `nosniff`, `X-Frame-Options: DENY`, `Referrer-Policy: no-referrer` and no version banner on `/` and `/api/health`. Needs a CI run. |
| Maestro Android E2E | **NOT RUN** | No Java/emulator locally; latest CI run failed. Details in §5.2. |

### CI state on `main`

Latest run `40198966502` for `5ed3ca1` (2026-10-25T13:44Z):

- Green: change detection, web lint, backend schema/typecheck, backend e2e,
  E2EE gate, mobile unit tests, web build, mobile bundle, Docker compose smoke.
- **Red (blocking): `2e · Mobile E2E (Android emulator)`** → `CI gate` fails.
- **Red (informational): `2c · Dependency audit (backend)`** — true for this run,
  which predates the upgrade; at `--audit-level=high` it now has nothing to
  report (§5.1).
- `Deploy` skipped (`DEPLOY_ENABLED` is not `true`).

The previous four `main` runs (`e148fee`, `feef366`, `dc0ce22`, `ce9e30e`) all
failed the same way, so this is not a one-off flake.

---

## 4. Capability status

### Implemented and covered by automated tests

- Phone + OTP sign-up/sign-in (no passwords), signup token separation, session
  rows, rotating refresh tokens, logout, session list/revoke, security events.
- Direct and group conversations, message history with cursor pagination,
  replies, forwards, edits, delete-for-everyone, delete-for-me, reactions
  (one per person, toggle), read receipts, typing, presence.
- Content sealing at rest for text and ordinary uploads; legacy MLS hand-back
  and import; signed, expiring attachment URLs with range support.
- Socket authentication, session revocation enforcement, per-socket rate
  limits, payload caps and membership checks.
- Calls: server-authorized LiveKit tokens, call lifecycle over sockets,
  server-issued media key for encrypted calls (web only), fail-closed rules,
  webhook endpoint.
- Web client: login wizard, chat list, chat, groups, profile, settings, theme,
  contacts paste flow, attachments, voice messages, calling.
- Mobile client: login wizard, chat list, chat, groups, contacts import,
  settings/theme, locked state for legacy-encrypted chats, calling UI (mobile
  cannot join encrypted calls).

### Implemented, but not verified in this audit

- Android bundle and on-device behavior: bundle is green in CI, Maestro is red.
- LiveKit calls end to end: no live call was placed in this session; the
  calling architecture document records prior structural verification.
- Push notifications: not implemented / not in scope of the current tests.
- Browser visual QA: several prior batches recorded
  `NATIVE_BROWSER_VIEWPORT_UNAVAILABLE`; screenshots are not part of the
  evidence base.
- Server restart and multi-instance behavior: in-process presence, call state
  and throttles are documented as per-process; no restart test exists.

### Partially implemented / limited

- Encryption: at-rest only, server-held key. No E2EE for new messages. Legacy
  MLS surfaces remain mounted. No key rotation or recovery for `CONTENT_KEY`.
- Mobile cannot decrypt legacy MLS conversations or join encrypted calls.
- Conversation flagged `e2ee` cannot change membership (legacy guard).
- Account deletion and data export are absent.
- Group administration UI (add/remove members, rename, avatar) is absent from
  both clients; encrypted/legacy-flagged groups are frozen server-side.
- Contacts matching is an enumeration oracle for any signed-in user, throttled
  but not eliminated.
- No SMS provider: development OTP is returned as `testCode`; production
  returns 503. Real-user phone verification is deferred.
- Signed attachment URLs are bearer capabilities until expiry.
- Redis is declared in compose but unused; `RedisService` is an in-process map.
- Web stores access and refresh tokens in `localStorage`.
- Message edit/delete are covered; reactions and attachments are intentionally
  blocked in legacy-encrypted chats.

### Deferred (documented, not planned for Beta)

- Paid SMS provider integration and real OTP delivery.
- A new end-to-end encryption protocol, key verification, multi-device E2EE.
- Mobile encrypted calls.
- Multi-instance realtime scaling (shared presence/rate-limit store).
- Account recovery, export and deletion.
- Production public release gates and monitoring/alerting.

---

## 5. Defects, risks, blockers

### 5.1 Backend production dependency audit — high/critical resolved

Baseline (before any change): 11 production findings — 1 critical, 4 high,
6 moderate.

- **critical** — `tar <= 7.5.20`, reached through `@mapbox/node-pre-gyp` ←
  `bcrypt@5`.
- **high** — `multer` (1.x line) and transitives; `@nestjs/platform-express`
  bundles `multer@1.4.5-lts.1`.
- **moderate** — `qs` (DoS), through Express, plus five others.

Applied, all in `backend/package.json`:

| Change | Reason |
|--------|--------|
| `bcrypt` `^5.1.1` → `^6.0.0` | Drops `node-pre-gyp`/`tar`; the native build is the same API this code uses. |
| `multer` `^1.4.5-lts.1` → `^2.5.0` | The 1.x line is the high finding. |
| `overrides`: `body-parser ^1.20.9`, `qs ^6.16.1`, `multer ^2.5.0` | Pins the transitive copies Nest's Express platform would otherwise resolve. |

Verified after the upgrade:

- `npm audit --omit=dev --audit-level=high` exits 0 (no critical/high).
- Resolved installed versions: `bcrypt@6.0.0`, `multer@2.5.0`,
  `body-parser@1.20.9`, `qs@6.16.1`.
- `npm run build` PASS; `npm run test:e2e` **103/103** PASS; a direct
  `bcrypt.hash`/`compare` round-trip PASS.

**The 6 remaining moderate advisories are accepted as unreachable for Beta:**

- `@nestjs/core@10.4.22` — SSE response injection (CVE-2026-35515), fixed in
  `11.1.18`. This API mounts no `@Sse()` route and returns no
  `text/event-stream` response; fixing it means a Nest 10 → 11 major upgrade.
- `file-type@20.4.1` (via `@nestjs/common`) — ASF/ZIP parse DoS
  (CVE-2026-32630), fixed in `21.3.2`. Nothing in this repo imports `file-type`
  and no route uses `ParseFilePipe`/`FileTypeValidator`; uploads are validated
  by the app's own extension allowlist, magic-byte check and optional ClamAV
  scan.
- The remaining four are the transitive copies that these two roots pull in.

Re-check both when Nest 11 is adopted. The registry audit endpoint answered
`ECONNRESET` on the last two attempts of this session (2026-10-25T15:22Z and
15:23Z), so the "after" numbers above are from the verified run earlier the same
day; the installed versions in the lockfile back them up.

### 5.2 Android Maestro E2E (blocking Phase 1 Task 2)

- Job `2e` fails on every `main` run. The failing step is
  `Run Maestro on the emulator` (`13:57:59Z → 14:00:38Z`, about 2 min 39 s,
  including emulator boot).
- GitHub's public annotations expose only
  `The process '/usr/bin/sh' failed with exit code 1`; the step's own
  `::error title=Maestro::…` annotation is absent, and logs/artifacts require
  authentication.
- That combination is consistent with a failure before or at `adb install`
  (which would abort the script before the Maestro retry/error block), or with
  the emulator runner failing to boot. It is **not** yet proven which.
- The flow selectors were cross-checked against the current mobile source:
  `login-*`, `composer-*`, `chat-header-profile`, `profile-screen`,
  `reaction-chip-N` and the dynamic `profile-tab-*` ids exist. No obviously
  stale selector was found in this pass.
- Because no Java/emulator exists locally, the fix is CI-side instrumentation
  rather than a blind selector change. **Landed on `beta/phase-1`** (unverified
  until a run exists):
  - the step now reports SDK level, Maestro version, `boot_completed` and
    `adb devices` to the step summary;
  - a missing APK is an explicit error that lists the output directory;
  - `adb install` is run explicitly, its full output is echoed, and a non-zero
    exit annotates `APK install failed` and captures logcat;
  - a launch smoke test (`am start -n com.openbridge.mobile/.MainActivity`,
    `pidof`, screenshot, logcat) runs before Maestro, so an install-ok /
    app-crash case is distinguishable from a flow failure;
  - `maestro test` now writes `--debug-output` for both attempts;
  - the artifact upload includes launch screenshot/log, install log, debug
    output and launch logcat.

### 5.3 Documentation/claims drift — corrected

- `docs/SECURITY.md` no longer implies the emulator run passes; it states the
  job is red and links here.
- `README.md`'s "CI is green" observation (2026-10-21) is replaced with the
  2026-10-25 state: everything green except `2e`/`CI gate`.
- The roadmap's Phase 1 Task 2 acceptance is still not met while `2e` is red;
  the instrumentation needs one CI run on a branch that CI watches.

### 5.4 Test and account cleanup (resolved in Phase 1.9)

The local database after the audit runs held 24 conversations with no
participants and no messages. They came from the e2e suites, which delete their
temporary users (cascading the participant rows) but not the conversations those
users created. `backend/test/calls.e2e.cjs` now records every conversation it
creates and deletes them before the users; the other suites already did. The 26
rows accumulated by the runs since then were removed by hand (empty,
participant-less, no messages), and a repeated suite run no longer adds any.

### 5.4 Security findings carried forward (assessed, not new)

- Server can read all message content and call media by design; claims must stay
  explicit.
- Legacy MLS surfaces (`/api/e2ee/*`, `e2ee:*` socket events, envelope/blob
  tables) remain reachable attack surface although no new message uses them.
- In-memory auth throttling, socket rate limits and presence are per-process.
- Signed attachment URLs remain valid for removed members until expiry.
- Contact matching allows enumeration of registered phone numbers.
- Web tokens live in `localStorage`.
- No malware scanning unless ClamAV is configured and reachable.
- No account deletion/export.

### 5.5 Operational blockers in this environment

- No Docker → compose smoke and image builds not reproducible locally.
- No Java/Android SDK/emulator → Maestro not reproducible locally.
- GitHub Actions logs, artifacts and summaries need authentication; only job
  names/conclusions and annotations are publicly readable.
- Production database is only reachable on the VPS (not from this machine);
  no production data was touched.

### 5.6 Encryption claims verification (Phase 1 Task 6)

The implemented model is server-held at-rest sealing, not end-to-end encryption
(§1). Every client-visible encryption string was read against that model:

- **Web call badge** (`CallLayer.jsx`): the verified state says media is
  encrypted before it leaves the device and that the call key is held on the
  OpenBridge server; the unencrypted state says the media is only protected by
  the transport layer. Both match the call backend and `useCall`.
- **Web message notice** (`MessageList.jsx`, `e2eeNotice`): states that the
  conversation is sealed on the server and readable by signed-in devices of the
  account, and reports how many legacy messages are still waiting for a
  key-holding device, with singular and plural forms. Consistent with the
  legacy-import behaviour and with the mobile banner.
- **Chat-list fallback label** (`Sidebar.jsx`): a conversation with no preview
  used to be labelled simply «رمزنگاری‌شده», which read as a
  property of the current state rather than of the old history. It now says the
  history is encrypted («تاریخچهٔ رمزنگاری‌شده»), matching the mobile chat-list
  accessibility label.
- **Mobile**: the call overlay says encrypted/unencrypted, and the call and send
  paths state in words that the key is server-held, that mobile cannot join
  encrypted calls, and that legacy history is unreadable on this version. No
  string claims more than the code does.
- **No end-to-end claim**: a repo-wide search for "end-to-end"/"end to end"
  finds only honest negatives (`README.md`, `docs/SECURITY.md`), the historical
  design and progress documents, an internal comment in `src/services/e2ee.js`,
  and the design rule that forbids the Persian word for end-to-end on any
  surface. No UI surface uses it.
- **Legacy hand-back edges**: covered by `backend/test/legacy-import.e2e.cjs`
  (author and time preserved, replay is idempotent, control and unknown
  sequences rejected, quote linkage, outsider refused) and
  `backend/test/legacy-import.test.cjs` (sealed storage, attachment descriptor
  validation, membership).
- **Logs and responses**: backend logging was reviewed. It emits user ids,
  socket ids, counts and error messages, never message text, file bytes, tokens
  or OTP codes. The production-OTP test asserts no code is returned, and refresh
  tokens are hashed before storage.

Verification: `npm run lint` and `npm run build` pass with the label change. No
backend file changed in this task, so the 107/107 e2e run from Phase 1.4 still
applies.

### 5.7 Web/mobile parity (Phase 1 Task 7)

The two clients were compared surface by surface from their sources. This
machine has no Android emulator (§5.5), so nothing below was exercised on a
device; the Android statement is what the code and the Jest suite support, not
an on-device observation.

| Journey | Web | Android | Note |
|---------|-----|---------|------|
| OTP sign-in and sign-up | yes | yes | Same endpoints; the test code exists only outside production. |
| Direct chat: send, receive, history | yes | yes | History is chronological and paged 50 rows at a time on both. |
| Group chat: create, list, send, read | yes | yes | Neither client offers member add/remove UI, although the API has it. |
| Receive and open attachments | yes | yes | Signed URLs; images render inline, files open through the OS. |
| Send attachments | yes | **no** | Mobile uploads only voice recordings; no image/document picker is installed. |
| Voice messages | yes | yes | Both record and play; mobile sends `VOICE` with the measured length. |
| Reactions, read receipts, typing | yes | yes | Same socket events. |
| Reply | yes | yes (added here) | New two-row action tray and quote rendering; the send carries `replyToId`. |
| Edit | yes | yes (added here) | `message:edit` over the socket; the row shows the edited mark. |
| Delete for me / for everyone | yes | yes (added here) | Confirmation sheet offers everyone only on an own message; scopes match the server. |
| Forward | yes | **no** | Needs a target picker that does not exist on mobile. |
| Search | conversation search | chat-list search only | No in-chat search field on mobile. |
| Profile | view and edit | view only | Mobile shows name, handle and avatar; no edit form or avatar picker. |
| Device/session management, security alerts | yes | **no** | No mobile screen calls `/auth/sessions` or `/auth/security-events`. |
| Theme | light, dark | system, light, dark | Mobile adds "follow the system". |
| Calls | audio and video, encrypted media for new calls | audio and video, refuses encrypted calls | The refusal is explicit and documented; the key is server-held. |
| Contacts | user search | user search plus device contacts | Mobile can import the phone's address book. |

Added in this phase: the mobile client now hears `message:edited`, so a message
changed on the web no longer keeps its old text until the screen is reopened;
it renders quotes and edited marks; and it can reply, edit and delete from the
same long-press tray. Covered by `mobile/__tests__/use-chat-reply.test.js` and
the new cases in `mobile/__tests__/chat-screen.test.js` (suite: 96/96). The
Android JS bundle also exports successfully, and the web lint/build still pass.

Remaining gaps that touch the Beta acceptance list are **sending attachments**
and **editing the profile from Android**; the rest are conveniences or
web-only administration. They are recorded here rather than implemented blind,
because a picker or form cannot be verified without a device and an emulator is
not available in this environment.

`docs/engineering/UI_UX_REDESIGN.md` is stale about group administration (it
says "absent at the API level"); the API now has participant add/remove, but
neither client has UI for it.

### 5.8 Calling verification (Phase 1 Task 8)

The lifecycle suite (`backend/test/calls.e2e.cjs`, 11 cases, part of the
110-case `npm run test:e2e` run) exercises the server side of calling without
a media server: `LIVEKIT_API_URL` is deliberately unset, so no room is created
and nothing leaves the process. It establishes:

- **Authorization.** A stranger cannot obtain a room token (403), the caller
  cannot join before an answer (409), both participants can, and no token is
  issued once the call has ended (409). The token’s `sub` is the authenticated
  account, its room is `ob_<callId>`, it carries no admin grant and no
  `canPublishData`, and the LiveKit API secret never appears in the response.
- **Token lifetime and reconnect.** `expiresIn` equals
  `CALL_TOKEN_TTL_SECONDS` (default 600) and the JWT expiry matches it. Asking
  again during an active call mints another token for the same room instead of
  starting a second call; tokens generated within the same second are
  byte-identical, which is expected for deterministic JWTs.
- **Ring timeout.** With `CALL_RING_TIMEOUT_SECONDS=2`, an unanswered ring ends
  as `MISSED` / `timeout` with `durationMs: 0`, no token can be minted, and
  both accounts are free to ring again immediately.
- **Webhook-authenticated cleanup.** An unsigned body, a forged signature, and a
  signature over a different body are all rejected with 401. A correctly signed
  `participant_left` ends a direct call with reason `participant-left`, and a
  signed `room_finished` ends a call whose clients vanished and blocks further
  tokens.
- **Encrypted media.** A new encrypted call holds one server-issued 32-byte key
  for the whole call (same key for both sides, not sent with the ring) and
  refuses a mobile token with 403. This matches the documented model: the key is
  server-held, not end-to-end.
- **Lifecycle edges.** Reject and cancel end the ring for both sides; duplicate
  accept/reject are idempotent; an offline callee is not rung and creates no
  record; a group call checks membership and ends when the last member leaves;
  a revoked session cannot mint a room token.

One behaviour surfaced while writing the suite and is worth knowing: invites are
rate-limited per socket (6 in 10 seconds), so a client that rings repeatedly is
refused before the call service runs.

**Not verified here.** No live call was performed. LiveKit room creation, media
flow, reconnection after a real network drop, the webhook subscription configured
in LiveKit, and joining from a device all remain unproven in this environment
(no media server, no emulator — §5.5). Call state is also held in process
memory, so a restart drops active calls and a second API instance would not see
them; Phase 1 Task 9 (§7) carries that into the backend-reliability work rather
than treating it as a calling defect.

### 5.9 Backend reliability and database (Phase 1 Task 9)

What changed in this phase, and how it is evidenced:

- **Liveness vs readiness.** `GET /api/health` stays a static process answer.
  `GET /api/health/ready` runs `SELECT 1` and answers 503 `{status:'error',db:'down'}`
  when Postgres is unreachable, without echoing the driver message or host.
  The compose healthcheck, the CI smoke waits and Render’s
  `healthCheckPath` now use `/api/health/ready` (Render previously pointed at
  `/api`, which has no route). Covered by `backend/test/health.e2e.cjs`
  (liveness, ready-up, ready-down with an injected query failure, recovery).
- **Graceful shutdown.** `main.ts` calls `app.enableShutdownHooks()`, so Nest
  runs `PrismaService.onModuleDestroy` (`$disconnect`) and
  `CallsService.onModuleDestroy` (stop the sweep, end live calls) on SIGTERM.
  The Docker image now uses `exec node dist/main`, making node PID 1 instead of
  `sh`, and compose allows 20s (`stop_grace_period`) for teardown. The image
  is not built locally (no Docker, §5.5), so this part is verified by source and
  configuration review, not by an observed container stop.
- **Indexes.** `Conversation` gains `@@index([isGroup, updatedAt])` for the chat
  list’s filter and sort; `Session` gains indexes on `expiresAt` and
  `revokedAt` for pruning and security alerts. Applied with `prisma db push`
  (the project has no migrations directory), and the schema validates.
- **Housekeeping.** `MaintenanceService` runs every
  `MAINTENANCE_INTERVAL_SECONDS` (default 3600, unref’d so it never holds the
  process open). One pass deletes expired one-time codes and sessions that have
  expired or were revoked more than `MAINTENANCE_SESSION_RETENTION_DAYS` ago;
  live and recently revoked sessions stay for the security history. The interval
  and retention are documented in `backend/.env.example`. Covered by
  `backend/test/maintenance.e2e.cjs`, which seeds expired, long-revoked,
  recently revoked and live rows and calls the pass directly. Logs carry counts
  only.
- **Atomic send.** `MessagesService.sendToConversation` now writes the message
  and the conversation’s recency stamp in one `$transaction`. The in-memory
  fake used by `message-encryption.test.cjs` models the callback so the unit
  harness keeps running; the real rollback path is not forced by a test.
- **Test isolation.** `calls.e2e.cjs` deletes the conversations it creates, and
  a verification run afterwards left zero participant-less conversations (§5.4).

Remaining, documented rather than changed:

- **In-memory state.** Calls, presence, auth throttling and socket rate limits
  are per process. A restart drops active calls; a second API instance would not
  see the first’s calls or presence. Multi-instance hosting needs shared state
  or sticky routing before it can be considered.
- **Pagination.** Message history is offset-paged (`skip` capped at 100000), so
  rows sharing a `createdAt` can repeat or vanish across a page boundary. Shared
  media uses a `createdAt < cursor` keyset, which drops same-millisecond rows.
  Links, envelopes and legacy status already use a correct keyset. The clients
  would need a cursor contract change, so this stays a known limitation.
- **Chat list cost.** `listConversations` and `listGroups` issue two counts per
  chat (N+1) and are bounded only by how many chats a user has. Fine at Beta
  scale, not at growth scale.
- **User directory.** `GET /api/users` returns every account without a limit.
  Both clients expose a `fetchUsers` helper but no screen calls it; the
  security suite uses it to prove phone numbers are hidden. Capping or removing
  it is a product decision, recorded here so it is not mistaken for a leak fix.
- **No file GC.** Uploads deleted on the error path are unlinked, but blobs left
  by account or conversation deletion are not swept from disk.

Full backend suite after these changes: `npm run test:e2e` → 113/113.

### 5.10 Beta environment and operations (Phase 1 Task 10)

The operational contract is now one document: `docs/engineering/BETA_OPERATIONS.md`.
It covers the four environments and their startup order, the full environment
variable table with defaults and validation, test-mode OTP, schema pushes and
seeding, the safe local reset, test commands and required configuration,
backup/restore, and a release checklist with rollback. What changed while
writing it:

- **Render health path corrected** from `/api` (no route) to
  `/api/health/ready`; the compose healthcheck, CI smoke waits and VPS
  `deploy.sh` now ask the readiness route as well, so a running process with an
  unreachable database no longer counts as a successful deploy.
- **Stale operational claims corrected** in `README.md` and `DEPLOY.md`: the
  security-suite/test counts, the health route, and the statement that CI is
  green (the Android Maestro job is red on `main`; the CI gate inherits that).
- **Seeder scope confirmed** from its source: `npm run seed:dev` refuses a
  non-localhost `DATABASE_URL` or `NODE_ENV=production`, so it cannot fill a Beta
  environment. CI uses its own disposable seed.
- **Env validation confirmed** from `backend/src/config/env.ts`: the process
  refuses to start without `JWT_SECRET`/`CONTENT_KEY`, production enforces the
  JWT length, and the new maintenance variables default in code and are
  documented in `backend/.env.example`.

Operational limits that remain, with the reason:

- Backup/restore and rollback are **documented and source-reviewed, not
  exercised**: the production database is only reachable on the VPS, no
  production action is authorized, and this machine has no Docker. The VPS
  `deploy.sh` rollback branch has still never run on a real VPS.
- A schema-changing release cannot be undone by rolling the image back; the
  previous code must tolerate additive changes. That is stated in the release
  checklist, together with the requirement to take a backup first.
- No Beta environment is deployed. The roadmap's Beta gate is assessed in §6 and
  the acceptance run; this section only makes the procedure repeatable.

---

## 6. Beta acceptance criteria

The Beta gate is met only when all of the following are true and evidenced:

1. Core supported journeys work on web and mobile: sign-in, direct chat, group
   chat, send/receive, history, attachments, voice messages, reactions, read
   receipts, profile/settings, and supported calls.
2. Web lint, web build, backend schema/typecheck, backend e2e, E2EE gate, mobile
   unit tests, mobile bundle and the Docker compose smoke test pass in CI.
3. The Android Maestro flow either passes or its removal/replacement is a
   documented, reviewed decision with equivalent on-device evidence.
4. No unresolved critical/high security defect affecting the Beta environment.
   Dependency findings are fixed or explicitly assessed and accepted.
5. Development OTP works with no SMS spend, and production cannot expose test
   codes or fall back to test mode.
6. Encryption claims match implementation: at-rest sealing is stated as such,
   and nothing is labeled E2EE unless it is.
7. Known limitations, local setup, test configuration, backup/restore and
   rollback procedures are documented.
8. A Beta release checklist and rollback procedure exist.
9. The Beta is deployed only to a controlled test environment and is not
   presented as a production-ready public service.

The current status against these criteria is recorded in §9.

---

## 7. Work required before Beta (Phase 1 plan)

Ordered by the roadmap, with the baseline's findings attached:

1. **CI reliability** — fix or instrument Maestro; resolve/assess the backend
   audit; keep every other job green; update stale CI claims.
2. **Authentication** — prove dev/test OTP only outside production, test
   expiry/single-use/lockout/throttle/token rotation/revocation, document the
   SMS integration point.
3. **Messaging** — regression coverage for send/edit/delete/reply/forward,
   receipts, reconnect, and cross-user access; verify attachment authorization.
4. **Security baseline** — no unresolved critical/high issue; review IDOR,
   socket authz, CORS/headers, uploads, secrets, logs and data exposure.
5. **Encryption verification** — keep the at-rest model accurate, verify
   legacy-hand-back edges, and ensure no log/response leaks plaintext.
6. **Client parity** — exercise the main journeys on web and the mobile test
   build, fix regressions, document intentional differences.
7. **Calling** — verify authorization, token expiry, lifecycle, reconnect and
   cleanup; document that mobile cannot join encrypted calls.
8. **Backend reliability** — indexes, transactions, pagination, in-memory
   state, cleanup jobs, health/readiness, graceful shutdown.
9. **Beta environment and operations** — local setup, test config, startup
   order, migrations/seed, backup/restore, safe reset, env validation.
10. **Beta acceptance run** — full CI plus end-to-end journeys, cross-user
    isolation, production OTP behavior, evidence log, release checklist and
    rollback.

---

## 8. Evidence log

| Date | Change / check | Evidence |
|------|----------------|----------|
| 2026-10-25 | Baseline audit | This document; commands in §3. |
| 2026-10-25 | Web lint ignore for `graphify-out` | `npm run lint` → exit 0. |
| 2026-10-25 | Dependency upgrade (`bcrypt@6`, `multer@2.5.0`, `body-parser`/`qs` overrides) | `npm run build` PASS; `npm run test:e2e` 103/103; `npm audit --omit=dev --audit-level=high` exit 0; `npm ls` shows the pinned versions. §5.1 |
| 2026-10-25 | Maestro step instrumentation | `.github/workflows/ci.yml` (`Run Maestro on the emulator`, artifact paths). No CI run yet. §5.2 |
| 2026-10-25 | Stale CI claims corrected | `README.md`, `docs/SECURITY.md`. §5.3 |
| 2026-10-25 | Lockfile root versions synced to 1.10.2; orphan test conversations removed | `package-lock.json`, `backend/package-lock.json`, `mobile/package-lock.json` (2 lines each); 24 participant-less conversations deleted locally. §5.4 |
| 2026-10-25 | Phase 1.3 auth cases | `node --test test/security.e2e.cjs` → 41/41; new cases named in §3. README documents the SMS integration point. |
| 2026-10-25 | Phase 1.4 messaging cases | Offline→reconnect catch-up and an authentic-but-expired file URL; `npm run test:e2e` → 107/107. |
| 2026-10-25 | Phase 1.5 headers | `nginx.conf` (nosniff, frame deny, referrer policy, `server_tokens off`), CI assertion, `docs/SECURITY.md` rationale for the missing CSP/HSTS. Web lint and build still pass. |
| 2026-10-25 | Phase 1.6 encryption claims | Client encryption strings matched to the server-held model; chat-list fallback changed to an encrypted-history label; no end-to-end claim on any surface; legacy hand-back already covered. `npm run lint` and `npm run build` exit 0. §5.6 |
| 2026-10-25 | Phase 1.7 parity | Mobile now applies `message:edited`, renders quotes and edited marks, and replies/edits/deletes from the long-press tray; parity matrix and remaining gaps in §5.7. Mobile Jest 96/96; `expo export --platform android` PASS; web `npm run lint`/`npm run build` PASS. |
| 2026-10-25 | Phase 1.8 calling cases | Signed-webhook cleanup, ring timeout, token TTL/reconnect and signature rejection added to `backend/test/calls.e2e.cjs`; `node --test test/calls.e2e.cjs` → 11/11; `npm run test:e2e` → 110/110. No live media server used; limits stated in §5.8. |
| 2026-10-25 | Phase 1.9 reliability | `/api/health/ready` DB probe (503 without driver detail) wired into compose, CI and Render; shutdown hooks plus `exec` and 20s grace; indexes on conversations and sessions; hourly pruning of expired OTPs and dead sessions; atomic message+recency write; calls suite deletes its conversations. `npm run test:e2e` → 113/113; `prisma validate` PASS; a calls run afterwards left 0 orphan conversations. Shutdown path is source-reviewed only (no Docker here). §5.9 |
| 2026-10-25 | Phase 1.10 operations | New `docs/engineering/BETA_OPERATIONS.md` (environments, env table, schema/seed/reset, tests, backup/restore, release checklist, rollback); Render and `deploy.sh` now use the readiness route; stale counts/CI status fixed in `README.md`/`DEPLOY.md`. Backup, restore and rollback are documented and source-reviewed, not executed. §5.10 |
| 2026-10-25 | Phase 1 acceptance run | Web lint/build PASS; E2EE gate 17/17; backend e2e 113/113; mobile Jest 96/96; Android export PASS; readiness 200 direct and through the Vite proxy. Audit blocked by registry `ECONNRESET`; compose smoke and Maestro unavailable here; CI not triggered for this branch. Gate remains closed: §9. |
Next update: after a CI run exercises the Maestro instrumentation (CI watches
PRs to `main` and pushes to `main`; a push to `beta/phase-1` does not trigger
it).

---

## 9. Phase 1 acceptance run and gate decision (2026-10-25)

Every command below was run on commit `cde3087` (`beta/phase-1`, product version
1.10.10) on this machine, against the local PostgreSQL. Only this report and the
version/changelog changed afterwards.

| Check | Command | Result |
|-------|---------|--------|
| Web lint | `npm run lint` | PASS (ESLint, no findings) |
| Web build | `npm run build` | PASS (Vite, chunk-size warning only) |
| MLS library gate | `npm run test:e2ee` | 17/17 |
| Backend schema | `npx prisma validate` | valid |
| Backend types/build | `npm run build` (inside `test:e2e`) | PASS |
| Backend e2e | `npm run test:e2e` | 113/113 across 12 files, including production-mode OTP, cross-user access, calling, health and maintenance |
| Mobile unit/component | `cd mobile && npm test -- --ci` | 96/96, 12 suites |
| Mobile bundle | `npx expo export --platform android` | PASS (Hermes `.hbc`, 4.8 MB) |
| Local API | `GET /api/health/ready` direct and through the Vite proxy | 200 `{status:'ok',db:'up'}` |
| Web dev shell | `GET http://127.0.0.1:5173/` | 200 with `<div id="root">` |
| Dependency audit | `npm audit --omit=dev --audit-level=high` (root) | **blocked**: `ECONNRESET` from the npm registry; no dependency changed since the clean 1.10.2 audit |
| Docker compose smoke | — | **not run**: no Docker on this machine |
| Android Maestro | — | **not run**: no emulator/SDK; job is red on `main` (§5.2) |
| CI for this branch | — | **not run**: a push to `beta/phase-1` does not trigger CI; it needs a PR or `main` merge, which is not authorized here |

### Gate decision

**The Beta gate is not met.** The engineering work for Phase 1 is complete and
every locally runnable check is green, but four criteria remain open, and none of
them can be closed by writing more code in this environment:

1. **Criterion 1 (core journeys on both clients)** — the mobile client still
   cannot send attachments and cannot edit the profile (§5.7). These are real
   journey gaps, not cosmetics. Supported calls have never been exercised end to
   end: only token minting, lifecycle and webhook paths are proven (§5.8).
2. **Criterion 2 (all checks in CI)** — the local equivalents pass, but the
   compose smoke and the CI run for this branch do not exist. Triggering CI
   requires a pull request or a merge to `main`; the user has authorized pushes
   to the working branch only.
3. **Criterion 3 (Maestro or a reviewed replacement)** — Maestro has failed on
   every recent `main` run and cannot be reproduced here. `beta/phase-1` carries
   diagnostics for the next CI run, not a fix.
4. **Criterion 4 (no unresolved high/critical finding)** — the last clean audit
   (1.10.2) has no dependency changes after it, but the current audit could not
   reach the registry, so it is not freshly evidenced.

Criteria 5–9 are met: development OTP works without SMS and production refuses
to issue codes; encryption claims match the server-held model; limitations,
setup, backup/restore and rollback are documented; a release checklist exists;
and no Beta or production deployment has been presented as ready.

What would close the gate, in order:

1. Open a PR from `beta/phase-1` to `main` (or authorize the merge), let CI run,
   and read the Maestro diagnostics artifact. Fix or replace that flow with
   equivalent evidence.
2. Re-run the dependency audit from a network that reaches the registry.
3. Implement mobile attachment sending and mobile profile editing, then verify
   them on a device or emulator.
4. Perform one real two-party call on a staging stack with LiveKit ports open,
   and record the result.
5. Then, and only then, run the Beta acceptance journeys on the deployed Beta
   environment and perform the smoke checks in `BETA_OPERATIONS.md` §7.

Stop point: this is the end of Phase 1. No Phase 2 work, no public deployment,
and no production database action was performed.
