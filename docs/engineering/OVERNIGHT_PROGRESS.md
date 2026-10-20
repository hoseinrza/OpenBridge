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
UI is gone — new accounts are created by verifying an OTP.

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
  and a legacy «ورود با نام کاربری و رمز» mode for old accounts.
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
   keyboard avoidance) and add automated visual-regression coverage for the
   documented viewport matrix.
8. Self-host Font Awesome so the web client can run without a CDN and under a
   strict CSP.
