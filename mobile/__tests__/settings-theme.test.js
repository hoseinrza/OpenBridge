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
