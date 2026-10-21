# Changelog

All notable changes to OpenBridge are documented here. The three manifests
(`package.json`, `backend/package.json`, `mobile/package.json` + `mobile/app.json`)
carry one product version, so a release entry applies to every client.

## [1.1.11] - 2026-10-21

E2EE Phase 4 on the web client: attachments are now encrypted on the sender's
device, and every conversation opens with a line that states what this device
actually does with it.

### Added
- **Encrypted file and picture sending on web.** A file is sealed with a fresh
  AES-256-GCM key and a fresh 96-bit nonce in the browser (WebCrypto) before any
  byte is uploaded; only ciphertext reaches the server. The descriptor — blob id,
  name, MIME type, size, key, nonce — is a small JSON payload inside the MLS
  message, so a stored attachment has no filename, no type and no plaintext hash
  anywhere the platform can read. `shared/e2ee/attachments.js` defines the format
  with nothing but JSON, base64 and length checks, so a phone can open what a
  browser wrote.
- **`EncryptedBlob` storage and its two-step access.** `backend/prisma/schema.prisma`
  gained a conversation-bound blob table (`enc-<uuid>.bin`, ciphertext length, no
  metadata); `POST /api/uploads/encrypted` accepts bytes for a conversation that
  is already end-to-end encrypted and refuses any other; `GET
  /api/uploads/encrypted/:id/url` re-checks membership and issues a fresh
  HMAC-signed URL; `GET /api/uploads/encrypted/:filename` serves the bytes only to
  a valid unexpired signature, as `application/octet-stream` with `nosniff` and
  `Content-Disposition: attachment`. Uploading to an unencrypted chat is refused
  with `400`, so the endpoint cannot be used as a free file host.
- **`src/services/attachments.js` and `EncryptedMedia.jsx`.** Ciphertext is
  fetched, authenticated and decrypted into a refcounted object URL that is
  revoked when the last view of it goes away; a picture is opened when it nears
  the viewport and a larger file only when asked for. GCM failure means no URL is
  ever created, so a changed file has no rendering path at all.
- **One notice per conversation, five sentences.** `e2eeNotice` in
  `MessageList.jsx` labels the chat as encrypted, as about-to-be-encrypted on its
  first message, as still resolving, as undecryptable on this device, or as a
  group — the last two saying so plainly instead of borrowing the first one's
  reassurance. The header chip and the composer's paperclip follow the same state.

### Changed
- **A fresh direct chat no longer claims it is unprotected.** It used to open with
  «این گفتگو هنوز سرتاسری رمزنگاری نمی‌شود» and no reason, which was both alarming
  and wrong; it now states that its first message is encrypted on this device, and
  the line turns into the full claim the moment that message goes out.
- **Files follow the same rule as text in an encrypted chat.** There is no
  plaintext attachment path left inside one: a file is sealed locally or the send
  is refused with a reason, and the paperclip is disabled only when the
  conversation truly cannot be carried.
- **The pre-encryption divider is now a note, not a banner**, and the encrypted
  bubble footer no longer implies anything about reactions, which an encrypted
  message cannot have: they live in the server's message table, and there is no
  row for a message the server cannot see.

### Tests
- `backend/test/e2ee-client.e2e.cjs` gained two cases and passes 8/8: a file
  encrypted on the sender, stored as opaque bytes and opened byte-for-byte by the
  peer (headers asserted, one tampered byte refused, the blob id absent from the
  envelope, zero plaintext rows, outsider `403`, unknown id `404`, unsigned blob
  `403`); and a conversation without the flag refusing to host a file at all.
  `security.e2e.cjs` 32/32, root `npm run test:e2ee` 5/5, `tsc --noEmit`, `eslint`
  and `vite build` clean.
- Live run on two real clients: a browser tab and a Node peer on the same shared
  core each sent an encrypted picture to the other in one fresh direct chat. The
  peer fetched the sender's blob through its signed URL and recovered the original
  1234 bytes exactly, with the stored ciphertext not beginning with the PNG magic
  and the response typed `application/octet-stream`; the browser authenticated the
  peer's file and rendered it at 300×240 from an object URL, its lightbox and
  download link included.

