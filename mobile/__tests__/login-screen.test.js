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
