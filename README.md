<p align="center">
  <img src="public/logo-wordmark.svg" alt="OpenBridge" width="380" />
</p>

<h1 align="center">OpenBridge</h1>

<p align="center">A real-time Persian (RTL) chat application for web and mobile — React + NestJS + Expo.</p>

---

## ✨ Features

- 📲 **Phone-number sign-in** with a 6-digit one-time code — there are no passwords
- 🧭 Step-by-step sign-up: number → code → username → name (family name optional)
- 💬 Real-time 1:1 messaging over Socket.IO, with delivery acks and paged history
- 👥 Group chats with owner/member roles and membership management — on web **and** mobile
- 🟢 Presence, ⌨️ typing indicators and read receipts (presence is tracked in
  process, so a single API instance is assumed)
- 😀 Message reactions — and copy, edit or delete a message from a right-click or
  Shift+F10 menu on the web, with a «ویرایش‌شده» marker on a rewritten bubble.
  A deleted message leaves the timeline entirely: its bubble collapses where it stood
  and nothing at all is drawn in its place, on the web and on the phone. «Delete for me»
  hides a row for one account only. The phone has no such menu yet.
- 📎 Private file & image uploads behind signed, expiring URLs (optional ClamAV scan)
- 🎙️ **Voice messages** on web and mobile — record, send with the length the
  device measured, and play from a rail. The recording travels as an attachment,
  and the server validates the declared duration.
- 📹 **Audio and video calls over a self-hosted LiveKit SFU** — 1:1 and group,
  with ringing, busy/missed/timeout states, mute/camera/screen-share controls and
  LiveKit room tokens minted only by the API. For a call in an encrypted chat the
  server generates one random media key for that call, keeps it in memory for the
  call's lifetime and hands it to the web clients with the room token; every media
  frame is encrypted before it leaves the browser, so the SFU only relays
  ciphertext. Plaintext chats can call too, and their call UI says they carry no
  media encryption. Mobile calls exist but cannot join an encrypted room,
  because the Expo build has no LiveKit E2EE support.
- 🔐 **Content sealed at rest with a server-held key**: message text and
  attachment bytes are encrypted by the API with a per-conversation key derived
  from `CONTENT_KEY`, so the database and the disk hold no readable content.
  Every signed-in device of the account can read the whole history.
- 🔎 User search by name/username, plus an in-conversation message filter
- 📇 **Contact matching**: check which of your phone's contacts already have an
  account — device address book on mobile, Contact Picker or pasted numbers on web
- 👤 Profiles: a unique username, a first name, an optional last name and a bio
- 🔤 Initials avatar whenever a user has no photo — the colour is derived from their name
- 🌗 Light and dark themes, RTL Persian UI, layouts checked down to 320 px
- 🔄 Revocable login sessions with rotating refresh tokens
- 📱 Expo React Native app: login, chat list, chat, contacts, new group

### What is deliberately not here

- 📵 **No SMS provider is wired in.** Outside production, `POST /auth/otp/request`
  returns the generated code in its response so you can finish the flow; with
  `NODE_ENV=production` it answers `503` («ارسال پیامک هنوز فعال نشده است») and
  creates no code. Sign-up therefore works only in development until a gateway
  is integrated.
  The integration point is `AuthService.requestOtp`
  (`backend/src/auth/auth.service.ts`): the `if (!OTP_TEST_MODE)` branch that
  currently answers `503` is where the provider call belongs. `OTP_TEST_MODE` is
  derived only from `NODE_ENV` (`backend/src/config/env.ts`), so no deployment
  variable can switch the test code back on. When adding a provider: send after
  the code row is stored, delete or expire that row if delivery fails, and remove
  `testCode` from the response in the same change. `backend/test/security.e2e.cjs`
  boots the API with `NODE_ENV=production` and fails if the response ever carries
  a test code again.
- 🔓 **Content is not end-to-end encrypted.** Sealing happens on the server, with
  a key the server holds, so an operator with `CONTENT_KEY` and the database can
  read every message and file. The trade is deliberate: it buys encryption at rest
  plus a history that any signed-in device can open. See
  [docs/SECURITY.md](docs/SECURITY.md) for the exact boundary and
  [docs/engineering/E2EE_DESIGN.md](docs/engineering/E2EE_DESIGN.md) §12 for the
  design that replaced MLS.
