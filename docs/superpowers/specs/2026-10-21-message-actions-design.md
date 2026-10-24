# Message actions: copy, edit, delete, and reactions

Date: 2026-10-21
Status: approved in chat, ready for implementation

## Context

The chat already renders Telegram-style bubbles, tapback chips, and a hover smile
picker on web, plus a floating reaction row on mobile. What does not exist is a
way to act on a whole message:

- `Message.editedAt` and `Message.deletedAt` exist in the schema, but no code
  writes or reads them.
- There is no copy, edit, or delete path on either client, and no server
  endpoint or socket event for any of them.
- Right-click does nothing on web. Long-press on mobile opens only the reaction
  row and cannot reach any other action.
- Direct chats that use E2EE have no server `Message` row at all: the transcript
  is a stream of opaque MLS envelopes (`E2eeEnvelope`), so a server-side edit or
  delete cannot exist for them. Groups are not E2EE. The mobile client has no
  E2EE transport and only ever acts on server-stored messages.

## Goals

1. Selecting a message opens an action menu: right-click on web, Shift+F10 or the
   Menu key from the keyboard, long-press on mobile.
2. The menu offers the five tapback reactions, copy, edit, and delete, with every
   entry gated by the caller's permissions.
3. Edits apply to the sender's own text messages only and leave a visible
   "edited" marker. Delete supports both "for everyone" and "for me".
4. Plaintext message actions are server-authoritative: the server validates,
   persists, and broadcasts so every device of every participant converges.
5. Encrypted direct-chat actions travel as encrypted MLS control messages, so
   the server never reads content, controls do not appear as chat messages, and
   reloading reconstructs the same transcript on every device.
6. Mobile gets the same outcomes in a bottom sheet, without regressing the
   existing bubble layout or the quick reaction chips.

## Non-goals

- Replies, forwards, pins, and saved messages.
- Group-admin deletion of other people's messages.
- Editing captions of images or files; only `TEXT` messages are editable.
- Edit history, scheduled deletion, undo-delete, or trash.
- E2EE for groups, or an E2EE transport on mobile.
- Deleting the underlying MLS ciphertext from the server's envelope log.

## Architecture

### 1. Data model

Add one table for per-viewer hides and one enum/column for envelope kinds.

```prisma
model MessageHide {
  id        String   @id @default(uuid())
  messageId String
  message   Message  @relation(fields: [messageId], references: [id], onDelete: Cascade)
  userId    String
  user      User     @relation(fields: [userId], references: [id], onDelete: Cascade)
  createdAt DateTime @default(now())

  @@unique([messageId, userId])
  @@index([userId])
  @@map("message_hides")
}

enum E2eeEnvelopeKind {
  MESSAGE
  CONTROL
}
```

- `User` gains `hides MessageHide[]`; `Message` gains `hides MessageHide[]`.
- `E2eeEnvelope` gains `kind E2eeEnvelopeKind @default(MESSAGE)` and an index on
  `(conversationId, kind)`, so unread counts can skip controls.
- Existing `Message.editedAt` and `Message.deletedAt` are used as-is.
- Wire messages gain `deleted: boolean` and `editedAt: ISO string | null`.
  A tombstone keeps `id`, `senderId`, `createdAt`, and `type`, and carries no
  `text`, `fileUrl`, `fileName`, or `fileSize`.
- The E2EE client cache stores `reactions` (rows of `{ userId, emoji }`),
  `editedAt`, and `deleted` on each cached message. Missing fields on old cache
  entries mean "no reactions, not edited, not deleted".

Migration order is safe for a running deployment: one new table, one new enum,
one column with a default.

### 2. Plaintext actions (server-stored messages)

Two new socket events with the same ack convention as `message:send`:

`message:edit` — payload `{ messageId, text }`

- The message must exist and the caller must be a participant of its
  conversation; membership is derived from the row, never from client input.
- The caller must be the sender, the type must be `TEXT`, and the message must
  not be deleted.
