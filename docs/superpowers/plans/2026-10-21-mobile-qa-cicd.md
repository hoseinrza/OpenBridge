# Mobile QA and real CI/CD Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add automated mobile component tests, a real Android emulator E2E flow, and CI jobs that run both on GitHub Actions, then ship as 1.1.11 with corrected docs.

**Architecture:** Two test layers. Jest + React Native Testing Library covers screen behavior on every push and PR in minutes. Maestro drives a release APK on an API-34 emulator against a real NestJS + PostgreSQL backend, seeded only in CI, on `main`, mobile PRs, nightly, and manual runs. One `ci-gate` stays the required check; the emulator skip is tolerated only when a PR does not touch mobile code. No production deployment is performed.

**Tech Stack:** Expo SDK 57 / React Native 0.86, Jest 29, jest-expo 57, @testing-library/react-native 13, Maestro CLI 2.11.0, GitHub Actions, PostgreSQL 16, Android emulator API 34, JDK 17.

**Spec:** `docs/superpowers/specs/2026-10-21-mobile-qa-cicd-design.md`

## Global Constraints

- Product version for this batch: `1.1.11` in root `package.json`, `backend/package.json`, `mobile/package.json`, and `mobile/app.json`.
- No production deployment, no server credentials, no seeded/demo data in the shipped app.
- Do not stage or commit the existing E2EE/upload work in progress; stage only the paths listed in each task.
- CI Node version stays `20`; the emulator job uses JDK 17.
- E2E fixtures use only `09120000001` / `09120000002` and the group name `E2E Group`, and only inside the disposable CI database.
- The E2E release APK is signed with Expo's generated debug keystore and gets a CI-only cleartext-manifest patch; neither is committed.
- All assertions about tests must come from an actual run.

---

### Task 1: Mobile Jest harness and pure utility tests

**Files:**
- Modify: `mobile/package.json`
- Modify: `mobile/package-lock.json`
- Create: `mobile/jest.config.js`
- Create: `mobile/jest.setup.js`
- Create: `mobile/__tests__/utils.test.js`

**Interfaces:**
- Consumes: existing `mobile/src/utils/phone.js` (`normalizeIranMobile`) and `mobile/src/utils/time.js` (`dayKey`, `formatDayLabel`, `formatConversationTime`).
- Produces: `npm test` / `npm run test:ci` in `mobile/`, and the shared mocks in `jest.setup.js` used by every later test file.

- [ ] **Step 1: Install the test toolchain**

Run from `mobile/`:

```bash
npm install --save-dev jest@29.7.0 jest-expo@~57.0.6 @testing-library/react-native@~13.3.3 react-test-renderer@19.2.3
```

If npm reports a peer conflict for `@react-native/jest-preset`, add `@react-native/jest-preset@0.86.3` to the same command.

- [ ] **Step 2: Add the scripts**

Edit `mobile/package.json`:

```json
  "scripts": {
    "start": "expo start",
    "android": "expo start --android",
    "ios": "expo start --ios",
    "web": "expo start --web",
    "test": "jest",
    "test:ci": "jest --ci --runInBand"
  },
```

- [ ] **Step 3: Add the Jest config**

Create `mobile/jest.config.js`:

```js
module.exports = {
  preset: 'jest-expo',
  setupFilesAfterEnv: ['<rootDir>/jest.setup.js'],
  testPathIgnorePatterns: ['/node_modules/', '/android/', '/ios/'],
};
```

- [ ] **Step 4: Add the shared native mocks**

Create `mobile/jest.setup.js`:

```js
jest.mock('@react-native-async-storage/async-storage', () =>
  require('@react-native-async-storage/async-storage/jest/async-storage-mock'),
);

const mockSecureStore = new Map();
jest.mock('expo-secure-store', () => ({
  getItemAsync: jest.fn(async key => mockSecureStore.get(key) ?? null),
  setItemAsync: jest.fn(async (key, value) => { mockSecureStore.set(key, value); }),
  deleteItemAsync: jest.fn(async key => { mockSecureStore.delete(key); }),
  __reset: () => mockSecureStore.clear(),
}));

jest.mock('react-native-safe-area-context', () => ({
  useSafeAreaInsets: () => ({ top: 0, right: 0, bottom: 0, left: 0 }),
  SafeAreaProvider: ({ children }) => children,
}));

jest.mock('@expo/vector-icons', () => {
  const React = require('react');
  const { Text } = require('react-native');
  return {
    FontAwesome6: ({ name, accessibilityLabel }) =>
      React.createElement(Text, { accessibilityLabel }, name),
  };
});

jest.mock('socket.io-client', () => ({ io: jest.fn() }));
```

- [ ] **Step 5: Write the utility tests**

Create `mobile/__tests__/utils.test.js`:

```js
import { normalizeIranMobile } from '../src/utils/phone';
import { dayKey, formatDayLabel, formatConversationTime } from '../src/utils/time';

describe('normalizeIranMobile', () => {
  test.each([
    ['09123456789', '09123456789'],
    ['۰۹۱۲۳۴۵۶۷۸۹', '09123456789'],
    ['+989123456789', '09123456789'],
    ['00989123456789', '09123456789'],
    ['989123456789', '09123456789'],
    ['9123456789', '09123456789'],
    ['0912 345 6789', '09123456789'],
    ['(0912)-345-6789', '09123456789'],
  ])('%s normalizes to %s', (input, expected) => {
    expect(normalizeIranMobile(input)).toBe(expected);
  });

  test.each(['12345', '08123456789', '', null, 9123456789])('rejects %p', input => {
    expect(normalizeIranMobile(input)).toBeNull();
  });
});

describe('time helpers', () => {
  beforeEach(() => {
    jest.useFakeTimers();
    jest.setSystemTime(new Date('2026-10-21T12:00:00'));
  });

  afterEach(() => {
    jest.useRealTimers();
  });

  test('dayKey uses the local calendar day', () => {
    expect(dayKey(new Date('2026-10-21T08:00:00'))).toBe('2026-9-21');
  });

  test('labels today and yesterday', () => {
    expect(formatDayLabel(new Date('2026-10-21T08:00:00'))).toBe('امروز');
    expect(formatDayLabel(new Date('2026-10-20T08:00:00'))).toBe('دیروز');
    expect(formatConversationTime(new Date('2026-10-20T08:00:00'))).toBe('دیروز');
  });

  test('omits a missing conversation timestamp', () => {
    expect(formatConversationTime(null)).toBe('');
  });
});
```

