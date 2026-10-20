# OpenBridge — UI/UX Redesign

Session: 2026-10-19 → 2026-10-20

This document records the design system and the redesign of the web and mobile
clients. It covers what was changed, the accessibility and RTL rules that were
applied, and exactly what was verified. It is not a marketing description:
limitations are listed at the end.

## Goals and constraints

- Keep every existing behavior: authentication, refresh, sockets, acks,
  conversations, groups, uploads, reactions, typing, receipts, search.
- No mock/demo data and no static arrays presented as server data.
- One visual language across web and mobile: brand red `#C5161D`, warm yellow
  `#FFC928`, warm neutral surfaces, Vazirmatn, Persian RTL.
- A real dark theme with AA contrast, not an inverted filter.
- Accessible names and roles for interactive controls; visible keyboard focus;
  reduced-motion support; 44 px touch targets on mobile.
- No glassmorphism stacks, decorative gradients, glows, heavy animation, or
  icon-only controls without a label.

## Design tokens

Web tokens live in `src/index.css` as CSS custom properties on `:root` and
`html[data-theme='dark']`. Mobile mirrors them in `mobile/src/theme.js`; the
token names are intentionally aligned so both clients stay one product.

| Token | Light | Dark |
|-------|-------|------|
| `accent` | `#C5161D` | `#C5161D` |
| `accent-text` | `#A91118` | `#FF8A85` |
| `on-accent` | `#FFFFFF` | `#FFFFFF` |
| `bg` | `#F6F3EE` | `#121110` |
| `surface` | `#FFFFFF` | `#1B1917` |
| `surface-2` | `#F1EDE6` | `#24211D` |
| `surface-3` | `#E8E2D9` | `#2F2A25` |
| `chat-bg` | `#FAF8F4` | `#141210` |
| `bubble-in` | `#FFFFFF` | `#24211D` |
| `bubble-out` | `#C5161D` | `#B3161C` |
| `text-1` | `#211E1A` | `#F2EEE6` |
| `text-2` | `#5D574E` | `#B9B1A5` |
| `text-3` | `#6E675C` | `#938B7E` |
| `border` | `rgba(33,30,26,.10)` | `rgba(255,255,255,.08)` |
| `focus` | `#C5161D` | `#FF8A85` |

Also shared: a 4→48 px spacing scale (`--sp-1…--sp-9`), radii
(`--r-xs…--r-pill`), a 11→28 px type scale, and motion durations with a single
easing curve. Mobile uses the same spacing, radius, and type values.

Accent handling: the filled accent stays the brand red in both themes so white
labels remain AA. On dark surfaces, red text/icons use `accent-text`
(`#FF8A85`), not the fill color. Yellow is an accent for highlights and
attention, never a background behind white text.

## Typography and RTL

- Vazirmatn 400/500/600/700 is served locally from `public/fonts/` with
  `@font-face` and `font-display: swap`; the regular and semibold weights are
  preloaded. Mobile bundles the same family from `mobile/assets/fonts/`.
- `index.html` declares `lang="fa" dir="rtl"`; layout uses logical CSS
  properties where direction matters, so RTL is structural rather than
  mirrored text inside an LTR layout.
- Persian copy and Persian digits are used consistently. Numeric values such as
  unread counts are formatted with `toLocaleString('fa-IR')`.
- Font Awesome remains loaded from the existing CDN. All icons are
  `aria-hidden` and paired with visible text or an `aria-label`.

## Web changes

- **App shell**: `#root` fills `100dvh`; sidebar and chat use a flex split with
  a single scrolling region per surface. Breakpoints at 900 px and 768 px
  collapse the sidebar behind an explicit back button.
- **Theme**: a tiny inline script applies the saved theme before first paint
  (`openbridge_theme`, falling back to `prefers-color-scheme`) to avoid a flash.
  `useTheme` persists changes, updates `html[data-theme]`, and updates
  `theme-color`. The toggle is available on the login screen and in the sidebar
  with a visible label.
- **Sidebar**: search field with clear button and result count, conversation
  rows with avatar/name/last-message/time/unread badge, empty and error states,
  profile and logout actions, dark-mode-aware skeleton loading.
- **Chat header**: peer or group identity, member count for groups, message
  search toggle with labeled controls, and a back action on narrow viewports.
  The video-call control remains hidden because no video infrastructure exists.
- **Messages**: day separators, grouped sender runs, sender names in groups,
  image and file bubbles, reactions with labels, read receipts, search
  highlighting, history error state with retry, jump-to-latest button.
- **Composer**: multiline auto-growing input, Enter-to-send with Shift+Enter
  for a newline, attachment button with an accessible label, emoji picker
  anchored above the trigger, send disabled state, upload and send errors shown
  as dismissible `role="alert"` notes instead of failing silently.
