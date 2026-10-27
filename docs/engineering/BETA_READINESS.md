# OpenBridge — Beta Readiness Baseline

Date: 2026-10-27
Commit: `c297ee9` (`main`, product version 1.12.1) — this batch adds mobile
attachment sending and the measurement that decides what the `2e` run of that
commit still fails on (1.13.0)
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
`chat` (Socket.IO gateway), `uploads`, `e2ee`, `calls`, plus `common`, `config`,
`prisma`, `redis` (an in-process map, not a Redis client), `maintenance`.
`sms` (OTP delivery) is mounted under `auth`, which is its only consumer.

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
- `health`: `GET /api/health`, `GET /api/health/ready`.

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
| `npm run test:e2e` (backend) | **PASS 113/113** (8.7 s) | Against local PostgreSQL. Includes crypto unit tests, content sealing/opening, legacy import, upload encryption/range serving, and the security, message-action, calls, content-key and client-level E2EE suites. |
| `node --test test/security.e2e.cjs` (backend) | **PASS 41/41** (12.7 s) | Re-run for Phase 1.3 with three new cases: single-use/retired OTP codes, the four accepted phone spellings, and a production-mode boot that must answer `503` with no `testCode`. |
| `npm run test:e2e` (backend), after Phase 1.3/1.4 | **PASS 113/113** | The suite grew by the three OTP cases, an offline-then-reconnect case, and an expired-signed-URL assertion inside the uploads case. |
| `npm run test:ci` (mobile) | **PASS 11 suites / 96 tests** | Jest + RNTL. |
| `npx expo export --platform android` (mobile) | **PASS** | Hermes bundle `index-f1388b6c8ec19ef4b17675b00a8087e7.hbc` (4.8 MB) plus assets in `dist-ci`. |
| `npm audit --omit=dev --audit-level=high` (backend) | **PASS** after upgrade | Baseline was 11 findings (1 critical, 4 high, 6 moderate). After `bcrypt@6`, `multer@2.5.0` and the `body-parser`/`qs` overrides the high/critical count is 0; 6 moderate advisories remain on paths this app does not use (§5.1). |
| Docker compose smoke | **NOT RUN** | No Docker on this machine. Last CI run's `4 · Docker images + compose smoke test` job passed. |
| nginx security headers | **NOT RUN locally** | Added in `nginx.conf` for Phase 1.5; the compose step now asserts `nosniff`, `X-Frame-Options: DENY`, `Referrer-Policy: no-referrer` and no version banner on `/` and `/api/health`. Needs a CI run. |
| Maestro Android E2E | **STILL RED** (next run decides) | All three causes are now identified and fixed in source: `NODE_ENV=development` (`d496992`), the line-by-line `script:` problem (`4601b93`), and the launch crash itself — `App.js` rendered no `SafeAreaProvider`, so `CallOverlay` threw on the first frame (`7ffd0a4` run annotations, fixed in 1.12.1). The fix is proven only by a unit test that reproduces the library's throw rule, not by a device: no emulator here. See §5.2. |
| `npm run test:e2e` (backend), after the SMS provider | **PASS 125/125** (25.4 s) | Was 113/113. The 12 new cases are `backend/test/sms-provider.test.cjs`: receptor normalization, masking, `verify/lookup` vs `sms/send`, gateway-failure handling with no leaked number/key/body, the three `AuthService` delivery rules and the three boot rules. `SMS_PROVIDER` defaults to `none`, so no existing case changed meaning. |
| `npx jest --ci --runInBand` (mobile), after the profile editor + app root | **PASS 16 suites / 128 tests** | Was 11 suites / 96 tests at the baseline audit. New since: `edit-profile-screen.test.js` (11), `app-root.test.js` (1), `chat-attachment.test.js` (11), `use-chat-attachment.test.js` (6), and two cases in `login-screen.test.js` that pin each step's primary action outside the scrollable card. |
| Attachment contract against a running API | **PASS** | Two throwaway accounts, a real JPEG and a real PDF uploaded through `POST /uploads` (server answered `IMAGE` 294 B / `FILE` 45 B), then `message:send` with mobile's exact payload for each: both acked `{ok:true,…}` and both rows came back with the name, size and signed URL stored. The accounts, their conversation, their messages and the two files were deleted afterwards. |
| `npx expo export --platform android` (mobile), with the attachment pickers and the login footer | **PASS** | Hermes `index-2e4c824f0f0fd69c48901514c9781606.hbc` (4.8 MB) plus assets. Proves both pickers, the composer tray and the pinned actions reach the bundle, not that they render correctly on a device. `expo prebuild --platform android --no-install` also runs clean with the new `expo-image-picker` plugin entry. |

