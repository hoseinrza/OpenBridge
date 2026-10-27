import { render, fireEvent, waitFor, act } from '@testing-library/react-native';
import EditProfileScreen from '../src/screens/EditProfileScreen';
import { SettingsProvider } from '../src/context/SettingsContext';

const mockSaveProfile = jest.fn();
const mockGoBack = jest.fn();
const account = () => ({
  id: 'me', name: 'علی رضایی', username: 'ali', firstName: 'علی', lastName: 'رضایی',
  phone: '09121234567', avatar: null, bio: 'توسعه‌دهنده',
});
let mockCurrentUser = account();

jest.mock('../src/context/AuthContext', () => ({
  useAuth: () => ({ currentUser: mockCurrentUser, saveProfile: mockSaveProfile }),
}));

beforeEach(() => {
  jest.clearAllMocks();
  mockCurrentUser = account();
  mockSaveProfile.mockResolvedValue({ ...mockCurrentUser, displayName: 'علی رضایی' });
});

async function renderScreen() {
  const view = render(
    <SettingsProvider>
      <EditProfileScreen navigation={{ goBack: mockGoBack }} />
    </SettingsProvider>,
  );
  // The provider reads the stored theme on mount; settle it inside act.
  await act(async () => { await Promise.resolve(); });
  return view;
}

const field = (view, label) => view.getByLabelText(label);
const save = (view) => fireEvent.press(view.getByLabelText('ذخیره تغییرات پروفایل'));

test('the form opens on the account a user already has', async () => {
  const view = await renderScreen();

  expect(field(view, 'نام').props.value).toBe('علی');
  expect(field(view, 'نام خانوادگی، اختیاری').props.value).toBe('رضایی');
  expect(field(view, 'نام کاربری').props.value).toBe('ali');
  expect(field(view, 'بیوگرافی، اختیاری').props.value).toBe('توسعه‌دهنده');
  // The number is identity, so it is shown as a fact rather than an input.
  expect(view.getByText('09121234567')).toBeTruthy();
  expect(view.queryByDisplayValue('09121234567')).toBeNull();
});

test('an account predating the name split opens with its display name divided', async () => {
  mockCurrentUser = { ...account(), firstName: null, lastName: null, name: 'مریم کوهی نور' };
  const view = await renderScreen();

  expect(field(view, 'نام').props.value).toBe('مریم');
  expect(field(view, 'نام خانوادگی، اختیاری').props.value).toBe('کوهی نور');
});

test('saving sends the profile fields and never re-sends an unchanged username', async () => {
  const view = await renderScreen();
  fireEvent.changeText(field(view, 'بیوگرافی، اختیاری'), 'مهندس نرم‌افزار');

  save(view);
  await waitFor(() => {
    expect(mockSaveProfile).toHaveBeenCalledWith({
      firstName: 'علی',
      lastName: 'رضایی',
      bio: 'مهندس نرم‌افزار',
    });
  });
  expect(mockGoBack).toHaveBeenCalled();
});

test('a changed username travels with the rest of the profile', async () => {
  const view = await renderScreen();
  fireEvent.changeText(field(view, 'نام کاربری'), 'alir2');

  save(view);
  await waitFor(() => {
    expect(mockSaveProfile).toHaveBeenCalledWith(expect.objectContaining({ username: 'alir2' }));
  });
});

test('a legacy account keeps an unusable handle it did not touch', async () => {
  // The handle rule arrived after this account was made, so the stored value
  // would fail it; leaving the field alone must not block editing the name.
  mockCurrentUser = { ...account(), username: 'کاربر1' };
  const view = await renderScreen();
  fireEvent.changeText(field(view, 'نام'), 'زهرا');

  save(view);
  await waitFor(() => {
    expect(mockSaveProfile).toHaveBeenCalledWith(expect.objectContaining({ firstName: 'زهرا' }));
  });
  expect(mockSaveProfile.mock.calls[0][0]).not.toHaveProperty('username');
});

test('the preview follows the name being typed', async () => {
  const view = await renderScreen();
  fireEvent.changeText(field(view, 'نام خانوادگی، اختیاری'), 'اصفهانی');

  expect(view.getByText('علی اصفهانی')).toBeTruthy();
});

test('a one-letter name is refused before anything reaches the server', async () => {
  const view = await renderScreen();
  fireEvent.changeText(field(view, 'نام'), 'ا');

  save(view);
  await waitFor(() => {
    expect(view.getByText(/نام باید حداقل/)).toBeTruthy();
  });
  expect(mockSaveProfile).not.toHaveBeenCalled();
  expect(mockGoBack).not.toHaveBeenCalled();
});

test('a username with a character the server rejects is refused too', async () => {
  const view = await renderScreen();
  fireEvent.changeText(field(view, 'نام کاربری'), 'ali-2');

  save(view);
  await waitFor(() => {
    expect(view.getByText(/نام کاربری باید/)).toBeTruthy();
  });
  expect(mockSaveProfile).not.toHaveBeenCalled();
});

test('a refused save surfaces the server reason and stays open', async () => {
  mockSaveProfile.mockRejectedValue(Object.assign(new Error('این نام کاربری گرفته شده است'), { status: 409 }));
  const view = await renderScreen();

  save(view);
  await waitFor(() => {
    expect(view.getByText('این نام کاربری گرفته شده است')).toBeTruthy();
  });
  expect(mockGoBack).not.toHaveBeenCalled();
});

test('cancelling leaves the profile untouched', async () => {
  const view = await renderScreen();
  fireEvent.changeText(field(view, 'نام'), 'بی‌نام');

  fireEvent.press(view.getByLabelText('انصراف از ویرایش'));
  expect(mockSaveProfile).not.toHaveBeenCalled();
  expect(mockGoBack).toHaveBeenCalled();
});

test('the bio stops at the length the server allows', async () => {
  const view = await renderScreen();
  expect(field(view, 'بیوگرافی، اختیاری').props.maxLength).toBe(150);
});
