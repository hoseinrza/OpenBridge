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

beforeEach(() => {
  jest.clearAllMocks();
  mockListeners.clear();
  mockFetchMessages.mockResolvedValue([]);
  mockFetchE2eeState.mockResolvedValue({ e2ee: false });
  mockUploadFile.mockResolvedValue({
    url: '/uploads/voice.m4a', name: 'voice.m4a', size: 61544, type: 'AUDIO',
  });
});

test('a recording is uploaded and the message names it with the length the phone measured', async () => {
  const { result } = renderHook(() => useChat(peer, me, jest.fn()));
  await waitFor(() => expect(result.current.historyState).toBe('ready'));

  await act(async () => {
    const sent = await result.current.sendVoice({
      uri: 'file:///mock/voice.m4a',
      name: 'voice-message.m4a',
      durationMs: 4600,
    });
    expect(sent.ok).toBe(true);
  });

  expect(mockUploadFile).toHaveBeenCalledWith({
    uri: 'file:///mock/voice.m4a',
    name: 'voice-message.m4a',
    type: 'audio/mp4',
  });
  expect(mockAckEmit).toHaveBeenCalledWith(
    'message:send',
    {
      toId: 'p1',
      type: 'AUDIO',
      fileUrl: '/uploads/voice.m4a',
      fileName: 'voice.m4a',
      fileSize: 61544,
      durationMs: 4600,
    },
    expect.any(Function),
  );
});

test('a group recording goes to the conversation instead of a person', async () => {
  const group = { id: 'g1', kind: 'group', name: 'تیم' };
  const { result } = renderHook(() => useChat(group, me, jest.fn()));
  await waitFor(() => expect(result.current.historyState).toBe('ready'));

  await act(async () => {
    await result.current.sendVoice({ uri: 'file:///mock/voice.m4a', durationMs: 1200 });
  });

  expect(mockAckEmit.mock.calls[0][1]).toMatchObject({
    conversationId: 'g1',
    type: 'AUDIO',
    fileUrl: '/uploads/voice.m4a',
    durationMs: 1200,
  });
});

test('a stored voice message keeps the length it was sent with', async () => {
  mockFetchMessages.mockResolvedValue([{
    id: 'm1',
    type: 'AUDIO',
    senderId: 'p1',
    receiverId: 'me',
    fileUrl: '/uploads/voice.m4a',
    fileName: 'voice.m4a',
    durationMs: 7400,
    createdAt: '2026-10-22T08:00:00.000Z',
    reactions: [],
  }]);

  const { result } = renderHook(() => useChat(peer, me, jest.fn()));
  await waitFor(() => expect(result.current.messages).toHaveLength(1));

  expect(result.current.messages[0]).toMatchObject({
    type: 'audio',
    durationMs: 7400,
    side: 'other',
  });
});

test('a chat that turns encrypted mid-open refuses a recording', async () => {
  mockFetchE2eeState.mockResolvedValue({ e2ee: true });
  const { result } = renderHook(() => useChat(peer, me, jest.fn()));
  await waitFor(() => expect(result.current.locked).toBe(true));

  await act(async () => {
    const refused = await result.current.sendVoice({ uri: 'file:///mock/voice.m4a', durationMs: 900 });
    expect(refused).toEqual({
      ok: false,
      error: 'این گفتگو سرتاسری رمزنگاری شده؛ نوشتن در آن فقط از نسخهٔ وب ممکن است',
    });
  });

  expect(mockUploadFile).not.toHaveBeenCalled();
  expect(mockAckEmit).not.toHaveBeenCalled();
});