- The conversation must not be `e2ee`. A legacy plaintext row inside an
  encrypted conversation cannot be edited, because the replacement would be a
  new plaintext write in a chat that is supposed to be ciphertext-only.
- Text is trimmed; empty text or more than 4000 characters is rejected (the same
  limit as sending).
- Persist `text` and `editedAt = now()`, then broadcast `message:edited` with the
  full wire message to every participant's user room, including the sender's
  other devices. Ack `{ ok: true, message }`.

`message:delete` — payload `{ messageId, scope }`

- `scope: "everyone"` is allowed for the sender only, on server-stored messages,
  including legacy plaintext rows in E2EE conversations. In one transaction:
  set `deletedAt`, null out `text`, `fileUrl`, `fileName`, `fileSize`, delete
  the message's `Reaction` rows and its `MessageRead` rows. Broadcast
  `message:deleted` `{ messageId, conversationId, scope: "everyone" }` to every
  participant's user room.
- `scope: "me"` is allowed for any participant. Upsert a `MessageHide` for the
  caller and emit `message:deleted` `{ messageId, conversationId, scope: "me" }`
  only to the caller's own user room, so every device of that account drops it.
- A deleted message cannot be deleted again, edited, reacted to, or hidden.

Reading paths change accordingly:

- `getConversationMessages` stops filtering `deletedAt` and instead filters
  `hides: { none: { userId } }`. Tombstones keep their position in the timeline
  and in pagination; hidden rows do not consume a page slot.
- Unread counts exclude `deletedAt != null` and the viewer's hides. E2EE unread
  counts exclude `kind = CONTROL`.
- Edits and deletes never bump `conversation.updatedAt`; actions must not
  reorder the conversation list.
- `toggleReaction` rejects messages that are deleted or hidden for the caller.
- Group unread and listing queries apply the same deleted/hidden filters.

The same `toWireMessage` output feeds REST history and the socket broadcasts, so
there is one shape for a tombstone everywhere.

### 3. Encrypted actions (E2EE direct chats)

Actions travel inside MLS application messages, because the server has no
plaintext row to modify and must never learn the content.

Envelope kind: the client appends with `kind: "CONTROL"`. `e2ee:append` accepts
an optional kind (`MESSAGE` default), `appendE2eeEnvelope` stores it, and
`listE2eeEnvelopes` returns it. A control bumps neither `conversation.updatedAt`
nor any unread count. It still consumes a `seq`, so it advances `appliedSeq` and
the ratchet like every other envelope.

Payload format: after decryption, a control is recognized only when the
envelope's `kind` is `CONTROL` **and** the plaintext starts with the prefix
`U+0001` followed by `OBX1`, then UTF-8 JSON:

```json
{ "v": 1, "action": "edit",   "target": 42, "text": "new text" }
{ "v": 1, "action": "delete", "target": 42, "scope": "everyone" }
{ "v": 1, "action": "delete", "target": 42, "scope": "me" }
{ "v": 1, "action": "react",  "target": 42, "emoji": "👍" }
{ "v": 1, "action": "react",  "target": 42, "emoji": null }
```

`target` is the target message's envelope `seq`, not its id: seq is the only
identifier every device of the conversation agrees on. Requiring both the
server-supplied kind and the prefix means a normal message that happens to begin
with the prefix still renders as text.

Client behavior (`shared/e2ee/client.js`):

- `sendControl(conversationId, payload)` runs on the same per-conversation
  serialization chain as `send`, requires an open group, serializes the prefixed
  JSON into an MLS application message, appends it with `kind: "CONTROL"`,
  advances `appliedSeq`, and does not cache it as a message. After the append
  ack, the sending device applies the action to its own cache locally, because
  its own echo is skipped as `record.own`; it emits the same `kind: "control"`
  result to UI handlers that a received control emits.
