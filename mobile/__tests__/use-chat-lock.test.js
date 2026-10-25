import { act, renderHook, waitFor } from '@testing-library/react-native';
import { useChat } from '../src/hooks/useChat';

const mockListeners = new Map();
const mockSocket = {
  connected: true,
  on: jest.fn((event, handler) => { mockListeners.set(event, handler); }),
  off: jest.fn((event, handler) => {
    if (mockListeners.get(event) === handler) mockListeners.delete(event);
  }),
  emit: jest.fn(),
};

jest.mock('../src/context/SocketContext', () => ({
  useSocket: () => ({ socket: mockSocket, connected: true }),
}));

const mockFetchE2eeState = jest.fn();
jest.mock('../src/services/api', () => ({
  fetchMessages: jest.fn(async () => []),
  fetchGroupMessages: jest.fn(async () => []),
  resolveUrl: (value) => value,
  fetchE2eeState: (...args) => mockFetchE2eeState(...args),
}));

const peer = { id: 'p1', kind: 'direct', name: 'سارا' };
const me = { id: 'me', name: 'من' };

beforeEach(() => {
  jest.clearAllMocks();
  mockListeners.clear();
});

test('locks an open plaintext chat when its first encrypted envelope arrives', async () => {
  mockFetchE2eeState
    .mockResolvedValueOnce({ conversationId: 'c1', e2ee: false })
    .mockResolvedValue({ conversationId: 'c1', e2ee: true });

  const { result } = renderHook(() => useChat(peer, me, jest.fn()));
  await waitFor(() => expect(mockFetchE2eeState).toHaveBeenCalledWith(peer));
  expect(result.current.locked).toBe(false);

  await act(async () => {
    mockListeners.get('e2ee:envelope')?.({ conversationId: 'c1', seq: 1 });
  });

  await waitFor(() => expect(result.current.locked).toBe(true));
  expect(await result.current.sendMessage('hello')).toEqual({
    ok: false,
    error: 'این گفتگو پیام‌های قدیمیِ رمزنگاری‌شده دارد؛ نوشتن در آن از این نسخه فعلاً ممکن نیست',
  });
  expect(mockSocket.emit).not.toHaveBeenCalledWith('message:send', expect.anything());
});
