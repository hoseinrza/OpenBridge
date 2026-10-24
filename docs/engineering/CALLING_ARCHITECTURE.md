# Calling architecture

Status: implemented on web and mobile, self-hosted LiveKit, E2EE on web for
conversations that already use MLS. Last updated: 2026-10-22.

## 1. What runs where

| Piece | Where | Responsibility |
|-------|-------|----------------|
| `calls` module (NestJS) | API | Call state machine, authorization, ring timers, LiveKit room tokens, cleanup |
| `CallsGateway` | API / Socket.IO | Invite, accept, reject, cancel, end; relays state events |
| `LiveKitService` | API | The only holder of the API secret; mints room JWTs and talks to the RoomService API |
| `livekit-server` | Docker | SFU: forwards encrypted RTP between participants; it is not a participant and is never given the E2EE key |
| `useCall` + `CallLayer` | Web | Ring/active UI, LiveKit client, local MLS call-key derivation, E2EE verification |
| `CallContext` + `CallOverlay` + `CallRoom` | Expo/RN | Ring/active UI and native LiveKit SDK; plaintext calls only (see §6) |

The server is authoritative for *who may be in a call*. The clients are
authoritative for *the media key* in an E2EE call, because the server must never
hold it.

## 2. Trust boundaries

- **LiveKit API key/secret**: only in the API process environment. The browser
  and mobile app receive a short-lived, room-scoped JWT and the public WebSocket
  URL. The secret is never in a Vite/Metro bundle.
- **Room token**: minted only by `POST /api/calls/:callId/token`, after the JWT
  guard has checked the session and `CallsService` has checked that the caller is
  a participant in that specific call. Grants are minimal: `roomJoin`,
  `room`, `canPublish`, `canSubscribe`; data publishing and room admin are off.
- **Room name**: `ob_<callId>`, built server-side. The call id is a client
  generated v4 UUID (so the caller can derive the E2EE key before ringing), but
  it is not a secret and grants nothing without a server-issued token.
- **E2EE key**: never leaves the device. Only a SHA-256 fingerprint of the key is
  sent to the server and relayed to the other participants for comparison.
- **Signaling**: Socket.IO over TLS/WSS in production. It is authenticated, but
  it is *not* treated as an encrypted key channel; see §5.
- **SFU**: LiveKit sees room names, participant identities (account ids), track
  metadata and network addresses. For an E2EE room it sees only ciphertext RTP.
  For a plaintext call it sees the media, exactly like any SFU; the UI labels
  such a call as not end-to-end encrypted.

## 3. Lifecycle and state machine

Server states:

```
RINGING -> CONNECTING -> CONNECTED -> ENDED
   |           |            |
   +-> MISSED  +-> ENDED     +-> ENDED
   +-> REJECTED
   +-> CANCELLED
   +-> FAILED
```

- `RINGING` is created by `call:invite` (direct) or `call:group-start` (group).
  The direct callee is reserved so a second caller gets "busy". A group call
  reserves only the initiator; an invite is not an obligation to join.
- The ring timer (`CALL_RING_TIMEOUT_SECONDS`, default 45s) ends an unanswered
  direct call as `MISSED`. A group call that nobody accepted also becomes
  `MISSED`.
- The first accept moves the call to `CONNECTING` and clears the ring timer.
  Later accepts for a group are idempotent join operations.
- A LiveKit `participant_joined` webhook moves the call to `CONNECTED` once the
  expected peer(s) are in the room. Without webhooks the media still works; the
  server-side connected time/duration is simply not known.
- `participant_left` ends a direct call. In a group it removes that participant;
  when everybody else is gone the room is ended as `empty`.
- `room_finished` and the max-duration sweep end leftover rooms.

Transitions are checked and written synchronously inside the event loop, so a
duplicate accept, a reject racing an accept, or a late end cannot move a terminal
call back into an active state. A finished call stays in memory for five minutes
so a duplicate event gets an idempotent answer.

State is in-process. This matches the existing single-API-instance presence
model; a second API instance would need a shared call store before calls can be
load-balanced. On boot the server deletes `ob_*` rooms left over from a previous
process when room administration is configured.

## 4. Authorization

- A direct call may only be created between the two participants of an existing
  direct conversation. A call cannot create a conversation and cannot ring an
  arbitrary account id.