- `applyEnvelope` decrypts, checks membership as today, then either applies a
  control or caches a message. Control results are dispatched through the
  existing `onMessage` handlers as `{ kind: "control", conversationId, action,
  target, scope? }`; UI code switches on `kind`. Controls are never returned by
  `history()`.
- Apply rules:
  - `edit`: target must be cached, not deleted, and its `senderId` must equal the
    envelope sender. Set `text`, `editedAt = envelope.createdAt`, re-cache.
  - `delete/everyone`: target must be cached and its sender must equal the
    envelope sender. Set `deleted`, clear `text`, `attachment`, and
    `reactions`, keep `seq`/`senderId`/`at`, re-cache.
  - `delete/me`: applied only when the envelope sender is the local account, so
    all devices of that account drop `msg/<conversationId>/<target>`; other
    participants ignore it. This is what keeps "delete for me" local without a
    server-side per-device list.
  - `react`: target must be cached and not deleted. `emoji: null` removes the
    sender's row; a string replaces or inserts it. One row per person, matching
    the server rule.
- Unknown action, wrong version, malformed JSON, non-integer target, missing
  target, or failed permission checks produce an ignored result. They never
  throw, because a throw would stall the ordered drain at that seq forever.
- Applying the same control twice yields the same cache (idempotent), which is
  what makes reconnect and replay safe.
- History replay already walks envelopes in seq order, so a fresh device caches
  each message and then applies later controls to it. After `catchUp`, the
  transcript reflects every edit, tombstone, reaction, and local hide.

Web `useChat` wiring:

- `normalizeEncrypted` keeps `seq`, `reactions`, `editedAt`, and `deleted`.
- On a control result: `edit`, `delete/everyone`, and `react` read the updated
  cached entry (a small exported `cachedMessage(conversationId, seq)` helper) and
  merge it by id; `delete/me` removes `e2ee-<seq>` from the list.
- `toggleReaction` for an encrypted message calls `sendControl` with `react`;
  for a server message it keeps emitting `reaction:add`.
- `editMessage` and `deleteMessage` route by the message's `encrypted` flag to
  `sendControl` or to the new socket events, and report `{ ok, error }` the same
  way `sendMessage` does.
- Plaintext socket listeners `message:edited` and `message:deleted` update the
  list by id: edited replaces the normalized message; deleted with scope
  `everyone` renders a tombstone; scope `me` removes the row.

Mobile only handles server-stored messages: its hook adds `editedAt`/`deleted`
normalization, `message:edited`/`message:deleted` listeners, and
`editMessage`/`deleteMessage` calls. It never opens an E2EE conversation.

### 4. Permissions

| Action | Own plaintext | Others' plaintext | Own E2EE | Others' E2EE | Legacy row in E2EE chat |
| --- | --- | --- | --- | --- | --- |
| Copy text | yes | yes | yes | yes | yes |
| Edit text | yes | no | yes | no | no |
| Delete for everyone | yes | no | yes | no | yes (server row) |
| Delete for me | yes | yes | yes | yes | yes |
| React | yes | yes | yes | yes | yes |

Deleted messages allow no actions. Group admins get no extra delete power in
this batch.

### 5. Web interaction

- Each message bubble becomes focusable (`tabIndex=0`) and has an accessible
  label naming its sender. `contextmenu` on the bubble opens the action menu at
  the pointer. Shift+F10 and the Menu key open it at the bubble's bounds. The
  hover smile button and the existing quick picker stay, and both share the same
  reaction handler.
- `MessageActionsMenu` is a new component rendered through
  `createPortal(document.body)`, `position: fixed`, clamped 8px inside the
  viewport, opened above the bubble when there is no room below. It has
  `role="menu"` with `role="menuitem"` entries. Opening focuses the first
  enabled item; closing returns focus to the bubble.
- Menu layout: a row of the five tapbacks (aria-pressed for the reactions the
  viewer holds), a divider, then Copy, Edit, and Delete. Copy appears for any
  message with text. Edit appears only where the permissions table allows it.
  Delete is present for any non-deleted message; choosing it opens a second step
  with "delete for everyone" (only when allowed) and "delete for me", never a
  browser `confirm()`.