- **Login**: split brand panel and form panel. Since the OTP rework (see
  `OVERNIGHT_PROGRESS.md`) the primary flow is phone → code, and since the
  multi-step follow-up a brand-new number continues into two more screens:
  `phone → code → username → name`. Each screen asks for exactly one thing,
  carries a step tracker («مرحله ۱ از ۴ · شماره») with dots plus a text label
  so the position is not colour-only, moves focus to the step's first field,
  and keeps the 30 s resend countdown, «تغییر شماره», a labelled test-code box,
  inline `role="alert"` errors and spinner/disabled busy states. The last step
  previews the identity being created — initials avatar, display name and
  `@username` — and marks نام خانوادگی with an «اختیاری» badge. The legacy
  username/password mode is gone: there is no password endpoint any more.
- **Profile**: view and edit states now separate نام and نام خانوادگی (family
  name optional, empty clears it) and the username stays editable; the phone is
  a read-only field («شماره موبایل برای ورود ثابت می‌ماند»).
- **Modals and new chat**: shared focus-trapping modal with labelled headings;
  new-chat/group creation exposes search, multi-select, validation, and errors.
- **Shared UI**: `Avatar`, `Modal`, and `ThemeToggle` live in
  `src/components/ui/`; time formatting lives in `src/utils/time.js`. An
  `Avatar` with no photo no longer falls back to a stock picture: it draws the
  first letter of the first and last word of the name (one letter when there is
  one word) on one of eight gradients chosen by a hash of the name, so the same
  person always gets the same colours. The fallback is `aria-hidden` — the name
  is already next to it — and `/images/user.png` was deleted along with every
  reference to it.

## Mobile changes

- **Theme**: `mobile/src/theme.js` mirrors the web palette, including a
  dedicated `accentText` for text/icons on dark surfaces and fixed
  `onBubbleOut` for white text on red bubbles. Navigation and status bar follow
  the active theme.
- **Login**: brand icon and wordmark, tagline, and the same four-step wizard as
  web (`phone → code → username → name`) with a dot-and-text step tracker
  exposed through `accessibilityLabel`, phone/number-pad keyboards,
  `textContentType` and `sms-otp` autofill hints, a live-region test-code box,
  30 s resend countdown, an identity preview on the last step, inline alerts,
  safe-area scrolling, and Persian validation. The legacy password mode, its
  visibility switch and the mode toggle were deleted. `Avatar` mirrors the web
  initials rule; RN has no CSS gradient, so the deterministic palette is used
  as a flat tint behind white letters.
- **Chat list**: safe-area-aware shell, search with clear action, rows with
  avatars and group badges, unread counts, pull-to-refresh, retry banner,
  distinct empty/search-empty states, and a footer with the signed-in user and
  logout.
- **Chat**: group and direct conversations, RTL bubbles (incoming right,
  outgoing left), sender identity in groups, day separators and 5-minute sender
  grouping, reversed `FlatList` with correct footer/empty inversion, history
  loading/error/retry, offline banner, typing indicator, read receipts, image
  and file messages, and a safe-area composer with send disabled until the
  socket is connected.
- **New group**: name field, debounced user search (350 ms), multi-select chips,
  validation (name ≥ 2 characters, at least one member), accessible disabled
  state, and creation that replaces the screen with the new group chat.
- **Navigation**: Login, ChatList, Chat, NewGroup; stack header follows the
  theme. The unused `VideoCallScreen` placeholder was deleted because there is
  no video infrastructure and the control is intentionally absent.
- **Brand assets**: icon, splash, favicon, and Android adaptive foreground /
  monochrome layers were regenerated from the OpenBridge bridge glyph; the
  splash and background colors match the light and dark palettes.

## Accessibility

- Every icon-only control has an `aria-label`/`accessibilityLabel`; decorative
  icons are hidden from assistive tech.
- Tab semantics (`tablist`, `tab`, `aria-selected`/`accessibilityState`) are
  used by the chat-header message search toggle; the login form no longer uses
  tabs since the OTP rework.
- Focus uses a visible `:focus-visible` ring (2 px, theme-aware). Focus order
  follows the RTL visual order.
- Errors use `role="alert"`/`accessibilityRole="alert"`; connection and typing
  status use status roles where appropriate.
- Contrast: the web QA audit parses rendered colors and checks text/icon pairs
  against WCAG AA; it returned no failures in light or dark. Disabled labels use
  `text-2`/`text-3` on `surface-3`, which was confirmed legible in rendered
  screenshots.