### CI state on `main`

Latest run read here: `40495495928` on `c297ee9` (2026-10-27) — the commit that
carried the `SafeAreaProvider` fix — through the public
`commits/<sha>/check-runs` and `check-runs/<id>/annotations` APIs. `gh` is not
installed on this machine, and the job log plus the artifact zip answer
`403`/`401` without a token, so check conclusions, step conclusions and
**annotations** are the evidence available to an unauthenticated agent.

- Green (11): change detection, web lint, backend schema/typecheck, backend e2e,
  E2EE gate, dependency audit (root and backend), mobile unit tests, web build,
  mobile bundle, Docker compose smoke.
  Caveat on the audit: `2c` is declared with `continue-on-error: true`
  (`.github/workflows/ci.yml:190`), so its `success` conclusion is not evidence
  that `npm audit --omit=dev --audit-level=high` exited 0 — a failing audit would
  still show green here. It closes nothing by itself.
- **Red (2, one cause):** `2e · Mobile E2E (Android emulator)` (check-run
  `122160079214`) fails at `Run Maestro on the emulator`; `CI gate` fails because
  it needs that job. The deploy job is `skipped`, as it must be while the gate is
  red.
- Inside job `2e`, the backend builds, boots, answers `health/ready`, the seeder
  creates the E2E users and the APK installs. The failure is the app on the
  emulator, not the pipeline around it (§5.2).
- **The launch crash is gone, and the annotations say so.** The same warning is
  absent this time, `flow output after the failure:` came back empty — no
  `AndroidRuntime` or `ReactNativeJS` line was produced — and the journey reached
  its eighth step instead of its second: `Attempt 1: [Failed] auth-and-chat (57s)
  (Element not found: Id matching regex: login-submit)`.
- Reaching that step is itself evidence, for the first time in this job's
  history: to be sitting on the code screen the app had to paint the login
  screen, accept the phone number, call `POST /auth/otp/request` across
  `10.0.2.2`, and read the returned `testCode` out of `login-test-code` — the
  `copyTextFrom` before the failing step succeeded. So the emulator↔API path and
  the first two wizard steps are now proven on a device by CI.
- What is left failing is one element: the code step's primary action, while the
  nodes around it were all found — including `login-request-code`, the same
  widget type one step earlier, so this is not testID plumbing. `login-submit` is
  an unconditional sibling of `login-code` and `login-test-code`, both of which
  the run did find, so it was mounted and the device had simply clipped it: with
  the numeric keyboard open, the CTA sits below the fold of the shrunk
  `ScrollView`. That is a reachability flaw for a real finger too, not only for
  Maestro, so the batch changes the product rather than the journey — every
  step's primary action moves to a footer pinned outside the scroller (§5.2),
  demanded by two tests that were red before it — and adds the measurement that
  lets the next run confirm the reasoning from the outside: on failure the runner
  dumps the uiautomator hierarchy and annotates every testID the device actually
  had, with its bounds, how many nodes the device itself marked not visible, the
  screen size and `mInputShown` (`.github/scripts/mobile-e2e-hierarchy.mjs`).

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
  settings/theme, profile editing (name, handle, bio), text/voice/photo/file
  messages in both directions, locked state for legacy-encrypted chats, calling
  UI (mobile cannot join encrypted calls).

### Implemented, but not verified in this audit

- Android bundle and on-device behavior: the bundle is green in CI, and since
  `c297ee9` part of the app is proven *on* the emulator — the login screen
  paints, the phone step reaches the API and the code step reads its `testCode`
  back. Not proven on a device: the chat journey past that code screen, the
  profile editor, and every surface this batch touches (attachment tray, photo
  and file send) — nor the login wizard's new pinned action row, which is the fix
  for what Maestro still reports red (§5.2). The journey itself has never got
  past the code step on a device.
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
- No SMS credentials: the Kavenegar gateway is implemented and stub-tested, but
  no account is configured anywhere, so with the default `SMS_PROVIDER=none`
  development OTP is returned as `testCode` and production returns 503. No real
  code has ever been delivered to a phone from this codebase.
- Signed attachment URLs are bearer capabilities until expiry.
- Redis is declared in compose but unused; `RedisService` is an in-process map.
- Web stores access and refresh tokens in `localStorage`.
- Message edit/delete are covered; reactions and attachments are intentionally
  blocked in legacy-encrypted chats.

### Deferred (documented, not planned for Beta)

