# OpenBridge — Engineering Progress Log

Session date: 2026-10-19

## Baseline (before this session)

- `main` had one unpushed group-chat commit (`40faf3c`) and no tests.
- Backend: NestJS 10 + Prisma 5 + PostgreSQL, no Jest/test setup, no lint script.
- Web: React 19 + Vite 8; `npm run lint` reported 320 problems (313 errors),
  mostly pre-existing React 19 rule violations.
- Verified security concerns: hardcoded `JWT_SECRET ?? 'secret'` fallbacks,
  `origin: true` CORS, unauthenticated `conversation:join`, reactions without
  membership checks, statically served uploads, unvalidated socket payloads,
  unbounded pagination, no HTTP DTOs for group endpoints.

## Completed and pushed

| Commit | Change |
|--------|--------|
| `40faf3c` | Group chat support: schema reuse, validated group creation, real-time events |
| `aaad488` | Required `JWT_SECRET` (fail fast, min 32 chars in production), origin allowlist for HTTP + Socket.IO, `.env.example` updates |
| `4c98526` | Socket authorization: removed unauthenticated room join, membership-checked reactions (derived from the message), validated message payloads, per-socket rate limits, 256 KB packet cap, multi-socket presence |
| `4aa9a6d` | HTTP DTOs for groups/membership, UUID route params, bounded `take`/`skip`, self-chat and unknown-recipient rejection, avatar path validation |
| `d98a3b0` | Private uploads: static serving removed, signed expiring URLs issued at API boundaries, HMAC download verification, type allowlist, image magic-byte checks, upload rate limit, signed URL resolution in web/mobile |
| `9efe0e4` | Automated security regression suite, CI workflow, security model documentation, progress log |
| `c9a2f5c` | HTTP fixed-window rate limiting for register/login/refresh per IP and per username; `TRUST_PROXY` support; 429 + `Retry-After`; env-tunable limits |
| `0897cff` | Server-side `Session` rows with revoked-session enforcement on HTTP and socket; rotating SHA-256-hashed refresh tokens; session list/revoke endpoints; transparent single-flight refresh on web and mobile |
| `4b3fa60` | Optional ClamAV malware scanning for uploads over clamd INSTREAM, fail-closed on scanner errors, infected files deleted; documented as opt-in |
| `d22840a` | Web lint baseline fixed (hooks/state/ref rules) and ESLint scoped to the web app; CI now runs lint before the production build |
| `0ce88a0` | E2EE design proposal: Signal Protocol vs MLS evaluation, recommendation and decision gate, key management, multi-device, migration, threat model, open questions. No crypto implemented |
| `fd25292` | Web UI redesign: local Vazirmatn, design tokens, light/dark themes, RTL, rebuilt login/sidebar/chat/composer/modals, accessible controls, message ack and history retry |
| `04c5719` | Mobile redesign: aligned tokens and dark theme, rebuilt login/list/chat, group creation parity, safe areas, brand assets, navigation theming; unused video-call placeholder removed |

## UI/UX redesign (2026-10-20)

Full detail, token tables, and limitations: `docs/engineering/UI_UX_REDESIGN.md`.

- Web now declares `lang="fa" dir="rtl"` and uses a token system in
  `src/index.css` for a warm light theme and an AA-checked dark theme. Theme is
  applied before first paint and persisted in `openbridge_theme`.
- Sidebar, chat header, message list, composer, emoji picker, login, profile,
  new-chat, and confirmation modals were rebuilt around those tokens. Icon-only
  controls have accessible names; tabs implement keyboard navigation; focus is
  visible; errors are announced.
- Web chat send now waits for the server ack and shows upload/send errors;
  history loading failures show a retry action instead of an empty transcript.
- Mobile mirrors the palette in `mobile/src/theme.js`, follows system light/dark,
  and rebuilds login, chat list, and chat with safe-area handling, RTL bubbles,
  history retry, typing/read states, and a 44 px target baseline. A new-group
  screen searches users and creates real groups through the existing API.
- Brand icon, splash, favicon, and Android adaptive layers were replaced with
  the bridge glyph; the splash and navigation colors match both themes.

Verification for this sprint:

- Web QA at 320×720, 375×812, 430×932, 768×1024, 1024×768, 1440×900, and
  1920×1080 in light and dark: horizontal overflow 0, console errors 0,
  unlabeled buttons 0, missing image alts 0, contrast audit empty. Live socket
  send, search, theme toggle, logout confirmation, and login tab keyboard
  navigation were exercised.
- Mobile UI was rendered with react-native-web in headless Chrome at 390×844
  (login, list, chat, new group; light and dark): overflow 0, console errors 0,
  0 unlabeled buttons, no labeled chat control below 44 px. Real messages and
  session restoration worked. `expo export --platform android` succeeded.
- `web`: lint clean; production build 78 modules. `backend`: 11/11 e2e tests.
- QA users, group, messages, sessions, and scratch scripts/screenshots were
  deleted after the run. No seed/demo data was added.

Known gaps for this sprint:

- Mobile was not run on a native emulator/device; react-native-web is close but
  not identical (native header RTL placement and safe areas remain unverified).
- No visual-regression suite is committed; viewport audits were manual.
- Font Awesome still loads from a CDN (blocks a strict CSP/offline PWA).
- E2EE is still not implemented and video calls remain absent.

## Phone OTP authentication (2026-10-20)

The primary login flow is now an Iranian mobile number plus a one-time code.
Legacy username/password login is kept for existing accounts, but registration
UI is gone — new accounts are created by verifying an OTP. (The password
endpoint and its UI were removed in the follow-up below: the phone number is
now the only way in.)

- **Normalization** (`backend/src/common/phone.ts`, mirrored in
  `src/utils/phone.js` and `mobile/src/utils/phone.js`): accepts
  `09xxxxxxxxx`, `+989…`, `00989…`, `989…`, and `9xxxxxxxxx`, converts Persian
  and Arabic digits, strips separators, and canonicalizes to `^09\d{9}$`.
- **Endpoints**: `POST /auth/otp/request` and `POST /auth/otp/verify`
  (`backend/src/auth/`). Codes are 6 random digits (`randomInt`), stored only
  as an HMAC-SHA256 digest keyed with `JWT_SECRET`, compared with
  `timingSafeEqual`, expire after `OTP_TTL_SECONDS` (300 s), and are locked
  after `OTP_MAX_ATTEMPTS` (5) wrong entries. A new request consumes prior
  unconsumed codes; verification consumes the code conditionally so a code is
  single-use under races. Requests are throttled per IP
  (`AUTH_OTP_REQUEST_LIMIT`) and per phone number
  (`AUTH_OTP_REQUEST_PHONE_LIMIT`) with 429 + `Retry-After`.
- The normalized phone is stored in a dedicated unique `users.phone` column
  (usernames are user-chosen at signup since the follow-up section below);
  phone accounts get a random 32-byte password so the legacy password endpoint
  cannot be used to take them over. `isNewUser` verification
  requires a display name (2–50 chars) and creates the account with a normal
  `withSession` response (session row + access JWT + rotating refresh token).
- **Test mode**: until an SMS provider is integrated, the code is generated
  server-side and returned in the response **only outside production**
  (`OTP_TEST_MODE`). With `NODE_ENV=production`, `POST /auth/otp/request`
  returns 503 («ارسال پیامک هنوز فعال نشده است») and never creates a code.
  Both web and mobile show the test code in a clearly labelled box
  («کد تست (فقط محیط توسعه)») with the same flow as production.
- **Web** (`src/components/Auth/LoginPage.jsx`): two-step form (phone → code),
  Persian-digit input handling, `autocomplete="one-time-code"`, 30 s resend
  countdown, «تغییر شماره» link, required display-name field for new users,
  and a legacy «ورود با نام کاربری و رمز» mode for old accounts (since
  removed — see the second follow-up below).