- [ ] **Step 6: Run the suite**

Run: `cd mobile && npm test -- --runInBand`

Expected: 3 test groups pass (the parameterized cases report individually).

- [ ] **Step 7: Commit**

```bash
git add mobile/package.json mobile/package-lock.json mobile/jest.config.js mobile/jest.setup.js mobile/__tests__/utils.test.js
git commit -m "Add a Jest harness and test the mobile pure helpers"
```

---

### Task 2: LoginScreen tests and the login testIDs

**Files:**
- Modify: `mobile/src/screens/LoginScreen.js`
- Create: `mobile/__tests__/login-screen.test.js`

**Interfaces:**
- Consumes: `AuthProvider` / `useAuth` from `mobile/src/context/AuthContext.js`; the API functions `requestOtp`, `verifyOtp`, `completeSignup`, `logout`, `resolveUrl`, `setUnauthorizedHandler` from `mobile/src/services/api.js`.
- Produces: `testID`s `login-phone`, `login-request-code`, `login-code`, `login-test-code`, `login-submit`, plus a test-code text node whose text is only the six digits.

- [ ] **Step 1: Split the test code into its own element and add testIDs**

In `mobile/src/screens/LoginScreen.js`:

Add `testID="login-phone"` to the phone `TextInput`, `testID="login-request-code"` to the request `Pressable`, `testID="login-code"` to the code `TextInput`, and `testID="login-submit"` to the verify/signup-continue `Pressable`.

Replace the test-code block with a column layout so the digits are a separate node:

```jsx
{!!testCode && (
  <View style={styles.testCode} accessibilityLiveRegion="polite">
    <FontAwesome6 name="flask" size={13} color={colors.text3} />
    <View style={{ flex: 1 }}>
      <Text style={styles.testCodeText}>
        کد تست (فقط محیط توسعه):
      </Text>
      <Text selectable testID="login-test-code" style={styles.testCodeValue}>
        {testCode}
      </Text>
    </View>
  </View>
)}
```

- [ ] **Step 2: Write the failing login tests**

Create `mobile/__tests__/login-screen.test.js`:

```js
import AsyncStorage from '@react-native-async-storage/async-storage';
import { render, fireEvent, waitFor } from '@testing-library/react-native';
import { Text } from 'react-native';
import { AuthProvider, useAuth } from '../src/context/AuthContext';
import LoginScreen from '../src/screens/LoginScreen';
import * as api from '../src/services/api';

jest.mock('../src/services/api', () => ({
  requestOtp: jest.fn(),
  verifyOtp: jest.fn(),
  completeSignup: jest.fn(),
  logout: jest.fn(async () => {}),
  resolveUrl: jest.fn(path => path),
  setUnauthorizedHandler: jest.fn(),
}));

const SecureStore = require('expo-secure-store');

function Probe() {
  const { currentUser } = useAuth();
  return <Text>{currentUser ? `signed:${currentUser.username}` : 'signed:no'}</Text>;
}

function renderLogin() {
  return render(
    <AuthProvider>
      <LoginScreen />
      <Probe />
    </AuthProvider>,
  );
}

async function requestCode(view, phone = '09123456789') {
  fireEvent.changeText(view.getByLabelText('شماره موبایل'), phone);
  fireEvent.press(view.getByLabelText('دریافت کد تأیید'));
  await waitFor(() => expect(view.getByLabelText('کد تأیید ۶ رقمی')).toBeTruthy());
}

beforeEach(async () => {
  jest.clearAllMocks();
  await AsyncStorage.clear();
  SecureStore.__reset();
});

test('rejects an invalid phone number before calling the API', async () => {
  const view = renderLogin();
  fireEvent.changeText(view.getByLabelText('شماره موبایل'), '123');
  fireEvent.press(view.getByLabelText('دریافت کد تأیید'));
  await waitFor(() =>
    expect(view.getByText('شماره موبایل معتبر نیست؛ نمونه: ۰۹۱۲۳۴۵۶۷۸۹')).toBeTruthy(),
  );
  expect(api.requestOtp).not.toHaveBeenCalled();
});

test('requests a code and exposes only the digits as the test code', async () => {
  api.requestOtp.mockResolvedValue({ isNewUser: false, testCode: '123456', expiresInSeconds: 300 });
  const view = renderLogin();
  await requestCode(view);
  expect(api.requestOtp).toHaveBeenCalledWith('09123456789');
  expect(view.getByTestId('login-test-code').props.children).toBe('123456');
});

test('signs an existing user in and persists the session', async () => {
  api.requestOtp.mockResolvedValue({ isNewUser: false, testCode: '123456', expiresInSeconds: 300 });
  api.verifyOtp.mockResolvedValue({ user: { id: 'u1', username: 'ali', displayName: 'علی' } });
  const view = renderLogin();
  await requestCode(view);
  fireEvent.changeText(view.getByLabelText('کد تأیید ۶ رقمی'), '123456');
  fireEvent.press(view.getByLabelText('تأیید و ورود'));
  await waitFor(() => expect(view.getByText('signed:ali')).toBeTruthy());
  expect(api.verifyOtp).toHaveBeenCalledWith('09123456789', '123456');
  expect(JSON.parse(await AsyncStorage.getItem('chatapp_user')).username).toBe('ali');
});

test('shows the server error when verification fails', async () => {
  api.requestOtp.mockResolvedValue({ isNewUser: false, testCode: '123456', expiresInSeconds: 300 });
  api.verifyOtp.mockRejectedValue(
    Object.assign(new Error('کد تأیید نادرست است'), { status: 401 }),
  );
  const view = renderLogin();
  await requestCode(view);
  fireEvent.changeText(view.getByLabelText('کد تأیید ۶ رقمی'), '000000');
  fireEvent.press(view.getByLabelText('تأیید و ورود'));
  await waitFor(() => expect(view.getByText('کد تأیید نادرست است')).toBeTruthy());
});

test('walks a new user through username and name', async () => {
  api.requestOtp.mockResolvedValue({ isNewUser: true, testCode: '654321', expiresInSeconds: 300 });
  api.verifyOtp.mockResolvedValue({ requiresSignup: true, signupToken: 'signup-token' });
  api.completeSignup.mockResolvedValue({
    id: 'u2', username: 'new_user', displayName: 'Ali Rezaei',
  });
  const view = renderLogin();
  await requestCode(view);
  fireEvent.changeText(view.getByLabelText('کد تأیید ۶ رقمی'), '654321');
  fireEvent.press(view.getByLabelText('ادامه ثبت‌نام'));
  await waitFor(() => expect(view.getByLabelText('نام کاربری')).toBeTruthy());

  fireEvent.changeText(view.getByLabelText('نام کاربری'), 'a');
  fireEvent.press(view.getByLabelText('ادامه به نام شما'));
  await waitFor(() =>
    expect(
      view.getByText('نام کاربری باید ۲ تا ۳۰ کاراکتر و فقط حروف انگلیسی، عدد و _ باشد'),
    ).toBeTruthy(),
  );

  fireEvent.changeText(view.getByLabelText('نام کاربری'), 'new_user');
  fireEvent.press(view.getByLabelText('ادامه به نام شما'));
  await waitFor(() => expect(view.getByLabelText('نام')).toBeTruthy());
  fireEvent.changeText(view.getByLabelText('نام'), 'علی');
  fireEvent.press(view.getByLabelText('ساخت حساب و ورود'));

  await waitFor(() => expect(view.getByText('signed:new_user')).toBeTruthy());
  expect(api.completeSignup).toHaveBeenCalledWith('signup-token', {
    username: 'new_user',
    firstName: 'علی',
    lastName: undefined,
  });
});
```