- A paid SMS account and the first real OTP delivery. The provider itself is no
  longer the missing piece - `SMS_PROVIDER=kavenegar` plus credentials is - but
  Phase 1 forbids paid services, so nothing has been sent for real and the
  gateway path has only ever met a stub.
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
- `npm run build` PASS; `npm run test:e2e` **113/113** PASS; a direct
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

### 5.2 Android Maestro E2E (four causes: three proven gone on the device, the fourth fixed in source)

The job has failed for four independent reasons, found one at a time because
each one hid the next. Run `40490417370` on `7ffd0a4` is the evidence for the
third; run `40495495928` on `c297ee9` is the evidence that all three are gone —
that journey no longer dies on the first frame and now runs for 57 seconds,
through the phone step and into the code step. Its annotation is the evidence for
the fourth.

1. **`NODE_ENV` disabled test mode** (fixed in `d496992`). With `test`/`production`
   the seeder got no `testCode`, created no users, and Maestro had nothing to
   drive. The seed step now passes.
2. **The emulator runner executes `script:` line by line** (fixed in `4601b93`).
   The multi-line summary block died with `Syntax error: end of file unexpected
   (expecting "}")` before Maestro started; the flow now lives in
   `.github/scripts/mobile-e2e-run.sh` and is invoked as one command.
3. **The app crashed on its first frame** (found in the `7ffd0a4` annotations,
   fixed in 1.12.1 and proven gone on `c297ee9`). `mobile/App.js` rendered `SettingsProvider` at the root
   and no `SafeAreaProvider` anywhere above it, while `CallOverlay` — mounted
   permanently by `AppShell`, next to the navigator, not behind any screen —
   calls `useSafeAreaInsets()` unconditionally. In
   `react-native-safe-area-context` v5 that hook throws when no provider is
   above it, so the React Native JS thread died before the login screen could
   paint. That is precisely the pair of symptoms the annotations reported: the
   process gone within five seconds of `am start`, and the flow's title
   assertion false. The same crash also made the unauthenticated screen
   unreachable for a real user, so this was an app bug that CI happened to be
   the only witness to.
4. **The code step's confirm button could not be tapped** (found in the
   `c297ee9` annotations, fixed in 1.13.0). `Element not found: Id matching
   regex: login-submit`, while `login-phone`, `login-request-code`, `login-code`
   and `login-test-code` had all been found minutes earlier. Since
   `login-submit` is an unconditional sibling of two nodes the run *did* find, it
   was mounted — the device had simply clipped it: the code step is the tallest
   step, the IME shrinks the `ScrollView`, and the button sat at the tail of the
   card, below the fold. A user with a small screen and the keyboard up hits the
   same wall, so the action moved out of the scroller into a pinned footer.

Why no test caught it: `mobile/jest.setup.js` mocks
`react-native-safe-area-context` with a `useSafeAreaInsets` that returns zeros
whether or not a provider exists, so every screen test in the repo was blind to
this class of bug by construction. `mobile/__tests__/app-root.test.js` closes
that hole by overriding the setup mock with the library's real rule — reading
the insets with no provider mounted throws — and then rendering the actual
`App`. It also asserts the login screen is reachable, so a root that paints
nothing but a provider would not pass either.

The test was checked in both directions, not just green-once: with the wrapper
removed from `App.js` it fails with the emulator's own message —
`No safe area value available. Make sure you are rendering `<SafeAreaProvider>`
at the top of your app.` — and with the fix in place the whole suite passes
(14 suites, 109 tests at that commit; 16 suites / 126 tests as of 1.13.0). That
is as close to a device as this machine gets; it is still not a device.

Claimed earlier in this document, and wrong: that cause 1 was *the* root cause
and that the job was "expected to pass" after `d496992`; and that the emulator
API URL should be `http://127.0.0.1:3000/api`. Inside the emulator that address
is the device itself, so no request could ever reach the API on the runner host —
it is back to `http://10.0.2.2:3000/api`, the emulator alias for the host.

Instrumentation landed so far (`mobile-e2e-run.sh`, all phases reported
separately): SDK level, Maestro version, `boot_completed`, `adb devices -l`; a
missing APK is an explicit error listing the output directory; `adb install`
output is echoed and a non-zero exit annotates the failure with logcat; a launch
smoke (`am start -n com.openbridge.mobile/.MainActivity`, `pidof`, screenshot,
logcat) distinguishes "install ok, app crashes" from "the flow is wrong";
`maestro test` writes `--debug-output` for both attempts; the artifact includes
the launch screenshot/log, install log, debug output and launch logcat.

