# Settings Phase 1: Appearance and Account Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Ship a settings surface on web and mobile that holds the theme control, the signed-in account facts, profile editing, and logout, with no backend change.

**Architecture:** Web gets a `SettingsPanel` modal opened from a gear in the sidebar footer; the theme hook becomes a shared external store so the new panel and the existing sidebar toggle never disagree. Mobile gets a `SettingsScreen` in the existing stack, a `SettingsProvider` that persists a three-way theme mode in AsyncStorage, and `useAppTheme` learning to honour that override. Both surfaces reuse the existing modal, auth, and design-system pieces.

**Tech Stack:** React 19 + Vite (web), Expo/React Native + React Navigation (mobile), Jest + RNTL (mobile), AsyncStorage.

**Spec:** `docs/superpowers/specs/2026-10-25-settings-design.md` (this plan implements phase 1 only)

## Global Constraints

- UI copy is Persian and RTL; keep the existing tone and tokens.
- No backend, Prisma, or socket changes in this phase.
- Every control must do something real; do not add phase 2 or phase 3 toggles early.
- Web has no unit-test runner: verification there is `npm run lint`, `npm run build`, plus the manual browser pass written into Task 2.
- Mobile tests run with `cd mobile && npx jest --ci --runInBand`; the AsyncStorage mock is already installed in `mobile/jest.setup.js`.
- Product version for this phase is `1.7.0`, set in all four manifests and the lockfile top-level fields.
- Commit after every task with the message given in that task.

---

## File Structure

**Create**

- `src/components/Settings/SettingsPanel.jsx` — web settings modal.
- `src/components/Settings/Settings.css` — styles for that modal.
- `mobile/src/context/SettingsContext.js` — theme-mode provider and `useSettings`.
- `mobile/src/screens/SettingsScreen.js` — mobile settings screen.
- `mobile/__tests__/settings-theme.test.js` — provider/theme override tests.
- `mobile/__tests__/settings-screen.test.js` — screen behaviour tests.

**Modify**

- `src/hooks/useTheme.js` — shared store, adds `setTheme`.
- `src/components/Sidebar/Sidebar.jsx` — gear button, panel render, profile/logout hand-off.
- `mobile/src/theme.js` — `useAppTheme` honours the stored mode.
- `mobile/App.js` — wrap in `SettingsProvider`, register the `Settings` screen.
- `mobile/src/screens/ChatListScreen.js` — gear button in the existing `headerRight` group.
- `package.json`, `backend/package.json`, `mobile/package.json`, `mobile/app.json`, `package-lock.json` — version `1.7.0`.
- `CHANGELOG.md` — `1.7.0` entry.

---

### Task 1: Shared web theme store

The new panel adds a second theme control, so two independent `useTheme` states would drift (the sidebar toggle would keep its old icon). Turn the hook into a module store and expose `setTheme`.

**Files:**
- Modify: `src/hooks/useTheme.js` (whole file)

**Interfaces:**
- Produces: `useTheme(): { theme: 'light' | 'dark', setTheme(next: 'light' | 'dark'): void, toggleTheme(): void }`
- Consumes: existing `document.documentElement.dataset.theme` bootstrap in `index.html` (unchanged).

- [ ] **Step 1: Replace the hook**

```js
import { useCallback, useSyncExternalStore } from 'react';

const STORAGE_KEY = 'openbridge_theme';
const listeners = new Set();

function readTheme() {
  return document.documentElement.dataset.theme === 'dark' ? 'dark' : 'light';
}

function subscribe(listener) {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

function writeTheme(next) {
  const theme = next === 'dark' ? 'dark' : 'light';
  if (readTheme() === theme) return;
  document.documentElement.dataset.theme = theme;
  try { localStorage.setItem(STORAGE_KEY, theme); } catch { /* storage may be unavailable */ }
  const meta = document.querySelector('meta[name="theme-color"]');
  if (meta) meta.setAttribute('content', theme === 'dark' ? '#141210' : '#C5161D');
  listeners.forEach(listener => listener());
}

export function useTheme() {
  // The dataset attribute is the single source of truth: index.html writes it
  // before first paint, so a second hook instance always reads the same value.
  const theme = useSyncExternalStore(subscribe, readTheme, () => 'light');
  const setTheme = useCallback(next => writeTheme(next), []);
  const toggleTheme = useCallback(() => writeTheme(readTheme() === 'dark' ? 'light' : 'dark'), []);
  return { theme, setTheme, toggleTheme };
}
```