- [ ] **Step 3: Run the tests**

Run: `cd mobile && npm test -- --runInBand __tests__/login-screen.test.js`

Expected before the testIDs exist: failures such as `Unable to find an element with label: login-phone`. After Step 1: PASS (5 tests).

- [ ] **Step 4: Commit**

```bash
git add mobile/src/screens/LoginScreen.js mobile/__tests__/login-screen.test.js
git commit -m "Cover the mobile login flow with React Native Testing Library"
```

---

### Task 3: ChatListScreen tests

**Files:**
- Create: `mobile/__tests__/chat-list-screen.test.js`

**Interfaces:**
- Consumes: `ChatListScreen` with props `{ navigation }`; the API functions `fetchConversations`, `fetchGroups`, `normalizeUser`, `normalizeGroup`; `useAuth` and `useSocket`.
- Produces: a regression suite for the list, search, empty, error, and navigation states.

- [ ] **Step 1: Write the tests**

Create `mobile/__tests__/chat-list-screen.test.js`:

```js
import { render, fireEvent, waitFor } from '@testing-library/react-native';
import ChatListScreen from '../src/screens/ChatListScreen';
import { fetchConversations, fetchGroups } from '../src/services/api';

jest.mock('../src/services/api', () => ({
  fetchConversations: jest.fn(),
  fetchGroups: jest.fn(),
  normalizeUser: jest.fn(user => ({
    id: user.id,
    kind: 'direct',
    name: user.displayName || user.username,
    username: user.username,
    avatar: null,
    bio: '',
    status: 'offline',
    unread: 0,
    createdAt: user.createdAt,
  })),
  normalizeGroup: jest.fn(group => ({
    id: group.id,
    kind: 'group',
    name: group.name,
    avatar: null,
    memberCount: (group.participants ?? []).length,
    participants: group.participants ?? [],
    unread: group.unread ?? 0,
    updatedAt: group.updatedAt,
  })),
}));

jest.mock('../src/context/AuthContext', () => ({
  useAuth: () => ({
    currentUser: { id: 'me', name: 'من', username: 'me' },
    logout: jest.fn(),
  }),
}));

jest.mock('../src/context/SocketContext', () => ({
  useSocket: () => ({ socket: null }),
}));

jest.mock('@react-navigation/native', () => {
  const React = require('react');
  return {
    useFocusEffect: callback => {
      React.useEffect(callback, [callback]);
    },
  };
});

const direct = {
  user: { id: 'u1', username: 'ali', displayName: 'علی' },
  unread: 2,
  updatedAt: '2026-10-21T10:00:00.000Z',
};
const group = {
  id: 'g1',
  name: 'تیم',
  participants: [{ id: 'u1' }, { id: 'u2' }],
  unread: 0,
  updatedAt: '2026-10-21T09:00:00.000Z',
};

const navigation = { setOptions: jest.fn(), navigate: jest.fn() };

beforeEach(() => {
  jest.clearAllMocks();
  fetchConversations.mockResolvedValue([direct]);
  fetchGroups.mockResolvedValue([group]);
});

test('renders direct and group rows with the unread badge', async () => {
  const view = render(<ChatListScreen navigation={navigation} />);
  expect(await view.findByText('علی')).toBeTruthy();
  expect(view.getByText('تیم')).toBeTruthy();
  expect(view.getByLabelText('2 پیام خوانده‌نشده')).toBeTruthy();
  expect(view.getByText('2 عضو')).toBeTruthy();
});

test('filters rows by name and username', async () => {
  const view = render(<ChatListScreen navigation={navigation} />);
  await view.findByText('علی');
  fireEvent.changeText(view.getByLabelText('جستجوی گفتگو'), 'ali');
  await waitFor(() => expect(view.queryByText('تیم')).toBeNull());
  expect(view.getByText('علی')).toBeTruthy();
  fireEvent.changeText(view.getByLabelText('جستجوی گفتگو'), 'نبود');
  await waitFor(() => expect(view.getByText('گفتگویی پیدا نشد')).toBeTruthy());
});

test('opens a conversation', async () => {
  const view = render(<ChatListScreen navigation={navigation} />);
  fireEvent.press(await view.findByText('علی'));
  expect(navigation.navigate).toHaveBeenCalledWith('Chat', {
    peer: expect.objectContaining({ id: 'u1', name: 'علی' }),
  });
});

test('shows the empty state for a new account', async () => {
  fetchConversations.mockResolvedValue([]);
  fetchGroups.mockResolvedValue([]);
  const view = render(<ChatListScreen navigation={navigation} />);
  expect(await view.findByText('هنوز گفتگویی نداری')).toBeTruthy();
});

test('shows the error banner and retries', async () => {
  fetchConversations.mockRejectedValue(new Error('خطای شبکه'));
  const view = render(<ChatListScreen navigation={navigation} />);
  expect(await view.findByText('خطای شبکه')).toBeTruthy();
  fireEvent.press(view.getByText('تلاش دوباره'));
  await waitFor(() => expect(fetchConversations).toHaveBeenCalledTimes(2));
});
```