On this batch the crash reason also leaves the log: the launch smoke and the
failed flow now emit the `AndroidRuntime`/`ReactNativeJS`/`ActivityTaskManager`
lines as **annotations**, which - unlike the job log and the artifact zip, both
of which answer `401`/`403` without a token - are readable through the public
`check-runs/<id>/annotations` API. That is how cause 3 was found.

Status: **causes 1–3 are proven gone on the device, and cause 4 is fixed in
source.** That fix is a deduction rather than a guess: inside the code step,
`login-code` and `login-test-code` are siblings of `login-submit` with nothing
conditional between them, and the run found both of those — so the button was
mounted, and a mounted node Maestro cannot tap is a node the device reported as
not visible. Why it was out of sight is the layout: the code step is the tallest
of the four, the IME shrinks the `ScrollView`, and the primary action sat at the
tail of the card, below the fold — a reachability problem for a real finger, not
only for a robot. So the product changed rather than the journey: every step's
primary action, with its secondary link, now renders in a footer outside the
scroller, where the same resize lifts it above the keyboard instead of burying
it, the way Telegram's continue button behaves.
`mobile/__tests__/login-screen.test.js` gained the two cases that demanded it —
written first and watched to fail while the action was still inside
`login-scroll` — and the markers they read (`login-scroll`, plus
`login-username-next` and `login-signup` on the two signup buttons) are new.
Mobile Jest 128/128; the Android bundle re-exports clean with the change. The
hierarchy annotation ships alongside it, so the next run reports the button's
actual bounds instead of leaving this reasoning to be re-derived: if the journey
still stops there, the annotation says why in one line.

### 5.3 Documentation/claims drift — corrected

- `docs/SECURITY.md` no longer implies the emulator run passes; it states the
  job is red and links here.
- `README.md`'s "CI is green" observation (2026-10-21) is replaced with the
  2026-10-25 state: everything green except `2e`/`CI gate`.
- The roadmap's Phase 1 Task 2 acceptance is still not met while `2e` is red.
  The instrumentation claim is now evidence rather than a hope: it ran on
  `main`, and its annotations are what named the launch crash (§5.2).

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
| Send attachments | yes | yes (added here) | Both upload through `POST /uploads` and then send `message:send` with the type the server reported. Mobile picks with `expo-image-picker` (photos) and `expo-document-picker` (files). Proven by unit tests and by replaying the exact payload against a running API (§8), not on a device. |
| Voice messages | yes | yes | Both record and play; mobile sends `VOICE` with the measured length. |
| Reactions, read receipts, typing | yes | yes | Same socket events. |
| Reply | yes | yes (added here) | New two-row action tray and quote rendering; the send carries `replyToId`. |
| Edit | yes | yes (added here) | `message:edit` over the socket; the row shows the edited mark. |
| Delete for me / for everyone | yes | yes (added here) | Confirmation sheet offers everyone only on an own message; scopes match the server. |
| Forward | yes | **no** | Needs a target picker that does not exist on mobile. |
| Search | conversation search | chat-list search only | No in-chat search field on mobile. |
| Profile | view and edit | view and edit | Mobile now has the editor for name, handle and bio (`mobile/src/screens/EditProfileScreen.js`). Avatar picking is still missing: the picker dependency this needed is installed as of 1.13.0, but no avatar UI calls it yet. |
| Device/session management, security alerts | yes | **no** | No mobile screen calls `/auth/sessions` or `/auth/security-events`. |
| Theme | light, dark | system, light, dark | Mobile adds "follow the system". |
| Calls | audio and video, encrypted media for new calls | audio and video, refuses encrypted calls | The refusal is explicit and documented; the key is server-held. |
| Contacts | user search | user search plus device contacts | Mobile can import the phone's address book. |

Added in this phase: the mobile client now hears `message:edited`, so a message
changed on the web no longer keeps its old text until the screen is reopened;
it renders quotes and edited marks; and it can reply, edit and delete from the
long-press tray. Covered by `mobile/__tests__/use-chat-reply.test.js` and
the new cases in `mobile/__tests__/chat-screen.test.js` (suite: 96/96). The
Android JS bundle also exports successfully, and the web lint/build still pass.

Editing the profile closed since: `mobile/src/screens/EditProfileScreen.js`
PATCHes `/users/me` with the fields and the validation rules the web modal
applies, and the server's reply is stored through `AuthContext.saveProfile`.
Covered by `mobile/__tests__/edit-profile-screen.test.js` (mobile Jest 108/108),
with the request and reply shape checked against a running API.