- [ ] **Step 2: Lint and build**

Run: `npm run lint && npm run build`
Expected: both exit 0, no new warnings.

- [ ] **Step 3: Manual check**

Run: `npm run dev`, sign in, click the moon/sun button in the sidebar footer.
Expected: the whole UI flips and the choice survives a page reload (the inline script in `index.html` restores it).

- [ ] **Step 4: Commit**

```bash
git add src/hooks/useTheme.js
git commit -m "Share one web theme store so a second control cannot drift"
```

---

### Task 2: Web settings panel and sidebar entry

**Files:**
- Create: `src/components/Settings/SettingsPanel.jsx`
- Create: `src/components/Settings/Settings.css`
- Modify: `src/components/Sidebar/Sidebar.jsx` (imports, state, footer actions, panel render)

**Interfaces:**
- Consumes: `useTheme()` from Task 1; existing `Modal` (`src/components/ui/Modal.jsx`), `Avatar`, and `Sidebar` props `currentUser`, `onOpenProfile`, `onLogout`.
- Produces: `SettingsPanel({ currentUser, onClose, onEditProfile, onLogoutRequest })`.

- [ ] **Step 1: Write the styles**

```css
.settings-modal { max-width: 460px; }

.settings-head {
  display: flex;
  align-items: center;
  justify-content: space-between;
  padding: 18px 20px 14px;
  border-bottom: 1px solid var(--border);
}

.settings-head h2 {
  font-size: 17px;
  font-weight: 800;
  color: var(--text-1);
}

.settings-body {
  padding: 16px 20px 20px;
  display: flex;
  flex-direction: column;
  gap: 18px;
  overflow-y: auto;
}

.settings-section h3 {
  font-size: 12.5px;
  font-weight: 700;
  color: var(--text-3);
  margin-bottom: 8px;
}

.settings-row {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 12px;
  padding: 12px 14px;
  background: var(--surface-2);
  border: 1px solid var(--border);
  border-radius: 12px;
}

.settings-row-text { display: flex; flex-direction: column; gap: 2px; }
.settings-label { font-size: 14px; font-weight: 600; color: var(--text-1); }
.settings-hint { font-size: 12px; color: var(--text-3); }

.settings-segment {
  display: flex;
  gap: 2px;
  padding: 2px;
  background: var(--surface);
  border: 1px solid var(--border);
  border-radius: 9px;
}

.settings-seg {
  padding: 6px 12px;
  border: 0;
  border-radius: 7px;
  background: transparent;
  color: var(--text-2);
  font: inherit;
  font-size: 13px;
  cursor: pointer;
}

.settings-seg.active {
  background: var(--accent-soft);
  color: var(--accent-text);
  font-weight: 700;
}

.settings-seg:focus-visible { outline: 2px solid var(--focus); outline-offset: 2px; }

.settings-facts {
  display: flex;
  flex-direction: column;
  gap: 10px;
  padding: 12px 14px;
  background: var(--surface-2);
  border: 1px solid var(--border);
  border-radius: 12px;
  margin-bottom: 10px;
}

.settings-fact { display: flex; align-items: center; justify-content: space-between; gap: 12px; }
.settings-fact dt { font-size: 12.5px; color: var(--text-3); }
.settings-fact dd { font-size: 13.5px; color: var(--text-1); font-weight: 600; }

.settings-action { width: 100%; justify-content: center; }

@media (max-width: 768px) {
  .settings-modal { max-width: none; }
  .settings-body { padding: 14px 16px 20px; }
}
```

