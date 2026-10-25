import { render, fireEvent, waitFor, act } from '@testing-library/react-native';
import { Alert } from 'react-native';
import AsyncStorage from '@react-native-async-storage/async-storage';
import SettingsScreen from '../src/screens/SettingsScreen';
import { SettingsProvider } from '../src/context/SettingsContext';

const mockLogout = jest.fn();
const mockAccount = { id: 'me', name: 'من', username: 'me', avatar: null };
let mockCurrentUser = mockAccount;

jest.mock('../src/context/AuthContext', () => ({
  useAuth: () => ({
    currentUser: mockCurrentUser,
    logout: mockLogout,
  }),
}));

beforeEach(async () => {
  jest.clearAllMocks();
  mockCurrentUser = mockAccount;
  await AsyncStorage.clear();
});

async function renderScreen() {
  const view = render(
    <SettingsProvider>
      <SettingsScreen />
    </SettingsProvider>,
  );
  // The provider reads the stored mode on mount; settle it inside act.
  await act(async () => { await Promise.resolve(); });
  return view;
}

test('shows the account facts and the three theme choices', async () => {
  const view = await renderScreen();
  expect(view.getByText('من')).toBeTruthy();
  expect(view.getByText('@me')).toBeTruthy();
  expect(view.getByText('همراه سیستم')).toBeTruthy();
  expect(view.getByText('روشن')).toBeTruthy();
  expect(view.getByText('تیره')).toBeTruthy();
});

test('picking a theme saves it for the next launch', async () => {
  const view = await renderScreen();
  fireEvent.press(view.getByLabelText('تیره'));
  await waitFor(async () => {
    expect(await AsyncStorage.getItem('openbridge_theme_mode')).toBe('dark');
  });
});

test('the theme choices are one radio group and the picked one is checked', async () => {
  const view = await renderScreen();

  expect(view.getByLabelText('حالت نمایش').props.accessibilityRole).toBe('radiogroup');

  const darkChoice = view.getByLabelText('تیره');
  expect(darkChoice.props.accessibilityRole).toBe('radio');
  expect(darkChoice.props.accessibilityState).toEqual({ checked: false });

  fireEvent.press(darkChoice);
  await waitFor(() => {
    expect(view.getByLabelText('تیره').props.accessibilityState).toEqual({ checked: true });
  });
  expect(view.getByLabelText('همراه سیستم').props.accessibilityState).toEqual({ checked: false });
});

test('logout asks for confirmation before signing out', async () => {
  const alertSpy = jest.spyOn(Alert, 'alert').mockImplementation(() => {});
  const view = await renderScreen();

  fireEvent.press(view.getByLabelText('خروج از حساب'));
  expect(alertSpy).toHaveBeenCalled();

  const buttons = alertSpy.mock.calls[0][2];
  await buttons[1].onPress();
  expect(mockLogout).toHaveBeenCalled();

  alertSpy.mockRestore();
});

test('cancelling the logout confirmation keeps the session', async () => {
  const alertSpy = jest.spyOn(Alert, 'alert').mockImplementation(() => {});
  const view = await renderScreen();

  fireEvent.press(view.getByLabelText('خروج از حساب'));
  const [cancel] = alertSpy.mock.calls[0][2];
  expect(cancel.style).toBe('cancel');

  // The cancel action dismisses; it must never sign the user out.
  await cancel.onPress?.();
  expect(mockLogout).not.toHaveBeenCalled();

  alertSpy.mockRestore();
});

test('a blank username never reaches the screen as a bare @', async () => {
  mockCurrentUser = { ...mockAccount, username: '' };
  const view = await renderScreen();

  expect(view.getByText('من')).toBeTruthy();
  expect(view.queryByText(/^@/)).toBeNull();
});