- **Mobile** (`mobile/src/screens/LoginScreen.js`): the same two-step flow with
  `phone-pad`/`number-pad` keyboards, `textContentType`/`autoComplete="sms-otp"`
  hints, live-region test-code box, and the same legacy password mode.

Verification for this batch:

- `backend`: `npm run build` passed and `npm run test:e2e` is now **14/14**,
  including three new OTP tests: full lifecycle (invalid phone 400, `+98`
  normalization, wrong code 401, missing display name 400, successful verify,
  single-use rejection, `/users/me`, rename lock, re-login), expiry and
  attempt lockout (expired code rejected; 5 wrong attempts invalidate the
  code; a fresh request recovers), and per-phone throttling (3 requests then
  429 with `Retry-After`).
- Live run against the local stack (PostgreSQL + built API + Vite dev): the
  full web flow was exercised through the browser — phone submit, code step
  with focus on the code input, wrong-code error, and successful login that
  stored a session for `username 09990000002` and rendered the app shell with
  zero console errors. A node script verified the raw API path for
  `09990000001` including `isNewUser` on first request and `false` on the
  second.
- Screenshot/DOM audits at 1440×900, 375×812 (light + dark), 320×720, and the
  code step in both themes: horizontal overflow 0, unlabeled buttons/inputs 0,
  correct headings, target phone shown on the code step.
- `web`: lint clean; production build passed. `mobile`: `expo export --platform
  android` bundled successfully (see below).
- QA users (`09990000001`, `09990000002`), their sessions/conversations, and
  all `09990000xx` OTP rows were deleted from the local database afterwards;
  pre-existing accounts were untouched.

### User-chosen usernames (2026-10-20, follow-up)

Signup no longer stores the phone number as the username. New users pick a
mandatory unique username during the code step; the verified phone moves to a
dedicated nullable unique `users.phone` column.

- `POST /auth/otp/verify` accepts `username` (2–30 chars, `[a-zA-Z0-9_]`,
  uniqueness-checked) alongside `displayName`, both required for new accounts.
  Validation happens **before** the OTP is consumed, so a bad username or a
  duplicate (409) does not burn the code.
- Account lookup for OTP is `{ phone } OR { phone: null, username: phone }`:
  accounts created when the phone *was* the username are still found on first
  login, keep their legacy username, and get `phone` backfilled at that point —
  no duplicate accounts are created.
- `phone` is returned only in self-scoped responses (`/auth/otp/verify`,
  `/auth/refresh`, `/users/me`, profile updates). The user directory, search,
  and peer lookups never include it. The rename lock on phone-created accounts
  was removed: usernames are editable again because the phone, not the
  username, now identifies the account for OTP.
- Web/mobile signup shows the username field above the display-name field with
  an inline hint; focus lands on the username field for new users. The web
  profile modal shows the username as editable plus the phone as a read-only
  field («شماره موبایل برای ورود ثابت می‌ماند»).

Verification: backend `npm run build` passed and `test:e2e` is now **15/15**
(new/updated tests: username required 400, duplicate 409 without consuming the
code, invalid format 400, user-chosen username + phone stored, rename allowed,
re-login preserves the renamed username, directory/search never expose `phone`,
and a legacy username-as-phone account signs in by OTP as the same user). A
live API run against the local stack confirmed the same behavior end-to-end,
including rename and re-login. Web signup was exercised in the browser
(client-side format error, then successful account creation storing both
`username` and `phone`), and the profile modal was verified in both view and
edit states, including a duplicate-username 409 and a successful rename.
Signup-step screenshots/audits at 1440×900 and 375×812 (light + dark) and
320×720: overflow 0, unlabeled buttons/inputs 0, focus on the username field.
`web` lint + build clean; `mobile` `expo export --platform android` bundled.
All QA users (`qa_otp_*`, `qa_web_*`) and `09990000xx` OTP rows were deleted
afterwards; the 11 real accounts were untouched.

### Multi-step sign-up, no more password login (2026-10-20, second follow-up)

`POST /auth/login` and `POST /auth/register` are **deleted**, together with
their DTOs and the `AUTH_LOGIN_*` / `AUTH_REGISTER_*` limits. The phone number
plus an OTP is the only way to authenticate, so the login screen is a wizard
that asks for one thing per step instead of everything at once.

- **Flow**: `phone → code → username → name`. `POST /auth/otp/verify` now
  takes only `phone` and `code`. When the verified number has no account it
  returns `{ requiresSignup: true, signupToken, signupExpiresInSeconds }`
  instead of a session; the remaining two screens collect a username and the
  name parts and post them with the token to `POST /auth/signup`, which creates
  the account and returns the normal `withSession` payload.
- **`signupToken`** is a stateless HS256 JWT (`{ pur: 'signup', phone }`,
  pinned algorithm list, `SIGNUP_TOKEN_TTL_SECONDS` default 900 s, throttled by
  `AUTH_SIGNUP_LIMIT`). It is not an access token — `JwtStrategy` requires
  `sub` + `sid` — and an access token cannot be replayed to `/auth/signup`
  because `pur !== 'signup'`. Reusing a token after the account exists is a
  409, because `users.phone` is unique and the conflict is checked before the
  insert. An expired token is a 401 and the clients send the user back to the
  phone step.
- **Name parts**: `users.firstName` / `users.lastName` (nullable) were added and
  `displayName` became a derived column kept in sync by `AuthService.completeSignup`
  and `UsersService.updateProfile` via `displayNameOf()`
  (`backend/src/common/names.ts`), so message/group/search/socket code that
  reads a single display name did not change. First name is required, family
  name optional (an empty string clears it). Both are validated by
  `/^[\p{L}][\p{L}\p{M}\u200c'’ .-]{1,49}$/u` — any script, Persian ZWNJ,
  spaces, apostrophes, hyphens.
- **Initials avatars**: `avatar: null` now means "draw the initials", and the
  stock `/images/user.png` fallback (and the file itself) is gone. Web
  `src/components/ui/Avatar.jsx` renders 1–2 letters (first letter of the first
  and last word, astral-safe) on one of eight deterministic gradients keyed by a
  name hash; `mobile/src/components/Avatar.js` mirrors the same initials and
  picks the matching flat tint because RN has no CSS gradient.
- **Clients**: the web wizard (`LoginPage.jsx`) has a step tracker
  («مرحله X از Y · نام مرحله»), auto-focus per step, a live identity preview on
  the last step (initials avatar + `@username`), and `Avatar` replaced the raw
  `<img>` in the video-call placeholder. The profile modal edits نام /
  نام خانوادگی separately and shows the «اختیاری» badge. `mobile/src/screens/LoginScreen.js`
  was rewritten to the same four steps with the password mode, the password
  inputs, and the mode switch deleted; `AuthContext` exposes
  `verifyOtp`/`completeSignup` (no `login`) and persists `firstName`/`lastName`.
- **Migration**: `prisma db push` added the two columns. Existing rows were
  backfilled locally (`firstName` = first word of `displayName`, `lastName` =
  the rest, and the stock `/images/user.png` avatar nulled). The local database
  now has name parts on 10 of its 14 users and no stock-avatar row left.
  The same statement for production, run on the VPS:

  ```sql
  UPDATE "users" SET
    "firstName" = split_part("displayName", ' ', 1),
    "lastName"  = NULLIF(trim(substring("displayName" from position(' ' in "displayName") + 1)), ''),
    "avatar"    = NULL
  WHERE "firstName" IS NULL AND "displayName" IS NOT NULL;
  UPDATE "users" SET "avatar" = NULL WHERE "avatar" = '/images/user.png';
  ```

  Accounts whose `username` is a phone number still sign in (the OTP lookup
  matches `{ phone }` or `{ phone: null, username: phone }` and backfills
  `phone`). Accounts with a username that is **not** a phone number and no
  `phone` column value can no longer sign in at all — there is no password
  endpoint any more. On the local database that was 10 of the pre-existing
  accounts; none of them had ever logged in with a phone. Any real deployment
  needs the same audit (`SELECT username FROM users WHERE phone IS NULL`) and,
  if needed, a one-time claim flow before the schema is pushed.

