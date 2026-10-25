# Beta operations

Written for the Beta phase. It records how the application is configured, run,
tested, backed up and released, and it is deliberately explicit about what has
been verified on this machine and what has not.

## 1. Environments and startup order

| Environment | Database | API | Web | Media | Notes |
|-------------|----------|-----|-----|-------|-------|
| Local development | `backend/docker-compose.yml` (Postgres 16 on :5432, Redis on :6379, not used by code) or any local Postgres | `npm run start:dev` in `backend/` on :3000 | `npm run dev` at the repo root on :5173, proxy `/api` + `/socket.io` | optional LiveKit dev container on :7880–7882 | OTP test codes are returned in the response (§3) |
| CI | Disposable Postgres service container | Built from `backend/dist`, booted per suite | Vite build (not served except in the compose smoke) | not started | GitHub Actions only |
| VPS (Docker Compose) | `postgres` container with a volume | `api` container, runs `prisma db push` before boot | `web` (nginx) serves the SPA and proxies API/socket/LiveKit | `livekit` container | Deployed by `deploy.sh`, gated on CI |
| Render + Vercel (alternative) | Render PostgreSQL | Render web service (`render.yaml`) | Vercel | not included | Production OTP returns 503 until an SMS gateway exists |

Startup order on the VPS is enforced by compose: Postgres becomes healthy
(`pg_isready`), then the API starts, runs schema sync and listens on 3000, and
nginx starts once the API is healthy. nginx only proxies `/api/*`; a bare `/api`
request must not be used as a health URL.

## 2. Configuration and validation

The API refuses to boot without `JWT_SECRET` and `CONTENT_KEY`
(`backend/src/config/env.ts`). In production `JWT_SECRET` must be at least 32
characters; `CONTENT_KEY` must be base64 for exactly 32 bytes in every
environment.

| Variable | Required | Default | Effect |
|----------|----------|---------|--------|
| `DATABASE_URL` | yes | — | Prisma connection |
| `JWT_SECRET` | yes | — | Access tokens, OTP HMAC key, signup tokens |
| `CONTENT_KEY` | yes | — | Master key for at-rest sealing. Changing it makes existing content unreadable |
| `NODE_ENV` | no | `development` | `production` disables OTP test codes and tightens CORS |
| `CORS_ORIGINS` | production cross-origin | empty (deny) | Comma-separated browser allowlist |
| `TRUST_PROXY` | behind nginx/Render | `false` | Express proxy hops for client IPs |
| `REFRESH_TOKEN_TTL_DAYS` | no | `30` | Session lifetime |
| `MAINTENANCE_INTERVAL_SECONDS` | no | `3600` | Housekeeping interval |
| `MAINTENANCE_SESSION_RETENTION_DAYS` | no | `30` | How long a revoked session is kept |
| `LIVEKIT_URL` / `LIVEKIT_API_URL` / `LIVEKIT_API_KEY` / `LIVEKIT_API_SECRET` | for calling | empty | Chat works without them; call endpoints answer 503 |
| `CALL_*` | no | see `.env.example` | Ring timeout, token TTL, max duration and group size |

`backend/.env.example` is the authoritative list and comments each value. Secrets
are never committed: the deploy script generates the database password, JWT
secret and LiveKit key/secret on first install, and only writes them to `.env`
on the server.

## 3. Test-mode OTP (no SMS spend)

Outside production, `POST /api/auth/otp/request` returns `testCode` and both
clients display it. `OTP_TEST_MODE` is derived only from `NODE_ENV`, so no
deployment variable can switch it on. With `NODE_ENV=production` the endpoint
answers 503 and creates no code; `backend/test/security.e2e.cjs` boots the app in
production mode and asserts that. This is the documented integration point for a
future SMS provider (README, "What is deliberately not here").

## 4. Schema changes, seeding, reset

- **Schema:** there is no `migrations/` directory; the schema is applied with
  `prisma db push`. The Docker CMD first runs
  `prisma/sql/dedupe-reactions.sql` and then `db push --skip-generate`, so a
  fresh container always matches `schema.prisma`. `prisma db push` fails rather
  than silently dropping data when a change would be destructive, which is the
  safety net for an additive Beta schema.
- **Before a schema-changing release:** take a backup (§6). A rollback of the
  image does not undo a schema push; the previous code is expected to tolerate
  the additive columns/indexes it finds. If a change is not additive, plan a
  forward fix instead of an image rollback.
- **Seed:** `cd backend && npm run seed:dev` runs
  `test/dev-chat-seed.mjs`. It wipes a **localhost** database, refuses to run
  with a non-local `DATABASE_URL` or `NODE_ENV=production`, and exists only for
  local screens. CI uses `test/mobile-e2e-seed.mjs` against a disposable
  database. No seed data is loaded into a Beta or production environment.
- **Safe reset (local only):** `docker compose down -v` in `backend/` removes
  the database volume. This is destructive and must never be run on the VPS or
  against a Beta environment. In tests, every suite creates its own users and
  deletes them (and, since 1.10.9, the conversations they created).