### Known limits
- **Groups are still plaintext, including their attachments** (name, type and
  bytes all visible to the server) — the blob endpoint requires the encryption
  flag, and only Phase 3 may set it on a group. Mobile holds no keys yet.
- **No scanning of encrypted uploads, and no claim of it.** ClamAV, magic-byte
  checks and MIME validation guard the plaintext path only; checking opaque
  ciphertext would be theatre, so the code does not do it and the notice does not
  promise otherwise.
- **A second device of one account cannot read a chat that started without it**,
  attachments included: the Welcome addresses the devices that existed when the
  group was formed. Proved during this batch — each live run needed a fresh peer
  account.
- Visual QA is still missing: this environment cannot capture screenshots
  (`NATIVE_BROWSER_VIEWPORT_UNAVAILABLE`), and the tab it drives never paints, so
  the viewport-gated open was exercised through a stubbed `IntersectionObserver`
  and a direct decrypt call. The behaviour is measured, not seen.


### Changed
- **The bubble interior now has one clear hierarchy.** Group sender names live
  inside the incoming bubble instead of floating above it; the footer holds
  only the clock, a smaller E2EE lock and the outgoing receipt; reaction chips
  moved to their own row along the bubble's lower edge. Image bubbles keep the
  7px inset on both rows. The sender name is drawn once per sender run, so a
  grouped second message does not repeat it.
- **The reaction control no longer clutters every bubble.** The smile button is
  a 24px circle pinned to the bubble's outer top corner: hidden at rest on
  hover-capable pointers and revealed on hover, focus or while open, while
  touch layouts keep it at 0.72 opacity. The picker floats above the bubble,
  flips below when the bubble is near the top of the scroller, clamps
  horizontally to the viewport, and closes on outside click, Escape (returning
  focus to the button), scroll or resize. It no longer changes bubble height or
  position.
- **Mobile mirrors the same layout.** Sender inside the bubble, a metadata row
  for time and ticks, chips on their own lower-edge row, the floating
  long-press picker anchored to the bubble's side, dismissal on scroll, and
  reduced bottom padding when chips are present.

### Tests
- `npm run build` clean on the final tree; ESLint clean on the changed web
  component; `npx expo export --platform android` exit 0.
- Live headless Chrome at 1264x900, dark theme: resting toggle opacity 0;
  footer at the inline end and chips at the inline start on a lower row; picker
  166px wide with five emoji; first emoji focused on open; bubble height and
  top identical before and after opening; adding a reaction through the picker
  round-tripped through the socket; Escape and outside click both closed it.
  The light theme was confirmed applied through the DOM, a 500px-wide emulation
  kept the picker inside the viewport, and the run logged no console errors.
- Controlled 420px-tall viewport: scrolled a bubble to 10px below the scroller
  top, opened the picker, and confirmed the `below` class, the picker 7px under
  the bubble, fully inside the viewport, with no bubble reflow.
- Three temporary fixture users, their conversations, sessions, messages,
  reactions and reads were deleted after the run; scratch scripts and bundles
  were removed.

### Known limits
- Mobile was bundled with `expo export`, not rendered on a device or emulator;
  picker anchoring and chip spacing there were reviewed in code only.
- The below-picker branch was exercised once in a scrolled short viewport, not
  on a touch device.

### Mobile QA & CI
- **Automated mobile QA.** `cd mobile && npm test` runs four Jest suites (33
  tests) with React Native Testing Library over the phone/time helpers, the
  login and sign-up steps, the chat list (search, empty, error), and the chat
  surface (message sides, send failure, long-press reactions, disconnected
  composer). `npm run test:ci` is the CI invocation.