- 📵 **Calls are not equally encrypted either.** A call in an encrypted chat gets
  a per-call key from the server, which also keeps a copy; a call in a plaintext
  chat has no media encryption, and mobile refuses an encrypted room entirely.
  Active call state is in-process: an API restart ends calls, and call history is
  not stored. See
  [docs/engineering/CALLING_ARCHITECTURE.md](docs/engineering/CALLING_ARCHITECTURE.md).

## 🔐 Sign-in & sign-up

The mobile number is the identity; the username is a unique handle others use to
find you.

- **Accepted formats:** `09xxxxxxxxx`, `+989xxxxxxxxx`, `00989xxxxxxxxx`,
  `989xxxxxxxxx`, `9xxxxxxxxx` — in Persian or Arabic digits, separators ignored.
  Everything normalizes to `09\d{9}` (`backend/src/common/phone.ts`, mirrored in
  `src/utils/phone.js` and `mobile/src/utils/phone.js`).
- **Codes:** 6 random digits, stored only as an HMAC-SHA256 digest keyed with
  `JWT_SECRET`, compared with `timingSafeEqual`, single-use, expiring after
  `OTP_TTL_SECONDS` and invalidated after `OTP_MAX_ATTEMPTS` wrong tries. Requests
  are throttled per IP and per phone number.
- **New numbers** get a short-lived signup token (`SIGNUP_TOKEN_TTL_SECONDS`) to
  finish the remaining steps on `POST /auth/signup` — username (2–30 chars,
  `[a-zA-Z0-9_]`) plus first/last name. Input is validated *before* the OTP is
  consumed, so a rejected signup does not burn the code. The signup token cannot
  be used as an access token, and vice versa.
- **Names** are stored as `firstName` + optional `lastName`, with `displayName`
  kept as a derived column so message, group, search and socket code paths did not
  change.
- ⚠️ **The old username/password flow is gone** (removed 2026-10-20): an account
  with no `phone` cannot request a code, unless its username happens to be a phone
  number — those legacy accounts are still found by OTP and get their `phone`
  backfilled on first login. Audit before deploying with
  `SELECT username, "displayName" FROM users WHERE phone IS NULL;` and either
  backfill the numbers or have those users register through OTP.

## 📇 Contacts

The point of the contacts feature is to answer one question — *which of these
numbers already has an account?* — without turning the server into a phone book.

- **Endpoint:** `POST /api/users/contacts/match` (session required) accepts
  `{ "phones": string[] }` in any of the sign-in formats, normalizes them with
  the same `normalizeIranMobile` used at login, ignores anything that is not an
  Iranian mobile number, and drops the caller's own number.
- **Response:** `{ checked, matches: [{ index, user }] }`. Only the *input
  position* comes back together with the profile that `/users/search` already
  exposes (`id`, `username`, names, avatar, bio, presence). No phone number is
  stored by the match, echoed in the response, or written to any table — the
  client maps index → its own contact. Verified by the e2e case that greps the
  whole payload for `09\d{9}`.
- **Mobile** (`expo-contacts`, permission asked only when the button is pressed):
  reads `fullName`/`givenName`/`familyName`/`phones` through
  `Contact.getAllDetails`, deduplicates numbers locally, and sends them in
  chunks of `CONTACT_MATCH_MAX_PHONES`. The screen lists the contacts that have
  an account (tap → chat) and, on demand, those that do not.
- **Web**: browsers cannot read the OS address book, so the new-chat modal uses
  the Contact Picker API where it exists (Chromium on Android — the button is
  hidden otherwise) and always offers a paste box, one number per line or comma.
- **Trade-off to know about:** any "does this number exist" endpoint lets a
  logged-in user test numbers, so the list length is capped at
  `CONTACT_MATCH_MAX_PHONES` (500) and the route is throttled to
  `CONTACT_MATCH_LIMIT` (20) requests per `CONTACT_MATCH_WINDOW_SECONDS` (900)
  per client. That slows abuse; it does not make enumeration impossible. Hashing
  the numbers first would not help either — the `09xxxxxxxxx` space is small
  enough to brute force.

## 🧱 Tech stack