Verification for this batch:

- `backend`: `npm run build` passed and `npm run test:e2e` is now **16/16**,
  with the suite rebuilt around the new flow: a verified new number finishes
  sign-up in its own steps, an expired sign-up token is refused, OTP expiry and
  attempt lockout still work, a legacy username-as-phone account still signs in,
  per-phone OTP throttling is limit-driven, and the removed password endpoints
  now answer 404.
- `web`: `npm run lint` clean (0 warnings) and `npm run build` succeeded (Vite,
  79 modules). `mobile`: `npx expo export --platform android` bundled
  successfully with the rewritten login screen.
- Live browser walk-through of the wizard with a brand-new number: 201 from
  `POST /auth/signup`, session + `firstName`/`lastName`/`avatar: null` in
  storage, the initials avatar «عر» rendered in the sign-up preview and in the
  profile modal, then a profile edit that cleared the family name and live
  collapsed the preview to «ع» before saving. `displayName` came back as «علی»
  (verified in the database, not just on screen).
- Narrow-width checks were DOM measurements inside hidden same-origin iframes
  (375 and 320, light and dark): horizontal overflow 0, tracker label fits.
  **No screenshots** — the in-app browser had no visible surface for this run
  (`NATIVE_BROWSER_VIEWPORT_UNAVAILABLE`), and the mobile app was not run on a
  device or emulator.
- QA rows created for these checks (`qa_wizard_1` / `09198765432`, its session,
  and the empty direct conversation it lazily opened with `dave`) are deleted
  after the run; pre-existing accounts were untouched.


## CI/CD review and staged pipeline (2026-10-20)

Reviewed the whole delivery path (`ci.yml`, `deploy.sh`, `docker-compose.yml`,
both Dockerfiles, `nginx.conf`) and rebuilt it as explicit stages. Findings that
drove the changes:

- **No root `.dockerignore`.** The web image does `COPY . .`, so every
  `node_modules` tree, `.git`, `backend/`, `mobile/` and the local logs were sent
  as build context on a 1 vCPU / 1 GB box. Added one that keeps only what
  `vite build` needs.
- **CI did not test the thing that ships.** It linted and built from source, but
  the deploy is `docker compose up -d --build`; a broken Dockerfile or a bad
  nginx→API route only surfaced on the VPS. Added a stage that builds both
  images and brings the compose stack up, then asserts the SPA serves,
  `/api/health` answers **through nginx**, and the Socket.IO handshake returns a
  `sid`.
- **No health path existed.** `GET /api` (the root health route) never reaches
  Nest through nginx, because nginx only proxies `location ^~ /api/` — the SPA
  fallback answers it with `index.html`. The route is now `GET /api/health`
  (`backend/src/app.controller.ts`), which is what the new `api` container
  healthcheck polls and what the redeploy waits on. Nothing else called the old
  root route.
- **CD had no gate, no backup, no verification and no rollback.** The installed
  cron pulled whatever landed on `main` and rebuilt it. `deploy.sh --redeploy`
  now runs seven stages: fetch → refuse unless CI reports green for that SHA
  (best-effort through the public workflow-runs API; `--skip-ci-check` to force)
  → checkout the tested SHA → `pg_dump` into `backups/` (5 kept) → build images
  while the old containers keep serving → swap → wait for health. On failure it
  restores the previous SHA, rebuilds, and records the bad SHA in
  `.deploy-failed-sha` so the cron cannot crash-loop on it. `HEALTH_DEADLINE`
  and `BACKUP_KEEP` are overridable.
- **`.env.example` and the compose file advertise Redis that nothing uses.**
  `backend/src/redis/redis.service.ts` is an in-process `Map`; no code reads
  `REDIS_URL` and no Redis client is a dependency. Presence therefore does not
  survive a second API instance, and the `redis` container is dead weight. Left
  in place (removing a running service is not a docs fix) but documented in
  README, and CI notes that it needs no Redis.
- **One required check instead of six.** Added a `ci-gate` job that depends on
  every stage and fails unless all are `success`, so branch protection can pin a
  single name. Also added `concurrency` cancel-in-progress, per-job
  `timeout-minutes`, npm caching for all three lockfiles, artefact uploads, and
  a non-blocking `npm audit` job.
- **`deploy.yml` (CD) deploys the commit CI proved**, via `workflow_run` on CI
  success plus manual dispatch, over SSH, running
  `deploy.sh --redeploy --ref <sha>` on the server. It is inert until
  `DEPLOY_ENABLED=true` and `SSH_HOST`/`SSH_USER`/`SSH_KEY` exist; without them
  the job skips rather than failing. Serialized with a `deploy-production`
  concurrency group that never cancels mid-deploy.

Verification actually run for this batch:

- `bash -n deploy.sh`, `deploy.sh --help`, and an unknown-flag run.
- The redeploy path exercised end-to-end against **stubbed `docker` and `curl`**
  in a throwaway `git clone` (`/tmp`, deleted afterwards): green CI deploys all
  seven stages and writes a backup; `conclusion:"failure"` and
  `total_count:0` both refuse to move HEAD; an unreachable API proceeds with a
  warning; a commit that never becomes healthy rolls back to the previous SHA,
  writes `.deploy-failed-sha` and exits 1; the next cron-style run skips that
  SHA; a failing image build restores the previous SHA without swapping
  containers; re-running on the already-deployed SHA reports "nothing to do".
  `BACKUP_KEEP=2` rotation was observed with real files.
- All three YAML files parsed with `js-yaml` (job and service keys checked).
  `docker compose config` and the image builds **could not** run locally: no
  Docker on this machine. The workflows have not executed on GitHub Actions
  either, so stage 4 and the SSH deploy are unproven until their first real run.
- `web`: `npm run lint` clean, `npm run build` OK. `backend`: `npm run build`
  OK and `npm run test:e2e` **16/16** after the health-route change. `mobile`:
  `npx expo export --platform android` (the exact CI command, `dist-ci`) bundled.

## Contacts: which of my contacts have an account (2026-10-20)

Requested as «میخوام دسترسی از مخاطبین بگیره و چک کنه اونا اکانت دارن یا نه».

**Backend — `POST /api/users/contacts/match`** (`users.controller.ts`,
`users.service.ts:matchContacts`, `dto/match-contacts.dto.ts`):

- Session-guarded, and the `users` controller now also runs `RateLimitGuard`
  (JWT first, so a missing token is still 401 rather than 429).
- Accepts `{ phones: string[] }`, each entry run through the existing
  `normalizeIranMobile`. Invalid entries are ignored rather than rejecting the
  request — a real address book is full of landlines.
- Returns `{ checked, matches: [{ index, user }] }`. `index` is the position in
  the client's own array, so the response never carries a phone number; the
  `user` object is exactly the `SAFE` projection `/users/search` already uses,
  plus presence. The caller's own number is excluded, and duplicates (two
  contacts sharing a number) collapse to one entry per account.
- Caps: `CONTACT_MATCH_MAX_PHONES` (500) per request, `CONTACT_MATCH_LIMIT` (20)
  per `CONTACT_MATCH_WINDOW_SECONDS` (900) per client. Numbers are matched in
  the query and never written anywhere.

**Mobile** (`expo-contacts` ~57.0.8, `src/services/contacts.js`,
`screens/ContactsScreen.js`, registered in `App.js`, entry points from
`ChatListScreen` header and its empty state):

- Permission is asked only when the user presses «دریافت مخاطبین», and a denial
  shows a distinct state with a retry plus a link to system settings.
- ⚠️ SDK 57 detail: the top-level `Contacts.getContactsAsync` **throws** at
  runtime (deprecated legacy shim). The supported bulk read is
  `Contacts.Contact.getAllDetails([FULL_NAME, GIVEN_NAME, FAMILY_NAME, PHONES])`
  — verified against the shipped Kotlin (`next/ContactsNextModule.kt`
  `StaticAsyncFunction("getAllDetails")`) and the JS source of the installed
  package.