- **A real on-device smoke flow.** Maestro drives an API-34 Android emulator in
  CI: it signs in with a CI-only seeded account, opens `E2E Group`, sends
  `hello from maestro`, and adds a 👍 reaction. The seed
  (`backend/test/mobile-e2e-seed.mjs`) exists only in the disposable CI
  database; the flow lives in `mobile/.maestro/auth-and-chat.yaml`.
- **CI jobs** `mobile-tests` and `mobile-e2e`, a `changes` detector, and a
  nightly schedule. The emulator runs on `main`, on PRs touching `mobile/` or
  `shared/e2ee/`, nightly, and manually.
- **Gate and concurrency.** `ci-gate` accepts the emulator job's `skipped` only
  when change detection says a PR has no mobile/shared changes; a skip or
  failure on `main` fails the gate. Main-branch CI runs are no longer cancelled
  by a newer push; PR runs still are.
- **Docs.** README and DEPLOY now state the observed pipeline status: CI is
  green on GitHub Actions, `Deploy` is skipped until `DEPLOY_ENABLED` and SSH
  secrets exist, and no production deployment has been performed. The claim
  that mobile QA is manual is removed.

## [1.1.9] - 2026-10-21

### Changed
- **Message bubbles now follow Telegram's geometry on both clients.** The radius
  is 12px instead of 14px, padding and line-height are tighter, the incoming
  bubble loses its drop shadow (a hairline border stays so it reads against the
  warm background), and the last bubble in a group gets a small curved tail on
  its outer bottom corner. Grouped bubbles are separated by 2px instead of 3px.
- **Outgoing bubbles use the brand-red gradient.** Light theme runs from
  `#CB1B22` to `#A91118`; dark theme from `#C0181E` to `#931015`; text stays
  white. Incoming bubbles stay flat. The tail is painted in the gradient's end
  colour so it joins the bottom edge without a seam. Mobile uses React Native's
  built-in `experimental_backgroundImage` gradient with the solid `bubbleOut`
  colour as the fallback for an older native build, and a positioned `View` for
  the curved tail.
- **Reactions sit on the bubble's bottom line.** Chips are compact pills at the
  inline start and the clock/receipt block is pushed to the inline end, exactly
  where Telegram places them. There are still no numeric counts. A chip you hold
  keeps its accent outline; on the red bubble the equivalent is a light outline.
  The in-bubble picker from 1.1.7 is unchanged and still opens from the smile
  button in the bubble.
- Sender names on group messages are now accent-coloured and 12.5px, matching
  the bubble's red language instead of the old grey.

### Tests
- ESLint clean on the changed component; `npm run build` clean;
  `npx expo export --platform android` exit 0. Root `npm run lint` was not used
  as a gate because unrelated in-progress attachment work currently reports an
  unused import.
- Live local stack in headless Chrome at 1264px, light and dark: signed in as a
  temporary account, opened a conversation containing messages from both test
  accounts, and measured the rendered rows. Outgoing bubbles showed the gradient
  (`linear-gradient(rgb(192,24,30), rgb(147,16,21))` in dark), incoming bubbles
  were flat white/dark, the clock sat at the inline end, reaction chips sat at the
  inline start, and the tail pseudo-element existed only on the last bubble of
  each group (radius `12px 12px 2px` on outgoing, `12px 12px 12px 2px` on
  incoming). A temporary green incoming colour confirmed the white tail shape
  renders on the left edge.
- Clicking the smile button opened a five-emoji picker; picking ❤️ changed the
  stored reaction through the socket and redrew the chip; the same chip was then
  removed by tapping it again. Both test accounts, their session, messages and
  reactions were deleted after the run.
- A 500px-wide dark render (device-metrics emulation with the chat pane opened)
  confirmed the bubbles still clear both edges and the bottom row does not
  overflow at the narrow layout.

### Known limits of this release
- Mobile was bundled, not rendered on a phone or emulator. The gradient depends
  on the new-architecture background-image style; a legacy native build keeps
  the solid brand red. The tail's exact curve is a React Native border-radius
  approximation, not the web's SVG-like clip path.
- The narrow web render was emulated at 500px in the same browser; it was not a
  separate mobile browser/device pass.

