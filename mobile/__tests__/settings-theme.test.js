import { render, fireEvent, waitFor, act } from '@testing-library/react-native';
import { Pressable, Text } from 'react-native';
import * as ReactNative from 'react-native';
import AsyncStorage from '@react-native-async-storage/async-storage';
import { SettingsProvider, useSettings } from '../src/context/SettingsContext';
import { useAppTheme } from '../src/theme';

const KEY = 'openbridge_theme_mode';

function ThemeProbe() {
  const { scheme } = useAppTheme();
  return <Text testID="scheme">{scheme}</Text>;
}

function ReadyProbe() {
  const { ready } = useSettings();
  return <Text testID="ready">{ready ? 'ready' : 'pending'}</Text>;
}

function ModeButton({ mode }) {
  const { setThemeMode } = useSettings();
  return (
    <Pressable accessibilityRole="button" accessibilityLabel={mode} onPress={() => setThemeMode(mode)}>
      <Text>{mode}</Text>
    </Pressable>
  );
}

let schemeSpy;

beforeEach(async () => {
  await AsyncStorage.clear();
  // The Jest React Native environment reports no OS scheme at all, so
  // "a manual choice wins" would stay true even with the override logic
  // deleted. Pinning the phone to dark makes the override a real assertion.
  schemeSpy = jest.spyOn(ReactNative, 'useColorScheme').mockReturnValue('dark');
});

afterEach(() => {
  schemeSpy.mockRestore();
});

async function renderProbe() {
  const view = render(
    <SettingsProvider>
      <ThemeProbe />
      <ModeButton mode="system" />
      <ModeButton mode="light" />
      <ModeButton mode="dark" />
    </SettingsProvider>,
  );
  // Let the stored mode arrive inside act, so a hydration update never escapes
  // the test's act scope.
  await act(async () => { await Promise.resolve(); });
  return view;
}

test('the scheme follows the dark OS until the user picks a mode', async () => {
  const view = await renderProbe();
  expect(view.getByTestId('scheme').props.children).toBe('dark');
});

test('a manual mode overrides the OS scheme and persists', async () => {
  const view = await renderProbe();

  fireEvent.press(view.getByLabelText('light'));
  expect(view.getByTestId('scheme').props.children).toBe('light');
  await waitFor(async () => expect(await AsyncStorage.getItem(KEY)).toBe('light'));

  fireEvent.press(view.getByLabelText('dark'));
  expect(view.getByTestId('scheme').props.children).toBe('dark');
  await waitFor(async () => expect(await AsyncStorage.getItem(KEY)).toBe('dark'));
});

test('choosing system hands the scheme back to the OS', async () => {
  const view = await renderProbe();

  fireEvent.press(view.getByLabelText('light'));
  expect(view.getByTestId('scheme').props.children).toBe('light');

  fireEvent.press(view.getByLabelText('system'));
  // The OS is mocked dark, so following it again has to paint dark.
  expect(view.getByTestId('scheme').props.children).toBe('dark');
  await waitFor(async () => expect(await AsyncStorage.getItem(KEY)).toBe('system'));

  // ...and it keeps following: a new OS scheme reaches the app untouched.
  schemeSpy.mockReturnValue('light');
  await act(async () => {
    view.rerender(
      <SettingsProvider>
        <ThemeProbe />
        <ModeButton mode="system" />
        <ModeButton mode="light" />
        <ModeButton mode="dark" />
      </SettingsProvider>,
    );
  });
  expect(view.getByTestId('scheme').props.children).toBe('light');
});

test('a saved mode is applied on mount', async () => {
  await AsyncStorage.setItem(KEY, 'dark');

  const view = await renderProbe();

  expect(view.getByTestId('scheme').props.children).toBe('dark');
});

test('the provider is ready only after the stored mode has settled', async () => {
  await AsyncStorage.setItem(KEY, 'light');

  const view = render(
    <SettingsProvider>
      <ThemeProbe />
      <ReadyProbe />
    </SettingsProvider>,
  );

  // Nothing may paint here: this is the frame the splash screen covers.
  expect(view.getByTestId('ready').props.children).toBe('pending');

  await act(async () => { await Promise.resolve(); });

  expect(view.getByTestId('ready').props.children).toBe('ready');
  expect(view.getByTestId('scheme').props.children).toBe('light');
});

test('a failing storage read still marks the provider ready', async () => {
  const getItemSpy = jest.spyOn(AsyncStorage, 'getItem').mockRejectedValueOnce(new Error('no storage'));

  const view = render(
    <SettingsProvider>
      <ThemeProbe />
      <ReadyProbe />
    </SettingsProvider>,
  );

  await act(async () => { await Promise.resolve(); });

  expect(view.getByTestId('ready').props.children).toBe('ready');
  expect(view.getByTestId('scheme').props.children).toBe('dark');

  getItemSpy.mockRestore();
});
