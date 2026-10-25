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