## 5. Tests and required configuration

Backend e2e runs against a real PostgreSQL and builds first:

```bash
cd backend
npm run test:e2e        # build + 113 cases across 12 files
```

The suites set their own `JWT_SECRET`, `CONTENT_KEY` and LiveKit test keys;
they need only `DATABASE_URL` (from `backend/.env`). `LIVEKIT_API_URL` is
deliberately unset in the call suite so no request reaches a media server.
`security.e2e.cjs` also boots a production-mode instance.

Web and mobile:

```bash
npm run lint && npm run build          # web
cd mobile && npm test                  # Jest + RNTL, 96 cases
cd mobile && npx expo export --platform android
npm run test:e2ee                      # MLS library gate
```

No test requires Docker, an emulator or a paid service on this machine; the
Docker compose smoke and the Maestro flow run only in CI (§8 of
`BETA_READINESS.md`).

## 6. Backup and restore

**VPS (Docker).** Every `deploy.sh --redeploy` refuses to continue if its
`pg_dump` fails, writes `backups/openbridge-<UTC timestamp>.sql.gz` and keeps the
last `BACKUP_KEEP` files (default 5).

```bash
cd /opt/openbridge
docker compose exec -T postgres pg_dump -U openbridge openbridge | gzip > backups/manual-$(date -u +%Y%m%dT%H%M%SZ).sql.gz
```

Restore into the running database (stop writers first or accept that the dump is
a point-in-time snapshot):

```bash
gunzip -c backups/openbridge-<timestamp>.sql.gz | \
  docker compose exec -T postgres psql -U openbridge -d openbridge
```

Verify after a restore: `docker compose exec -T postgres psql -U openbridge -d openbridge -c '\dt'`,
then check row counts for `users`, `conversations`, `messages` and `sessions`,
request `/api/health/ready`, and sign in with a test account **on a
non-production environment**. A restore does not need `CONTENT_KEY` to succeed
but content is unreadable without the same `CONTENT_KEY` the dump was written
with — it is not in the dump.

**Render.** Use the dashboard's PostgreSQL backups or `pg_dump` from a machine
that can reach the database; the production database is only reachable from the
VPS, so restore from there.

**Local.** `pg_dump` the local database the same way before a schema experiment;
the local volume is disposable by design.

## 7. Release checklist and rollback

Pre-release:

1. `npm run lint` and `npm run build` at the root; `npm run test:e2ee`.
2. `cd backend && npm run test:e2e` (113 cases, includes production-mode OTP,
   calling, health and maintenance).
3. `cd mobile && npm test` and `npx expo export --platform android`.
4. `npm audit --omit=dev --audit-level=high` at the root and in `backend/`;
   record any accepted advisory.
5. Confirm CI is green on the commit being released (`CI gate`). A branch push
   does not run CI; only a pull request or a `main` push does.
6. Confirm `CONTENT_KEY` is unchanged and `.env` has every newly required
   variable. Never rotate `CONTENT_KEY` during a release.
7. Read `CHANGELOG.md`; the version in all three manifests and the lockfiles
   matches the release entry.

Deploy (VPS, only with explicit authorization):

```bash
cd /opt/openbridge
bash deploy.sh --redeploy --ref <sha>
```

The script checks CI, backs up the database, builds while the old containers
serve, swaps, and waits for `/api/health/ready` through nginx. Tune
`HEALTH_DEADLINE` on slow boxes.

Post-deploy:

1. `docker compose ps` — all five services up, `api` and `web` healthy.
2. `curl http://localhost/api/health/ready` through nginx.
3. Sign in over OTP in the Beta environment (test-mode only) and send one
   direct message; open a group; make a short call if LiveKit ports are open.
4. Watch `docker compose logs --tail=100 api` for restart loops or readiness
   warnings; confirm no OTP, token or message content appears in the log.

Rollback:

- **Image/code:** `bash deploy.sh --redeploy --ref <previous sha>`. The script
  detects an unhealthy release and rolls back automatically; a bad SHA is
  recorded in `.deploy-failed-sha` so the 5-minute cron stops retrying it.
- **Database:** restoring a dump (§6) is a separate, manual operation and may
  discard messages written after the backup. Prefer a forward fix; use the dump
  only when data is corrupted or a non-additive schema change must be undone.
- **Record** the incident and the SHA in the release log, then remove
  `.deploy-failed-sha` deliberately once `main` has moved past the bad commit.

## 8. What is not verified here

- No Docker on this machine: the compose healthcheck, image build, container
  stop/uptime and the nginx proxy path are configured but were exercised only
  in CI's `deploy-dry-run` (which has not run for `beta/phase-1`).
- No emulator or Android device: the mobile flow is CI-only (Maestro has been
  red on `main`; see `BETA_READINESS.md` §5.2).
- No production deployment, no production database access, and no SMS provider.
- The VPS `deploy.sh` rollback branch has never been run on a real VPS; the
  script is reviewed, not proven.