- The menu closes on an outside pointerdown, Escape, any capture-phase scroll,
  window resize, conversation change, or once an action starts. It is a portal
  and fixed, so opening it never moves a bubble.
- Copy writes `message.text` with `navigator.clipboard.writeText`, falling back
  to a hidden textarea plus `document.execCommand('copy')`; success shows the
  existing toast with "کپی شد", failure with "کپی ناموفق بود".
- Edit mode lives in the chat screen: the message id and its original text.
  `InputArea` renders an edit bar above the composer with the title
  "ویرایش پیام", a one-line preview of the original text, and a cancel button.
  The textarea is prefilled, focused, and the caret is placed at the end.
  Attachments are disabled; the emoji picker still inserts text. Enter saves,
  Shift+Enter inserts a newline, Escape cancels and restores the draft that was
  in the composer before editing began. The send button becomes a check labeled
  "ذخیره ویرایش". A failed save stays in edit mode and shows
  "ویرایش پیام ناموفق بود".
- An edited message shows "ویرایش‌شده" next to its time. A delete-for-everyone
  renders a muted, italic tombstone with the text "این پیام حذف شد", keeping
  its side and day grouping, with no reactions, no smile, no menu, and no
  selectable text.

### 6. Mobile interaction

- Long-pressing a bubble (text, image, or file) opens `MessageActionsSheet`, a
  transparent `Modal` anchored to the bottom with safe-area padding and a dimmed
  backdrop. Backdrop tap and Android back close it. It replaces the current
  floating tapback row, whose state and render are deleted.
- The sheet contains the reaction row first (same five emoji, same
  `reaction-option-<emoji>` testIDs), then Copy, Edit, and Delete rows. Tapping a
  chip toggles the reaction exactly like the current row does and closes the
  sheet. Copy is shown for text messages, Edit only for the user's own server
  text messages, Delete for any non-deleted message.
- Delete opens a native `Alert` titled "حذف پیام": own messages offer
  "حذف برای همه" (destructive) and "حذف برای من"; other people's messages offer
  only "حذف برای من", plus "انصراف" in both cases.
- Edit mode mirrors web: an edit bar above the composer titled "ویرایش پیام"
  with a cancel button, a prefilled and focused input, the send button replaced
  by a check, and attachments disabled. Success clears the mode; failure keeps
  it and surfaces "ویرایش پیام ناموفق بود" in the composer's existing error
  area.
- Copy uses `expo-clipboard`'s `setStringAsync` and shows a transient "کپی شد"
  pill above the composer on both platforms.
- Tombstones and the "ویرایش‌شده" marker render like web. Tombstones are not
  long-pressable.
- `expo-clipboard` is added with `npx expo install expo-clipboard`; it is an
  Expo-managed module and needs no hand-written native code.

### 7. Copy deck

Shared Persian strings, used by both clients:

| Key | Text |
| --- | --- |
| deleted tombstone | این پیام حذف شد |
| edited marker | ویرایش‌شده |
| edit bar title | ویرایش پیام |
| delete for everyone | حذف برای همه |
| delete for me | حذف برای من |
| copy | کپی |
| copied | کپی شد |
| edit | ویرایش |
| delete | حذف |
| cancel | انصراف |
| delete dialog title | حذف پیام |
| copy failed | کپی ناموفق بود |
| edit failed | ویرایش پیام ناموفق بود |
| delete failed | حذف پیام ناموفق بود |
| save edit | ذخیره ویرایش |

### 8. Compatibility and rollout

- `kind` is optional on `e2ee:append` and defaults to `MESSAGE`; older clients
  keep working and their envelopes count and order as before.
- Controls only start flowing after this release. A stale web tab without
  control handling would show the decrypted control JSON as a text bubble until
  it reloads; the new build then reconstructs the correct transcript.