- Motion respects `prefers-reduced-motion: reduce` on web; mobile avoids
  decorative animation.
- Touch targets on mobile are at least 44 px high, or reach 44 px effective
  area with hit slop for icon-only controls (for example the 28 px chip remove
  button with 8 px slop on each side). The chat-screen audit found no labeled
  control below 44×44 px.

## Verification actually performed

Web (Vite on `:5173`, API on `:3000`, local PostgreSQL), light and dark:

- Viewports: 320×720, 375×812, 430×932, 768×1024, 1024×768, 1440×900,
  1920×1080. In every run: horizontal overflow 0, console errors 0, unlabeled
  buttons 0, images without alt 0, contrast audit empty.
- Screens reviewed: login at 1440 and 375, chat at 768 and 375, group chat at
  375, conversation list at 1440, dark chat at 1440 and 375, emoji popover
  anchoring.
- Keyboard: the login form is fully keyboard-operable (phone submit moves
  focus to the code field; all controls are reachable links/buttons with
  visible focus). The earlier login-tab keyboard test applied before the OTP
  rework removed the tabs.
- Live behavior: sending a real message over the socket incremented the
  conversation and rendered the message; theme toggle and logout confirmation
  worked; sidebar and header message search returned results.

Mobile (Expo app rendered through react-native-web in headless Chrome at
390×844; light and dark):

- Screens reviewed: login, chat list, chat, and new group, in both themes.
  Overflow 0 on every screen, no unlabeled buttons, no labeled targets below
  44 px, console errors none.
- The composer showed the connected placeholder and the socket-backed chat
  rendered real messages; session restoration across reloads worked.
- `npx expo export --platform android` completed and produced an Android Hermes
  bundle, confirming the app bundles with the new assets and screens.

Web checks: `npm run lint` clean; `npm run build` succeeded (Vite 8, 78 modules,
~330 KB JS / ~44 KB CSS before gzip). Backend: `npm run test:e2e` 11/11 passing
against real PostgreSQL.

### Re-run for the multi-step sign-up and initials avatars

- The whole wizard was driven in the in-app browser against the live stack with
  a brand-new number: request → code (test code from the API) → username →
  name, ending in a real 201 `POST /auth/signup`, a session in `localStorage`
  (`firstName: علی`, `lastName: رضایی`, `avatar: null`) and the app shell
  loading with zero console errors. The step tracker was observed advancing
  ۱ از ۴ → ۴ از ۴, the sign-up preview drew «عر» from the two name fields, and
  clearing نام خانوادگی in the profile editor collapsed the modal avatar to a
  single «ع» before saving; the row came back as `firstName: "علی"`,
  `lastName: null`, `displayName: "علی"`.
- Layout at narrow widths was measured, not eyeballed: the login page was
  mounted in hidden same-origin iframes at 375 and 320 in both themes.
  Horizontal overflow was 0 in all four runs, the card stayed inside the
  viewport, and the longest tracker label («مرحله ۱ از ۴ · نام کاربری»,
  101 px) fitted with room to spare.
- **No screenshots were captured for this batch**: the in-app browser reported
  no visible surface (`NATIVE_BROWSER_VIEWPORT_UNAVAILABLE`), so every check
  above is a DOM/computed-style measurement or an accessibility snapshot.
  Colour contrast of the new avatar gradients was not re-audited.
- Web `npm run lint` clean and `npm run build` succeeded; backend
  `npm run test:e2e` 16/16; `npx expo export --platform android` bundled the
  rewritten mobile login (exit 0). The mobile app itself was not run on a
  device or emulator, as before.

## Limitations and honest caveats

- Mobile was **not** run on a native Android/iOS emulator or physical device.
  Visual QA used react-native-web, which can differ from native layout, safe
  areas, and RTL back-button placement; the native-stack web header back button
  appears on the left as a web artifact. Android bundling was verified, native
  rendering was not.
- react-native-web support was used only for QA; no web-specific mobile code
  remains (SecureStore is used for tokens as before).
- There is no automated visual-regression suite in the repository. The viewport
  and screen audits were run manually with scratch scripts, which were removed
  after the session.
- Font Awesome still comes from a CDN. Self-hosting icons is a prerequisite for
  a strict CSP/offline-first PWA.
- Web tokens remain in `localStorage` (existing trade-off, XSS-exposed); mobile
  tokens use SecureStore.
- E2EE is not implemented; the server stores plaintext messages. See
  `docs/engineering/E2EE_DESIGN.md`.
- Video calls are intentionally absent: no signaling/media infrastructure is
  wired in either client.
- Mobile group participation parity was added (list, read, send, create). Group
  administration (add/remove members, rename, avatar) is still web-only/absent
  at the API level.