- [ ] **Step 2: Run the tests**

Run: `cd mobile && npm test -- --runInBand __tests__/chat-list-screen.test.js`

Expected: PASS (5 tests). If the navigation label is not pressable, use `fireEvent.press(view.getByLabelText('علی'))`.

- [ ] **Step 3: Commit**

```bash
git add mobile/__tests__/chat-list-screen.test.js
git commit -m "Cover the mobile chat list, search, and error states"
```

---

### Task 4: ChatScreen tests and the composer/reaction testIDs

**Files:**
- Modify: `mobile/src/screens/ChatScreen.js`
- Create: `mobile/__tests__/chat-screen.test.js`

**Interfaces:**
- Consumes: `ChatScreen` with prop `{ route: { params: { peer } } }`; `useChat` returning `{ messages, isTyping, typingName, connected, historyState, historyError, retryHistory, sendMessage, notifyTyping, toggleReaction }`.
- Produces: `testID`s `bubble-mine` / `bubble-other`, `composer-input`, `composer-send`, `reaction-option-<emoji>`, `reaction-chip-<emoji>`; the E2E flow in Task 5 uses them.

- [ ] **Step 1: Add the testIDs**

In `mobile/src/screens/ChatScreen.js`:

- On the message bubble `Pressable`, add `testID={`bubble-${isMine ? 'mine' : 'other'}`}`.
- On the composer `TextInput`, add `testID="composer-input"`.
- On the send `Pressable`, add `testID="composer-send"`.
- On the picker option `Pressable` (inside `REACTIONS.map`), add `testID={`reaction-option-${emoji}`}`.
- On the reaction chip `Pressable`, add `testID={`reaction-chip-${emoji}`}`.

- [ ] **Step 2: Write the tests**

Create `mobile/__tests__/chat-screen.test.js`:

```js
import { render, fireEvent, waitFor } from '@testing-library/react-native';
import ChatScreen from '../src/screens/ChatScreen';
import { useChat } from '../src/hooks/useChat';

jest.mock('../src/hooks/useChat', () => ({ useChat: jest.fn() }));

jest.mock('../src/context/AuthContext', () => ({
  useAuth: () => ({ currentUser: { id: 'me', name: 'من' } }),
}));

const peer = { id: 'p1', kind: 'direct', name: 'سارا', username: 'sara', status: 'online' };
const mine = {
  id: 'm1', type: 'text', text: 'سلام از من', side: 'mine', senderId: 'me',
  time: '۱۰:۰۰', createdAt: 1, read: true, reactions: [],
};
const other = {
  id: 'm2', type: 'text', text: 'سلام از سارا', side: 'other', senderId: 'p1',
  sender: 'سارا', time: '۱۰:۰۱', createdAt: 2, read: false, reactions: [],
};

function makeChat(overrides = {}) {
  const chat = {
    messages: [mine, other],
    isTyping: false,
    typingName: '',
    connected: true,
    historyState: 'ready',
    historyError: '',
    retryHistory: jest.fn(),
    sendMessage: jest.fn(async () => ({ ok: true })),
    notifyTyping: jest.fn(),
    toggleReaction: jest.fn(() => true),
    ...overrides,
  };
  useChat.mockReturnValue(chat);
  return chat;
}

function renderChat() {
  return render(<ChatScreen route={{ params: { peer } }} />);
}

beforeEach(() => {
  jest.clearAllMocks();
});

test('renders both message sides and the read receipt', () => {
  makeChat();
  const view = renderChat();
  expect(view.getByText('سلام از من')).toBeTruthy();
  expect(view.getByText('سلام از سارا')).toBeTruthy();
  expect(view.getByTestId('bubble-mine')).toBeTruthy();
  expect(view.getByTestId('bubble-other')).toBeTruthy();
  expect(view.getByLabelText('خوانده شد')).toBeTruthy();
});

test('sends the composer text and clears the input', async () => {
  const chat = makeChat();
  const view = renderChat();
  fireEvent.changeText(view.getByLabelText('متن پیام'), 'hello');
  expect(chat.notifyTyping).toHaveBeenCalled();
  fireEvent.press(view.getByLabelText('ارسال پیام'));
  await waitFor(() => expect(chat.sendMessage).toHaveBeenCalledWith('hello'));
  expect(view.getByLabelText('متن پیام').props.value).toBe('');
});

test('keeps the text and shows the error when sending fails', async () => {
  makeChat({ sendMessage: jest.fn(async () => ({ ok: false, error: 'ارسال پیام ناموفق بود' })) });
  const view = renderChat();
  fireEvent.changeText(view.getByLabelText('متن پیام'), 'hello');
  fireEvent.press(view.getByLabelText('ارسال پیام'));
  expect(await view.findByText('ارسال پیام ناموفق بود')).toBeTruthy();
  expect(view.getByLabelText('متن پیام').props.value).toBe('hello');
});

test('opens reactions on long press and records the chosen emoji', async () => {
  const chat = makeChat({ messages: [mine] });
  const view = renderChat();
  fireEvent(view.getByTestId('bubble-mine'), 'longPress');
  const option = await view.findByLabelText('افزودن واکنش 👍');
  fireEvent.press(option);
  expect(chat.toggleReaction).toHaveBeenCalledWith('m1', '👍');
});

test('reports a reaction when the socket is gone', async () => {
  const chat = makeChat({ messages: [mine], toggleReaction: jest.fn(() => false) });
  const view = renderChat();
  fireEvent(view.getByTestId('bubble-mine'), 'longPress');
  fireEvent.press(await view.findByLabelText('افزودن واکنش 👍'));
  expect(
    await view.findByText('اتصال به سرور برقرار نیست؛ واکنش ثبت نشد'),
  ).toBeTruthy();
  expect(chat.toggleReaction).toHaveBeenCalled();
});

test('disables sending while disconnected', () => {
  makeChat({ connected: false });
  const view = renderChat();
  expect(view.getByText('در حال اتصال به سرور…')).toBeTruthy();
  expect(view.getByLabelText('ارسال پیام')).toBeDisabled();
});

test('shows the empty and error history states', async () => {
  makeChat({ messages: [], historyState: 'error', historyError: 'دریافت پیام‌ها ناموفق بود' });
  const view = renderChat();
  expect(await view.findByText('دریافت پیام‌ها ناموفق بود')).toBeTruthy();
  fireEvent.press(view.getByText('تلاش دوباره'));
  expect(useChat.mock.results[0].value.retryHistory).toHaveBeenCalled();
});
```