## [1.1.8] - 2026-10-21

### Changed
- **Your messages sit on the right again, everyone else's on the left.** The
  right-to-left page had the two sides mirrored: outgoing bubbles hugged the left
  edge and incoming ones the right. Both clients now anchor outgoing messages to
  the right and incoming to the left, with the avatar on the outer left edge, the
  bubble tail on the outer corner, and the footer, chips and reaction picker
  following their own bubble. Mobile resolves the row direction from
  `I18nManager.isRTL`, so the physical sides are the same on an RTL phone and an
  LTR one. The loading skeleton follows the same sides.

### Tests
- Rendered a static copy of the chat in headless Chrome screenshots at 1000px
  and 500px: outgoing bubbles sit against the right edge, incoming ones against
  the left with the avatar outside on the left, the sender name over the outer
  edge, and each footer, chip and tail follows its own bubble.
- Also measured the live app on the local stack in headless Chrome (dark theme,
  1264px wide): signed in as one test account, opened the conversation holding
  messages from both accounts, and read the row boxes. All three outgoing
  bubbles ended on the chat column's right edge (right: 928px); the incoming
  bubble sat at the left (left: 54px) with its avatar outside it (left: 16px).
  Both test accounts, their OTP rows and their conversation were deleted after
  the run.
- Root `npm run lint` clean, `npm run build` clean,
  `npx expo export --platform android` exit 0. No backend change, so the e2e
  suite was not re-run.

### Known limits of this release
- Mobile has no visual QA: the row-direction swap bundles, but no phone or
  emulator rendered it. `I18nManager.isRTL` is read once at module load, so a
  device that only flips direction after a relaunch picks the sides up on the
  next launch, the same way the rest of the app does.
- The live web check was one signed-in browser at 1264px; the 500px layout was
  rendered from the static copy above, not the live app.

## [1.1.7] - 2026-10-21

### Changed
- **A bubble now holds everything about its message.** On web the timestamp, the
  encryption lock, the react button, the read receipt, the reaction chips and the
  reaction picker all render inside `.bubble`; on mobile the tapback strip moved
  from next to the bubble into it. What stays outside is the profile — the
  avatar and, in a group, the sender's name — and nothing else.
- The web reaction picker is no longer a floating bar that appears above the
  message on hover. It opens in place, under the message content, from the smile
  button in the bubble's own footer, and closes when you pick or press it again.
  Hovering now only brightens that button, so the layout no longer jumps when the
  pointer crosses a message.
- Because the meta row and chips are painted on the bubble surface instead of the
  page background, they are bubble-aware now: on the outgoing bubble the time, the
  lock and the ticks turn translucent white and the chips keep the bubble's
  palette (`rgba(255,255,255,.16)` for someone else's, `#FFE0DE` border for the
  one you hold) so a light pill never disappears into the red.

### Fixed
- **Image and file messages never loaded their own content.** `resolveUrl` in
  both clients turned `/uploads/<file>` into `/api/<file>` — it sliced off the
  `uploads` segment that is the actual route — so every attachment 404'd and a
  picture collapsed to a broken-icon sliver inside its bubble. Both clients now
  resolve to `/api/uploads/<file>?exp=…&sig=…`
  (`src/services/api.js:11`, `mobile/src/services/api.js:27`). The defect came in
  with `d98a3b0` ("Make uploads private…"), and the e2e case for it only checked
  the URL the API *returns*, never the one the browser finally requests — so it
  survived five releases.
- Uploaded avatars could not render on web at all: `normalizeUser`, the group
  participant list and `normalizeGroup` passed the backend's `/uploads/...` path
  straight to `<img>`, which resolves against the app origin instead of the API.
  They now go through `resolveUrl`, the way mobile already did.

