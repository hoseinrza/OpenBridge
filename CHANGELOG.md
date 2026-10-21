# Changelog

All notable changes to OpenBridge are documented here. The three manifests
(`package.json`, `backend/package.json`, `mobile/package.json` + `mobile/app.json`)
carry one product version, so a release entry applies to every client.

## [1.1.1] - 2026-10-21

### Changed
- **Documentation only — messages are still not encrypted.** The mandatory
  Phase 0 library gate in `docs/engineering/E2EE_DESIGN.md` was executed with
  real code (§3.5): libsignal has no web or Expo artifact, `ts-mls` runs a full
  MLS lifecycle in web/Node with a pure-JS provider (measured sizes and
  timings), and mobile fails because Hermes has no `crypto.subtle`. Two server
  consequences are recorded: MLS needs strictly ordered per-conversation
  delivery, and ~3 KB of group state per conversation does not fit
  `expo-secure-store`.

## [1.1.0] - 2026-10-20

### Added
- **Contact matching.** `POST /api/users/contacts/match` takes the numbers a
  device already holds, normalises them server-side, and answers only which
  input positions belong to an account — no phone number is stored or echoed
  back. Requires a session, caps the list at `CONTACT_MATCH_MAX_PHONES` (500)
  and is rate limited per client (`CONTACT_MATCH_LIMIT` 20 / 15 min).
- **Mobile contacts screen** (`expo-contacts`): asks for the permission on
  demand, reads the address book, and lists the contacts that have an account
  (tap to start a chat) plus an opt-in list of those that do not. Reachable
  from the chat-list header and from the empty state.
- **Web contacts panel** in the new-chat modal: uses the Contact Picker API
  where the browser supports it (Chromium on Android) and always offers a
  paste-a-list box, which is what desktop browsers can actually do.
- Three e2e cases covering the match, the validation/rejection paths, and the
  rate limit.

### Changed
- `users` controller now runs the shared `RateLimitGuard` alongside JWT auth.

## [1.0.0] - 2026-10-20

First release line. Bundled into it, newest first:

- **CI/CD**: staged `ci.yml` (static checks → e2e → dependency audit → build
  artefacts → `docker compose` smoke test → single required `ci-gate`), an
  optional SSH `deploy.yml` gated behind `DEPLOY_ENABLED`, and `deploy.sh
  --redeploy` with CI gate, `pg_dump` backup, health wait, rollback and
  poisoned-SHA quarantine. `/api/health` plus container healthchecks make the
  running stack verifiable through nginx.
- **README rewritten** for the OTP-only sign-in, the mobile app, and the VPS stack.
- **Phone OTP identity**: legacy username/password login removed; sign-up is a
  four-step wizard (phone → code → username → name); family name is optional and
  `displayName` is derived from the two parts; accounts with no photo are shown
  as initials on a deterministic colour.
- **Mandatory user-chosen username** at signup, phone normalisation accepting
  `09…`, `+989…`, `00989…`, `989…`, `9…` including Persian/Arabic digits.
- **UI redesign** on both clients: shared design tokens, RTL, light/dark themes,
  rebuilt chat surfaces, group creation on mobile.
- **Security hardening**: required `JWT_SECRET` and configured CORS, authorised
  socket events with payload validation, private signed-URL uploads with type
  checks and optional ClamAV scanning, input validation with bounded pagination,
  per-IP/per-phone auth throttling, revocable server-side sessions with rotating
  refresh tokens, and a security regression e2e suite in CI.
- **Group chat** support with participant management and real-time events.

[1.1.0]: https://github.com/hoseinrza/OpenBridge/compare/fd25292...HEAD
[1.0.0]: https://github.com/hoseinrza/OpenBridge/comm/fd25292