- [ ] **Step 3: Run the tests**

Run: `cd mobile && npm test -- --runInBand __tests__/chat-screen.test.js`

Expected: PASS (7 tests). If `fireEvent(element, 'longPress')` does not trigger, use `fireEvent(element, 'onLongPress')`.

- [ ] **Step 4: Run the full mobile suite**

Run: `cd mobile && npm run test:ci`

Expected: 3 suites, 20 tests, all pass.

- [ ] **Step 5: Commit**

```bash
git add mobile/src/screens/ChatScreen.js mobile/__tests__/chat-screen.test.js
git commit -m "Cover the mobile chat surface, sending, and reactions"
```

---

### Task 5: Maestro flow and CI-only seed

**Files:**
- Create: `mobile/.maestro/auth-and-chat.yaml`
- Create: `backend/test/mobile-e2e-seed.mjs`

**Interfaces:**
- Consumes: the testIDs from Tasks 2 and 4; the real API endpoints `POST /api/auth/otp/request`, `POST /api/auth/otp/verify`, `POST /api/auth/signup`, `POST /api/messages/groups`, `GET /api/health`.
- Produces: a deterministic `E2E Group` owned by `09120000001` with `09120000002` as a member, and a Maestro flow that logs in, sends `hello from maestro`, and adds 👍.

- [ ] **Step 1: Write the seed script**

Create `backend/test/mobile-e2e-seed.mjs`:

```js
const BASE = process.env.E2E_API_URL ?? 'http://127.0.0.1:3000/api';

async function call(path, { method = 'GET', token, body } = {}) {
  const res = await fetch(`${BASE}${path}`, {
    method,
    headers: {
      'Content-Type': 'application/json',
      ...(token ? { Authorization: `Bearer ${token}` } : {}),
    },
    body: body ? JSON.stringify(body) : undefined,
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) {
    throw new Error(`${method} ${path} -> ${res.status} ${JSON.stringify(data)}`);
  }
  return data;
}

async function waitForHealth(deadlineMs = 60000) {
  const start = Date.now();
  while (Date.now() - start < deadlineMs) {
    try {
      const res = await fetch(`${BASE}/health`);
      if (res.ok) return;
    } catch {
      // The API is still booting.
    }
    await new Promise(resolve => setTimeout(resolve, 1000));
  }
  throw new Error(`Backend at ${BASE} never became healthy`);
}

async function createUser({ phone, username, firstName, lastName }) {
  const requested = await call('/auth/otp/request', { method: 'POST', body: { phone } });
  if (!requested.testCode) {
    throw new Error('OTP test mode is off; the mobile E2E needs NODE_ENV != production');
  }
  const verified = await call('/auth/otp/verify', {
    method: 'POST',
    body: { phone, code: requested.testCode },
  });
  if (verified.requiresSignup) {
    const created = await call('/auth/signup', {
      method: 'POST',
      body: {
        signupToken: verified.signupToken,
        username,
        firstName,
        lastName,
      },
    });
    return { id: created.user.id, token: created.token ?? created.accessToken };
  }
  return { id: verified.user.id, token: verified.token ?? verified.accessToken };
}

const users = [
  { phone: '09120000001', username: 'e2e_user_a', firstName: 'E2E', lastName: 'Alpha' },
  { phone: '09120000002', username: 'e2e_user_b', firstName: 'E2E', lastName: 'Beta' },
];

await waitForHealth();
const created = [];
for (const user of users) {
  created.push(await createUser(user));
}
const group = await call('/messages/groups', {
  method: 'POST',
  token: created[0].token,
  body: { name: 'E2E Group', memberIds: [created[1].id] },
});
console.log(`Seeded ${users[0].username} + ${users[1].username} in E2E Group (${group.id ?? 'created'})`);
```

- [ ] **Step 2: Write the Maestro flow**

Create `mobile/.maestro/auth-and-chat.yaml`:

```yaml
appId: com.openbridge.mobile
---
- launchApp:
    clearState: true
- assertVisible: "ورود یا ثبت‌نام"
- tapOn:
    id: "login-phone"
- inputText: "09120000001"
- tapOn:
    id: "login-request-code"
- assertVisible: "کد تأیید"
- copyTextFrom:
    id: "login-test-code"
- tapOn:
    id: "login-code"
- inputText: ${maestro.copiedText}
- tapOn:
    id: "login-submit"
- assertVisible: "گفتگوها"
- tapOn: "E2E Group"
- assertVisible: "E2E Group"
- tapOn:
    id: "composer-input"
- inputText: "hello from maestro"
- tapOn:
    id: "composer-send"
- assertVisible: "hello from maestro"
- longPressOn: "hello from maestro"
- assertVisible: "👍"
- tapOn:
    id: "reaction-option-👍"
- assertVisible:
    id: "reaction-chip-👍"
- takeScreenshot: "e2e-chat-after-reaction"
```

- [ ] **Step 3: Validate the files**

Run:

```bash
node --check backend/test/mobile-e2e-seed.mjs
node -e "const fs=require('fs');const y=fs.readFileSync('mobile/.maestro/auth-and-chat.yaml','utf8');if(!y.includes('appId: com.openbridge.mobile'))process.exit(1);console.log('flow header ok')"
```

Expected: both commands exit 0. A YAML parser pass happens in Task 7 with the workflow files.

- [ ] **Step 4: Commit**

```bash
git add backend/test/mobile-e2e-seed.mjs mobile/.maestro/auth-and-chat.yaml
git commit -m "Add the Android E2E flow and its CI-only fixture"
```

---

### Task 6: CI jobs, trigger rules, and the gate

**Files:**
- Modify: `.github/workflows/ci.yml`

**Interfaces:**
- Consumes: the `test:ci` script (Task 1), the seed script and flow (Task 5), the release APK path `mobile/android/app/build/outputs/apk/release/app-release.apk`.
- Produces: `changes` output `mobile`, the `mobile-tests` and `mobile-e2e` jobs, and a gate that accepts only the expected skip.

- [ ] **Step 1: Add change detection and the trigger rules**

At the top of `.github/workflows/ci.yml`, add `schedule` and `workflow_dispatch`, and make cancellation PR-only:

