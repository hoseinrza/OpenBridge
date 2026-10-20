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
- Video calling UI remains hidden; signaling code is present but unused.
- Mobile receives auth/session improvements and 401 refresh, but has no session
  list UI and still cannot create or display groups.

## Next priorities

1. Add a session-management UI on web (list active sessions, revoke individual
   devices) using the existing endpoints.
2. Move throttling/presence to a shared store (Redis) before running more than
   one API instance.
3. Add authorization tests for group membership changes (add/remove participant)
   and message edit/delete once those endpoints exist.
4. Capture and display the E2EE `Session`/device list as the precursor to
   multi-device key management; run the Phase 0 library gate described in the
   E2EE design before any cryptographic implementation.
5. Add a web security review pass (CSP, token storage trade-off) and cover the
   signed-URL download path with a cross-user authorization test.