- [ ] **Step 2: Write the panel**

```jsx
import Modal from '../ui/Modal.jsx';
import { useTheme } from '../../hooks/useTheme.js';
import './Settings.css';

export default function SettingsPanel({ currentUser, onClose, onEditProfile, onLogoutRequest }) {
  const { theme, setTheme } = useTheme();

  return (
    <Modal onClose={onClose} labelledBy="settings-title" className="settings-modal">
      <header className="settings-head">
        <h2 id="settings-title">تنظیمات</h2>
        <button type="button" className="icon-btn" onClick={onClose} aria-label="بستن تنظیمات">
          <i className="fas fa-xmark" aria-hidden="true" />
        </button>
      </header>

      <div className="settings-body">
        <section className="settings-section" aria-labelledby="settings-theme">
          <h3 id="settings-theme">ظاهر</h3>
          <div className="settings-row">
            <span className="settings-row-text">
              <span className="settings-label">حالت نمایش</span>
              <span className="settings-hint">فقط روی همین دستگاه ذخیره می‌شود</span>
            </span>
            <div className="settings-segment" role="group" aria-label="حالت نمایش">
              <button
                type="button"
                className={`settings-seg${theme === 'light' ? ' active' : ''}`}
                aria-pressed={theme === 'light'}
                onClick={() => setTheme('light')}
              >
                روشن
              </button>
              <button
                type="button"
                className={`settings-seg${theme === 'dark' ? ' active' : ''}`}
                aria-pressed={theme === 'dark'}
                onClick={() => setTheme('dark')}
              >
                تیره
              </button>
            </div>
          </div>
        </section>

        <section className="settings-section" aria-labelledby="settings-account">
          <h3 id="settings-account">حساب</h3>
          <dl className="settings-facts">
            <div className="settings-fact">
              <dt>نام</dt>
              <dd>{currentUser.name}</dd>
            </div>
            <div className="settings-fact">
              <dt>نام کاربری</dt>
              <dd dir="ltr">@{currentUser.username}</dd>
            </div>
            {currentUser.phone && (
              <div className="settings-fact">
                <dt>شماره</dt>
                <dd dir="ltr">{currentUser.phone}</dd>
              </div>
            )}
          </dl>
          <button type="button" className="btn btn-secondary settings-action" onClick={onEditProfile}>
            ویرایش پروفایل
          </button>
        </section>

        <section className="settings-section">
          <button type="button" className="btn btn-danger settings-action" onClick={onLogoutRequest}>
            خروج از حساب
          </button>
        </section>
      </div>
    </Modal>
  );
}
```

- [ ] **Step 3: Wire the sidebar**

At the top of `src/components/Sidebar/Sidebar.jsx`, add the import next to the other component imports:

```jsx
import SettingsPanel from '../Settings/SettingsPanel.jsx';
```

Add state next to the existing `confirmLogout` state:

```jsx
const [settingsOpen, setSettingsOpen] = useState(false);
```

In the footer's `.footer-actions`, before `<ThemeToggle />`, add:

```jsx
<button
  type="button"
  className="icon-btn"
  title="تنظیمات"
  aria-label="تنظیمات"
  onClick={() => setSettingsOpen(true)}
>
  <i className="fas fa-gear" aria-hidden="true" />
</button>
```

Render the panel after `</footer>`, before the `confirmLogout` modal:

```jsx
{settingsOpen && (
  <SettingsPanel
    currentUser={currentUser}
    onClose={() => setSettingsOpen(false)}
    onEditProfile={() => { setSettingsOpen(false); onOpenProfile?.(); }}
    onLogoutRequest={() => { setSettingsOpen(false); setConfirmLogout(true); }}
  />
)}
```

- [ ] **Step 4: Lint and build**

Run: `npm run lint && npm run build`
Expected: both exit 0.

- [ ] **Step 5: Manual browser pass**

Run `npm run dev` and check each line:

