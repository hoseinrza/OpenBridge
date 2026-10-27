import { act, render, fireEvent, waitFor } from '@testing-library/react-native';
import ChatScreen from '../src/screens/ChatScreen';
import { useChat } from '../src/hooks/useChat';
import * as ImagePicker from 'expo-image-picker';
import * as DocumentPicker from 'expo-document-picker';

jest.mock('../src/hooks/useChat', () => ({ useChat: jest.fn() }));

jest.mock('../src/context/AuthContext', () => ({
  useAuth: () => ({ currentUser: { id: 'me', name: 'من' } }),
}));

jest.mock('expo-image-picker', () => ({
  requestMediaLibraryPermissionsAsync: jest.fn(),
  launchImageLibraryAsync: jest.fn(),
}));

jest.mock('expo-document-picker', () => ({
  getDocumentAsync: jest.fn(),
}));

const peer = { id: 'p1', kind: 'direct', name: 'سارا' };

function makeChat(overrides = {}) {
  const chat = {
    messages: [],
    isTyping: false,
    typingName: '',
    connected: true,
    locked: false,
    historyState: 'ready',
    historyError: '',
    retryHistory: jest.fn(),
    sendMessage: jest.fn(async () => ({ ok: true })),
    sendVoice: jest.fn(async () => ({ ok: true })),
    sendAttachment: jest.fn(async () => ({ ok: true })),
    notifyTyping: jest.fn(),
    toggleReaction: jest.fn(() => true),
    editMessage: jest.fn(async () => ({ ok: true })),
    deleteMessage: jest.fn(async () => ({ ok: true })),
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
  ImagePicker.requestMediaLibraryPermissionsAsync.mockResolvedValue({ granted: true });
  ImagePicker.launchImageLibraryAsync.mockResolvedValue({
    canceled: false,
    assets: [{
      uri: 'file:///mock/photo-1.jpg',
      fileName: 'photo-1.jpg',
      fileSize: 30211,
      mimeType: 'image/jpeg',
      type: 'image',
      width: 1200,
      height: 800,
    }],
  });
  DocumentPicker.getDocumentAsync.mockResolvedValue({
    canceled: false,
    assets: [{
      uri: 'file:///mock/report.pdf',
      name: 'report.pdf',
      size: 9100,
      fileSize: 9100,
      type: 'application/pdf',
      mimeType: 'application/pdf',
    }],
  });
});

test('the composer offers an attach control that opens a two-item tray', () => {
  makeChat();
  const view = renderChat();
  expect(view.queryByLabelText('انتخاب تصویر')).toBeNull();

  fireEvent.press(view.getByLabelText('پیوست'));
  expect(view.getByLabelText('انتخاب تصویر')).toBeTruthy();
  expect(view.getByLabelText('انتخاب فایل')).toBeTruthy();
});

test('the tray closes when the attach control is tapped again', () => {
  makeChat();
  const view = renderChat();
  fireEvent.press(view.getByLabelText('پیوست'));
  fireEvent.press(view.getByLabelText('پیوست'));
  expect(view.queryByLabelText('انتخاب تصویر')).toBeNull();
});

test('a locked chat does not offer an attachment at all', () => {
  makeChat({ locked: true });
  const view = renderChat();
  expect(view.queryByLabelText('پیوست')).toBeNull();
});

test('picking an image asks for library access and sends the asset the picker returned', async () => {
  const chat = makeChat();
  const view = renderChat();
  fireEvent.press(view.getByLabelText('پیوست'));
  fireEvent.press(view.getByLabelText('انتخاب تصویر'));

  await waitFor(() => expect(chat.sendAttachment).toHaveBeenCalled());
  expect(ImagePicker.requestMediaLibraryPermissionsAsync).toHaveBeenCalled();
  expect(ImagePicker.launchImageLibraryAsync).toHaveBeenCalledWith(
    expect.objectContaining({ mediaTypes: ['images'] }),
  );
  // A plain attachment is a one-argument call: the quote travels only when the
  // user actually quoted something, exactly as a text message does.
  expect(chat.sendAttachment).toHaveBeenCalledWith({
    uri: 'file:///mock/photo-1.jpg',
    name: 'photo-1.jpg',
    size: 30211,
    mimeType: 'image/jpeg',
  });
  await waitFor(() => expect(view.queryByLabelText('انتخاب تصویر')).toBeNull());
});

