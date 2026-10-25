import { render, fireEvent, waitFor } from '@testing-library/react-native';
import ChatScreen from '../src/screens/ChatScreen';
import { useChat } from '../src/hooks/useChat';

jest.mock('../src/hooks/useChat', () => ({ useChat: jest.fn() }));

jest.mock('../src/context/AuthContext', () => ({
  useAuth: () => ({ currentUser: { id: 'me', name: 'من' } }),
}));

const peer = { id: 'p1', kind: 'direct', name: 'سارا', username: 'sara', status: 'online' };
const mine = {
  id: 'm1', type: 'text', text: 'سلام از من', side: 'mine', senderId: 'me',
  time: '۱۰:۰۰', createdAt: 1, read: true, reactions: [],
};
const other = {
  id: 'm2', type: 'text', text: 'سلام از سارا', side: 'other', senderId: 'p1',
  sender: 'سارا', time: '۱۰:۰۱', createdAt: 2, read: false, reactions: [],
};

function makeChat(overrides = {}) {
  const chat = {
    messages: [mine, other],
    isTyping: false,
    typingName: '',
    connected: true,
    historyState: 'ready',
    historyError: '',
    retryHistory: jest.fn(),
    sendMessage: jest.fn(async () => ({ ok: true })),
    sendVoice: jest.fn(async () => ({ ok: true })),
    notifyTyping: jest.fn(),
    toggleReaction: jest.fn(() => true),
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
});

test('renders both message sides and the read receipt', () => {
  makeChat();
  const view = renderChat();
  expect(view.getByText('سلام از من')).toBeTruthy();
  expect(view.getByText('سلام از سارا')).toBeTruthy();
  expect(view.getByTestId('bubble-mine')).toBeTruthy();
  expect(view.getByTestId('bubble-other')).toBeTruthy();
  expect(view.getByLabelText('خوانده شد')).toBeTruthy();
});

test('sends the composer text and clears the input', async () => {
  const chat = makeChat();
  const view = renderChat();
  fireEvent.changeText(view.getByLabelText('متن پیام'), 'hello');
  expect(chat.notifyTyping).toHaveBeenCalled();
  fireEvent.press(view.getByLabelText('ارسال پیام'));
  await waitFor(() => expect(chat.sendMessage).toHaveBeenCalledWith('hello'));
  expect(view.getByLabelText('متن پیام').props.value).toBe('');
});

test('locks the composer of an encrypted chat instead of offering a send', () => {
  const chat = makeChat({ messages: [], locked: true });
  const view = renderChat();
  expect(view.getByText(/پیام‌های قدیمیِ این گفتگو/)).toBeTruthy();
  expect(view.getByText(/هنوز پیام خواندنی روی سرور نیست/)).toBeTruthy();
  const input = view.getByLabelText('متن پیام');
  expect(input.props.editable).toBe(false);
  expect(input.props.placeholder).toBe('نوشتن در این نسخه برای این گفتگو هنوز باز نشده');
  expect(view.getByLabelText('ضبط پیام صوتی')).toBeDisabled();
  expect(chat.sendMessage).not.toHaveBeenCalled();
});

test('keeps the text and shows the error when sending fails', async () => {
  makeChat({ sendMessage: jest.fn(async () => ({ ok: false, error: 'ارسال پیام ناموفق بود' })) });
  const view = renderChat();
  fireEvent.changeText(view.getByLabelText('متن پیام'), 'hello');
  fireEvent.press(view.getByLabelText('ارسال پیام'));
  expect(await view.findByText('ارسال پیام ناموفق بود')).toBeTruthy();
  expect(view.getByLabelText('متن پیام').props.value).toBe('hello');
});

test('opens reactions on long press and records the chosen emoji', async () => {
  const chat = makeChat({ messages: [mine] });
  const view = renderChat();
  fireEvent(view.getByTestId('bubble-mine'), 'longPress');
  const option = await view.findByLabelText('افزودن واکنش 👍');
  fireEvent.press(option);
  expect(chat.toggleReaction).toHaveBeenCalledWith('m1', '👍');
});

test('reports a reaction when the socket is gone', async () => {
  const chat = makeChat({ messages: [mine], toggleReaction: jest.fn(() => false) });
  const view = renderChat();
  fireEvent(view.getByTestId('bubble-mine'), 'longPress');
  fireEvent.press(await view.findByLabelText('افزودن واکنش 👍'));
  expect(
    await view.findByText('اتصال به سرور برقرار نیست؛ واکنش ثبت نشد'),
  ).toBeTruthy();
  expect(chat.toggleReaction).toHaveBeenCalled();
});

test('disables sending while disconnected', () => {
  makeChat({ connected: false });
  const view = renderChat();
  expect(view.getByText('در حال اتصال به سرور…')).toBeTruthy();
  expect(view.getByLabelText('ضبط پیام صوتی')).toBeDisabled();
  // The empty composer offers voice, so the send path is exercised by typing
  // first; with no connection the send button must stay disabled.
  fireEvent.changeText(view.getByTestId('composer-input'), 'سلام');
  expect(view.getByLabelText('ارسال پیام')).toBeDisabled();
});

test('shows the empty and error history states', async () => {
  makeChat({ messages: [], historyState: 'error', historyError: 'دریافت پیام‌ها ناموفق بود' });
  const view = renderChat();
  expect(await view.findByText('دریافت پیام‌ها ناموفق بود')).toBeTruthy();
  fireEvent.press(view.getByText('تلاش دوباره'));
  expect(useChat.mock.results[0].value.retryHistory).toHaveBeenCalled();
});