- The gear in the sidebar footer opens the modal; Escape and a backdrop click close it.
- Choosing «تیره» in the panel flips the UI and the sidebar theme button's icon changes without a reload; «روشن» flips back.
- The account section shows the signed-in name, `@username`, and the phone number.
- «ویرایش پروفایل» closes settings and opens the existing profile panel.
- «خروج از حساب» closes settings and opens the existing logout confirmation; cancel leaves the session alone.

- [ ] **Step 6: Commit**

```bash
git add src/components/Settings/SettingsPanel.jsx src/components/Settings/Settings.css src/components/Sidebar/Sidebar.jsx
git commit -m "Add a settings modal with theme, account and logout on web"
```

---

### Task 3: Mobile settings provider and theme override

**Files:**
- Create: `mobile/src/context/SettingsContext.js`
- Create: `mobile/__tests__/settings-theme.test.js`
- Modify: `mobile/src/theme.js` (`useAppTheme`)
- Modify: `mobile/App.js` (split `App`/`AppShell`, wrap in provider)

**Interfaces:**
- Produces: `SettingsProvider`, `useSettings(): { themeMode: 'system' | 'light' | 'dark', setThemeMode(mode): void }`; `useAppTheme()` now returns the overridden scheme.
- Consumes: AsyncStorage key `openbridge_theme_mode`.

- [ ] **Step 1: Write the failing test**

Create `mobile/__tests__/settings-theme.test.js`:

```js
import { render, fireEvent, waitFor } from '@testing-library/react-native';
import { Pressable, Text } from 'react-native';
import AsyncStorage from '@react-native-async-storage/async-storage';
import { SettingsProvider, useSettings } from '../src/context/SettingsContext';
import { useAppTheme } from '../src/theme';

function ThemeProbe() {
  const { scheme } = useAppTheme();
  return <Text testID="scheme">{scheme}</Text>;
}

function ModeButton({ mode }) {
  const { setThemeMode } = useSettings();
  return (
    <Pressable accessibilityRole="button" accessibilityLabel={mode} onPress={() => setThemeMode(mode)}>
      <Text>{mode}</Text>
    </Pressable>
  );
}

beforeEach(async () => {
  await AsyncStorage.clear();
});

test('a manual mode overrides the OS scheme and persists', async () => {
  const view = render(
    <SettingsProvider>
      <ThemeProbe />
      <ModeButton mode="light" />
      <ModeButton mode="dark" />
    </SettingsProvider>,
  );

  fireEvent.press(view.getByLabelText('light'));
  await waitFor(() => expect(view.getByTestId('scheme').props.children).toBe('light'));
  await waitFor(async () => expect(await AsyncStorage.getItem('openbridge_theme_mode')).toBe('light'));

  fireEvent.press(view.getByLabelText('dark'));
  await waitFor(() => expect(view.getByTestId('scheme').props.children).toBe('dark'));
  await waitFor(async () => expect(await AsyncStorage.getItem('openbridge_theme_mode')).toBe('dark'));
});

test('a saved mode is applied on mount', async () => {
  await AsyncStorage.setItem('openbridge_theme_mode', 'dark');

  const view = render(
    <SettingsProvider>
      <ThemeProbe />
    </SettingsProvider>,
  );

  await waitFor(() => expect(view.getByTestId('scheme').props.children).toBe('dark'));
});
```

- [ ] **Step 2: Run it to verify it fails**

Run: `cd mobile && npx jest __tests__/settings-theme.test.js --runInBand`
Expected: FAIL — `Cannot find module '../src/context/SettingsContext'`.

- [ ] **Step 3: Write the provider**

Create `mobile/src/context/SettingsContext.js`:

