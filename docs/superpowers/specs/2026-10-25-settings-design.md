# Settings: one surface per client, three phases

Date: 2026-10-25
Status: direction approved in chat; spec awaiting review

## Context

Neither client has a settings surface. What exists today:

- Web keeps the theme in `localStorage` (`src/hooks/useTheme.js`) and exposes a
  single toggle in the sidebar footer (`Sidebar.jsx:329`).
- Mobile follows the OS colour scheme only (`mobile/src/theme.js` uses
  `useColorScheme`); there is no manual override.
- `User` has no preference columns. `Session` (userAgent, ip, lastUsedAt,
  revokedAt) and `Device` exist, and `GET auth/sessions` plus
  `DELETE auth/sessions/:id` are already live.
- Read state is server-side: `MessagesService.markRead` writes `MessageRead`,
  serialization derives `read`, and the gateway broadcasts `message:read`.
- Presence is tracked in memory: `RedisService` keeps a socket set per user and
  the gateway broadcasts `user:online` / `user:offline` on the first connect and
  the last disconnect. The `User.status` column is never written and stays
  OFFLINE; there is no persisted `lastSeenAt`, and presence is lost on restart
  and not shared across instances.
- There is no chat mute, no in-app notification sound, and no vibration.
  Mobile has no `expo-notifications` dependency, so push does not exist.
- Direct chats that use E2EE store no `Message` rows; their transcript is MLS
  envelopes and the server never sees content or per-message read state.

## Goals

1. One settings screen per client, reachable in two taps, rendered in the
   existing design system and in Persian RTL.
2. Server-backed preferences that follow the account across devices; local
   preferences (theme) stay per device.
3. Every toggle controls real behaviour. A preference whose feature does not
   exist yet is not shipped as a dead switch.
4. Defaults preserve today's behaviour: receipts on, sound on, vibration on,
   last seen visible.

## Non-goals

- Push notifications, device tokens, or notification delivery outside the app.
- Per-device notification channel management (OS settings stay OS settings).
- Settings for calls (microphone, camera, ringtone).
- A server-driven form schema; the sections are fixed and typed.
- Changing E2EE group support, or reading message content server-side.

## Architecture

### Data model

```prisma
model UserSettings {
  userId            String   @id
  user              User     @relation(fields: [userId], references: [id], onDelete: Cascade)
  showReadReceipts  Boolean  @default(true)  // phase 3
  lastSeenVisible   Boolean  @default(true)  // phase 3
  notificationSound Boolean  @default(true)  // phase 2
  vibration         Boolean  @default(true)  // phase 2
  updatedAt         DateTime @updatedAt
}

model MessageRead {
  // existing columns…
  hidden Boolean @default(false) // phase 3: row kept for unread math, hidden from the sender
}

model ConversationParticipant {
  // existing columns…
  mutedAt DateTime? // phase 2, per conversation, per member
}

model User {
  // existing columns…
  lastSeenAt DateTime? // phase 3
}
```

A separate `UserSettings` row keeps `User` lean and lets later phases add
columns without widening every user query. The row is optional: missing means
defaults.

### API

In the existing users module:

- `GET /users/me/settings` returns the effective settings (defaults merged).
- `PATCH /users/me/settings` accepts any subset of booleans, validates with a
  DTO, upserts, and returns the effective settings.

Both are JWT-guarded like the rest of `users.controller.ts`. Read receipts and
last seen are enforced server-side (below); sound and vibration are client
behaviour and only stored here.

### Enforcement

Receipts (phase 3a): `markRead` always writes the `MessageRead` row so unread
counts keep working, and stamps `hidden` from the reader's
`showReadReceipts`. Serialization reports `read` only from non-hidden rows.
Both receipt paths in the gateway — the explicit `message:read` handler and the
auto-receipt timer that fires after a direct message to an online receiver —
emit only for non-hidden marks. Result: the sender never sees the tick, the
reader's unread count still clears, and no join to `UserSettings` is needed on
the message read path.

