import { act, render, fireEvent, waitFor } from '@testing-library/react-native';
import { Alert } from 'react-native';
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

test('a quoted reply shows its sender and text, and an edit mark', () => {
  const replied = {
    ...other,
    id: 'm3',
    text: 'جواب',
    editedAt: 3,
    replyTo: { id: 'm1', type: 'text', text: 'متن نقل‌شده', sender: 'من', deleted: false },
  };
  makeChat({ messages: [replied] });
  const view = renderChat();
  expect(view.getByText('متن نقل‌شده')).toBeTruthy();
  expect(view.getByText('ویرایش شد')).toBeTruthy();
});

test('choosing reply quotes that message on the next send', async () => {
  const chat = makeChat({ messages: [mine] });
  const view = renderChat();
  fireEvent(view.getByTestId('bubble-mine'), 'longPress');
  fireEvent.press(await view.findByLabelText('پاسخ به این پیام'));
  expect(view.getByLabelText('لغو پاسخ')).toBeTruthy();

  fireEvent.changeText(view.getByLabelText('متن پیام'), 'جواب');
  fireEvent.press(view.getByLabelText('ارسال پیام'));
  await waitFor(() =>
    expect(chat.sendMessage).toHaveBeenCalledWith('جواب', 'm1'));
  expect(view.queryByLabelText('لغو پاسخ')).toBeNull();
});

test('cancelling a reply returns the composer to a plain send', async () => {
  const chat = makeChat({ messages: [mine] });
  const view = renderChat();
  fireEvent(view.getByTestId('bubble-mine'), 'longPress');
  fireEvent.press(await view.findByLabelText('پاسخ به این پیام'));
  fireEvent.press(view.getByLabelText('لغو پاسخ'));

  fireEvent.changeText(view.getByLabelText('متن پیام'), 'بدون نقل');
  fireEvent.press(view.getByLabelText('ارسال پیام'));
  await waitFor(() => expect(chat.sendMessage).toHaveBeenCalledWith('بدون نقل'));
  expect(view.queryByLabelText('لغو پاسخ')).toBeNull();
});

test('a quote of a deleted message says so', () => {
  const replied = {
    ...other,
    id: 'm4',
    replyTo: { id: 'm1', type: 'text', text: '', sender: 'من', deleted: true },
  };
  makeChat({ messages: [replied] });
  const view = renderChat();
  expect(view.getByText('پیام حذف شد')).toBeTruthy();
});

test('editing a message preloads the composer and saves through the edit event', async () => {
  const chat = makeChat({ messages: [mine] });
  const view = renderChat();
  fireEvent(view.getByTestId('bubble-mine'), 'longPress');
  fireEvent.press(await view.findByLabelText('ویرایش این پیام'));

  expect(view.getByLabelText('متن پیام').props.value).toBe('سلام از من');
  fireEvent.changeText(view.getByLabelText('متن پیام'), 'سلام تازه');
  fireEvent.press(view.getByLabelText('ذخیرهٔ ویرایش'));

  await waitFor(() => expect(chat.editMessage).toHaveBeenCalledWith('m1', 'سلام تازه'));
  expect(view.getByLabelText('متن پیام').props.value).toBe('');
  expect(view.queryByLabelText('لغو ویرایش')).toBeNull();
});

test('cancelling an edit clears the composer and restores the send button', async () => {
  makeChat({ messages: [mine] });
  const view = renderChat();
  fireEvent(view.getByTestId('bubble-mine'), 'longPress');
  fireEvent.press(await view.findByLabelText('ویرایش این پیام'));
  fireEvent.press(view.getByLabelText('لغو ویرایش'));

  expect(view.getByLabelText('متن پیام').props.value).toBe('');
  expect(view.getByLabelText('ضبط پیام صوتی')).toBeTruthy();
});

test('deleting an own message offers everyone and me, and sends the chosen scope', async () => {
  const alertSpy = jest.spyOn(Alert, 'alert').mockImplementation(() => {});
  const chat = makeChat({ messages: [mine] });
  const view = renderChat();

  fireEvent(view.getByTestId('bubble-mine'), 'longPress');
  fireEvent.press(await view.findByLabelText('حذف این پیام'));
  expect(alertSpy).toHaveBeenCalled();

  const buttons = alertSpy.mock.calls[0][2];
  expect(buttons.map(b => b.text)).toEqual(['لغو', 'حذف برای همه', 'حذف برای من']);
  await act(async () => { buttons[1].onPress(); });
  await waitFor(() => expect(chat.deleteMessage).toHaveBeenCalledWith('m1', 'everyone'));

  alertSpy.mockRestore();
});

test('an incoming message can only be deleted for me and never edited', async () => {
  const alertSpy = jest.spyOn(Alert, 'alert').mockImplementation(() => {});
  const chat = makeChat({ messages: [other] });
  const view = renderChat();

  fireEvent(view.getByTestId('bubble-other'), 'longPress');
  expect(view.queryByLabelText('ویرایش این پیام')).toBeNull();
  fireEvent.press(view.getByLabelText('حذف این پیام'));

  const buttons = alertSpy.mock.calls[0][2];
  expect(buttons.map(b => b.text)).toEqual(['لغو', 'حذف برای من']);
  await act(async () => { buttons[1].onPress(); });
  await waitFor(() => expect(chat.deleteMessage).toHaveBeenCalledWith('m2', 'me'));

  alertSpy.mockRestore();
});

test('reports an error when a delete is refused', async () => {
  const alertSpy = jest.spyOn(Alert, 'alert').mockImplementation(() => {});
  makeChat({
    messages: [mine],
    deleteMessage: jest.fn(async () => ({ ok: false, error: 'حذف پیام ناموفق بود' })),
  });
  const view = renderChat();

  fireEvent(view.getByTestId('bubble-mine'), 'longPress');
  fireEvent.press(await view.findByLabelText('حذف این پیام'));
  const buttons = alertSpy.mock.calls[0][2];
  await act(async () => { buttons[1].onPress(); });

  expect(await view.findByText('حذف پیام ناموفق بود')).toBeTruthy();
  alertSpy.mockRestore();
});
