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

## Validation actually run

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

- No E2EE; the server stores plaintext messages. A design proposal exists in
  `docs/engineering/E2EE_DESIGN.md`, but no cryptography is implemented.
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
- No message edit/delete, account deletion, or device-based E2EE key management.
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
- The staged CI/CD pipeline has not executed on GitHub Actions yet: the redeploy
  logic was tested against stubbed `docker`/`curl`, but stage 4 (image builds +
  compose smoke test) and the SSH deploy job are unproven until their first real
  run. `deploy.yml` also stays inert until `DEPLOY_ENABLED` and the `SSH_*`
  secrets are configured, so the VPS currently relies on its own cron.
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
5. Capture and display the E2EE `Session`/device list as the precursor to
   multi-device key management; run the Phase 0 library gate described in the
   E2EE design before any cryptographic implementation.
6. Add a web security review pass (CSP, token storage trade-off) and cover the
   signed-URL download path with a cross-user authorization test.
7. Run the mobile app on a native emulator or device (RTL header, safe areas,
   keyboard avoidance, the contacts permission prompt and address-book read) and
   add automated visual-regression coverage for the documented viewport matrix.
8. Self-host Font Awesome so the web client can run without a CDN and under a
   strict CSP.
