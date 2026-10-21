# Changelog

All notable changes to OpenBridge are documented here. The three manifests
(`package.json`, `backend/package.json`, `mobile/package.json` + `mobile/app.json`)
carry one product version, so a release entry applies to every client.

## [1.1.4] - 2026-10-21

### Added
- **E2EE Phase 2a on the backend: the server can now deliver ciphertext it
  cannot read. Messages are still not encrypted, because no client holds keys
  yet.** `Conversation.e2ee` is a one-way opt-in flag set by `POST
  /api/messages/e2ee/direct` (either side can set it, nothing turns it off, so a
  downgrade can only ever be a visible user action), and `GET
  /api/messages/e2ee/direct/:userId` answers `{conversationId, e2ee}` without
  creating or changing anything — a client asks this every time it opens a chat.
- New table `e2ee_envelopes`: one opaque base64 MLS blob per message plus a
  per-conversation `seq`, unique on `(conversationId, seq)`. `e2ee:append`
  numbers a blob and broadcasts `e2ee:envelope` to the participants inside one
  critical section — an in-process per-conversation queue, a transaction-scoped
  `pg_advisory_xact_lock(hashtext(conversationId))`, and the unique index as
  backstop — because MLS refuses a ratchet generation it has not seen yet.
- `GET /api/messages/:conversationId/envelopes?afterSeq=&take=` is the
  reconnect catch-up: oldest first, page bounded by `E2EE_ENVELOPE_PAGE`,
  returned byte for byte and never as message content.
- Read state for an encrypted chat is one forward-only `e2eeReadSeq`
  high-water mark per participant (`e2ee:read`, always answering `{ok, moved}`),
  because the server cannot tell which ciphertexts a client has read. The chat
  list now carries `e2ee` and computes unread as "peer envelopes above my mark".
- `message:send` into an encrypted conversation is refused on both the
  conversation-id and peer-id routes, and a flagged group refuses envelopes *and*
  plaintext, so the flag can only be set where transport exists.
- Caps in `backend/src/config/env.ts`: `E2EE_MAX_ENVELOPE_CHARS`,
  `E2EE_ENVELOPE_PAGE` (documented in `backend/.env.example`).
- Six e2e cases in `backend/test/security.e2e.cjs` (**32/32 pass locally**):
  the 12-concurrent-append test asserts gapless numbering and strictly
  ascending delivery; others cover the one-way flag, inert probing, plaintext
  refusal, catch-up paging with membership checks, forward-only marks,
  per-conversation sequence isolation, base64/size caps, and that an outsider
  appending to a guessed conversation id is told only that they are not a member.
- Verified on the running dev server, not only in the suite: the new routes
  appear in the live Nest router log, unauthenticated calls return 401, and a
  throwaway two-account session exercised opt-in, append, broadcast, catch-up
  and read marks with the stored row byte-identical to what the client sent.

### Changed
- `docs/engineering/E2EE_DESIGN.md` §6 now describes the MLS transport that
  landed instead of the Signal-shaped per-device envelope the first draft
  proposed; `one_time_prekeys` and per-recipient envelope tables are marked
  superseded. §7 records Phase 2's server half as landed and §11 states plainly
  that no shipped client calls any of this, so no user-visible chat is encrypted.
- `docs/engineering/OVERNIGHT_PROGRESS.md` gains the Phase 2a batch and a new
  owed item: the envelope stream has no retention rule, because a high-water
  mark records what one participant saw, not what all of them did.

### Not encrypted yet
- No product code imports `shared/e2ee`; web and mobile still send plaintext.
  Turning the flag on requires an API call, never a UI action.

## [1.1.3] - 2026-10-21

### Added
- **E2EE Phase 1 on the backend: device registration and `KeyPackage` storage.
  Messages are still not encrypted.** `backend/src/e2ee/` serves five endpoints
  under `/api/e2ee`: register or refresh own device, list own devices, revoke
  own device, append public KeyPackages to own pool, and claim one fresh
  KeyPackage per active device of a recipient. The pool is one opaque base64
  column plus consumption metadata — the server never decodes it, and there is
  deliberately no column that could hold a private key, MLS client state or a
  passphrase.
- KeyPackage consumption is atomic: a claim stamps rows with `consumedAt` and a
  random `claimToken`, then re-reads exactly the rows carrying its own token, so
  one package can never reach two callers. A recipient whose pool cannot cover
  every active device yields no partial bundle — an incomplete group is a
  silent message leak to the missing device.
- New tables `devices` and `key_packages` (applied with `prisma db push`), and
  new caps in `backend/src/config/env.ts`: `E2EE_MAX_DEVICES_PER_USER`,
  `E2EE_MAX_PACKAGES_PER_UPLOAD`, `E2EE_MAX_PACKAGES_PER_DEVICE`,
  `E2EE_MAX_PACKAGE_CHARS`, `E2EE_CLAIM_LIMIT`, `E2EE_REGISTER_LIMIT`.
- Seven e2e cases in `backend/test/security.e2e.cjs` (26/26 pass locally):
  injected `userId`/`privateKey`/`state` fields dropped and never stored,
  another account's device unreachable by id, revoked device ids cannot
  re-register, base64/size/count caps, the same package never handed out twice
  including two concurrent racers for the last one, and identical error text
  for an unknown account and a device-less one so the endpoint cannot be used
  to enumerate accounts.

### Changed
- `docs/engineering/E2EE_DESIGN.md` marks Phase 1 done and describes the
  delivered API and its custody properties (§4/§7); the overnight log's next
  priority is now Phase 2 (client keys and encrypted direct conversations).

## [1.1.2] - 2026-10-21

### Added
- **E2EE Phase 0 gate closed; messages are still not encrypted.**
  `shared/e2ee/provider.js` adapts ts-mls's crypto interfaces onto `hpke` +
  `@panva/hpke-noble` (noble-backed DHKEM X25519 / HKDF-SHA256 / AES-128-GCM)
  and pinned `@noble/curves` Ed25519, so MLS no longer needs `crypto.subtle` —
  the blocker that made Expo/Hermes impossible in 1.1.1. The provider is
  interface glue and implements no primitive.
- `npm run test:e2ee`, wired into CI as job `2b · E2EE library gate`: the full
  MLS lifecycle on two ciphersuites, replay and stale-generation rejection,
  removed member cannot decrypt, state round-trip, cross-provider interop in
  both directions against ts-mls's WebCrypto path, and the same run with
  `crypto.subtle` replaced by a throwing trap. 5/5 pass locally.

### Changed
- The E2EE design doc records the gate verdict (§3.6), fixes MLS as the
  protocol (§3.4/§3.5 are superseded), restates key storage and multi-device in
  MLS terms, and adds a non-negotiable key-custody rule in §4: no server escrow,
  no recovery endpoint, no server-side search, preview or scanning of encrypted
  content — no access level, including the platform owner, can read message
  text.
- Dependency pins reproduce the tested tree exactly (`ts-mls@1.6.4`,
  `hpke@1.1.7`, `@panva/hpke-noble@1.1.7`, `@noble/ciphers@2.1.1`,
  `@noble/curves@2.0.1`, `@noble/hashes@2.4.0`). Two known costs are documented
  rather than hidden: Metro will not tree-shake the post-quantum code
  `@panva/hpke-noble` imports, and npm nests a second `@noble/ciphers` because
  ts-mls peer-pins an older one.

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