### Tests
- Verified live in two logged-in browsers on two throwaway accounts inside one
  group, at a narrow viewport: text, image and file bubbles on both sides each
  contain their own footer, chips and picker (checked as DOM containment *and*
  bounding-box containment), the avatar and sender name stay outside, the
  512×512 image now decodes (naturalWidth 512, drawn 280px), the file link answers
  `200` with `Content-Disposition: attachment`, and a `👍` tapped in one tab shows
  up in the other as one unpressed chip inside the sender's own bubble.
- Root `npm run lint` clean, `npm run build` clean,
  `npx expo export --platform android` exit 0. No backend change, so the e2e
  suite (38/38 at 1.1.6) was not re-run.

### Known limits of this release
- The profile dialog still cannot preview an avatar right after picking the file:
  the upload endpoint answers with an *unsigned* `/uploads/<file>` path and the
  security suite locks that contract, so the preview 403s until the profile is
  saved and the API hands back a signed URL. Everything else about a saved
  avatar works now.
- Mobile has no visual QA again: the tapback strip inside the bubble is proven to
  bundle, but no phone or emulator rendered it. On a 320pt-wide screen the strip
  is wider than the bubble's content box, so it wraps to a second row by design
  rather than clipping.

## [1.1.6] - 2026-10-21

### Changed
- **A reaction is a tapback, not a tally.** One person holds at most one reaction
  per message: tapping an emoji adds it, tapping the same one again takes it back,
  and tapping a different one replaces it. `MessagesService.addReaction` became
  `toggleReaction` — the old version had no delete path (`update: {}`) and no
  replace rule, so repeated taps grew the number and one account could stack
  several emoji on a single message.
- The rule is enforced by the database, not only by the service: `Reaction` now
  carries `@@unique([userId, messageId])`, and an e2e case inserts a second row
  for a pair directly through Prisma to prove the write is rejected with
  `P2002` even when it skips the service.
- `backend/prisma/sql/dedupe-reactions.sql` is the migration path for existing
  rows — keep the newest emoji per pair, drop the old
  `(userId, messageId, emoji)` index, create `reactions_userId_messageId_key`.
  The container's start command runs it before `prisma db push`, because Prisma
  refuses to add an index that existing data might violate and refuses it even
  after the duplicates are gone.
- The socket contract changed: `reaction:add` answers with `{ok, reactions}` and
  broadcasts **`reaction:changed`** with the message's whole row list instead of
  the old `reaction:added` delta. Clients replace what they hold instead of
  adding to it, so no device can drift into showing more than the people who
  reacted.
- **No counts anywhere.** A chip is the emoji alone; the one you hold is drawn
  pressed (accent border and fill) so it reads as yours and taps to lift it. The
  web hover bar marks the emoji you already hold too, so "add" and "remove" are
  the same control.
- Mobile can react for the first time: long-press a bubble (text, image or file)
  to open a tapback strip and pick. Before this, the chips mobile showed were
  read-only decorations with no way to add or lift one.
- Emoji are drawn by the device's own colour font — `Apple Color Emoji` first,
  then `Segoe UI Emoji`, then `Noto Color Emoji` — so an iPhone or Mac shows
  Apple's kit. Apple licenses that font to Apple hardware only, so it is not a
  file this app can ship; the codepoints are stored once and each platform draws
  them with its own artwork.

### Tests
- `backend/test/security.e2e.cjs` (**32/32**, `npm run test:e2e` **38/38**): one
  case covers add → lift → replace, six rapid taps by the same account still
  being one row, two people holding the same emoji as two rows behind one chip,
  the broadcast carrying the same list the sender's ack got, and the outsider's
  reaction still reaching nobody under the new event name.

### Known limits of this release
- Reactions are still plaintext metadata: inside an encrypted direct chat they
  are blocked outright (there is no server row to attach one to), and in every
  other conversation the server sees who reacted, with what, to when.
- Mobile remains locked out of an encrypted chat (see 1.1.5); this release did
  not touch that.
- The tapback strip and the pressed-chip states have no visual QA. The web
  behaviour is verified live in two browsers on two throwaway accounts (one chip
  per emoji whoever taps, no digits anywhere, your own chip marked pressed on
  each device), but the app's browser view cannot capture screenshots in this
  environment, so every step ran as a scripted DOM event — behaviour and markup,
  not appearance. The mobile strip has only been proven to bundle: no phone or
  emulator ran it.