```js
import { createContext, useCallback, useContext, useEffect, useMemo, useState } from 'react';
import AsyncStorage from '@react-native-async-storage/async-storage';

const STORAGE_KEY = 'openbridge_theme_mode';
const MODES = ['system', 'light', 'dark'];

// The default keeps components that render outside the provider (tests, the
// splash screen) working: they simply follow the OS.
const SettingsContext = createContext({ themeMode: 'system', setThemeMode: () => {} });

export function SettingsProvider({ children }) {
  const [themeMode, setThemeModeState] = useState('system');

  useEffect(() => {
    let cancelled = false;
    AsyncStorage.getItem(STORAGE_KEY)
      .then(saved => {
        if (!cancelled && MODES.includes(saved)) setThemeModeState(saved);
      })
      .catch(() => undefined);
    return () => { cancelled = true; };
  }, []);

  const setThemeMode = useCallback(mode => {
    if (!MODES.includes(mode)) return;
    setThemeModeState(mode);
    AsyncStorage.setItem(STORAGE_KEY, mode).catch(() => undefined);
  }, []);

  const value = useMemo(() => ({ themeMode, setThemeMode }), [themeMode, setThemeMode]);
  return <SettingsContext.Provider value={value}>{children}</SettingsContext.Provider>;
}

export function useSettings() {
  return useContext(SettingsContext);
}
```

- [ ] **Step 4: Make `useAppTheme` honour the mode**

In `mobile/src/theme.js`, add the import at the top:

```js
import { useSettings } from './context/SettingsContext';
```

Replace `useAppTheme` with:

```js
export function useAppTheme() {
  const scheme = useColorScheme();
  const { themeMode } = useSettings();
  const dark = themeMode === 'system' ? scheme === 'dark' : themeMode === 'dark';
  const colors = dark ? darkColors : lightColors;
  return { dark, scheme: dark ? 'dark' : 'light', colors };
}
```

- [ ] **Step 5: Wrap the app so its own theme reads the provider**

In `mobile/App.js`, add the import:

```js
import { SettingsProvider } from './src/context/SettingsContext';
```

Rename the existing `export default function App()` to `function AppShell()` (keep its body unchanged) and add below it:

```jsx
export default function App() {
  return (
    <SettingsProvider>
      <AppShell />
    </SettingsProvider>
  );
}
```

The provider must sit outside `AppShell` because `AppShell` itself calls `useAppTheme` for the navigation theme and status bar.

- [ ] **Step 6: Run the test to verify it passes**

Run: `cd mobile && npx jest __tests__/settings-theme.test.js --runInBand`
Expected: PASS, 2 tests.

- [ ] **Step 7: Commit**

```bash
git add mobile/src/context/SettingsContext.js mobile/__tests__/settings-theme.test.js mobile/src/theme.js mobile/App.js
git commit -m "Persist a manual theme mode on mobile and honour it in useAppTheme"
```

---

### Task 4: Mobile settings screen and header entry

**Files:**
- Create: `mobile/src/screens/SettingsScreen.js`
- Create: `mobile/__tests__/settings-screen.test.js`
- Modify: `mobile/App.js` (import + `Stack.Screen`)
- Modify: `mobile/src/screens/ChatListScreen.js` (gear in `headerRight`)

**Interfaces:**
- Consumes: `useSettings()` and `useAppTheme()` from Task 3; `useAuth()` for `currentUser` and `logout`; `Avatar({ uri, name, size })`.
- Produces: the `Settings` route name used by `ChatListScreen`.

- [ ] **Step 1: Write the failing test**

Create `mobile/__tests__/settings-screen.test.js`:

