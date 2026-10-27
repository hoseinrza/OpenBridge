import { act, renderHook, waitFor } from '@testing-library/react-native';
import { useChat } from '../src/hooks/useChat';

const mockListeners = new Map();
const mockAckEmit = jest.fn((event, payload, done) => done(null, { ok: true, id: 'm9' }));
const mockSocket = {
  connected: true,
  on: jest.fn((event, handler) => { mockListeners.set(event, handler); }),
  off: jest.fn((event, handler) => {
    if (mockListeners.get(event) === handler) mockListeners.delete(event);
  }),
  emit: jest.fn(),
  timeout: jest.fn(() => ({ emit: mockAckEmit })),
};

jest.mock('../src/context/SocketContext', () => ({
  useSocket: () => ({ socket: mockSocket, connected: true }),
}));

const mockUploadFile = jest.fn();
const mockFetchMessages = jest.fn();
const mockFetchE2eeState = jest.fn(async () => ({ e2ee: false }));
jest.mock('../src/services/api', () => ({
  fetchMessages: (...args) => mockFetchMessages(...args),
  fetchGroupMessages: jest.fn(async () => []),
  resolveUrl: (value) => value,
  fetchE2eeState: (...args) => mockFetchE2eeState(...args),
  uploadFile: (...args) => mockUploadFile(...args),
}));

const peer = { id: 'p1', kind: 'direct', name: 'سارا' };
const me = { id: 'me', name: 'من' };

// What the pickers hand over: an image asset from expo-image-picker, filed the
// way the upload endpoint wants to receive it.
const photo = {
  uri: 'file:///mock/photo.jpg',
  name: 'holiday.jpg',
  size: 481000,
  mimeType: 'image/jpeg',
};

beforeEach(() => {
  jest.clearAllMocks();
  mockListeners.clear();
  mockFetchMessages.mockResolvedValue([]);
  mockFetchE2eeState.mockResolvedValue({ e2ee: false });
  mockUploadFile.mockResolvedValue({
    url: '/uploads/8f2c.jpg', name: 'holiday.jpg', size: 481000, type: 'IMAGE',
  });
});

test('a picked photo is uploaded and the message carries the type the server saw', async () => {
  const { result } = renderHook(() => useChat(peer, me, jest.fn()));
  await waitFor(() => expect(result.current.historyState).toBe('ready'));

  await act(async () => {
    const sent = await result.current.sendAttachment(photo);
    expect(sent.ok).toBe(true);
  });

  expect(mockUploadFile).toHaveBeenCalledWith({
    uri: 'file:///mock/photo.jpg',
    name: 'holiday.jpg',
    type: 'image/jpeg',
  });
  // The type is the server's answer, not the phone's guess: the web client sends
  // the same field and the shelf the row lands in is derived from it.
  expect(mockAckEmit).toHaveBeenCalledWith(
    'message:send',
    {
      toId: 'p1',
      type: 'IMAGE',
      fileUrl: '/uploads/8f2c.jpg',
      fileName: 'holiday.jpg',
      fileSize: 481000,
    },
    expect.any(Function),
  );
});

test('a picked document keeps the server FILE type instead of an image bubble', async () => {
  mockUploadFile.mockResolvedValue({
    url: '/uploads/report.pdf', name: 'report.pdf', size: 22016, type: 'FILE',
  });
  const { result } = renderHook(() => useChat(peer, me, jest.fn()));
  await waitFor(() => expect(result.current.historyState).toBe('ready'));

  await act(async () => {
    await result.current.sendAttachment({
      uri: 'file:///mock/report.pdf',
      name: 'report.pdf',
      size: 22016,
      mimeType: 'application/pdf',
    });
  });

  expect(mockUploadFile).toHaveBeenCalledWith({
    uri: 'file:///mock/report.pdf',
    name: 'report.pdf',
    type: 'application/pdf',
  });
  expect(mockAckEmit.mock.calls[0][1]).toMatchObject({
    type: 'FILE',
    fileUrl: '/uploads/report.pdf',
    fileName: 'report.pdf',
    fileSize: 22016,
  });
});

test('a group attachment is addressed to the conversation', async () => {
  const group = { id: 'g1', kind: 'group', name: 'تیم' };
  const { result } = renderHook(() => useChat(group, me, jest.fn()));
  await waitFor(() => expect(result.current.historyState).toBe('ready'));

  await act(async () => {
    await result.current.sendAttachment(photo);
  });

  expect(mockAckEmit.mock.calls[0][1]).toMatchObject({
    conversationId: 'g1',
    type: 'IMAGE',
    fileUrl: '/uploads/8f2c.jpg',
  });
});

test('quoting a message while attaching travels with it', async () => {
  const { result } = renderHook(() => useChat(peer, me, jest.fn()));
  await waitFor(() => expect(result.current.historyState).toBe('ready'));

  await act(async () => {
    await result.current.sendAttachment(photo, 'm2');
  });

  expect(mockAckEmit.mock.calls[0][1]).toMatchObject({
    toId: 'p1',
    fileUrl: '/uploads/8f2c.jpg',
    replyToId: 'm2',
  });
});

test('a file the server refuses is reported with its own words and nothing is sent', async () => {
  mockUploadFile.mockRejectedValue(new Error('نوع فایل مجاز نیست'));
  const { result } = renderHook(() => useChat(peer, me, jest.fn()));
  await waitFor(() => expect(result.current.historyState).toBe('ready'));

  let refused;
  await act(async () => {
    refused = await result.current.sendAttachment(photo);
  });

  expect(refused).toEqual({ ok: false, error: 'نوع فایل مجاز نیست' });
  expect(mockAckEmit).not.toHaveBeenCalled();
});

test('an encrypted chat refuses an attachment before any byte is uploaded', async () => {
  mockFetchE2eeState.mockResolvedValue({ e2ee: true });
  const { result } = renderHook(() => useChat(peer, me, jest.fn()));
  await waitFor(() => expect(result.current.locked).toBe(true));

  let refused;
  await act(async () => {
    refused = await result.current.sendAttachment(photo);
  });

  expect(refused).toEqual({
    ok: false,
    error: 'این گفتگو پیام‌های قدیمیِ رمزنگاری‌شده دارد؛ نوشتن در آن از این نسخه فعلاً ممکن نیست',
  });
  expect(mockUploadFile).not.toHaveBeenCalled();
  expect(mockAckEmit).not.toHaveBeenCalled();
});