- Mobile ignores E2EE conversations entirely, so it is unaffected by controls.
- New socket events are additive; an older client misses live updates but sees
  the persisted result after a reload.
- Version 1.1.11 in root `package.json`, `backend/package.json`,
  `mobile/package.json`, and `mobile/app.json`, with a `CHANGELOG.md` entry.
  The mobile-QA spec currently reserves 1.1.11 but is not implemented; when that
  batch starts, it takes the next free version (1.1.12). This spec's version
  line is updated at that time if needed.
- README gets the new controls and the delete/edit semantics; no demo data is
  added.

## Failure handling

- Server validation errors come back in the ack; the client keeps its current
  state and shows the matching failure string. A failed delete never renders a
  tombstone.
- For encrypted actions the local change is applied only after the append ack;
  a failed append leaves the bubble untouched and shows the error.
- Malformed, out-of-order, or unauthorized controls are ignored without
  throwing, so ordered decryption never stalls. The sender's UI only shows a
  result after its own device applied it.
- Reactions to a tombstone are rejected by the server and hidden by both UIs.
- The action menu closes before any async work, so retries always start from a
  clean state.

## Verification

Local, before shipping:

- `cd backend && npm run build`, `npx prisma validate`, and a new backend e2e
  script covering: edit by sender broadcast to both accounts; edit by a
  non-sender rejected; non-text and deleted messages rejected; edit in an E2EE
  conversation rejected; delete-for-everyone clears content/reactions and both
  accounts read a tombstone from REST history; delete-for-me hides the row from
  that account only and removes it from unread counts; reactions on a tombstone
  rejected; hidden rows absent from history without consuming pagination.
- A Node test against `shared/e2ee/client.js` with two MLS clients: edit
  propagates and sets `editedAt`; delete-for-everyone clears both caches;
  delete-for-me removes the message only on the actor's clients; add, replace,
  and remove reactions; a fresh cache replays envelopes and controls to the same
  final transcript; unknown targets and malformed controls are ignored without a
  gap error; controls never appear in `history()`.
- Extend `backend/test/e2ee-client.e2e.cjs` so the real socket and server path
  proves control envelopes are stored with `kind: CONTROL`, do not bump
  `conversation.updatedAt`, and are excluded from unread counts.
- Web build, lint, and a headless browser pass: open the menu by right-click and
  by keyboard; copy writes the clipboard; edit saves and shows the marker;
  delete-for-everyone shows the tombstone; delete-for-me removes the row; bubble
  geometry does not move when the menu opens; a two-account run verifies live
  sync, and a reload rebuilds the same transcript.
- `cd mobile && npx expo export --platform android` still bundles. Mobile UI is
  not rendered on a device in this batch; that limitation is stated in the
  changelog, not claimed as tested.
- `npm run test:e2ee` and the existing test suites stay green.

## Risks

- E2EE "delete for everyone" is a client-state tombstone, not erasure: the
  ciphertext stays in the server's envelope log, and a member who saved the
  plaintext keeps it. The UI and docs must not promise more than that.
- Envelope `kind` is delivery metadata, not MLS-authenticated. The prefix check,
  membership check, and per-action permission checks (only the sender can edit
  or delete-for-everyone) bound what a dishonest server could inject; a
  spoofed reaction would still be attributed to the sender's leaf. This matches
  the existing trust model, where the server assigns sender ids.
- Last-write-wins: two devices editing the same message concurrently keep the
  later control in seq order, with no conflict indicator.
- A stale tab can briefly show control JSON as text until reload.
- `MessageHide` grows one row per hidden message per user; the unique pair and
  the user index keep lookups cheap.
- The working tree currently holds uncommitted E2EE ingress work that touches
  `shared/e2ee/client.js` and `src/hooks/useChat.js`. Implementation starts only
  after that work is committed or otherwise resolved, and this batch stages only
  its own files.
