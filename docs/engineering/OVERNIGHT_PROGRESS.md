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
| this commit | Automated security regression suite, CI workflow, security model documentation, progress log |

## Validation actually run

- `backend`: `npm run build` — passed after every batch.
- `backend`: `npm run test:e2e` — 9/9 tests passed:
  - startup fails without `JWT_SECRET`
  - unauthenticated/forged JWTs rejected
  - self-chat, pagination bounds, invalid UUIDs, group DTO validation
  - non-member cannot read history, send, react, or type in a group
  - participant reactions broadcast with the real conversation ID
  - oversized/invalid message payloads rejected; self and external-file sends rejected
  - invalid socket token disconnected
  - upload allowlist, magic-byte check, unsigned/tampered download denial,
    signed download success with `nosniff`
  - CORS allows localhost in development and rejects unknown origins
- Manual checks with the running API:
  - missing `JWT_SECRET` throws before the server starts
  - production origin policy: configured origin allowed, unknown origins get no CORS headers
  - real PNG upload/avatar round-trip through a signed URL (200, `image/png`, `nosniff`)
  - HTML and disguised PNG uploads rejected (400) without leaving files behind
  - direct chat send and group chat send/typing/read/reaction behavior verified
- `web`: `npm run build` — passed (Vite, 74 modules).
- Test data created during verification was deleted afterwards; the existing
  `amir` group and user-created accounts were left untouched.

## Unresolved / known issues

- No E2EE; server stores plaintext messages. See `docs/SECURITY.md`.
- No refresh tokens, session listing/revocation, or account deletion flow.
- No HTTP rate limiting on login/register yet.
- Socket rate limits/presence are in-memory (single process).
- Signed download URLs are bearer capabilities until expiry; membership is not
  re-checked on download.
- No virus scanning for uploaded documents.
- Web lint baseline is broken (313 errors); CI does not run lint yet.
- Mobile app unchanged in this session; only `resolveUrl` updated for private uploads.
- Video calling UI remains hidden; signaling code is still present but unused.

## Next priorities

1. Add HTTP rate limiting for auth endpoints (login/register) and a shared
   throttling store for multi-instance deployments.
2. Implement server-side session/refresh-token revocation and a session list UI.
3. Add authorization tests for group membership changes (add/remove participant)
   and message edit/delete once those endpoints exist.
4. Fix the web lint baseline, then add lint to CI.
5. Evaluate a maintained E2EE protocol (e.g. libsignal) and produce a design
   before any cryptographic implementation.
