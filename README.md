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
- 😀 Message reactions
- 📎 Private file & image uploads behind signed, expiring URLs (optional ClamAV scan)
- 🔎 User search by name/username, plus an in-conversation message filter
- 👤 Profiles: a unique username, a first name, an optional last name and a bio
- 🔤 Initials avatar whenever a user has no photo — the colour is derived from their name
- 🌗 Light and dark themes, RTL Persian UI, layouts checked down to 320 px
- 🔄 Revocable login sessions with rotating refresh tokens
- 📱 Expo React Native app: login, chat list, chat, new group

### What is deliberately not here

- 📵 **No SMS provider is wired in.** Outside production, `POST /auth/otp/request`
  returns the generated code in its response so you can finish the flow; with
  `NODE_ENV=production` it answers `503` («ارسال پیامک هنوز فعال نشده است») and
  creates no code. Sign-up therefore works only in development until a gateway
  is integrated.
- 🔓 Not end-to-end encrypted — the server stores message content in plaintext.
  See [docs/SECURITY.md](docs/SECURITY.md) and
  [docs/engineering/E2EE_DESIGN.md](docs/engineering/E2EE_DESIGN.md).
- 📹 Video calls are not wired to any UI. Signalling events exist in the gateway
  and orphaned components sit in `src/components/VideoCall/`, but neither client
  can start a call.

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

## 🧱 Tech stack

| Layer      | Stack                                                          |
|------------|----------------------------------------------------------------|
| Web        | React 19, Vite, React Router, Socket.IO client                 |
| Mobile     | Expo SDK 57, React Native, React Navigation, SecureStore       |
| Backend    | NestJS 10, Socket.IO, Prisma, JWT + Passport                   |
| Data       | PostgreSQL 16 (Prisma)                                         |
| Infra      | Docker Compose, nginx (SPA + API/WebSocket proxy), ClamAV (opt)|

> `backend/src/redis/redis.service.ts` is an in-process presence map despite its
> name: no code reads `REDIS_URL` and no Redis client is installed, so the
> `redis` container in `docker-compose.yml` is currently dead weight and presence
> does not survive a second API instance.

## 🔒 Security

OpenBridge is **not end-to-end encrypted**; the server stores message content in
plaintext. See [docs/SECURITY.md](docs/SECURITY.md) for the confidentiality model,
implemented controls, threat model, and known limitations.

The API requires `JWT_SECRET` and refuses to start without it. In production it
must be at least 32 characters. Cross-origin browser access is deny-by-default
in production; set `CORS_ORIGINS` to a comma-separated allowlist when the web
app and API are on different origins. Native apps send no `Origin` header and are
always allowed.

## 🧪 Tests & checks

```bash
cd backend && npm run test:e2e     # 16 tests: OTP signup, sessions, uploads, CORS, socket
npm run lint                       # web ESLint
npm run build                      # web production build
cd mobile && npx expo export --platform android
```

The e2e suite boots the Nest app against the configured PostgreSQL database,
creates temporary users and conversations, and cleans them up afterwards. Note
that mobile has no automated test suite — screen QA is manual.

## 🔁 CI & CD

[`ci.yml`](.github/workflows/ci.yml) runs in ordered stages, each one gated on
the stage before it, so the slow jobs never start on code the fast jobs reject:

| Stage | Job | What it proves |
|-------|-----|----------------|
| 1 · static | `web-lint`, `backend-check` | ESLint clean · Prisma schema valid · TypeScript compiles |
| 2 · tests | `backend-e2e` | The 16 security tests pass against real PostgreSQL |
| 2b | `dependencies` | `npm audit` findings (reports, never blocks) |
| 3 · artefacts | `web-build`, `mobile-bundle` | The Vite bundle builds · the Expo Hermes bundle builds |
| 4 · ship path | `deploy-dry-run` | Both Docker images build, `docker compose up` serves the SPA, `/api/health` answers **through nginx**, and Socket.IO handshakes |
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
swap → wait for `/api/health` through nginx. If health never arrives, it checks
out the previous commit, rebuilds, and records the bad SHA in
`.deploy-failed-sha` so the cron cannot crash-loop on it. Tune the wait with
`HEALTH_DEADLINE` on very slow boxes.

> The CI/CD pipelines themselves have not run on GitHub Actions yet — the
> redeploy logic was verified against stubbed `docker`/`curl` in a throwaway
> clone. Expect to tune the first few real runs.

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
AsyncStorage.

## ☁️ Deployment

### Docker on a VPS (what is actually running)

`docker-compose.yml` at the repo root brings up four services — `postgres`,
`redis`, `api` and `web` (nginx serving the built SPA and proxying `/api` plus
`/socket.io` to the API). One command on a fresh Linux server:

```bash
curl -fsSL https://raw.githubusercontent.com/hoseinrza/OpenBridge/main/deploy.sh | bash
```

[`deploy.sh`](deploy.sh) installs Docker if needed, creates 2 GB of swap, clones
the repo to `/opt/openbridge`, generates `.env` with random database password and
JWT secret (first run only), builds and starts the stack, then installs a cron
entry that runs `bash deploy.sh --redeploy` every 5 minutes — the same staged
path the Deploy workflow uses (CI gate, backup, build, swap, health check,
rollback). [`DEPLOY.md`](DEPLOY.md) (Persian) covers status, logs, manual
updates, restarts, domain/HTTPS and common problems such as a busy `WEB_PORT`.

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

- [docs/SECURITY.md](docs/SECURITY.md) — confidentiality model, controls, threat model
- [docs/engineering/E2EE_DESIGN.md](docs/engineering/E2EE_DESIGN.md) — protocol evaluation and rollout design
- [docs/engineering/UI_UX_REDESIGN.md](docs/engineering/UI_UX_REDESIGN.md) — design tokens, screens, verified QA
- [docs/engineering/OVERNIGHT_PROGRESS.md](docs/engineering/OVERNIGHT_PROGRESS.md) — what shipped, batch by batch, with the verification actually performed