```js
import { render, fireEvent, waitFor } from '@testing-library/react-native';
import { Alert } from 'react-native';
import AsyncStorage from '@react-native-async-storage/async-storage';
import SettingsScreen from '../src/screens/SettingsScreen';
import { SettingsProvider } from '../src/context/SettingsContext';

const mockLogout = jest.fn();

jest.mock('../src/context/AuthContext', () => ({
  useAuth: () => ({
    currentUser: { id: 'me', name: 'من', username: 'me', avatar: null },
    logout: mockLogout,
  }),
}));

beforeEach(async () => {
  jest.clearAllMocks();
  await AsyncStorage.clear();
});

function renderScreen() {
  return render(
    <SettingsProvider>
      <SettingsScreen />
    </SettingsProvider>,
  );
}

test('shows the account facts and the three theme choices', () => {
  const view = renderScreen();
  expect(view.getByText('من')).toBeTruthy();
  expect(view.getByText('@me')).toBeTruthy();
  expect(view.getByText('همراه سیستم')).toBeTruthy();
  expect(view.getByText('روشن')).toBeTruthy();
  expect(view.getByText('تیره')).toBeTruthy();
});

test('picking a theme saves it for the next launch', async () => {
  const view = renderScreen();
  fireEvent.press(view.getByLabelText('تیره'));
  await waitFor(async () => {
    expect(await AsyncStorage.getItem('openbridge_theme_mode')).toBe('dark');
  });
});

test('logout asks for confirmation before signing out', async () => {
  const alertSpy = jest.spyOn(Alert, 'alert').mockImplementation(() => {});
  const view = renderScreen();

  fireEvent.press(view.getByLabelText('خروج از حساب'));
  expect(alertSpy).toHaveBeenCalled();

  const buttons = alertSpy.mock.calls[0][2];
  await buttons[1].onPress();
  expect(mockLogout).toHaveBeenCalled();

  alertSpy.mockRestore();
});
```

- [ ] **Step 2: Run it to verify it fails**

Run: `cd mobile && npx jest __tests__/settings-screen.test.js --runInBand`
Expected: FAIL — `Cannot find module '../src/screens/SettingsScreen'`.

- [ ] **Step 3: Write the screen**

Create `mobile/src/screens/SettingsScreen.js`:

```jsx
import { useMemo } from 'react';
import { Alert, Pressable, ScrollView, StyleSheet, Text, View } from 'react-native';
import { FontAwesome6 } from '@expo/vector-icons';
import { useAuth } from '../context/AuthContext';
import { useSettings } from '../context/SettingsContext';
import { navFonts, radius, spacing, type, useAppTheme } from '../theme';
import Avatar from '../components/Avatar';

const THEME_OPTIONS = [
  { value: 'system', label: 'همراه سیستم' },
  { value: 'light', label: 'روشن' },
  { value: 'dark', label: 'تیره' },
];

export default function SettingsScreen() {
  const { currentUser, logout } = useAuth();
  const { themeMode, setThemeMode } = useSettings();
  const { colors } = useAppTheme();
  const styles = useMemo(() => makeStyles(colors), [colors]);

  function confirmLogout() {
    Alert.alert('خروج از حساب', 'از حساب OpenBridge خارج می‌شوی؟', [
      { text: 'انصراف', style: 'cancel' },
      { text: 'خروج', style: 'destructive', onPress: logout },
    ]);
  }

  return (
    <ScrollView style={styles.screen} contentContainerStyle={styles.content}>
      <View style={[styles.group, styles.identity]}>
        <Avatar uri={currentUser.avatar} name={currentUser.name} size={56} />
        <View style={styles.identityText}>
          <Text style={styles.name}>{currentUser.name}</Text>
          <Text style={styles.username} dir="ltr">@{currentUser.username}</Text>
        </View>
      </View>

      <Text style={styles.sectionTitle}>ظاهر</Text>
      <View style={styles.group}>
        {THEME_OPTIONS.map((option, index) => {
          const selected = themeMode === option.value;
          return (
            <Pressable
              key={option.value}
              onPress={() => setThemeMode(option.value)}
              accessibilityRole="radio"
              accessibilityState={{ selected }}
              accessibilityLabel={option.label}
              style={({ pressed }) => [
                styles.row,
                index > 0 && styles.rowDivider,
                pressed && styles.rowPressed,
              ]}
            >
              <Text style={styles.rowLabel}>{option.label}</Text>
              {selected && <FontAwesome6 name="check" size={14} color={colors.accent} />}
            </Pressable>
          );
        })}
      </View>

      <Text style={styles.sectionTitle}>حساب</Text>
      <Pressable
        onPress={confirmLogout}
        accessibilityRole="button"
        accessibilityLabel="خروج از حساب"
        style={({ pressed }) => [styles.group, styles.logout, pressed && styles.rowPressed]}
      >
        <FontAwesome6 name="right-from-bracket" size={16} color={colors.danger} />
        <Text style={styles.logoutText}>خروج از حساب</Text>
      </Pressable>
    </ScrollView>
  );
}

function makeStyles(colors) {
  return StyleSheet.create({
    screen: { flex: 1, backgroundColor: colors.bg },
    content: { padding: spacing.lg, gap: spacing.md },
    group: {
      backgroundColor: colors.surface,
      borderRadius: radius.md,
      borderWidth: StyleSheet.hairlineWidth,
      borderColor: colors.border,
      overflow: 'hidden',
    },
    identity: {
      flexDirection: 'row',
      alignItems: 'center',
      gap: spacing.md,
      padding: spacing.md,
    },
    identityText: { flex: 1 },
    name: { ...navFonts.bold, fontSize: type.lg, color: colors.text1 },
    username: { ...navFonts.regular, fontSize: type.sm, color: colors.text2, marginTop: 2 },
    sectionTitle: {
      ...navFonts.medium,
      fontSize: type.sm,
      color: colors.text3,
      marginTop: spacing.sm,
      marginStart: spacing.xs,
    },
    row: {
      flexDirection: 'row',
      alignItems: 'center',
      justifyContent: 'space-between',
      paddingHorizontal: spacing.md,
      paddingVertical: 14,
    },
    rowDivider: { borderTopWidth: StyleSheet.hairlineWidth, borderTopColor: colors.border },
    rowPressed: { opacity: 0.7 },
    rowLabel: { ...navFonts.medium, fontSize: type.base, color: colors.text1 },
    logout: {
      flexDirection: 'row',
      alignItems: 'center',
      justifyContent: 'center',
      gap: spacing.sm,
      paddingVertical: spacing.md,
    },
    logoutText: { ...navFonts.medium, fontSize: type.base, color: colors.danger },
  });
}
```