## [1.1.5] - 2026-10-21

### Added
- **Direct chats are now end-to-end encrypted on the web.** A direct
  conversation between two web devices carries nothing but MLS ciphertext: the
  text is encrypted on the sender's device and decrypted only on the
  recipient's, and the server stores an opaque base64 blob per message. This is
  the first release in which any user-visible message is encrypted.
- `shared/e2ee/client.js`: the protocol half of the client — MLS device identity,
  KeyPackage pool, per-conversation group state, and the strict-order receive
  pipeline. Written to run unchanged on the phone; `src/services/e2ee.js` only
  supplies a browser (IndexedDB store, socket) and keeps one client per tab.
- The web device boots at sign-in: it registers itself and uploads a pool of 8
  KeyPackages, so an account is invitable before anybody opens a chat with it
  and its very first inbound message can already be encrypted.
- Per-account key storage: `openbridge-e2ee-<userId>` in IndexedDB. A second
  account in another tab cannot read the first one's keys or records, and keys
  survive signing out — the same browser is the same device, and discarding its
  keys would make every conversation it joined permanently unreadable.
- Lazy, read-only-first negotiation: opening a chat probes
  `GET /api/messages/e2ee/direct/:userId`, and only a "not encrypted" answer
  claims the peer's KeyPackages and flips the flag. Claiming before locking is
  what keeps the fallback honest — a peer with no keys fails with `no-keys` and
  its chat stays an ordinary plaintext one instead of becoming a conversation
  that refuses every message.
- Every active device of both users is invited, and the peer joins from the
  Welcome at envelope 1, so a device that was offline while the group was
  created can still build it purely from the ordered stream.
- Encrypted chat UI: a divider labeling the last plaintext message («از این پیام
  به بعد…» with a lock) so pre-encryption history is honest rather than
  disguised, an encrypted indicator in the header and chat list, the server's
  reason surfaced when a send is refused, and — inside an encrypted chat —
  attachments and reactions blocked instead of uploaded in the clear, and search
  run over this device's own decrypted cache with a placeholder that says so.
- Read receipts now cover encrypted bubbles: `e2ee:read` broadcasts
  `message:read`, so the one forward-only mark serves both chat kinds.
- Six client-level e2e cases in `backend/test/e2ee-client.e2e.cjs`, wired into
  `npm run test:e2e` (**38/38 pass locally**). They drive the real
  `shared/e2ee/client.js` against the live Nest server and PostgreSQL with no
  mocks: ciphertext-only storage, key state surviving a device reload, all
  active devices invited, a late envelope reordered and a duplicate ignored,
  and a relabelled sender / a blob from another conversation / an uninvited
  device all refused.

### Fixed
- A chat with an account that had never registered a device became
  envelope-only and refused everything, leaving a stuck composer with a
  meaningless error. The flag is now set only after a decryptable group exists.
- Read receipts were silently dropped for direct conversations (the handler
  matched the peer id only for groups).
- The Welcome message inflated the unread badge of the device that received it,
  and the conversation on screen kept showing a badge it had already read.

### Known limits of this release
- **Mobile is not just unencrypted, it is locked out of an encrypted chat.** No
  Expo client holds keys, so a chat a web user encrypts rejects that user's
  phone with a plaintext refusal and no explanation. Next release must close
  this, on mobile or with a visible "update the app to read this chat" state.
- Groups on every client, and any existing direct chat nobody has opened from
  the web app since this release, are still plaintext.
- No safety numbers: key adoption is trust-on-first-use. A device added after a
  conversation started cannot read its earlier messages. Losing every device
  loses the history — by decision, no recovery exists at any access level.
- The encrypted states have no visual QA: screenshots could not be captured in
  this environment, so all web verification was DOM assertions and DB queries
  across three Vite origins, not visual review.

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
