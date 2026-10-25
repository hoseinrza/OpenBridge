import { act, renderHook, waitFor } from '@testing-library/react-native';
import { useChat } from '../src/hooks/useChat';

const mockListeners = new Map();
const mockAckEmit = jest.fn((event, payload, done) => done(null, { ok: true, id: 'm2' }));
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

const mockFetchMessages = jest.fn();
jest.mock('../src/services/api', () => ({
  fetchMessages: (...args) => mockFetchMessages(...args),
  fetchGroupMessages: jest.fn(async () => []),
  resolveUrl: (value) => value,
  fetchE2eeState: jest.fn(async () => ({ e2ee: false })),
  uploadFile: jest.fn(),
}));

const peer = { id: 'p1', kind: 'direct', name: 'سارا' };
const me = { id: 'me', name: 'من' };

const base = {
  id: 'm1',
  conversationId: 'c1',
  senderId: 'me',
  receiverId: 'p1',
  type: 'TEXT',
  text: 'متن قبلی',
  createdAt: '2026-10-25T08:00:00.000Z',
};

beforeEach(() => {
  jest.clearAllMocks();
  mockListeners.clear();
  mockFetchMessages.mockResolvedValue([]);
});

test('an edit made on another device replaces the text and marks the row', async () => {
  mockFetchMessages.mockResolvedValue([base]);
  const { result } = renderHook(() => useChat(peer, me, jest.fn()));
  await waitFor(() => expect(result.current.historyState).toBe('ready'));

  await act(async () => {
    mockListeners.get('message:edited')({
      ...base,
      text: 'متن تازه',
      editedAt: '2026-10-25T08:05:00.000Z',
    });
  });

  expect(result.current.messages).toHaveLength(1);
  expect(result.current.messages[0].text).toBe('متن تازه');
  expect(result.current.messages[0].editedAt).toBe(
    new Date('2026-10-25T08:05:00.000Z').getTime(),
  );
});

test('an edit that belongs to another conversation is ignored', async () => {
  mockFetchMessages.mockResolvedValue([base]);
  const { result } = renderHook(() => useChat(peer, me, jest.fn()));
  await waitFor(() => expect(result.current.historyState).toBe('ready'));

  await act(async () => {
    mockListeners.get('message:edited')({
      ...base,
      conversationId: 'c9',
      senderId: 'someone',
      receiverId: 'else',
      text: 'پیام دیگری',
    });
  });

  expect(result.current.messages[0].text).toBe('متن قبلی');
});

test('a reply sends the quoted id and a plain send stays unchanged', async () => {
  const { result } = renderHook(() => useChat(peer, me, jest.fn()));
  await waitFor(() => expect(result.current.historyState).toBe('ready'));

  await act(async () => {
    const sent = await result.current.sendMessage('سلام', 'm1');
    expect(sent.ok).toBe(true);
  });
  expect(mockAckEmit).toHaveBeenCalledWith(
    'message:send',
    { toId: 'p1', type: 'TEXT', text: 'سلام', replyToId: 'm1' },
    expect.any(Function),
  );

  mockAckEmit.mockClear();
  await act(async () => {
    await result.current.sendMessage('بدون نقل');
  });
  expect(mockAckEmit).toHaveBeenCalledWith(
    'message:send',
    { toId: 'p1', type: 'TEXT', text: 'بدون نقل' },
    expect.any(Function),
  );
});

test('history carries the quote the server resolved', async () => {
  mockFetchMessages.mockResolvedValue([{
    ...base,
    id: 'm2',
    text: 'پاسخ',
    replyTo: {
      id: 'm0',
      type: 'TEXT',
      text: 'پیام اصلی',
      sender: { id: 'p1', name: 'سارا' },
      deleted: false,
    },
  }]);
  const { result } = renderHook(() => useChat(peer, me, jest.fn()));
  await waitFor(() => expect(result.current.historyState).toBe('ready'));

  expect(result.current.messages[0].replyTo).toEqual({
    id: 'm0',
    type: 'text',
    text: 'پیام اصلی',
    name: undefined,
    sender: 'سارا',
    deleted: false,
  });
});

test('edit and delete ask the server with the message id and the chosen scope', async () => {
  const { result } = renderHook(() => useChat(peer, me, jest.fn()));
  await waitFor(() => expect(result.current.historyState).toBe('ready'));

  await act(async () => {
    const edited = await result.current.editMessage('m1', '  متن تازه  ');
    expect(edited.ok).toBe(true);
  });
  expect(mockAckEmit).toHaveBeenCalledWith(
    'message:edit',
    { messageId: 'm1', text: 'متن تازه' },
    expect.any(Function),
  );

  mockAckEmit.mockClear();
  await act(async () => {
    const removed = await result.current.deleteMessage('m1', 'everyone');
    expect(removed.ok).toBe(true);
  });
  expect(mockAckEmit).toHaveBeenCalledWith(
    'message:delete',
    { messageId: 'm1', scope: 'everyone' },
    expect.any(Function),
  );
});

test('an empty edit never reaches the server', async () => {
  const { result } = renderHook(() => useChat(peer, me, jest.fn()));
  await waitFor(() => expect(result.current.historyState).toBe('ready'));

  await act(async () => {
    const edited = await result.current.editMessage('m1', '   ');
    expect(edited.ok).toBe(false);
  });
  expect(mockAckEmit).not.toHaveBeenCalled();
});
