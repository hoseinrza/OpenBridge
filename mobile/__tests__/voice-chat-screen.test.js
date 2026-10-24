import { act, fireEvent, render, waitFor } from '@testing-library/react-native';
import ChatScreen from '../src/screens/ChatScreen';
import { useChat } from '../src/hooks/useChat';
const audio = require('expo-audio');

jest.mock('../src/hooks/useChat', () => ({ useChat: jest.fn() }));

jest.mock('../src/context/AuthContext', () => ({
  useAuth: () => ({ currentUser: { id: 'me', name: 'من' } }),
}));

const peer = { id: 'p1', kind: 'direct', name: 'سارا', status: 'online' };

function voice(id, side, overrides = {}) {
  return {
    id,
    type: 'audio',
    text: '',
    src: `https://bridge.test/uploads/${id}.m4a`,
    durationMs: 4600,
    side,
    senderId: side === 'mine' ? 'me' : 'p1',
    sender: side === 'mine' ? 'من' : 'سارا',
    time: '۱۰:۰۰',
    createdAt: side === 'mine' ? 1 : 2,
    reactions: [],
    ...overrides,
  };
}

function makeChat(messages, overrides = {}) {
  const chat = {
    messages,
    isTyping: false,
    typingName: '',
    connected: true,
    locked: false,
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
  audio.__recorder.__reset();
  audio.__players.length = 0;
});

// ── The bubble ─────────────────────────────────────────

// Each bubble owns an id in its own test: the player is one object for the
// whole app, so a shared id would let one test answer another's tap.
test('a voice message shows the length its sender measured', () => {
  makeChat([voice('b1', 'other')]);
  const view = renderChat();
  expect(view.getByTestId('voice-play-b1')).toBeTruthy();
  expect(view.getByText('۰۰:۰۵')).toBeTruthy();
});

// Two labels draw the same bubble: the type a recording is stored under now,
// and the audio type the rows written before it still carry.
test('a recording shows its bubble whatever type the row is filed under', () => {
  makeChat([voice('b10', 'other', { type: 'voice' }), voice('b11', 'mine', { type: 'audio' })]);
  const view = renderChat();
  expect(view.getByTestId('voice-play-b10')).toBeTruthy();
  expect(view.getByTestId('voice-play-b11')).toBeTruthy();
});

test('tapping a bubble opens the stream and the button turns into a pause', async () => {
  makeChat([voice('b2', 'other')]);
  const view = renderChat();

  fireEvent.press(view.getByTestId('voice-play-b2'));

  expect(audio.createAudioPlayer).toHaveBeenCalledWith({ uri: 'https://bridge.test/uploads/b2.m4a' });
  expect(audio.__players[0].play).toHaveBeenCalled();
  await waitFor(() => expect(view.getByLabelText('توقف پیام صوتی')).toBeTruthy());
});

test('a second tap pauses and a third resumes the same player', async () => {
  makeChat([voice('b3', 'other')]);
  const view = renderChat();

  fireEvent.press(view.getByTestId('voice-play-b3'));
  await waitFor(() => expect(view.getByLabelText('توقف پیام صوتی')).toBeTruthy());
  fireEvent.press(view.getByTestId('voice-play-b3'));
  expect(audio.__players[0].pause).toHaveBeenCalled();
  await waitFor(() => expect(view.getByLabelText('پخش پیام صوتی')).toBeTruthy());

  fireEvent.press(view.getByTestId('voice-play-b3'));
  expect(audio.createAudioPlayer).toHaveBeenCalledTimes(1);
  expect(audio.__players[0].play).toHaveBeenCalledTimes(2);
});

test('only one recording plays at a time', async () => {
  makeChat([voice('b4', 'other'), voice('b5', 'mine')]);
  const view = renderChat();

  fireEvent.press(view.getByTestId('voice-play-b4'));
  await waitFor(() => expect(view.getByLabelText('توقف پیام صوتی')).toBeTruthy());

  fireEvent.press(view.getByTestId('voice-play-b5'));

  expect(audio.__players[0].remove).toHaveBeenCalled();
  expect(audio.__players).toHaveLength(2);
  await waitFor(() => expect(view.getByLabelText('توقف پیام صوتی')).toBeTruthy());
  expect(view.getByTestId('voice-play-b4').props.accessibilityLabel).toBe('پخش پیام صوتی');
});