```yaml
on:
  push:
    branches: [main]
  pull_request:
  schedule:
    - cron: '17 3 * * *'
  workflow_dispatch:

# A new push to the same branch replaces a PR run; a main run is not killed
# mid-flight because the emulator job is long.
concurrency:
  group: ci-${{ github.ref }}
  cancel-in-progress: ${{ github.event_name == 'pull_request' }}
```

Add the detection job before `web-lint`:

```yaml
  changes:
    name: '0 · Change detection'
    runs-on: ubuntu-latest
    timeout-minutes: 5
    outputs:
      mobile: ${{ steps.detect.outputs.mobile }}
    steps:
      - uses: actions/checkout@v4
        with:
          fetch-depth: 0
      - id: detect
        env:
          EVENT: ${{ github.event_name }}
          BASE_REF: ${{ github.base_ref }}
        run: |
          if [ "$EVENT" != "pull_request" ]; then
            echo "mobile=true" >> "$GITHUB_OUTPUT"
            exit 0
          fi
          git fetch --no-tags origin "$BASE_REF" --depth=1
          if git diff --name-only "origin/$BASE_REF...HEAD" | grep -Eq '^(mobile/|shared/e2ee/|\.github/workflows/ci\.yml)'; then
            echo "mobile=true" >> "$GITHUB_OUTPUT"
          else
            echo "mobile=false" >> "$GITHUB_OUTPUT"
          fi
```

- [ ] **Step 2: Add the fast mobile test job**

After `e2ee-gate`:

```yaml
  mobile-tests:
    name: '2d · Mobile unit tests (Jest + RNTL)'
    runs-on: ubuntu-latest
    timeout-minutes: 15
    defaults:
      run:
        working-directory: mobile
    steps:
      - uses: actions/checkout@v4
      - uses: actions/setup-node@v4
        with:
          node-version: ${{ env.NODE_VERSION }}
          cache: npm
          cache-dependency-path: mobile/package-lock.json
      - run: npm ci
      - run: npm run test:ci
```

- [ ] **Step 3: Add the emulator job**

After `mobile-bundle`:

```yaml
  mobile-e2e:
    name: '2e · Mobile E2E (Android emulator)'
    runs-on: ubuntu-latest
    timeout-minutes: 60
    needs: [changes, mobile-tests]
    if: needs.changes.outputs.mobile == 'true'
    services:
      postgres:
        image: postgres:16-alpine
        env:
          POSTGRES_USER: openbridge
          POSTGRES_PASSWORD: openbridge
          POSTGRES_DB: openbridge
        ports:
          - 5432:5432
        options: >-
          --health-cmd "pg_isready -U openbridge"
          --health-interval 5s
          --health-timeout 5s
          --health-retries 10
    env:
      DATABASE_URL: postgresql://openbridge:openbridge@localhost:5432/openbridge
      JWT_SECRET: ci-only-secret-at-least-32-characters-long-0000
      NODE_ENV: test
      PORT: '3000'
      EXPO_PUBLIC_API_URL: http://10.0.2.2:3000/api
      EXPO_NO_TELEMETRY: '1'
      CI: true
    steps:
      - uses: actions/checkout@v4

      - uses: actions/setup-node@v4
        with:
          node-version: ${{ env.NODE_VERSION }}
          cache: npm
          cache-dependency-path: backend/package-lock.json
      - uses: actions/setup-java@v4
        with:
          distribution: temurin
          java-version: '17'

      - name: Install and build the backend
        working-directory: backend
        run: |
          npm ci
          npx prisma generate
          npx prisma db push --skip-generate
          npm run build

      - name: Start the backend
        working-directory: backend
        run: |
          node dist/main > /tmp/openbridge-api.log 2>&1 &
          echo $! > /tmp/openbridge-api.pid

      - name: Wait for the API
        run: |
          for i in $(seq 1 60); do
            if curl -fsS http://127.0.0.1:3000/api/health; then exit 0; fi
            sleep 1
          done
          cat /tmp/openbridge-api.log
          exit 1

      - name: Seed the E2E users and group
        working-directory: backend
        run: node test/mobile-e2e-seed.mjs

      - uses: actions/setup-node@v4
        with:
          node-version: ${{ env.NODE_VERSION }}
          cache: npm
          cache-dependency-path: mobile/package-lock.json

      - name: Install mobile dependencies
        working-directory: mobile
        run: npm ci

      - name: Generate the Android project
        working-directory: mobile
        run: npx expo prebuild --platform android --no-install

      - name: Point the generated manifest at the local HTTP API
        run: |
          node -e "const fs=require('fs');const p='mobile/android/app/src/main/AndroidManifest.xml';let s=fs.readFileSync(p,'utf8');if(!s.includes('usesCleartextTraffic')){s=s.replace('<application ','<application android:usesCleartextTraffic=\"true\" ');fs.writeFileSync(p,s)}"

      - uses: actions/cache@v4
        with:
          path: |
            ~/.gradle/caches
            ~/.gradle/wrapper
          key: gradle-${{ runner.os }}-${{ hashFiles('mobile/package-lock.json') }}
          restore-keys: gradle-${{ runner.os }}-

      - name: Build the release APK
        working-directory: mobile/android
        run: ./gradlew assembleRelease --no-daemon -x lint -x test

      - name: Enable KVM
        run: |
          echo 'KERNEL=="kvm", GROUP="kvm", MODE="0666", OPTIONS+="static_node=kvm"' | sudo tee /etc/udev/rules.d/99-kvm4all.rules
          sudo udevadm control --reload-rules
          sudo udevadm trigger --name-match=kvm

      - name: Install Maestro 2.11.0
        run: |
          curl -fsSL -o /tmp/maestro.zip https://github.com/mobile-dev-inc/maestro/releases/download/cli-2.11.0/maestro.zip
          unzip -q /tmp/maestro.zip -d "$HOME"
          echo "$HOME/maestro/bin" >> "$GITHUB_PATH"

      - name: Run Maestro on the emulator
        uses: ReactiveCircus/android-emulator-runner@v2
        with:
          api-level: 34
          target: google_apis
          arch: x86_64
          profile: pixel_6
          disable-animations: true
          script: |
            adb install -r mobile/android/app/build/outputs/apk/release/app-release.apk
            adb logcat -c
            set +e
            maestro test --format junit --output "$RUNNER_TEMP/maestro-report.xml" mobile/.maestro
            status=$?
            if [ $status -ne 0 ]; then
              echo "First Maestro attempt failed; retrying once"
              maestro test --format junit --output "$RUNNER_TEMP/maestro-report.xml" mobile/.maestro
              status=$?
            fi
            adb logcat -d > "$RUNNER_TEMP/logcat.txt"
            exit $status

      - name: Upload the E2E report and screenshots
        if: always()
        uses: actions/upload-artifact@v4
        with:
          name: mobile-e2e-artifacts
          path: |
            ${{ runner.temp }}/maestro-report.xml
            ${{ runner.temp }}/logcat.txt
            /home/runner/.maestro/tests
            mobile/.maestro/**/*.png
          if-no-files-found: ignore
          retention-days: 7
```