| Layer      | Stack                                                          |
|------------|----------------------------------------------------------------|
| Web        | React 19, Vite, React Router, Socket.IO client, LiveKit client |
| Mobile     | Expo SDK 57, React Native, React Navigation, SecureStore, expo-contacts, LiveKit RN SDK |
| Backend    | NestJS 10, Socket.IO, Prisma, JWT + Passport, LiveKit server SDK |
| Data       | PostgreSQL 16 (Prisma)                                         |
| Media      | Self-hosted LiveKit SFU (pinned image), UDP 7882 / TCP 7881     |
| Infra      | Docker Compose, nginx (SPA + API/WebSocket proxy), ClamAV (opt)|

> `backend/src/redis/redis.service.ts` is an in-process presence map despite its
> name: no code reads `REDIS_URL` and no Redis client is installed, so the
> `redis` container in `docker-compose.yml` is currently dead weight and presence
> does not survive a second API instance.

## 🔒 Security

Message text and attachment bytes are **sealed at rest by the API itself**: a
per-conversation key derived with HKDF-SHA256 from the single `CONTENT_KEY`
secret, AES-256-GCM, stored as `obx1.<iv>.<tag>.<ciphertext>` on the row and with
an `OBX1` header on the file. The server holds the key, so it can read content by
design — that is what lets every signed-in device of an account open the whole
history. History written under the earlier end-to-end scheme is a separate tail:
those envelopes stay ciphertext until a web device that still holds the MLS keys
opens the chat and hands them back to the server, which re-seals them. Mobile
shows such a chat as holding unreadable older messages and refuses to write into
it. See [docs/SECURITY.md](docs/SECURITY.md) for the
confidentiality model, implemented controls, threat model, and known
limitations; [docs/engineering/E2EE_DESIGN.md](docs/engineering/E2EE_DESIGN.md)
§11 and §12 are the authoritative statement of what is and is not encrypted
today.
Calls follow the same line: an encrypted call's media key is generated by the
server and handed to the web clients with the room token, plaintext and mobile
calls carry no media encryption, and no call key is ever persisted or logged. See
[docs/engineering/CALLING_ARCHITECTURE.md](docs/engineering/CALLING_ARCHITECTURE.md).

The API requires `JWT_SECRET` and refuses to start without it. In production it
must be at least 32 characters. `CONTENT_KEY` is required in every environment: a
base64 string decoding to exactly 32 bytes, checked at startup, because a fallback
key would make every deployment share a secret the code can guess.
Set it once before the first deploy and never change it — a new value leaves every
sealed message and file unreadable.
Cross-origin browser access is deny-by-default
in production; set `CORS_ORIGINS` to a comma-separated allowlist when the web
app and API are on different origins. Native apps send no `Origin` header and are
always allowed.

