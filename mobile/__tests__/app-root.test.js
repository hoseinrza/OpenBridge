import { render, act } from '@testing-library/react-native';

// The emulator crashed on the first frame with `No safe area value available`,
// which no screen test could see: jest.setup mocks this module with a hook that
// returns zeros whether or not a provider exists. Here the mock keeps the
// library's actual rule - reading the insets without a provider throws - so the
// real app root is the thing under test. A global counter is used because a
// jest.mock factory may not close over anything from the outer module.

jest.mock('react-native-safe-area-context', () => {
  const React = require('react');
  const { View } = require('react-native');
  if (globalThis.__safeAreaProviders === undefined) globalThis.__safeAreaProviders = 0;
  return {
    SafeAreaProvider: ({ children }) => {
      globalThis.__safeAreaProviders += 1;
      return React.createElement(View, { testID: 'safe-area-provider' }, children);
    },
    useSafeAreaInsets: () => {
      if (!globalThis.__safeAreaProviders) {
        throw new Error('No safe area value available. Make sure you are rendering `<SafeAreaProvider>` at the top of your app.');
      }
      return { top: 0, right: 0, bottom: 0, left: 0 };
    },
  };
});

jest.mock('expo-font', () => ({ useFonts: () => [true, null] }));
jest.mock('expo-splash-screen', () => ({
  preventAutoHideAsync: () => Promise.resolve(),
  hideAsync: () => Promise.resolve(),
}));
// The address-book module subclasses a native object at import time, which no
// test environment provides. Nothing here exercises contacts.
jest.mock('expo-contacts', () => ({
  getPermissionsAsync: jest.fn(async () => ({ granted: false })),
  requestPermissionsAsync: jest.fn(async () => ({ granted: false })),
  Contact: { getAllDetails: jest.fn(async () => []) },
  ContactField: { FULL_NAME: 'name', GIVEN_NAME: 'givenName', FAMILY_NAME: 'familyName', PHONES: 'phones' },
}));

// The navigators are not the subject: a passthrough stack still mounts the
// screen the app would show, which is where the insets are read.
jest.mock('@react-navigation/native', () => ({
  NavigationContainer: ({ children }) => children,
}));

jest.mock('@react-navigation/native-stack', () => {
  const React = require('react');
  return {
    createNativeStackNavigator: () => ({
      Navigator: ({ children }) => children,
      Screen: ({ component: Component, route }) =>
        React.createElement(Component, { navigation: { navigate: jest.fn(), setOptions: jest.fn() }, route }),
    }),
  };
});

const App = require('../App').default;

beforeEach(() => {
  globalThis.__safeAreaProviders = 0;
});

test('the app root renders a safe-area provider above the screens', async () => {
  const view = render(<App />);
  // Auth and settings hydrate from storage one tick after mount.
  await act(async () => { await Promise.resolve(); await Promise.resolve(); });

  expect(view.queryByTestId('safe-area-provider')).toBeTruthy();
  // The first unauthenticated screen is what used to crash.
  expect(view.getByLabelText('شماره موبایل')).toBeTruthy();
});