- [ ] **Step 4: Extend the gate**

Replace the `ci-gate` `needs` list and summary logic:

```yaml
  ci-gate:
    name: 'CI gate'
    runs-on: ubuntu-latest
    timeout-minutes: 5
    needs: [changes, web-lint, backend-check, backend-e2e, e2ee-gate, mobile-tests, mobile-e2e, web-build, mobile-bundle, deploy-dry-run]
    if: always()
    steps:
      - name: Summarise
        run: |
          echo "mobile-tests: ${{ needs.mobile-tests.result }}"
          echo "mobile-e2e:   ${{ needs.mobile-e2e.result }} (mobile=${{ needs.changes.outputs.mobile }})"
          [ "${{ needs.changes.result }}" = "success" ] || exit 1
          [ "${{ needs.web-lint.result }}" = "success" ] || exit 1
          [ "${{ needs.backend-check.result }}" = "success" ] || exit 1
          [ "${{ needs.backend-e2e.result }}" = "success" ] || exit 1
          [ "${{ needs.e2ee-gate.result }}" = "success" ] || exit 1
          [ "${{ needs.mobile-tests.result }}" = "success" ] || exit 1
          [ "${{ needs.web-build.result }}" = "success" ] || exit 1
          [ "${{ needs.mobile-bundle.result }}" = "success" ] || exit 1
          [ "${{ needs.deploy-dry-run.result }}" = "success" ] || exit 1
          # The emulator is skipped only when change detection says this is a
          # web-only PR. A skip on main, or with mobile=true, is a failure.
          if [ "${{ needs.mobile-e2e.result }}" = "success" ]; then
            exit 0
          fi
          if [ "${{ needs.mobile-e2e.result }}" = "skipped" ] && [ "${{ needs.changes.outputs.mobile }}" != "true" ]; then
            echo "mobile-e2e skipped: no mobile/shared changes in this PR."
            exit 0
          fi
          echo "::error::mobile-e2e result=${{ needs.mobile-e2e.result }} mobile=${{ needs.changes.outputs.mobile }}"
          exit 1
```

- [ ] **Step 5: Validate the workflow**

Run:

```bash
python -c "import yaml; yaml.safe_load(open('.github/workflows/ci.yml')); print('ci.yml ok')"
git diff --check
```

If PyYAML is unavailable, run `npx --yes yaml-lint .github/workflows/ci.yml` is not a real package; instead use the parse check recorded in Task 7.

- [ ] **Step 6: Commit**

```bash
git add .github/workflows/ci.yml
git commit -m "Run mobile tests and a real emulator E2E in CI"
```

---

### Task 7: Docs, version, and changelog

**Files:**
- Modify: `README.md`
- Modify: `DEPLOY.md`
- Modify: `CHANGELOG.md`
- Modify: `package.json`
- Modify: `package-lock.json`
- Modify: `backend/package.json`
- Modify: `backend/package-lock.json`
- Modify: `mobile/package.json`
- Modify: `mobile/package-lock.json`
- Modify: `mobile/app.json`

**Interfaces:**
- Consumes: the actual job names from Task 6 (`changes`, `mobile-tests`, `mobile-e2e`, `ci-gate`) and the observed CI state (CI green on `0c5ce48`, Deploy skipped).
- Produces: documentation that no longer claims manual mobile QA or an unrun CI, and one product version `1.1.11`.

- [ ] **Step 1: Update the README test and CI sections**

Replace the paragraph containing `mobile has no automated test suite — screen QA is manual.` with:

```markdown
Mobile has two automated layers:

```bash
cd mobile && npm test          # Jest + React Native Testing Library
cd mobile && npm run test:ci   # the CI invocation
```

The unit/component suite covers phone normalization, the login and sign-up
steps, the chat list (search, empty, error), and the chat surface (sides,
sending, reactions). The on-device layer is a Maestro flow
(`mobile/.maestro/auth-and-chat.yaml`) that runs against a real API-34 Android
emulator in CI: it signs in with the CI-only seeded user, sends a message in
`E2E Group`, and adds a reaction. Fixtures come from
`backend/test/mobile-e2e-seed.mjs` and exist only in the disposable CI
database. A local run needs an emulator, a backend, and the seed script; CI is
the supported path.
```

In the CI table, add these rows before the gate row:

```markdown
| 0 · detect | `changes` | Path detection for PRs; main/schedule/manual always run the mobile E2E |
| 2 · tests | `mobile-tests` | Jest + RNTL mobile behavior suite |
| 2 · tests | `mobile-e2e` | Maestro on an API-34 emulator against a real PostgreSQL + NestJS backend (main, mobile PRs, nightly) |
```

Keep `ci-gate` as the single required check.

In the CD paragraph, add:

```markdown
Observed state (2026-10-21): CI runs on GitHub Actions and is green, including
the Docker compose smoke stage. `Deploy` is `skipped` because
`vars.DEPLOY_ENABLED` is not `true`; it stays inert until the SSH secrets
exist. No production deployment has been performed.
```

- [ ] **Step 2: Correct the DEPLOY.md status note**

Replace the paragraph beginning `توجه: این پایپ‌لاین هنوز روی GitHub Actions اجرا نشده` with:

```markdown
وضعیت مشاهده‌شده (۲۰۲۶-۱۰-۲۱): CI روی GitHub Actions اجرا شده و سبز است —
شامل مرحلهٔ ساخت ایمیج‌های Docker و smoke test همان compose. ولی `deploy.yml`
همیشه `skipped` است چون `DEPLOY_ENABLED` روی `true` نیست و سکرت‌های SSH وجود
ندارند. پس تا وقتی سرور و سکرت‌ها آماده نشوند، هیچ دیپلوی Production انجام
نمی‌شود. تنها بخشی که هنوز روی VPS واقعی آزمایش نشده، همان redeploy/rollback
اسکریپت است؛ مسیر Docker/compose/nginx/socket در `deploy-dry-run` واقعاً اجرا
می‌شود.
```