Contact matching is the one endpoint that receives phone numbers, and it is the
one place where enumeration is a real concern — see
[📇 Contacts](#-contacts) for the caps, the throttle and why the response carries
no numbers. `users.phone` remains excluded from every other user response.

## 🧪 Tests & checks

```bash
cd backend && npm run test:e2e     # unit crypto checks plus the database suites: OTP signup, sessions, uploads, CORS, socket, contacts, content sealing, legacy import, message actions, calling
npm run test:e2ee                  # MLS library gate, including the no-WebCrypto (Hermes) run
npm run lint                       # web ESLint
npm run build                      # web production build
cd mobile && npx expo export --platform android
```

The e2e suite boots the Nest app against the configured PostgreSQL database,
creates temporary users and conversations, and cleans them up afterwards.

Mobile has two automated layers:

```bash
cd mobile && npm test          # Jest + React Native Testing Library
cd mobile && npm run test:ci   # the CI invocation
```

The unit/component suite covers phone normalization, the login and sign-up
steps, the chat list (search, empty, error), and the chat surface (sides,
sending, reactions). The on-device layer is a Maestro flow
(`mobile/.maestro/auth-and-chat.yaml`) that runs against a real API-34 Android
emulator in CI: it signs in with the CI-only seeded user, sends a message in
`E2E Group`, and adds a reaction. Fixtures come from
`backend/test/mobile-e2e-seed.mjs` and exist only in the disposable CI
database. A local run needs an emulator, a backend, and the seed script; CI is
the supported path.

## 🔁 CI & CD

[`ci.yml`](.github/workflows/ci.yml) runs in ordered stages, each one gated on
the stage before it, so the slow jobs never start on code the fast jobs reject:

| Stage | Job | What it proves |
|-------|-----|----------------|
| 0 · detect | `changes` | Path detection for PRs; main/schedule/manual always run the mobile E2E |
| 1 · static | `web-lint`, `backend-check` | ESLint clean · Prisma schema valid · TypeScript compiles |
| 2 · tests | `backend-e2e` | The 41 security cases plus the wider e2e suite (113 cases) pass against real PostgreSQL |
| 2 · tests | `mobile-tests` | Jest + RNTL mobile behavior suite |
| 2 · tests | `mobile-e2e` | Maestro on an API-34 emulator against a real PostgreSQL + NestJS backend (main, mobile PRs, nightly) |
| 2b | `dependencies` | `npm audit` findings (reports, never blocks) |
| 3 · artefacts | `web-build`, `mobile-bundle` | The Vite bundle builds · the Expo Hermes bundle builds |
| 4 · ship path | `deploy-dry-run` | Both Docker images build, `docker compose up` serves the SPA, `/api/health/ready` answers **through nginx** (database included), and Socket.IO handshakes |
| — | `ci-gate` | One required check for branch protection |

Make `CI gate` the required status check rather than listing every job, so the
job list can change without breaking protection.

[`deploy.yml`](.github/workflows/deploy.yml) then deploys **the exact commit CI
just proved green**, over SSH, by running `deploy.sh --redeploy` on the server.
It stays inert until you opt in:

1. Set the repository variable `DEPLOY_ENABLED = true`.
2. Set the secrets `SSH_HOST`, `SSH_USER`, `SSH_KEY` (and optionally `SSH_PORT`,
   `SSH_KNOWN_HOSTS`, plus the `APP_DIR` variable, default `/opt/openbridge`).
3. Without them the job is skipped, and the server keeps redeploying from its
   own 5-minute cron entry.

On the server, every redeploy runs the same seven stages: fetch → refuse the
commit if CI is not green → check out the tested SHA → `pg_dump` into
`backups/` (last 5 kept) → build images while the old containers keep serving →
swap → wait for `/api/health/ready` through nginx. If health never arrives, it checks
out the previous commit, rebuilds, and records the bad SHA in
`.deploy-failed-sha` so the cron cannot crash-loop on it. Tune the wait with
`HEALTH_DEADLINE` on very slow boxes.

> Observed state (2026-10-25): every job is green except the Android Maestro
> job (`2e · Mobile E2E`), which has failed on every recent `main` run; the
> `CI gate` job therefore fails with it. Instrumentation for that step landed in
> `beta/phase-1` and waits for a run to diagnose it — see
> [docs/engineering/BETA_READINESS.md](docs/engineering/BETA_READINESS.md) §5.2.
> The Docker compose smoke stage passes. `Deploy` is `skipped` because
> `vars.DEPLOY_ENABLED` is not `true`; it stays inert until the SSH secrets
> exist. No production deployment has been performed, and the redeploy/rollback
> branch on a real VPS is still unverified.

## 🚀 Local development

### Prerequisites
- Node.js 20+
- Docker (for PostgreSQL/Redis) — or any local PostgreSQL instance

### 1. Backend

```bash
cd backend
docker compose up -d            # starts PostgreSQL on :5432 and Redis on :6379
cp .env.example .env            # then edit values
npm install
npx prisma db push              # create tables
npm run start:dev               # → http://localhost:3000/api
```

No SMS provider is configured, so in development the OTP response carries the
code as `testCode` and both clients show it in a «کد تست (فقط محیط توسعه)» box.

#### Calls in local development

Calls need a media server. The quickest local one is LiveKit in dev mode:

```bash
docker run --rm -p 7880:7880 -p 7881:7881 -p 7882:7882/udp \
  livekit/livekit-server:v1.13.10 --dev --bind 0.0.0.0
```

The dev key/secret are `devkey` / `secret`; the backend `.env.example` already
points at `ws://localhost:7880`. The web app and the mobile development build
both use the token returned by the API, so no LiveKit secret is ever placed in a
client bundle. Without a server, the call buttons report that calling is not
configured and chat keeps working.

### 2. Web

```bash
npm install
npm run dev                     # → http://localhost:5173
```

`VITE_API_URL` defaults to `/api` and the Vite dev server proxies `/api` and
`/socket.io` to `http://localhost:3000`, so no `.env` is needed locally. (The
root `.env.example` belongs to `docker-compose.yml`, not to Vite.) Set
`VITE_API_URL` only when the API lives on another origin — see the Dockerfile.

### 3. Mobile

```bash
cd mobile
cp .env.example .env            # EXPO_PUBLIC_API_URL must be an absolute URL
npm install
npx expo start
```

Use your machine's LAN IP (not `localhost`) when testing on a physical device.
Access and refresh tokens live in SecureStore; the cached profile sits in
AsyncStorage. Calls use the native LiveKit SDK and need a development build
(`npx expo prebuild` + a native build, or EAS); Expo Go can still run the chat
but shows a clear message when a call is attempted.

## ☁️ Deployment

### Docker on a VPS (what is actually running)

`docker-compose.yml` at the repo root brings up five services — `postgres`,
`redis`, `api`, `web` (nginx serving the built SPA and proxying `/api`,
`/socket.io` and `/livekit/`), and `livekit` (the self-hosted SFU). One command
on a fresh Linux server:

```bash
curl -fsSL https://raw.githubusercontent.com/hoseinrza/OpenBridge/main/deploy.sh | bash
```

[`deploy.sh`](deploy.sh) installs Docker if needed, creates 2 GB of swap, clones
the repo to `/opt/openbridge`, generates `.env` with random database password,
JWT secret and LiveKit key/secret (first run only), builds and starts the stack,
then installs a cron entry that runs `bash deploy.sh --redeploy` every 5 minutes
— the same staged path the Deploy workflow uses (CI gate, backup, build, swap,
health check, rollback). [`DEPLOY.md`](DEPLOY.md) (Persian) covers status, logs,
manual updates, restarts, domain/HTTPS, the LiveKit UDP/TCP ports and common
problems such as a busy `WEB_PORT`. Calls need inbound `7881/tcp` and `7882/udp`
open in the provider firewall in addition to the web port.

### Alternative: Vercel + Render

[`vercel.json`](vercel.json) and [`render.yaml`](render.yaml) are kept for a
split-hosting setup. Point `VITE_API_URL` at the deployed API and set
`CORS_ORIGINS` on the backend to the frontend origin, otherwise browsers reject
cross-origin calls in production. Remember that production OTP requests return
`503` until an SMS gateway is added.

## 📁 Structure

```
.
├── src/                # React web app (Vite)
├── mobile/             # Expo React Native app
├── public/             # Static assets + logos
├── backend/            # NestJS API: REST, Socket.IO gateway, Prisma schema
│   ├── src/
│   ├── prisma/
│   └── test/           # security e2e suite
├── docs/               # SECURITY.md + engineering notes
├── .github/workflows/  # ci.yml (staged) + deploy.yml (CI-gated SSH deploy)
├── docker-compose.yml  # Postgres + Redis + API + nginx
├── .dockerignore       # keeps the web image context small
├── deploy.sh           # VPS bootstrap + staged --redeploy
├── render.yaml         # Render blueprint (alternative)
└── vercel.json         # Vercel config (alternative)
```

## 📚 Docs

- [CHANGELOG.md](CHANGELOG.md) — release history; every shipped change bumps the product version here
- [docs/SECURITY.md](docs/SECURITY.md) — confidentiality model, controls, threat model
- [docs/engineering/E2EE_DESIGN.md](docs/engineering/E2EE_DESIGN.md) — protocol evaluation and rollout design
- [docs/engineering/UI_UX_REDESIGN.md](docs/engineering/UI_UX_REDESIGN.md) — design tokens, screens, verified QA
- [docs/engineering/OVERNIGHT_PROGRESS.md](docs/engineering/OVERNIGHT_PROGRESS.md) — what shipped, batch by batch, with the verification actually performed
- [docs/engineering/BETA_OPERATIONS.md](docs/engineering/BETA_OPERATIONS.md) — environments, configuration, backup/restore, release checklist and rollback