- Numbers are deduplicated on the device and sent in chunks of 500; the index
  map converts the reply back into contact rows. Nothing is persisted — no
  AsyncStorage cache of numbers.
- `app.json` registers the `expo-contacts` plugin with a Persian
  `contactsPermission` string for iOS. Note the official plugin also adds
  `WRITE_CONTACTS` on Android even though the app only reads; trimming it would
  mean a custom config plugin, so it is documented instead.

**Web** (`src/components/NewChat/ContactsPanel.jsx`, wired into `NewChatModal`
as a «جستجوی نام / مخاطبین» source toggle so it works for both direct chats and
group member picking):

- Browsers cannot read the OS address book, so the Contact Picker API
  (`navigator.contacts.select`) is feature-detected; on desktop Chromium,
  Firefox and Safari the picker button is simply not rendered.
- A paste box (one number per line or comma) is always available and is the
  path that works everywhere. Unmatched numbers are listed back to the user,
  matched ones open a chat or toggle group membership.
- Found and fixed during live QA: splitting the pasted text on whitespace
  shredded readable numbers like `0912 345 6789` into invalid fragments; the
  split is now on newlines/commas/semicolons only.

**Verification actually run**

- `backend`: `npm run build` OK; `npm run test:e2e` **19/19**, including three
  new cases — matching across formats with a payload grep proving no
  `09\d{9}` ever appears in the response, validation (`401` anonymous, `400`
  for empty/oversized/non-string/missing input), and the per-client `429` with
  `Retry-After`.
- Live API probe against the dev server (real OTP session, three dev accounts):
  `checked: 3` from a 6-number list (self, landline and a duplicate dropped),
  `+98…` and Persian-digit forms matched, response contained no number.
- Live web check in the in-app browser via DOM reads (pointer actions and
  screenshots are unavailable in this surface): the contacts tab renders,
  pasted numbers produced «۳ شماره بررسی شد؛ ۲ حساب پیدا شد», the unmatched
  number was listed, and group-mode selection synced chips ⇄ rows both ways.
- `web`: `npm run lint` clean, `npm run build` OK.
- `mobile`: `npx expo export --platform android` bundles with `expo-contacts`
  included. **Not** run on a device or emulator, so the native permission
  prompt and `getAllDetails` behaviour are unverified at runtime.

**Release housekeeping**

- Added `CHANGELOG.md` and gave the three manifests one shared product version
  (`1.1.0`); the web manifest had been the Vite placeholder `0.0.0`.

## E2EE Phase 0 gate, executed (2026-10-21)

No product code changed and **messages are still not encrypted**. The work was
the mandatory library gate in `docs/engineering/E2EE_DESIGN.md` §7, run against
the real packages instead of assumed, and its result is written into §3.5 of
that document.

What was actually run (Node on this machine, throwaway scratch directory, not
committed):

- Installed `ts-mls@1.6.4`, `@hpke/core@1.9.0`, `@noble/ciphers`,
  `@noble/curves`, `@noble/hashes` and exercised MLS with the pure-JS provider
  and ciphersuite id 1: create group → add member → welcome → join → encrypted
  application messages in both directions → add a third member → remove the
  second. Asserted: the removed member cannot decrypt post-removal traffic, a
  replayed generation is rejected, and `encodeGroupState`/`decodeGroupState`
  round-trips (~3 KB at three members, 349-byte welcome, ~151-byte overhead on a
  200-character body, ≈2.2 ms per message round trip).
- Simulated Hermes by removing `crypto.subtle` from the global and re-running
  the same lifecycle. It fails at the first key generation: ts-mls's "noble"
  provider substitutes AEAD/hash/signature but takes the KEM and KDF from
  `@hpke/core`, which are WebCrypto wrappers (`subtle.generateKey`,
  `importKey`, `deriveBits`). Reading those sources confirmed AEAD is too.
- Checked the alternatives: `libsignal` publishes no browser artifact and no
  Expo binding, so the §3.4 primary path cannot satisfy the gate as written;
  `@hpke/dhkem-x25519` is also WebCrypto-backed; `@panva/hpke-noble` is a real
  pure-JS HPKE suite but targets the newer `hpke` interface, not the one
  ts-mls consumes; `isomorphic-webcrypto` is unmaintained and was rejected as a
  shim to put under a protocol library.
- Drafted a ~120-line noble-backed `DhkemPrimitives`/`KdfInterface`/
  `AeadInterface` substitution. **It is unproven and was not kept**: the
  reference path (`@hpke/core` `CipherSuite.seal`) itself threw inside Node
  26's `exportKey`, so there was no trustworthy baseline to compare against.
  Anyone continuing this must fix that harness first.

Consequences recorded for the implementation phases: MLS needs strictly ordered
per-conversation delivery from the server (a receiver cannot decrypt generation
n+1 before n), and mobile key/state storage cannot live in
`expo-secure-store` (per-item limit) — it needs SQLite/AsyncStorage, which is
weaker at rest than §4 assumes.

## E2EE gate closed with a pure-JS provider (2026-10-21)

Still **no product encryption: messages are plaintext**. What changed is that
the mobile blocker found above turned out to need no owned primitive, and the
gate is now an executable test in the repo rather than a scratch directory.

- `shared/e2ee/provider.js` adapts ts-mls's `Hpke`/`Kdf`/`Signature` interfaces
  onto `hpke@1.1.7` (RFC 9180 key schedule) + `@panva/hpke-noble@1.1.7`
  (noble-backed DHKEM X25519 / HKDF-SHA256 / AES-128-GCM / ChaCha20Poly1305) and
  `@noble/curves` Ed25519. It contains glue only.
- ts-mls's `makeNobleSignatureImpl` is deliberately not reused: it prefers
  `crypto.subtle` when present and stores PKCS#8 there but a raw seed on
  Hermes, which would make key material platform-dependent. Pinning noble gives
  one format on both clients.
- `npm run test:e2ee` (CI job `2b · E2EE library gate`, `shared/e2ee/*.test.mjs`)
  asserts, per supported ciphersuite: full lifecycle, replay/stale-generation
  rejection, removed member cannot decrypt, state round-trip, **cross-provider
  interop in both directions** against ts-mls's WebCrypto path, and the whole
  lifecycle with `crypto.subtle` replaced by a throwing trap. 5/5 pass;
  ~3.6-4.9 ms per encrypt+decrypt, ~2.9-3.0 KB state, 342 B welcome, ~144 B
  overhead on a 200-character body.
- Known costs, recorded rather than hidden: `@panva/hpke-noble` statically
  imports `@noble/post-quantum`, which Metro will not tree-shake, and ts-mls
  peer-pins `@noble/ciphers@2.1.1` while hpke-noble needs `^2.3.0`, so npm nests
  a second copy. Versions are pinned to the exact tested tree; upgrades must
  re-run the gate.
- Not yet done: nothing has run on a phone or in a real browser tab, and no
  product code imports `shared/e2ee` yet.

## E2EE Phase 1 on the backend: devices and key packages (2026-10-21)

Still **no product encryption: messages are plaintext.** This batch builds the
server side of the key plumbing the gate doc promised, with the custody rule
from design doc §4 enforced by the schema itself.

- `backend/src/e2ee/` adds five endpoints under `/api/e2ee`: register/refresh
  own device, list own devices, revoke own device, append public KeyPackages to
  own pool, and claim one fresh KeyPackage per active device of a recipient.
- New tables `devices` and `key_packages` (applied locally with
  `prisma db push`). A KeyPackage is one opaque base64 column plus consumption
  metadata: the server never decodes it, and there is no column anywhere that
  could hold a private key, MLS client state, or a passphrase.
- Consumption is atomic. A claim stamps `consumedAt` plus a random
  `claimToken` in an update that re-checks `consumedAt IS NULL`, then re-reads
  only the rows carrying its own token, so a package can never reach two
  callers. A recipient whose pool cannot cover every active device gets an
  error instead of a partial bundle — a missing device would mean a group that
  silently excludes it.