- [ ] **Step 4: Register the route**

In `mobile/App.js`, add the import next to the other screens:

```js
import SettingsScreen from './src/screens/SettingsScreen';
```

Inside the signed-in fragment, after the `Contacts` screen:

```jsx
<Stack.Screen name="Settings" component={SettingsScreen} options={{ title: 'تنظیمات' }} />
```

- [ ] **Step 5: Add the gear to the chat list header**

In `mobile/src/screens/ChatListScreen.js`, inside the existing `headerRight` `View`, before the contacts `Pressable`:

```jsx
<Pressable
  onPress={() => navigation.navigate('Settings')}
  hitSlop={10}
  style={styles.headerBtn}
  accessibilityRole="button"
  accessibilityLabel="تنظیمات"
>
  <FontAwesome6 name="gear" size={17} color={colors.text1} />
</Pressable>
```

- [ ] **Step 6: Run the new test, then the whole mobile suite**

Run: `cd mobile && npx jest __tests__/settings-screen.test.js --runInBand`
Expected: PASS, 3 tests.

Run: `cd mobile && npx jest --ci --runInBand`
Expected: PASS. If `chat-list-screen.test.js` fails on the new header button, fix the test's navigation mock rather than removing the button.

- [ ] **Step 7: Commit**

```bash
git add mobile/src/screens/SettingsScreen.js mobile/__tests__/settings-screen.test.js mobile/App.js mobile/src/screens/ChatListScreen.js
git commit -m "Add the mobile settings screen with theme choices and logout"
```

---

### Task 5: Version 1.7.0, changelog, and full verification

**Files:**
- Modify: `package.json`, `backend/package.json`, `mobile/package.json`, `mobile/app.json`, `package-lock.json`
- Modify: `CHANGELOG.md`

**Interfaces:**
- None; this task only records the release.