- A group call requires current membership of that group; the server refuses a
  non-member and enforces `CALL_MAX_GROUP_PARTICIPANTS` (default 20) and the
  LiveKit E2EE ceiling of 20.
- A room token is refused before acceptance, for a non-participant, after the
  call ended, and for a mobile client asking to join an E2EE call.
- Every socket operation that creates or grants access re-checks the session id
  against the `sessions` table, so a revoked session cannot start or accept a
  call. A 30-second sweep also ends calls whose participants no longer have any
  live session.
- Ending a call asks LiveKit to delete the room when `LIVEKIT_API_URL` is set,
  so an already-issued token cannot be used to rejoin a finished call.

## 5. End-to-end encryption

### Key derivation

For a conversation that already has an MLS group, the web client calls
`client.exportCallKey(conversationId, callId)` (`shared/e2ee/client.js`):

```
key = MLS-Exporter(
  exporter_secret of the current epoch,
  label   = "openbridge-call-v1",
  context = "call:" + callId,
  length  = 32 bytes
)
```

`ts-mls` exposes the exporter secret and `mlsExporter`, so no custom
cryptographic primitive is introduced. The call id binds the key to one call; the
MLS epoch authenticates the group and its members. The 32 bytes are handed to
LiveKit's E2EE key provider as a base64 passphrase; LiveKit derives the frame
keys locally.

The server receives:

```
fingerprint = base64url(SHA-256(key))
```

and nothing else. Fingerprints are compared at invite, accept and token time.
They are held in memory on the call record, not in a database, and are never
logged. A mismatch (including two devices at different MLS epochs) is refused.

### Fail-closed rules

A web call is treated as E2EE only when the conversation has MLS state:

- If derivation fails, the caller does not send the ring.
- The callee derives before showing an acceptable incoming call; a missing key or
  a fingerprint mismatch rejects the call.
- Every participant must request its token with the same fingerprint.
- After connecting, the client shows "رمزنگاری سرتاسری" only once
  `room.isE2EEEnabled` is true and every remote participant reports
  `isEncrypted`. If that is not true within 25 seconds (45 for a group), the
  call is ended. A later encryption error or a participant turning encryption
  off ends it too.
- LiveKit's `setE2EEEnabled` throws on a browser without insertable-stream
  support; the call is ended rather than continuing in the clear.

A plaintext conversation has no MLS exporter. Its call is still protected by
WebRTC's DTLS-SRTP in transit, but the SFU can see the media. Both clients show
«بدون رمزنگاری سرتاسری» for such a call; it is never presented as E2EE.

### Group calls

Web members of an encrypted group derive one key per call from the group's MLS
exporter. Every invited web device must be at the same epoch (membership changes
for encrypted groups are frozen in the current implementation, so this holds).
Mobile has no group state and is refused a token. Plaintext groups can be called
from web and mobile and are labeled as not E2EE.

## 6. Mobile limitation

The Expo build does not run the MLS client. It therefore cannot derive the media
key for an encrypted conversation. The call service refuses a mobile token for
an E2EE call, and the mobile provider rejects such an incoming ring with an
explanation instead of joining unencrypted. Mobile calls in plaintext chats are
implemented and labeled as lacking end-to-end encryption. The LiveKit RN SDK's
native E2EE key provider (`useRNE2EEManager`) is available for a future MLS
integration, but no key source exists on this build; do not advertise mobile
E2EE until an authenticated key-delivery path is implemented and tested.

## 7. Socket API

Client to server:

| Event | Payload | Notes |
|-------|---------|-------|
| `call:invite` | `{ callId, toId, type, keyFingerprint? }` | direct; existing conversation only |
| `call:group-start` | `{ callId, conversationId, type, keyFingerprint? }` | group; member only |
| `call:accept` | `{ callId, keyFingerprint? }` | required for E2EE |
| `call:reject` | `{ callId }` | direct: ends the ring; group: declines |
| `call:cancel` | `{ callId }` | caller only |
| `call:end` | `{ callId }` | direct: ends; group: leaves (initiator ends) |

Server to client:

| Event | Meaning |
|-------|---------|
| `call:incoming` | ring with call id, caller, type, kind, group, E2EE flag and fingerprint |
| `call:accepted` | a participant answered/joined; includes the fingerprint for comparison |
| `call:participant-left` | a group member left/rejected; all tabs of that account also close |
| `call:ended` | terminal state with `reason` (`hangup`, `rejected`, `cancelled`, `timeout`, `empty`, …) |