- Revocation is permanent and local: the `clientId` can never re-register, and
  the device's whole pool (used and unused) is deleted in the same transaction
  that stamps it, so a claim that already selected those rows blocks and then
  matches nothing.
- Caps live in `backend/src/config/env.ts` (`E2EE_MAX_DEVICES_PER_USER`,
  `E2EE_MAX_PACKAGES_PER_UPLOAD`, `E2EE_MAX_PACKAGES_PER_DEVICE`,
  `E2EE_MAX_PACKAGE_CHARS`, `E2EE_CLAIM_LIMIT`, `E2EE_REGISTER_LIMIT`).
- Seven new e2e cases assert the above rather than describing it: injected
  `userId`/`privateKey`/`state` fields are dropped and never stored, another
  account's device is unreachable even when its `clientId` is known, base64 and
  size caps bite, the last package in a pool goes to exactly one of two
  concurrent racers, and an unknown account, a device-less account and an empty
  pool all answer with the same 404 text so the endpoint cannot enumerate.
- Accepted cost, documented: an abandoned claim burns one package per device.
  That is the price of keeping no reservation state server-side; clients refill
  when the pool runs low.
- Not yet done: no client calls any of this. Phase 2 (device keys, MLS groups
  for direct conversations, ordered envelope delivery) is where ciphertext
  appears, and a real phone and a real browser tab are still owed.

## E2EE Phase 2a on the backend: ordered opaque delivery (2026-10-21)

Still **no product encryption: every message a user can see is plaintext.** This
batch is the transport the client will need, built so the server physically
cannot read content.

- `Conversation.e2ee` is a one-way flag set by `POST /api/messages/e2ee/direct`
  (idempotent; either side can set it; nothing turns it off, so a downgrade can
  only ever be a visible user action). `GET /api/messages/e2ee/direct/:userId`
  answers `{conversationId, e2ee}` and is inert — a client asks this on every
  chat open, so probing must never create or flip a conversation.
- New table `e2ee_envelopes`: one opaque base64 blob per MLS message plus a
  per-conversation `seq`, unique on `(conversationId, seq)`. Applied locally
  with `prisma db push`.
- `e2ee:append` (socket) stores a blob at the next `seq` and broadcasts
  `e2ee:envelope` to the participants **inside one critical section**: an
  in-process per-conversation queue, a transaction-scoped
  `pg_advisory_xact_lock(hashtext(conversationId))` around numbering and insert,
  and the unique index as backstop. MLS is not order tolerant, so this is the
  server's entire job — a sequencer, not a postman that reorders.
- `GET /api/messages/:conversationId/envelopes?afterSeq=&take=` is the
  reconnect catch-up, oldest first, page bounded by `E2EE_ENVELOPE_PAGE`.
- `e2ee:read` moves a `ConversationParticipant.e2eeReadSeq` high-water mark,
  forward only, and always answers `{ok, moved}`. Read state cannot be a row per
  message here: the server cannot see which ciphertexts a client read. Unread in
  the chat list is now "peer envelopes above my mark", and the list carries
  `e2ee` so the UI can label the conversation.
- Format checks (`E2EE_MAX_ENVELOPE_CHARS`, base64 shape) run before anything
  that could describe the conversation; membership runs before conversation
  state, so an outsider appending to a guessed id learns only that they are not
  a member.
- `message:send` into an `e2ee` conversation is refused on both the
  conversation-id and peer-id routes, and a flagged group refuses envelopes *and*
  plaintext — which is why only Phase 3 may ever set the flag on a group. A
  plaintext `Message` row and an `E2eeEnvelope` never mix in one conversation.
- Six new e2e cases, including the one that matters most for correctness: 12
  concurrent appends from two different sockets produce seqs 1..12 with no gap
  and no duplicate, and the peer receives them strictly ascending.
- Verified against the running server, not only the suite: routes mapped in the
  live Nest log, a two-account session opted a chat in, appends/catch-up/read
  marks behaved as described, and the stored row was byte-identical to the blob
  the client sent. Probe accounts were deleted afterwards.
- Not yet done: clients. Until web and mobile hold keys and build MLS groups, no
  conversation can become `e2ee` from the UI, and nothing is encrypted.

## E2EE Phase 2b on the web: the browser holds the keys (2026-10-21)

**This is the first batch that actually encrypts user-visible messages.** A
direct chat opened from the web app between two web devices is now end-to-end
encrypted; the server keeps nothing but opaque ciphertext for it. Groups and
mobile are still plaintext.

- `shared/e2ee/client.js` (new) is the protocol half of the client, written for
  the phone to run the same code: MLS identity, key-package pool, per-conversation
  group state, the strict-order receive pipeline, encrypt→append→broadcast→apply.
  `src/services/e2ee.js` only supplies what a browser has — an IndexedDB store
  and a socket — and keeps one client per tab.
- Keys live in `openbridge-e2ee-<userId>` (IndexedDB), **one database per signed-in
  account**, so a second tab logged in as somebody else cannot read the first
  one's records. Signing out keeps the keys: the same browser is the same device,
  and dropping its keys would make every conversation it joined unreadable
  forever. Only the in-memory client is disposed.
- The device boots at sign-in (`src/App.jsx` effect): register, then mint and
  upload a pool of 8 KeyPackages. Without this, an account is uninvitable until
  somebody opens a chat with it, which would force a plaintext first message.
- Negotiation is lazy and read-only-first: opening a chat asks
  `GET /api/messages/e2ee/direct/:userId`; only when the answer is "not
  encrypted" does the client claim the peer's packages and flip the flag.
  **Claim-before-lock** is the invariant that makes the fallback honest — a peer
  with no pooled keys fails with `no-keys` and its chat stays an ordinary
  plaintext one, instead of becoming a conversation that refuses every message.
- Both sides are invited, and every active device of each: the peer joins through
  the Welcome that is envelope 1, so a device that was offline at creation can
  still build the group purely from the ordered stream (`ratchetTreeExtension`).
- One receive path per conversation, serialized: envelopes are applied strictly in
  `seq` order, a gap triggers catch-up, the caller's own envelope ids (not account
  ids) are echoed so its own broadcasts are skipped, and a protocol failure is
  *recorded on the conversation* instead of thrown at whatever UI happened to be
  mounted. A broken ratchet must not silently drop text.
- Plaintext has no path in from the UI: an encrypted chat sends over `e2ee:append`
  only. Attachments and reactions are blocked there rather than silently uploaded
  in the clear; search becomes local over the device's own decrypted cache; the
  transcript shows a divider («از این پیام به بعد…») at the first encrypted
  message so pre-encryption history is labeled, not disguised.
- Read marks ride the same high-water mark: `e2ee:read` broadcasts `message:read`,
  so encrypted bubbles get read receipts too (the handler previously matched only
  groups, which silently dropped them). The Welcome is consumed at join so it
  cannot inflate the unread badge, and the chat on screen is forced to zero unread.
- Product bug found by driving the real UI, fixed and pinned by a test: an account
  with no registered device produced an encrypted-looking chat that refused
  everything («این گفتگو فقط بسته رمزنگاری‌شده می‌پذیرد») with a stuck composer.
  Two more read-receipt/unread defects came from the same run.
- Six client-level e2e cases in `backend/test/e2ee-client.e2e.cjs` (new file, in
  `npm run test:e2e`) drive the **real** `shared/e2ee/client.js` against the live
  Nest server and PostgreSQL — no mocks: full open-and-store-only-ciphertext
  lifecycle, keys surviving a device reload, every active device invited, late
  envelope reordered and duplicate ignored, a relabelled sender / a blob from
  another conversation / an uninvited device all refused, and the keyless-peer
  fallback.