Last seen (phase 3b): the gateway writes `User.lastSeenAt` when a user's first
socket connects and when `removeSocket` reports the last one gone, so multi-
device users do not flap the timestamp. User payloads include it only when
`lastSeenVisible` is true for that user. The column is persisted, so unlike the
in-memory presence map it survives a restart.

Sessions (phase 3c): no backend work; the screen lists `GET auth/sessions` and
revokes with `DELETE auth/sessions/:id`.

### Web

- `src/components/Settings/SettingsPanel.jsx` plus CSS, opened from a gear
  button in the sidebar footer next to `ThemeToggle`.
- Sections: Appearance (theme via `useTheme`), Account (name, phone, username,
  link to profile, logout), Notifications (phase 2), Privacy (phase 3).
- `useSettings` hook fetches once per session, caches in memory, and PATCHes
  optimistically with rollback on failure.

### Mobile

- `mobile/src/screens/SettingsScreen.js` registered as a `Stack.Screen` in
  `App.js`, opened from a gear added to the existing `headerRight` group in
  `ChatListScreen`.
- Theme selection (system/light/dark) stored in AsyncStorage and read by
  `theme.js`; this is the first manual override on mobile.
- Rows use `Switch` with the existing palette; destructive actions (logout)
  use the existing confirm `Alert` pattern.

## Phases

### Phase 1: appearance and account

Scope: the screen shell on both clients, theme override on mobile, web theme
entry, account facts, logout. No backend work beyond what exists.

Acceptance: gear opens settings on both clients; theme choice survives a
restart; account facts match the profile; logout still confirms.

### Phase 2: notifications in-app

Scope: `UserSettings.notificationSound` and `vibration`, per-chat mute via
`ConversationParticipant.mutedAt`, a web notification tone, mobile tone plus
`Vibration.vibrate()`. All in-app only.

Acceptance: a message from an unmuted chat plays sound/vibration per the global
toggles; a muted chat stays silent on both clients; the mute survives reload and
is visible in the chat row or profile.

### Phase 3: privacy

Scope: receipts (3a), last seen (3b), active sessions (3c) as described above.

Acceptance: with receipts off, the other side never gets a green tick while the
reader's unread count still clears; with last seen off, peers see no timestamp;
sessions list matches logins and revoking one ends that session immediately.

## Error handling

- PATCH failure: revert the toggle, show the existing toast (web) or `Alert`
  (mobile). Never leave the UI claiming a saved value the server rejected.
- Offline: theme still works (local). Server-backed toggles render the last
  known value and retry on the next screen open.
- Missing `UserSettings` row: GET returns defaults without writing.

## Testing

- Backend e2e: defaults on first GET; PATCH persists a subset; unknown keys
  rejected; receipts off suppresses `read` and the socket event while unread
  count still clears; last seen hidden from peers when off.
- Web: `npm run lint`, `npm run build`.
- Mobile: Jest/RNTL for the settings screen and theme override; `tsc` where
  applicable.
- Manual two-account pass per phase on web and device; read receipts and last
  seen cannot be proven with one account.

## Risks

- Dead toggles: phase 2 and 3 each add behaviour, not just storage. Shipping a
  switch before its behaviour exists is a bug, not a shortcut.
- Unread regression: receipts must keep writing `MessageRead` rows; hiding the
  row instead would strand unread counts.
- Presence loop: `lastSeenAt` must write only on the first connect and the last
  disconnect, which the existing `addSocket` / `removeSocket` transition already
  identifies; writing per socket would chatter the user table.
- E2EE direct chats carry no server read state, so receipt privacy applies to
  server-stored messages. Their transcript stays out of scope.
- Scope creep: sessions management is read-and-revoke only, no "log out all".

## Versioning

Phase 1 ships as `1.7.0` with a changelog entry; phases 2 and 3 get their own
minor bumps when they ship.