test('a container this phone cannot decode says so inside its own bubble', async () => {
  makeChat([voice('b6', 'other')]);
  const view = renderChat();

  fireEvent.press(view.getByTestId('voice-play-b6'));
  act(() => { audio.__players[0].__emit({ error: 'cannot decode this container', isLoaded: false }); });

  expect(await view.findByText('پخش نشد')).toBeTruthy();
});

test('a finished recording goes back to its own length', async () => {
  makeChat([voice('b7', 'other')]);
  const view = renderChat();

  fireEvent.press(view.getByTestId('voice-play-b7'));
  act(() => { audio.__players[0].__emit({ currentTime: 2.3, duration: 4.6 }); });
  expect(await view.findByText('۰۰:۰۲')).toBeTruthy();

  act(() => { audio.__players[0].__emit({ didJustFinish: true, playing: false }); });
  expect(await view.findByText('۰۰:۰۵')).toBeTruthy();
  expect(view.queryByLabelText('توقف پیام صوتی')).toBeNull();
});

// ── The recorder ───────────────────────────────────────

test('an empty composer offers a microphone and a press starts the recorder', async () => {
  makeChat([]);
  const view = renderChat();

  fireEvent.press(view.getByLabelText('ضبط پیام صوتی'));

  await waitFor(() => expect(audio.__recorder.record).toHaveBeenCalled());
  expect(view.getByText('در حال ضبط…')).toBeTruthy();
  expect(view.queryByLabelText('ارسال پیام')).toBeNull();
});

test('the clock the phone counts is the clock on the row', async () => {
  audio.__recorder.durationMillis = 5200;
  makeChat([]);
  const view = renderChat();

  fireEvent.press(view.getByLabelText('ضبط پیام صوتی'));

  expect(await view.findByText('۰۰:۰۵')).toBeTruthy();
});

test('sending hands the recorded file and its length to the server', async () => {
  audio.__recorder.durationMillis = 4600;
  const chat = makeChat([]);
  const view = renderChat();

  fireEvent.press(view.getByLabelText('ضبط پیام صوتی'));
  await waitFor(() => expect(audio.__recorder.isRecording).toBe(true));

  fireEvent.press(view.getByLabelText('ارسال پیام صوتی'));

  await waitFor(() => expect(chat.sendVoice).toHaveBeenCalledWith({
    uri: 'file:///mock/voice.m4a',
    name: 'voice-message.m4a',
    durationMs: 4600,
  }));
  expect(audio.__recorder.stop).toHaveBeenCalled();
  await waitFor(() => expect(view.getByLabelText('متن پیام')).toBeTruthy());
});

test('the trash drops the recording and nothing is uploaded', async () => {
  const chat = makeChat([]);
  const view = renderChat();

  fireEvent.press(view.getByLabelText('ضبط پیام صوتی'));
  await waitFor(() => expect(audio.__recorder.isRecording).toBe(true));

  fireEvent.press(view.getByLabelText('حذف پیام صوتی'));

  await waitFor(() => expect(audio.__recorder.stop).toHaveBeenCalled());
  expect(chat.sendVoice).not.toHaveBeenCalled();
  expect(view.getByLabelText('متن پیام')).toBeTruthy();
});

test('a denied microphone says what it needs instead of recording silence', async () => {
  audio.requestRecordingPermissionsAsync.mockResolvedValueOnce({ granted: false, status: 'denied' });
  makeChat([]);
  const view = renderChat();

  fireEvent.press(view.getByLabelText('ضبط پیام صوتی'));

  expect(await view.findByText('برای ضبط پیام صوتی اجازهٔ استفاده از میکروفون لازم است')).toBeTruthy();
  expect(audio.__recorder.record).not.toHaveBeenCalled();
});

test('the ceiling sends a long recording on its own', async () => {
  audio.__recorder.durationMillis = 10 * 60 * 1000 + 1;
  const chat = makeChat([]);
  const view = renderChat();

  fireEvent.press(view.getByLabelText('ضبط پیام صوتی'));

  expect(await view.findByLabelText('ارسال پیام صوتی')).toBeTruthy();
  await waitFor(() => expect(chat.sendVoice).toHaveBeenCalledWith(expect.objectContaining({
    durationMs: 600001,
  })));
});

test('an encrypted chat leaves the microphone switched off', () => {
  makeChat([], { locked: true });
  const view = renderChat();
  expect(view.getByLabelText('ضبط پیام صوتی')).toBeDisabled();
  expect(view.getByLabelText('متن پیام').props.editable).toBe(false);
});