- Verified in a real browser across separate origins (5173/5174/5175 so per-origin
  IndexedDB isolation was tested rather than assumed): registration, first send
  creating the group, peer join, live delivery both ways, offline catch-up in
  order, read marks and badges, the plaintext→encrypted divider on both devices,
  local search, blocked attachments, and a DB audit confirming the opted-in chats
  hold envelopes only. Screenshots could **not** be captured (the app's browser
  view reports `NATIVE_BROWSER_VIEWPORT_UNAVAILABLE`), so visual QA of these
  states is still owed; every claim above comes from DOM assertions and queries.
- Not done: mobile. A web-activated chat locks the phone out of sending — the
  backend refuses its plaintext — and mobile shows no reason why. That interim
  gap is the first thing Phase 2c must close.

## Reactions became tapback-shaped (2026-10-21, shipped as 1.1.6)

Asked for: no counts, one reaction per person per message, tapping it again
lifts it instead of growing a number, and iPhone-style emoji.

**What was actually wrong.** `MessagesService.addReaction` upserted on
`(userId, messageId, emoji)` with `update: {}` — so it could never delete, never
replace, and a second tap by the same person on a *different* emoji simply added
a second row. Both clients then listened to `reaction:added` and incremented a
local counter, so one account tapping `👍` ten times made a message look like it
had been liked by ten people. The bug was in three places at once and each place
looked correct on its own.

**The rule now lives in the database.** `Reaction` gained
`@@unique([userId, messageId])` next to `@@index([messageId])`, so "one reaction
per person" is a constraint, not a convention the service happens to respect.
The e2e case inserts a duplicate pair straight through Prisma and asserts the
write fails with `P2002` — proof that a code path skipping the service cannot
break the rule either.

`prisma db push` would not add the index by itself: it refuses a unique index it
cannot prove is satisfiable by the rows in the table, and in this database it
kept refusing it even after the duplicates had been deleted — the observation is
only that deleting the rows was not enough, not why. Making the SQL idempotent
and explicit fixed it, so `backend/prisma/sql/dedupe-reactions.sql` now does the
three steps in order — keep the newest row per pair, drop the old
`(userId, messageId, emoji)` index, create `reactions_userId_messageId_key` —
and the container's `CMD` runs it before `db push`, because this image has no
migrate step: schema changes land through the start command. Verified against the
dev database by seeding a legacy duplicate pair (6 rows → 5, zero pairs with more
than one row, `db push` then clean, and a repeat insert rejected with SQL state
`23505`).

**The transport changed shape too.** `reaction:add` → `toggleReaction` answers
`{ok, reactions}` and broadcasts **`reaction:changed`** with the message's whole
row list to every participant, the sender included. Clients no longer add
anything: they group the rows by emoji and replace what they hold. That is what
makes remove/replace/spam all the same code path, and it removes the class of
drift where a client that missed one event stayed wrong forever.

**No counts, on either client.** A chip is the emoji alone. The row set carries
`userId`, so the chip knows whether *this* device holds it and draws it pressed
(accent border + soft fill on web, same idea on the red outgoing bubble where a
light chip would vanish). Web's hover bar marks the emoji you already hold, so
the same control adds and lifts. Mobile previously showed read-only chips and had
no way to react at all; it now long-presses a bubble — text, image or file — into
a five-emoji strip with a close button, and a tap outside or a pick dismisses it.

**On the "iPhone emoji kit" ask, honestly.** Apple's colour emoji font is
licensed to Apple hardware and cannot be shipped as an asset, so there is no file
in this repo that turns a Windows machine into an iPhone. What was done is the
native-first stack (`Apple Color Emoji` → `Segoe UI Emoji` → `Segoe UI Symbol` →
`Noto Color Emoji`) applied to the reaction bar, the chips and the picker: an
iPhone or Mac now shows Apple's own artwork, and the codepoints stored in the
database stay platform-neutral so both sides see the same reaction.

## Everything a message owns moved inside its bubble (2026-10-21, shipped as 1.1.7)

**The ask was a layout rule, not a feature:** «همه چیز پیام جز پروفایل داخل حباب
پیام باشن» — everything belonging to a message inside the bubble, only the profile
outside, placement left to me. On web the bubble was the one surface that clearly
says "this is the message", and directly under it sat three loose rows that also
belong to it: the timestamp/receipt/react-button footer, the reaction chips, and a
picker bar floating 40px above the whole thing. So the rule became literal: one
bubble, everything in it, avatar and sender name the only outside company.

**Web structure.** `.bubble` is now a column flex container and holds, in order,
the content, the picker strip (only while open), the chips (only while any exist)
and the footer. `BubbleContent` became `BubbleBody` — it returns only the inside —
because the row owns the `.bubble` class, and the file bubble used to *be* the
`<a>`: an anchor may not contain the reaction buttons, so the card's link is now
`.bubble-file-link` sitting inside the bubble next to the meta. `.bubble-image`
dropped `overflow: hidden` (the button already clips its own corners) — with the
picker inside the bubble, that rule would have clipped it.

**The picker stopped floating.** `.reaction-bar` lost `position: absolute`,
`top: -40px`, the `right: 0` / `left: 38px` anchors, the `bar-mine` class and both
mobile media-query overrides. It is an in-flow pill row inside the bubble, opened
from the smile button in the footer and closed by picking or by that button again.
Hover no longer opens it: an in-flow strip that appears on hover resizes the
bubble as the pointer crosses the row, and the row can move out from under the
cursor. Hover now only brightens the button, which is what `:hover` was already
doing in CSS.

**Bubble-aware ink.** The footer and chips used to be painted against the page
background, so their colours were chosen for it. Inside the bubble they are on the
accent red for outgoing messages, where a light pill and a dark-grey timestamp
would both disappear, so the outgoing side gets `rgba(255,255,255,.78)` meta,
translucent-white chips (`rgba(255,255,255,.16)`, `#FFE0DE` border when you hold
it) and a translucent picker strip — the same treatment mobile's chips already
used, which is why the two clients now read as one design.