- [ ] **Step 1: Bump the manifests**

Run:

```bash
node <<'EOF'
const fs = require('fs');
for (const file of ['package.json', 'backend/package.json', 'mobile/package.json']) {
  const text = fs.readFileSync(file, 'utf8');
  const pkg = JSON.parse(text);
  pkg.version = '1.7.0';
  fs.writeFileSync(file, JSON.stringify(pkg, null, 2) + '\n');
}
const app = JSON.parse(fs.readFileSync('mobile/app.json', 'utf8'));
app.expo.version = '1.7.0';
fs.writeFileSync('mobile/app.json', JSON.stringify(app, null, 2) + '\n');
const lock = JSON.parse(fs.readFileSync('package-lock.json', 'utf8'));
lock.version = '1.7.0';
lock.packages[''].version = '1.7.0';
fs.writeFileSync('package-lock.json', JSON.stringify(lock, null, 2) + '\n');
EOF
```

Check the lockfile diff is exactly the two version lines:

```bash
git diff --stat package-lock.json
git diff package-lock.json | grep '^[-+]' | grep -v '^[-+][-+]'
```

Expected: no dependency `resolved`/`integrity` lines in the output; only `"version": "1.6.0" → "1.7.0"` and the root package entry.

- [ ] **Step 2: Add the changelog entry**

Run (Persian copy goes through Node so the digits and RTL text stay intact):

```bash
node <<'EOF'
const fs = require('fs');
const entry = `## [1.7.0] - 2026-10-25

### Added
- **تنظیمات.** وب: چرخ‌دنده در فوتر سایدبار پنجرهٔ تنظیمات را باز می‌کند؛ موبایل:
  چرخ‌دنده در هدر «گفتگوها» صفحهٔ تنظیمات را باز می‌کند. هر دو بخش «ظاهر» و
  «حساب» دارند.
- حالت نمایش روی موبایل حالا دستی انتخاب می‌شود (همراه سیستم، روشن، تیره) و روی
  همان دستگاه می‌ماند؛ وب همان انتخاب روشن/تیره را در پنل تازه هم دارد و دو
  کنترل تم با هم هماهنگ می‌مانند.
- ویرایش پروفایل و خروج از حساب از همان صفحه در دسترس‌اند؛ خروج همچنان تأیید
  می‌خواهد.

### Verified
\`npm run lint\` و \`npm run build\` وب، و تست‌های Jest موبایل سبزند. بازبینی
دستگاه انجام نشده است.
`;
const path = 'CHANGELOG.md';
const text = fs.readFileSync(path, 'utf8');
const marker = '## [1.6.0]';
if (!text.includes(marker)) throw new Error('changelog marker missing');
fs.writeFileSync(path, text.replace(marker, entry + marker));
console.log('inserted 1.7.0 entry');
EOF
```

- [ ] **Step 3: Run the full verification set**

Run:

```bash
npm run lint
npm run build
cd mobile && npx jest --ci --runInBand
```

Expected: lint and build exit 0; Jest reports all suites passing.

- [ ] **Step 4: Refresh the knowledge graph**

Run from the repository root: `graphify update .`
Expected: `graphify-out/graph.json` updated without LLM cost; the new `SettingsPanel` and `SettingsScreen` nodes appear.

- [ ] **Step 5: Commit**

```bash
git add package.json package-lock.json backend/package.json mobile/package.json mobile/app.json CHANGELOG.md
git commit -m "Release settings phase one as 1.7.0"
```

---

## Manual acceptance (after Task 5)

Cannot be proven by tests; run it on a real browser and device before calling the phase done.

- Web: gear opens settings; theme choice flips both controls and survives reload; account facts match the profile; edit-profile and logout hand off to the existing dialogs.
- Mobile: gear opens the settings screen; choosing «تیره» recolours the app immediately and survives a cold start; «همراه سیستم» follows the OS again; logout shows the destructive confirm.
- Both: no phase 2 or phase 3 controls exist yet.