Sending attachments closed since, on Android as on web: the composer gained a
paperclip that opens a two-item tray (`mobile/src/screens/ChatScreen.js`), the
pickers are `expo-image-picker` for photos and `expo-document-picker` for files,
and `sendAttachment` in `mobile/src/hooks/useChat.js` uploads through the
endpoint a recording already used and then emits `message:send` with the
**server's** type rather than a mimetype guessed on the phone. The gallery
permission ask is kept because it is not decoration on older devices — reading
the module source (`getMediaLibraryPermissions`, `expo-image-picker@57.0.20`)
shows it requests nothing at all from Android 13 up, where the system photo
picker needs no storage permission, and the legacy read/write storage pair
below that. Covered by
`mobile/__tests__/chat-attachment.test.js` (11 cases: the tray opening and
closing, the locked composer, the permission ask and its refusal, a document
picked without one, the extension filling a missing mimetype, a cancelled pick,
the server's own words on a refusal, the quoted send, the resting button)
and `mobile/__tests__/use-chat-attachment.test.js` (6 cases: the payload shape,
a group target, a quote, a refused upload, a locked chat) — mobile Jest
126/126. The same payload was replayed against a running API with a real JPEG and
a real PDF: both uploads came back `IMAGE`/`FILE`, both sends were acked, and the
stored rows carried the file name and size they were sent with. The probe users
and their rows were deleted afterwards.

Remaining gaps that touch the Beta acceptance list: **the profile avatar still
cannot be chosen on mobile** — the picker dependency now exists, but no avatar UI
was added, so a picture stays a web-side action — **forwarding** needs a target
picker, and **no mobile screen has been looked at on a device**; the rest are
conveniences or web-only administration. Maestro drives only the text journey,
so an attachment send is proven by unit tests plus the API contract, not by the
emulator flow.

`docs/engineering/UI_UX_REDESIGN.md` is stale about group administration (it
says "absent at the API level"); the API now has participant add/remove, but
neither client has UI for it.

### 5.8 Calling verification (Phase 1 Task 8)

The lifecycle suite (`backend/test/calls.e2e.cjs`, 11 cases, part of the
113-case `npm run test:e2e` run) exercises the server side of calling without
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

### 5.11 `CONTENT_KEY` setup state (2026-10-27)

The at-rest key is now configured in every environment this machine can reach,
and one claim in `README.md` was checked against the code rather than repeated:

| Environment | Key | Verified how |
|-------------|-----|--------------|
| Local dev API (`backend/.env`) | already present, base64 → 32 bytes, canonical | `loadContentKey` accepts it; a live `ContentCrypto` round-trip sealed text to an `obx1.<iv>.<tag>.<ct>` envelope containing no plaintext, reopened it, threw on the wrong conversation id, and round-tripped a file with the `OBX1` magic |
| Local compose stack (root `.env`) | created, set to the **same** value as `backend/.env` | written from `.env.example` with every `change-this` placeholder replaced; gitignored (`git check-ignore` → `.gitignore:24`). The stack itself was **not** started: no Docker on this machine |
| CI | fixed CI-only value in `.github/workflows/ci.yml` | unchanged from 1.10.9; the job database is disposable |
| VPS / Beta | not set | `deploy.sh` `ensure_env` generates `openssl rand -base64 32` on a fresh install, and on an existing `.env` appends one only when the line is absent — it never rotates. Reaching the server needs SSH secrets this machine does not have, so this remains open |

`npm run test` on `backend/test/content-crypto.test.cjs` → 8/8, including the
case that a 32-byte base64 key is the only accepted form.

Claim correction: `README.md` says the decoded length is "checked at startup".
That is true of `loadContentKey` (`backend/src/common/content-crypto.ts`), which
`ContentCrypto` calls during module construction, and which also rejects
non-canonical base64 — not of `env.ts`, which only requires the variable to be
non-empty. A placeholder value therefore fails at boot instead of sealing rows
under a key derived from garbage. `BETA_OPERATIONS.md` §2.1 records the
key-per-environment table and the backup rule: a `pg_dump` restored without its
matching `CONTENT_KEY` boots and answers, and shows every sealed message as
undecryptable.

What is **not** closed by this: production `prisma db push`, the legacy envelope
hand-back that waits on a key-holding web device, and any on-device check. Key
rotation and recovery remain deliberately absent (§4).

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
   codes or fall back to test mode - including with a gateway configured, since
   test mode requires `SMS_PROVIDER=none` as well as a non-production `NODE_ENV`.
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
| 2026-10-25 | Dependency upgrade (`bcrypt@6`, `multer@2.5.0`, `body-parser`/`qs` overrides) | `npm run build` PASS; `npm run test:e2e` 113/113; `npm audit --omit=dev --audit-level=high` exit 0; `npm ls` shows the pinned versions. §5.1 |
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
| 2026-10-26 | Merge `beta/phase-1` to `main` | Commit `40224f6`, product version 1.10.11; all checks pass locally; CI pending. §9 |
| 2026-10-26 | Fix Maestro E2E `NODE_ENV` | Set `NODE_ENV=development` in `.github/workflows/ci.yml`; the seeder step does pass now. The "expect green" half of this entry was wrong - see the two 2026-10-27 rows. §5.2 |
| 2026-10-27 | `CONTENT_KEY` setup | Local `backend/.env` key verified by a live seal/open round-trip; root `.env` created for the compose stack with the same value; `deploy.sh` generation and the never-rotate rule confirmed from source; `content-crypto.test.cjs` 8/8. README's "checked at startup" claim traced to `loadContentKey`, not `env.ts`. VPS key and compose run still unverified. §5.11 |
| 2026-10-27 | Maestro script moved out of `ci.yml` | Commit `4601b93`: `android-emulator-runner@v2` runs each `script:` line in its own `sh`, so the multi-line block died with a syntax error before Maestro started. The flow is `.github/scripts/mobile-e2e-run.sh`, invoked as one command. Also reverts the `127.0.0.1` API URL this document had recommended, back to `10.0.2.2`. |
| 2026-10-27 | CI read without a token | `commits/8be1651/check-runs` → 11 green, `2e` + `CI gate` red; `actions/jobs/122110899448` → step 18 `Run Maestro on the emulator` is the only failing step; its annotations report `app process not running five seconds after launch` and `Attempt 1: [Failed] auth-and-chat (28s)`. Job logs and artifact zips need a token (`403`/`401`). §5.2 |
| 2026-10-27 | Crash reason made readable from outside the log | `.github/scripts/mobile-e2e-run.sh`: an `annotate` helper emits single-line workflow commands; the launch smoke now carries the `am start` output plus `AndroidRuntime`/`ReactNativeJS`/`ActivityTaskManager` lines, and a failed flow adds the last ten JS/native crash lines. `bash -n` clean. |
| 2026-10-27 | Kavenegar OTP delivery | `SMS_PROVIDER` + `KAVENEGAR_*` in `env.ts` with three boot rules; `SmsProvider` interface, `KavenegarSmsProvider` (`verify/lookup` or `sms/send`, 15 s timeout, masked logs), `SmsModule` under `AuthModule`, delivery inside `AuthService.requestOtp` with consume-on-failure and a 502. `npm run test:e2e` → 125/125 (12 new cases). Compose, both `.env.example` files, `README.md` and `BETA_OPERATIONS.md` §3 document it. No real gateway call has been made. |
| 2026-10-27 | Mobile profile editor | `mobile/src/screens/EditProfileScreen.js` — name, handle and bio, with the phone number shown as identity rather than an input; reached from Settings → ویرایش پروفایل. `AuthContext.saveProfile` stores the server's reply instead of merging locally. Mobile Jest 108/108; `PATCH /users/me` exercised against a running API (200 with a recomputed `displayName`, empty `lastName` clears it, 400 for a name holding a digit). Never rendered on a device. §5.7 |
| 2026-10-27 | Launch crash found in the annotations | `commits/7ffd0a4/check-runs` → 11 green, `2e` + `CI gate` red (run `40490417370`, job `122142965122`). `check-runs/122142965122/annotations` → `app process not running five seconds after launch` carrying `E ReactNativeJS: { [Error: No safe area value available...` with a `componentStack` naming `CallOverlay` inside `CallProvider` → `SocketProvider` → `AuthProvider` → `AppShell` → `SettingsProvider` → `App`, plus `Attempt 1: [Failed] auth-and-chat (24s)`. Log and artifact still `403`/`401`. §5.2 |
| 2026-10-27 | SafeAreaProvider added at the app root | `mobile/App.js` wraps `SettingsProvider` in `SafeAreaProvider`; `mobile/__tests__/app-root.test.js` overrides the `jest.setup.js` mock with the library's real throw rule and renders the actual `App`. Checked in both directions: removing the wrapper makes that test fail with the emulator's own message, restoring it gives 14 suites / 109 tests green and a `expo export --platform android` PASS. The device run is still pending. §5.2 |
| 2026-10-27 | Mobile attachment sending (1.13.0) | `mobile/src/hooks/useChat.js` gains `sendAttachment`: upload through the endpoint a voice message already used, then `message:send` with the type **the server** reported. `mobile/src/screens/ChatScreen.js` gains the paperclip (`composer-attach`), a two-item tray (`attach-image`, `attach-file`) and the two pickers; `expo-image-picker@~57.0.20` and `expo-document-picker@~57.0.3` added to `mobile/package.json`, with a `photosPermission` string in `mobile/app.json`. New tests: `chat-attachment.test.js` (11) and `use-chat-attachment.test.js` (6) → mobile Jest **126/126, 16 suites**; `expo export --platform android` → `index-0f640d1c3c6daa4dda912ea144dc184f.hbc` (4.8 MB); `expo prebuild --platform android --no-install` exits 0 with the plugin entry; root `npm run lint` clean. §5.7 |
| 2026-10-27 | Attachment contract replayed on a running API | Throwaway accounts, a real JPEG and a real PDF: `POST /uploads` returned `IMAGE` and `FILE`, and the exact payloads `sendAttachment` emits were acked (`{"ok":true,"id":…}`) with the stored rows carrying the sent file name and size. Test accounts, their messages, conversations and uploaded bytes were deleted afterwards, and the probe script removed from the tree. This is the API half of the claim; no device has held the app. §5.7 |
| 2026-10-27 | `2e` read on `c297ee9`: the crash cause is gone | Run `40495495928`, check-run `122160079214` → `completed failure`; annotations carry `Attempt 1: [Failed] auth-and-chat (57s) (Element not found: Id matching regex: login-submit)`, no `app process not running` warning, and an empty `flow output after the failure:` — so nothing crashed and the journey now reaches the code step, which additionally proves the emulator↔API path and the `testCode` read on a device. 11 other checks green, `CI gate` red, deploy skipped. Logs/artifacts still `403`/`401`. §3, §5.2 |
| 2026-10-27 | Hierarchy annotation added | `.github/scripts/mobile-e2e-hierarchy.mjs` + its call in `mobile-e2e-run.sh`: a failed run dumps `uiautomator`, and one annotation carries every resource-id with bounds, the count of nodes the device marked not visible, `wm size` and `mInputShown`; `hierarchy.xml` joins the artifact list. Checked against a captured dump shape (both `pkg:id/name` and bare ids, real `[x,y][x,y]` bounds) and `bash -n` clean on the runner. It turns the next `2e` failure into a fact instead of a guess. §5.2 |
| 2026-10-27 | Login wizard's primary actions pinned | `mobile/src/screens/LoginScreen.js`: the four steps' confirm/continue buttons and their secondary links left the `ScrollView` and moved into a footer (`login-actions`) that the IME resize lifts instead of hiding; `login-scroll`, `login-username-next` and `login-signup` added as markers. `mobile/__tests__/login-screen.test.js` grew two cases — first red with the action inside the scroller, green after the move — and the suite is **128/128, 16 suites**; `expo export --platform android` → `index-2e4c824f0f0fd69c48901514c9781606.hbc`. Not yet seen on a device; the Maestro journey still taps `login-submit` by id, unchanged. §5.2 |
Next update: read the `2e` run of this batch. If it clears the code step, the
next suspects are the chat surfaces the journey has never reached — the reaction
tray, the profile tabs, and the composer that now carries a paperclip — and the
hierarchy annotation will say in one line whether anything else is being clipped
the way the button was. If it still stops at login, that same annotation is the
diagnosis. Either way: the avatar picker is the next UI gap worth closing, and
neither attachments, the profile editor, nor the reply/edit/delete tray has been
held on a real phone yet.

---

## 9. Phase 1 acceptance run and gate decision (updated 2026-10-27)

The commands below were run on commits `cde3087` (initial run, version 1.10.10)
and `d496992` (merged `beta/phase-1`, version 1.10.11) on this machine, against
the local PostgreSQL. The mobile, Maestro and CI rows have since been refreshed
with this batch's runs (version 1.12.x); every other row is still the
`d496992` observation, and §3 carries the newest number for each check. The
mobile rows are 1.13.0's; the CI rows are `c297ee9`'s run.

| Check | Command | Result |
|-------|---------|--------|
| Web lint | `npm run lint` | PASS (ESLint, no findings) |
| Web build | `npm run build` | PASS (Vite, chunk-size warning only) |
| MLS library gate | `npm run test:e2ee` | 17/17 |
| Backend schema | `npx prisma validate` | valid |
| Backend types/build | `npm run build` (inside `test:e2e`) | PASS |
| Backend e2e | `npm run test:e2e` | 125/125 across 13 files, including production-mode OTP, cross-user access, calling, health, maintenance and the SMS provider rules (113/113 before the gateway was wired) |
| Mobile unit/component | `cd mobile && npm test -- --ci` | 128/128, 16 suites (was 109/109, 14 suites) |
| Mobile bundle | `npx expo export --platform android` | PASS (Hermes `index-2e4c824f0f0fd69c48901514c9781606.hbc`, 4.8 MB) |
| Local API | `GET /api/health/ready` direct and through the Vite proxy | 200 `{status:'ok',db:'up'}` |
| Web dev shell | `GET http://127.0.0.1:5173/` | 200 with `<div id="root">` |
| Dependency audit | `npm audit --omit=dev --audit-level=high` (root) | **blocked**: `ECONNRESET` from the npm registry; no dependency changed since the clean 1.10.2 audit |
| Docker compose smoke | — | **not run**: no Docker on this machine |
| Android Maestro | `bash .github/scripts/mobile-e2e-run.sh` in CI | **STILL RED** on `main`: the seeder and install steps pass, and the launch crash it reported (`No safe area value available`) is now fixed in source with a regression test. Not re-run yet - this machine has no emulator (§5.2) |
| CI on `main` | `check-runs` API | `40490417370` on `7ffd0a4`: 11 green, `2e` + `CI gate` red, deploy `skipped` |

### Gate decision

**The Beta gate is not met.** The engineering work for Phase 1 is complete and
every locally runnable check is green, but four criteria remain open, and none of
them can be closed by writing more code in this environment:

1. **Criterion 1 (core journeys on both clients)** — mobile now sends
   attachments (photo and file) as well as text and voice, so the parity gap this
   criterion named is closed in code and covered by tests; what is still missing
   is the device side of it: neither the attachment tray, nor the profile editor
   that landed, nor the reply/edit/delete tray has ever been seen on a phone
   (§5.7). Choosing a profile avatar is still a web-only action. Forwarding has
   no mobile UI at all. Supported calls have never been exercised end to end:
   only token minting, lifecycle and webhook paths are proven (§5.8).
2. **Criterion 2 (all checks in CI)** — no longer about CI existing: pushes to
   `main` run the full workflow and 11 of 13 checks are green there, including
   the Docker/compose smoke that cannot run on this machine. It is open only
   because `2e` is red and `CI gate` therefore fails (§3, §5.2).
3. **Criterion 3 (Maestro or a reviewed replacement)** — still red on `main`,
   and the reason has changed: the launch crash is now **proven fixed on the
   emulator**, because `c297ee9`'s run paints the login screen, takes the phone
   number, calls the API and reaches the code step (57 s versus 24 s to failure,
   no crash line at all). What failed then is one element — `login-submit`, not
   found while its own siblings were — and that pins it: the button was mounted
   and the device had clipped it, because the open keyboard left the tail of the
   card below the fold. A reachability flaw for a real finger as well as for
   Maestro, so the action is now pinned outside the scroller, by two tests that
   were red first. One green run still closes the criterion (§5.2).
4. **Criterion 4 (no unresolved high/critical finding)** — CI's `2c` shows green
   on `main`, but it is a `continue-on-error` job, so that conclusion is not
   evidence (§3). The last locally verified production audit is the clean
   1.10.2-era one in §5.1; the registry was unreachable from here on later
   attempts.

Criteria 5–9 are met: development OTP works without SMS and production refuses
to issue codes; encryption claims match the server-held model; limitations,
setup, backup/restore and rollback are documented; a release checklist exists;
and no Beta or production deployment has been presented as ready.

What would close the gate, in order:

1. Read the `2e` run of this batch. The clipped button is fixed, so the journey
   should get past the login wizard and onto the chat surfaces it has never
   reached on a device — the reaction tray, the profile tabs, and a composer that
   now carries a paperclip. Whatever it reports next arrives as an annotation with
   the device's own bounds, so a fifth cause would be named rather than inferred.
2. Re-run the dependency audit from a network that reaches the registry.
3. Give the profile avatar its picker. `expo-image-picker` arrived with
   attachments, so this is UI work only; then look at the profile editor, the
   attachment tray and the reply/edit/delete tray on a device or emulator.
4. Perform one real two-party call on a staging stack with LiveKit ports open,
   and record the result.
5. Then, and only then, run the Beta acceptance journeys on the deployed Beta
   environment and perform the smoke checks in `BETA_OPERATIONS.md` §7.

Stop point: this is the end of Phase 1. No Phase 2 work, no public deployment,
and no production database action was performed.