**Mobile.** The tapback strip moved from `bubbleCol` (a sibling after the bubble
`Pressable`) into the bubble itself, after the caption and before the chips, so
long-press → pick now happens entirely inside one surface. Inside the bubble the
strip is bounded by the bubble's own padding, so five 36pt circles plus the close
button (~222pt) overflow the content box of a 78%-wide column on a 320pt screen:
the circles went to 34pt, `marginTop` went away (the bubble's `gap: 4` spaces it),
`flexWrap: 'wrap'` was added, and the strip took over the chips' two-tone
treatment (surface3 on the incoming bubble so it is not white-on-white,
translucent white on the outgoing one).

**A real defect surfaced while measuring an image bubble.** The picture rendered as
a sliver because the request 404'd. `resolveUrl` in both clients turned the
backend's `/uploads/<file>` into `/api/<file>` — `path.slice('/uploads'.length)`
removed the segment that *is* the route (`@Controller('uploads')` +
`app.setGlobalPrefix('api')`), so every image and file message on every client,
forever since `d98a3b0` ("Make uploads private and validate uploaded files"),
requested a URL the server does not serve. The e2e case for that batch asserted
the shape of the URL the API *returns* — signed and correct — and never the URL
the browser finally asks for, which is where the segment went missing. Both
clients now resolve to `/api/uploads/<file>?exp=…&sig=…`. The same audit found web
avatars passing the raw `/uploads/...` path straight to `<img>` in three places
(`normalizeUser`, the group participant map, `normalizeGroup`), i.e. a user-picked
avatar could never display on web; they go through `resolveUrl` now, like mobile.

**Deliberately left alone.** The profile dialog still cannot preview an avatar the
second it is picked, because the upload endpoint answers with an *unsigned* path
and `security.e2e.cjs:542` locks that contract (`/^\/uploads\/[a-f0-9-]+\.png$/`);
fixing it properly means either signing on upload or previewing with a blob URL
and tracking the uploaded path separately for save. That is a separate change, not
a bubble-layout one.

## Validation actually run

- 1.1.7 batch, 2026-10-21: root `npm run lint` clean, root `npm run build` clean
  (524 ms, rolldown warnings are the pre-existing `@hpke/common` pure-annotation
  ones), `npx expo export --platform android` exit 0 after the tapback move. No
  backend change, so `npm run test:e2e` was not re-run. Containment was then
  measured, not eyeballed: in two logged-in browsers on two throwaway accounts
  inside one group, for **mine and other** and for **text, image and file**, every
  owned node (`.bubble-text` / `.msg-image-btn` / `.bubble-file-link`,
  `.msg-reactions`, `.msg-reaction`, `.reaction-bar`, `.msg-footer`) passed both
  DOM containment (`bubble.contains(el)`) and bounding-box containment against the
  bubble rect, with `.msg-avatar` and `.msg-sender` verified to stay outside. The
  opened strip measured 186×40 inside a 288px-wide image bubble (mine) and sat
  right-anchored at `bubble.right − 13` inside an incoming bubble; picking `❤️`
  closed the strip, reordered the bubble to media → chips → footer and left one
  chip with `aria-pressed=true`. The attachment fix was verified at the HTTP layer
  from inside the page: the broken URL answered `404 Cannot GET /api/<file>.png`,
  the corrected one answered `200 image/png` 281 555 bytes for the picture and
  `200` with `Content-Disposition: attachment` for the file, and the peer's tab
  decoded the incoming image at naturalSize 512×512. Probe rows and their three
  upload files were deleted afterwards (five messages: two texts, two images, one
  file; the 👍 went with its message); the "asd" group keeps the three messages
  that were already there and were not mine. **Still no screenshots: the in-app
  browser reports `NATIVE_BROWSER_VIEWPORT_UNAVAILABLE`, so every step above is
  scripted DOM plus computed style — layout numbers verified, appearance not.**

- 1.1.6 batch, 2026-10-21: `backend` `npm run test:e2e` — **38/38 passed**
  against the real local PostgreSQL (the reaction case is the one rewritten
  above, and it includes the `P2002` duplicate-write check). `prisma db push`
  ran clean over a database that still held a legacy duplicate pair, after the
  dedupe SQL had been applied through the same command the container uses.
  Root `npm run lint` clean, root `npm run build` clean, and
  `npx expo export --platform android` produced a 2.5 MB bundle with exit code 0
  after the tapback strip landed. No screenshots: the reaction states have had
  no visual QA on either client.
- Live two-account reaction run, driven through the DOM of two Vite origins
  (127.0.0.1:5173 and :5174) against the restarted dev backend, in a fresh
  group conversation between two throwaway accounts: adding gave one chip whose
  text was exactly `👍` with `aria-pressed=true` and the `mine` class; tapping
  the chip lifted it; `👍` then `❤️` left a single `❤️`; more than a dozen taps
  across all five emoji left **one row in `reactions`**; the peer's browser saw
  each change without a reload, and after the peer tapped the same chip it stayed
  a single chip — `mine` on both devices, **two rows** in the database, i.e. the
  chip counts people and never taps. `getComputedStyle` on a chip returned
  `"Apple Color Emoji", "Segoe UI Emoji", "Segoe UI Symbol", "Noto Color Emoji",
  sans-serif`, which on this Windows host resolves to Segoe, as documented.
  **Caveat: the in-app browser still reports `NATIVE_BROWSER_VIEWPORT_UNAVAILABLE`,
  so pointer actions were impossible and every step above ran through scripted DOM
  events — behaviour and markup verified, appearance not.** The two probe accounts,
  their group and their direct conversation were deleted afterwards (`reactions`
  back to 0, 13 conversations, no orphan devices or KeyPackages).

- `backend`: `npm run test:e2e` — **38/38 passed** on 2026-10-21 against the
  real local PostgreSQL: the 32 earlier cases, then six E2EE Phase 2a transport
  cases (opt-in and one-way flag, plaintext refused inside an encrypted chat,
  gapless strict-order numbering under 12 concurrent appends, catch-up paging
  with membership checks, forward-only read marks, per-conversation isolation
  and the group guard), then six Phase 2b client cases that run the real
  `shared/e2ee/client.js` against the live server (encrypted open with
  ciphertext-only storage, state surviving a device reload, all active devices
  invited, late envelope reordered and duplicate ignored, forged sender /
  foreign blob / uninvited device all refused, keyless-peer fallback).
  The counts in the bullets below belong to the batches that produced them (11
  tests then, 19 after contact matching, 26 after Phase 1, 32 after Phase 2a);
  the suite has only grown.
- Live check on the running dev server (`npm run start:dev`): every new route
  appears in the Nest router log, unauthenticated calls return 401, and a
  throwaway two-account session exercised opt-in, append, broadcast, catch-up
  and read marks end to end. Probe accounts were deleted afterwards.
- Real-browser Phase 2b run, three Vite origins (5173/5174/5175) against the
  running backend, each origin holding its own account and its own IndexedDB:
  sign-in device registration, first message creating the MLS group, peer join
  from the Welcome, live encrypted delivery both directions, an away device
  catching up in order, read marks clearing badges, the pre-encryption divider
  on both sides, local-only search, attachments blocked, and a peer with no keys
  falling back to plaintext with a visible reason. A direct Prisma audit of the
  opted-in conversations confirmed `messages` held nothing new and
  `e2ee_envelopes` held only base64 blobs.
  **Caveat: no screenshots were captured** — the app's browser view reported
  `NATIVE_BROWSER_VIEWPORT_UNAVAILABLE`, so these checks are DOM assertions and
  DB queries, not visual QA.

- Root: `npm run test:e2ee` — 5/5 passed (MLS lifecycle on two ciphersuites,
  cross-provider interop both directions, and the same lifecycle with
  `crypto.subtle` trapped).
- Root: `npm run lint` — clean with `shared/e2ee` inside the web lint scope.
- `backend`: `npm run build` — passed after every batch.
- `backend`: `npm run test:e2e` — 11/11 tests passed (about 4.5 s) against a
  real local PostgreSQL:
  - startup fails without `JWT_SECRET`
  - unauthenticated/forged JWTs rejected; a JWT signed with the correct secret
    but no/unknown session id is rejected on HTTP
  - self-chat, pagination bounds, invalid UUIDs, group DTO validation
  - non-member cannot read history, send, react, or type in a group
  - participant reactions broadcast with the real conversation ID
  - oversized/invalid message payloads rejected; self and external-file sends rejected
  - invalid socket token disconnected; a socket with a revoked session is rejected
  - upload allowlist, magic-byte check, unsigned/tampered download denial,
    signed download success with `nosniff`
  - login throttling returns 429 with `Retry-After` for both IP and username
    buckets (tested with a fresh username and `X-Forwarded-For` under
    `TRUST_PROXY`)
  - refresh rotation: old refresh token rejected after rotation, cross-user
    session revocation returns 404, logout invalidates both access and refresh
    tokens, and revoke-by-id invalidates the session
  - ClamAV path tested against a real TCP INSTREAM stub: clean upload accepted,
    EICAR upload rejected with 400 and its file removed; scan invoked
  - CORS allows localhost in development and rejects unknown origins
- Manual browser checks (Vite dev server + built API + local PostgreSQL):
  - after replacing the stored access token with an invalid value, the next API
    call transparently refreshed and `/api/users/me` returned 200
  - after logout, both captured access and refresh tokens returned 401 and
    local storage was cleared
  - post-lint-refactor regression: register a new user, search a peer, open the
    conversation, send a message, and see it rendered in the chat
- `web`: `npm run lint` — clean (0 errors, 0 warnings); `npm run build` —
  passed (Vite, 74 modules).
- UI/UX sprint re-run: `web` lint clean and production build 78 modules;
  `backend` `npm run test:e2e` 11/11; mobile `expo export --platform android`
  bundled successfully. Details and caveats in `UI_UX_REDESIGN.md`.
- Test users, sessions, conversations, and messages created for verification
  were deleted afterwards; existing user-created accounts and groups were left
  untouched.

## Unresolved / known issues

- **Encryption is live on web direct chats only.** Since Phase 2b landed
  (2026-10-21), a direct conversation opened from the web app between two web
  devices carries nothing but ciphertext the server cannot read. Everything else
  is still plaintext and the server still reads it: **groups on every client,
  mobile on every client, and any existing direct chat nobody has opened from
  the web app since the rollout** (negotiation is lazy, so an untouched chat
  stays plaintext). Design doc §11 is the authoritative statement.
- **Mobile is now the blocking gap, not an unfinished nice-to-have.** A chat a
  web user encrypted locks the phone out of sending: the backend refuses
  plaintext into an `e2ee` conversation with 400, and the mobile UI has no MLS
  client and no explanation. Until Phase 2c ships, web users who chat with mobile
  users can make that chat unusable for them. The mobile composer needs either
  the protocol or a visible "this chat is encrypted — update the app" state.
- **No key verification yet.** Key adoption is trust-on-first-use: nothing shows
  safety numbers, so a key substituted by the server at first contact would not
  be detected. Phase 5.
- **A device added after a conversation started cannot read it.** The Welcome
  addresses the devices that existed when the group was created, and there is no
  history sharing between devices, so a second browser or a reinstalled phone
  joins an ongoing chat with a gap. Not solved by Phase 2b.
- **No recovery, by decision.** Losing every device loses the history; only a
  user-initiated passphrase-encrypted export is allowed and it is Phase 5 work.
- **Attachments and reactions are blocked inside encrypted chats**, not encrypted
  (Phase 4), and search there covers only this device's local cache.
- The envelope stream is unbounded: `e2ee_envelopes` rows are never deleted, and
  an encrypted chat has no server-visible read state to prune against (a
  high-water mark tells us what *one* participant has seen, not what all of them
  have). Retention and multi-device pruning are owed before real traffic.
- Consumed `KeyPackage` rows are never pruned: every claim leaves one row with
  `consumedAt` set, deleted only when the device is revoked. Harmless at current
  traffic, but a retention rule is owed before volume grows.
- No session-management UI: `GET /api/auth/sessions` and `DELETE
  /api/auth/sessions/:id` exist, but web/mobile do not expose them yet.
- Refresh-token reuse detection is not implemented; a replayed old token is
  rejected but does not auto-revoke its session.
- Web stores access and refresh tokens in `localStorage` (XSS-exposed); mobile
  keeps both in SecureStore.
- HTTP auth throttling, socket rate limits, and presence are in-memory and
  per-process; multi-instance deployments need a shared store (e.g. Redis).
- Signed download URLs are bearer capabilities until expiry; membership is not
  re-checked on download.
- Malware scanning is off unless a clamd instance is configured; encrypted
  content (future E2EE) cannot be scanned server-side.
- No message edit/delete or account deletion. Device-based key management exists
  on both sides now (the web app registers a device at sign-in), but there is no
  UI for it: a user still cannot list, name or revoke a device holding their
  keys, even though `GET /api/e2ee/devices` and `DELETE
  /api/e2ee/devices/:clientId` are live and tested.
- Database rows and attachment files are unencrypted at rest.
- Video calling UI remains hidden on web and was removed from mobile navigation;
  signaling code is present but unused.
- Mobile now lists, reads, sends in, and creates groups, but group
  administration (add/remove members, rename, group avatar) is not exposed in
  either client.
- OTP login has no SMS provider: outside production the code is returned in
  the API response (test mode); in production the request endpoint returns 503
  until a provider (e.g. Kavenegar/SMS.ir) is integrated. OTP throttling is
  in-memory like the rest of the auth limits.
- The staged CI/CD pipeline **has now executed for real**: the run on `2c7e20d`
  (2026-10-21) completed with every blocking stage green — web lint, backend
  schema + typecheck, backend e2e (38/38 against PostgreSQL), the E2EE library
  gate, web build, mobile Android bundle, the Docker images + compose smoke
  test, and the gate job. Two things that run cost us: the backend e2e job could
  not import `shared/e2ee` until it also installed the root manifest, and `npx
  prisma validate` fails on a checkout with no `.env` unless `DATABASE_URL` is
  supplied — both were fixed here, and both had already been failing the
  pipeline since it was staged. The dependency-audit jobs still fail as
  informational steps (see the audit item above), and `deploy.yml` stays
  **skipped** because `vars.DEPLOY_ENABLED` is not `true`, so the VPS is still
  updated by its own cron, not by CI.
- The `redis` service is declared in `docker-compose.yml` and `REDIS_URL` is in
  both `.env.example` files, but no code reads it and no Redis client is a
  dependency (`RedisService` is an in-process Map). Either wire a real shared
  store or drop the container; leaving it invites the false belief that presence
  is distributed.

- Contact matching ships but has never executed on hardware: the Expo bundle
  builds and the endpoint is covered by tests, but the native permission prompt
  and `Contact.getAllDetails` are unverified at runtime. Nothing was tested in
  Expo Go or an emulator.
- `POST /users/contacts/match` is still an enumeration oracle for any logged-in
  user — the length cap and per-client throttle slow it down, they do not stop
  it. Re-check this before opening registration to the public.
- The official `expo-contacts` Android plugin also requests `WRITE_CONTACTS`
  although the app only reads; removing it needs a custom config plugin.
- Contacts without an account are listed but there is no invite flow, and on
  desktop browsers the OS address book is unreachable, so web users get the
  paste box only.

## Next priorities

1. Integrate a real SMS provider behind the existing OTP service boundary and
   disable test-mode code exposure in all non-local environments.
2. Add a session-management UI on web (list active sessions, revoke individual
   devices) using the existing endpoints.
3. Move throttling/presence to a shared store (Redis) before running more than
   one API instance.
4. Add authorization tests for group membership changes (add/remove participant)
   and message edit/delete once those endpoints exist.
5. **E2EE Phase 2c: keys on mobile — this is now the priority that blocks
   everything else.** Web Phase 2b landed the same day (design doc §6): the
   browser registers its device at sign-in, pools KeyPackages in IndexedDB,
   builds the two-member MLS group on the first send, joins from the Welcome,
   and encrypts for real. What Phase 2c must reproduce on Expo/Hermes: Metro
   `watchFolders`/`extraNodeModules` so `shared/e2ee` resolves, an
   `expo-crypto` `getRandomValues` polyfill over the pure-JS provider, an
   AsyncStorage-backed key store, the same read-only-first negotiation, and
   `npx expo export --platform android` to prove the bundle.
   **The interim hazard is user-visible and must be closed in the same batch:**
   a chat a web user encrypted rejects the phone's plaintext sends with a bare
   400, so until mobile speaks MLS the composer has to say "this chat is
   encrypted — update the app" instead of failing silently.
   Custody rule unchanged and already encoded: no escrow, no recovery, nothing
   at any access level can read message content (design doc §4). The provider
   still has never run on a real phone.
6. Then E2EE Phase 3 (groups): commit/welcome routing through the ordered
   transport, rekey on membership change, removal semantics. Groups are the last
   large plaintext surface, and only Phase 3 may set the flag on one.
7. Add a web security review pass (CSP, token storage trade-off) and cover the
   signed-URL download path with a cross-user authorization test.
8. Run the mobile app on a native emulator or device (RTL header, safe areas,
   keyboard avoidance, the contacts permission prompt and address-book read) and
   add automated visual-regression coverage for the documented viewport matrix.
   Phase 2b's encrypted states were only checked structurally — the app view
   could not capture screenshots (`NATIVE_BROWSER_VIEWPORT_UNAVAILABLE`), so the
   padlock, the pre-encryption divider and the blocked-attachment note have no
   visual QA yet. Same for 1.1.6: the long-press tapback strip and the pressed
   chip states have only been proven to bundle, not seen on a screen. And again
   for 1.1.7: the in-bubble footer, chips and picker strip were verified by
   measured bounding boxes, not by eye — the image-bubble padding and the
   34pt tapback row at 320pt width are the two places a real screen is most
   likely to disagree with the maths.
9. Self-host Font Awesome so the web client can run without a CDN and under a
   strict CSP.