test('a refused photo permission says so instead of opening the library', async () => {
  ImagePicker.requestMediaLibraryPermissionsAsync.mockResolvedValue({ granted: false });
  const chat = makeChat();
  const view = renderChat();
  fireEvent.press(view.getByLabelText('پیوست'));
  fireEvent.press(view.getByLabelText('انتخاب تصویر'));

  await waitFor(() => expect(view.getByText(/اجازهٔ دسترسی به گالری/)).toBeTruthy());
  expect(ImagePicker.launchImageLibraryAsync).not.toHaveBeenCalled();
  expect(chat.sendAttachment).not.toHaveBeenCalled();
});

test('a document goes through the file picker without asking any permission', async () => {
  const chat = makeChat();
  const view = renderChat();
  fireEvent.press(view.getByLabelText('پیوست'));
  fireEvent.press(view.getByLabelText('انتخاب فایل'));

  await waitFor(() => expect(chat.sendAttachment).toHaveBeenCalled());
  expect(ImagePicker.requestMediaLibraryPermissionsAsync).not.toHaveBeenCalled();
  expect(chat.sendAttachment).toHaveBeenCalledWith({
    uri: 'file:///mock/report.pdf',
    name: 'report.pdf',
    size: 9100,
    mimeType: 'application/pdf',
  });
});

test('a photo asset that carries no mimetype is filed under its extension', async () => {
  ImagePicker.launchImageLibraryAsync.mockResolvedValue({
    canceled: false,
    assets: [{
      uri: 'file:///mock/shot.png', fileName: 'shot.png', fileSize: 120, type: 'image',
    }],
  });
  const chat = makeChat();
  const view = renderChat();
  fireEvent.press(view.getByLabelText('پیوست'));
  fireEvent.press(view.getByLabelText('انتخاب تصویر'));

  await waitFor(() => expect(chat.sendAttachment).toHaveBeenCalled());
  expect(chat.sendAttachment.mock.calls[0][0]).toMatchObject({
    name: 'shot.png',
    mimeType: 'image/png',
  });
});

test('a cancelled picker sends nothing', async () => {
  ImagePicker.launchImageLibraryAsync.mockResolvedValue({ canceled: true, assets: [] });
  const chat = makeChat();
  const view = renderChat();
  fireEvent.press(view.getByLabelText('پیوست'));
  fireEvent.press(view.getByLabelText('انتخاب تصویر'));

  await act(async () => { await new Promise((resolve) => { setTimeout(resolve, 0); }); });
  expect(chat.sendAttachment).not.toHaveBeenCalled();
  expect(view.queryByLabelText('انتخاب تصویر')).toBeNull();
});

test('an attachment the server refuses is shown in its own words', async () => {
  const chat = makeChat({
    sendAttachment: jest.fn(async () => ({ ok: false, error: 'نوع فایل مجاز نیست' })),
  });
  const view = renderChat();
  fireEvent.press(view.getByLabelText('پیوست'));
  fireEvent.press(view.getByLabelText('انتخاب فایل'));

  await waitFor(() => expect(view.getByText('نوع فایل مجاز نیست')).toBeTruthy());
});

test('an attachment quoted to a message carries that message id', async () => {
  const chat = makeChat({
    messages: [{
      id: 'm2', type: 'text', text: 'سلام از سارا', side: 'other', senderId: 'p1',
      sender: 'سارا', createdAt: 2, read: false, reactions: [],
    }],
  });
  const view = renderChat();
  fireEvent(view.getByTestId('bubble-other'), 'longPress');
  fireEvent.press(await view.findByLabelText('پاسخ به این پیام'));

  fireEvent.press(view.getByLabelText('پیوست'));
  fireEvent.press(view.getByLabelText('انتخاب تصویر'));

  await waitFor(() => expect(chat.sendAttachment).toHaveBeenCalled());
  expect(chat.sendAttachment.mock.calls[0][1]).toBe('m2');
});

test('the attach control rests while a file is uploading and wakes when it finishes', async () => {
  let release;
  const chat = makeChat({
    sendAttachment: jest.fn(() => new Promise((resolve) => { release = () => resolve({ ok: true }); })),
  });
  const view = renderChat();
  fireEvent.press(view.getByLabelText('پیوست'));
  fireEvent.press(view.getByLabelText('انتخاب فایل'));
  await waitFor(() => expect(chat.sendAttachment).toHaveBeenCalled());

  expect(view.getByTestId('composer-attach').props.accessibilityState.disabled).toBe(true);
  fireEvent.press(view.getByLabelText('پیوست'));
  expect(view.queryByLabelText('انتخاب تصویر')).toBeNull();

  await act(async () => { release(); });
  await waitFor(() => expect(view.getByTestId('composer-attach').props.accessibilityState.disabled).toBe(false));
});
