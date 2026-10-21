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

const { configure } = require('@testing-library/react-native');
configure({ asyncUtilTimeout: 5000 });