- [ ] **Step 3: Bump the four manifests**

Set `"version": "1.1.11"` in `package.json`, `backend/package.json`, and
`mobile/package.json`; set `expo.version` to `1.1.11` in `mobile/app.json`.

Then sync the lockfile version fields:

```bash
npm install --package-lock-only --ignore-scripts
cd backend && npm install --package-lock-only --ignore-scripts
cd ../mobile && npm install --package-lock-only --ignore-scripts
```

- [ ] **Step 4: Add the changelog entry**

Prepend to `CHANGELOG.md`:

```markdown
## [1.1.11] - 2026-10-21

### Added
- **Automated mobile QA.** `cd mobile && npm test` runs Jest + React Native
  Testing Library over the phone/time helpers, the login and sign-up steps, the
  chat list (search, empty, error), and the chat surface (message sides, send
  failure, long-press reactions, disconnected composer).
- **A real on-device smoke flow.** Maestro drives an API-34 Android emulator in
  CI: it signs in with a CI-only seeded account, opens `E2E Group`, sends
  `hello from maestro`, and adds a 👍 reaction. The seed
  (`backend/test/mobile-e2e-seed.mjs`) exists only in the disposable CI
  database.
- **CI jobs** `mobile-tests` and `mobile-e2e`, a `changes` detector, and a
  nightly schedule. The emulator runs on `main`, on PRs touching `mobile/` or
  `shared/e2ee/`, nightly, and manually.

### Changed
- `ci-gate` accepts the emulator job's `skipped` only when change detection says
  a PR has no mobile/shared changes; a skip or failure on `main` fails the gate.
- Main-branch CI runs are no longer cancelled by a newer push; PR runs still
  are.

### Docs
- README and DEPLOY now state the observed pipeline status: CI is green on
  GitHub Actions, `Deploy` is skipped until `DEPLOY_ENABLED` and SSH secrets
  exist, and no production deployment has been performed. The claim that mobile
  QA is manual is removed.

### Tests
- Local: `cd mobile && npm run test:ci` (3 suites, 20 tests), `npm run lint`,
  `npm run test:e2ee`, and `cd mobile && npx expo export --platform android`.
- The emulator E2E is verified by the GitHub Actions run; the first real run is
  recorded after it completes.
```

- [ ] **Step 5: Verify docs and version consistency**

Run:

```bash
node -e "const p=require('./package.json'),b=require('./backend/package.json'),m=require('./mobile/package.json'),a=require('./mobile/app.json');if([p.version,b.version,m.version,a.expo.version].some(v=>v!=='1.1.11'))process.exit(1);console.log('versions ok')"
```

- [ ] **Step 6: Commit**

```bash
git add README.md DEPLOY.md CHANGELOG.md package.json package-lock.json backend/package.json backend/package-lock.json mobile/package.json mobile/package-lock.json mobile/app.json
git commit -m "Document the mobile QA pipeline and release 1.1.11"
```

---

### Task 8: Full local verification, push, and the real Actions run

**Files:** no new files (unless a failure needs a fix).

**Interfaces:**
- Consumes: everything above.
- Produces: a pushed commit whose real GitHub Actions run is observed and reported.

- [ ] **Step 1: Run the full local checks**

```bash
cd mobile && npm run test:ci
cd .. && npm run lint
npm run test:e2ee
cd mobile && npx expo export --platform android --output-dir dist-ci
```

Expected: the mobile suite is green, web ESLint is clean, the E2EE gate passes,
and the Expo Android export exits 0.

- [ ] **Step 2: Check the tree before committing anything else**

```bash
git status --short
```

Confirm that the existing E2EE/upload work is still unstaged and only the paths
from this plan are in the new commits.

- [ ] **Step 3: Push**

```bash
git push origin main
```

- [ ] **Step 4: Watch the real run**

Poll the public API until the CI run for the pushed SHA completes:

```bash
SHA=$(git rev-parse HEAD)
for i in $(seq 1 80); do
  RUN=$(curl -fsS "https://api.github.com/repos/hoseinrza/OpenBridge/actions/runs?per_page=20" | node -e "let s='';process.stdin.on('data',d=>s+=d).on('end',()=>{const j=JSON.parse(s);const r=j.workflow_runs.find(x=>x.head_sha===process.argv[1]&&x.name==='CI');if(r)console.log(r.id+' '+r.status+' '+r.conclusion)})" "$SHA")
  echo "$RUN"
  case "$RUN" in *" completed success") break;; *" completed failure"*|*" completed cancelled"*) break;; esac
  sleep 30
done
curl -fsS "https://api.github.com/repos/hoseinrza/OpenBridge/actions/runs/<RUN_ID>/jobs" | node -e "let s='';process.stdin.on('data',d=>s+=d).on('end',()=>{for(const j of JSON.parse(s).jobs)console.log(j.name+': '+j.conclusion)})"
```

Expected: `changes`, `web-lint`, `backend-check`, `backend-e2e`, `e2ee-gate`,
`mobile-tests`, `web-build`, `mobile-bundle`, and `mobile-e2e` are `success`;
`ci-gate` is `success`; the `Deploy` workflow is `skipped`.

- [ ] **Step 5: Fix and repeat if the emulator job fails**

The jobs API exposes per-step conclusions. Use the failing step to drive a
local fix (most likely candidates: release signing, the cleartext patch, or
Maestro selector syntax), commit, push, and repeat Step 4. Do not call the
pipeline green until the job list shows `mobile-e2e: success`.

- [ ] **Step 6: Record the first real E2E run**

After the run is green, append one line to the `### Tests` section of the
changelog entry:

```markdown
- GitHub Actions run <RUN_ID> (2026-10-21): `mobile-tests` and `mobile-e2e`
  green; `ci-gate` green; `Deploy` skipped.
```

Commit and push; the follow-up run is docs-only, but `main` pushes still run
the E2E by design.

```bash
git add CHANGELOG.md
git commit -m "Record the first real mobile E2E run"
git push origin main
```

- [ ] **Step 7: Final status report**

Report:

- the local commands that passed and their observed output;
- the GitHub Actions run id, the job conclusions, and the Deploy status;
- that no production deployment happened and what is still required for one;
- any known limits (first-run Gradle duration, emulator flakiness, iOS
  untested).