HTTP:

- `POST /api/calls/:callId/token` — `{ client: "web"|"mobile", keyFingerprint? }`
- `GET /api/calls/status` — whether this deployment has LiveKit configured
- `GET /api/calls/active/:conversationId` — an ongoing group call a member can
  still discover (the current UI does not surface this banner yet)
- `POST /api/calls/webhook` — LiveKit-signed raw body; verifies the signature
  before changing state

## 8. Self-hosted deployment

- Compose service `livekit` (pinned `v1.13.10`), config delivered through
  `LIVEKIT_CONFIG`, keys through `LIVEKIT_KEYS`; both are environment values.
- nginx proxies `/livekit/` to `livekit:7880` over WebSocket with a runtime
  resolver, so the chat app still boots when the media container is down.
- Public ports: `7881/tcp` (ICE/TCP) and `7882/udp` (WebRTC). `7880` is internal.
  Open these in the provider firewall. TURN is disabled by default; the compose
  file contains the block to enable it for restrictive NATs (requires a domain,
  a TLS certificate, `5349/tcp` and `3478/udp`).
- `LIVEKIT_URL` is the public `ws://` or `wss://` URL clients receive;
  `LIVEKIT_API_URL` is the internal `http://livekit:7880` used for room
  administration. With TLS termination, use `wss://example.com/livekit`.
- The webhook target is `http://api:3000/api/calls/webhook` inside the compose
  network.
- Health: `GET /` on port 7880 returns `OK` when the node stats are fresh; the
  compose healthcheck and `deploy.sh` wait for it.
- A 1 GB VPS can carry a small 1:1 call; group video and multiple concurrent
  calls want 2 vCPU / 4 GB and more bandwidth. The SFU forwards media rather than
  transcoding, so CPU stays modest but egress scales with participants.

## 9. Local development

1. Run LiveKit in dev mode:
   `docker run --rm -p 7880:7880 -p 7881:7881 -p 7882:7882/udp livekit/livekit-server:v1.13.10 --dev --bind 0.0.0.0`
   Dev keys are `devkey` / `secret`.
2. Set `LIVEKIT_URL=ws://localhost:7880`, `LIVEKIT_API_URL=http://localhost:7880`,
   `LIVEKIT_API_KEY=devkey`, `LIVEKIT_API_SECRET=secret` in `backend/.env`.
3. Run the API and web app as usual. For two users, use two browser profiles;
   the calls are between existing conversations.

The Expo app needs a development build (not Expo Go) for the native WebRTC
module. `app.json` includes `@livekit/react-native-expo-plugin` and
`@config-plugins/react-native-webrtc`; iOS usage descriptions and Android
permissions are declared there. A physical-device build is required to validate
camera/mic/audio-session behavior.

## 10. Tests and verified claims

- `backend/test/calls.e2e.cjs` (8 cases): ring/accept/reject/cancel, offline
  user, token claims and minimal grants, unauthorized user refused, duplicate
  accept idempotent, E2EE fingerprint required and mismatch refused, mobile
  refused for E2EE, group membership authorization, webhook signature rejection,
  session revocation.
- `backend/test/e2ee-client.e2e.cjs`: two web clients derive the same call key;
  a different call id gives a different key; a group's devices derive one key.
- `npm run lint`, `npm run build` (web), `nest build`, `npm run test:e2ee`,
  mobile Jest (65/65) and `expo export --platform android` pass locally (see the
  release notes for the exact runs; the disconnected-send mobile test was
  adapted to the newer voice composer by typing before asserting).
- A real browser DOM check with two accounts over a separate API instance and a
  real Socket.IO connection verified: the incoming ring rendered the caller name
  and «بدون رمزنگاری سرتاسری», clicking reject produced a server `call:ended`
  with `reason: rejected` and closed the overlay; the header call button then
  started an outgoing ring and the UI displayed «طرف مقابل تماس را رد کرد».
  This was driven through DOM events because the in-app browser surface is
  hidden; no screenshot or pointer input was used.

Not verified here: a live two-browser call against a real LiveKit server
(no Docker/LiveKit in this workspace), a physical iOS/Android device, TURN
through a restrictive NAT, and an independent security review. No call history
is persisted; the displayed duration is the client timer, and server-side
`connectedAt` only exists when the webhook reaches the API.
