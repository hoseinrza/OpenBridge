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
| `npm run test:ci` (mobile) | **PASS 11 suites / 81 tests** | Jest + RNTL. |
| `npx expo export --platform android` (mobile) | **PASS** | Hermes bundle `index-f1388b6c8ec19ef4b17675b00a8087e7.hbc` (4.8 MB) plus assets in `dist-ci`. |
| `npm audit --omit=dev --audit-level=high` (backend) | **FAIL** | 11 production findings: 1 critical, 4 high, 6 moderate. Details in §5.1. |
| Docker compose smoke | **NOT RUN** | No Docker on this machine. Last CI run's `4 · Docker images + compose smoke test` job passed. |
| Maestro Android E2E | **NOT RUN** | No Java/emulator locally; latest CI run failed. Details in §5.2. |

### CI state on `main`

Latest run `40198966502` for `5ed3ca1` (2026-10-25T13:44Z):

- Green: change detection, web lint, backend schema/typecheck, backend e2e,
  E2EE gate, mobile unit tests, web build, mobile bundle, Docker compose smoke.
- **Red (blocking): `2e · Mobile E2E (Android emulator)`** → `CI gate` fails.
- **Red (informational): `2c · Dependency audit (backend)`**.
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

### 5.1 Backend production dependency audit (blocking Phase 1 Task 2)

`npm audit --omit=dev --audit-level=high` reports 11 findings:

- **critical** — `tar <= 7.5.20` (multiple path traversal/DoS advisories),
  reached through `@mapbox/node-pre-gyp` ← `bcrypt@5`.
- **high** — `multer` (1.x line) and transitives, `@nestjs/platform-express`
  bundles `multer@1.4.5-lts.1`.
- **moderate** — `qs` (DoS advisories), through Express.
- Other findings: 6 moderate in total.

`npm audit fix --force` proposes `multer@2.5.0` (breaking) and `bcrypt@6`.
Both need a reviewed upgrade and full regression run; no upgrade was applied in
this baseline. The `2c` job is `continue-on-error`, so this does not block CI
today, but the roadmap requires resolving or assessing it.

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
- Because no Java/emulator exists locally, the next step is CI-side
  instrumentation (explicit `adb wait-for-device`, install output, device list,
  and a summary line per phase) and a re-run, not a blind selector change.

### 5.3 Documentation/claims drift

- `docs/SECURITY.md` states CI covers the emulator run; it currently does not
  pass. The document should not imply a green gate until `2e` is fixed.
- `README.md` claims a green CI observation dated 2026-10-21; that is stale.
- The roadmap's Phase 1 Task 2 acceptance is not met while `2e` is red.

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

Next update: after the CI reliability batch.
