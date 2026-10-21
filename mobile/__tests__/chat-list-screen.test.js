import { render, fireEvent, waitFor } from '@testing-library/react-native';
import ChatListScreen from '../src/screens/ChatListScreen';
import { fetchConversations, fetchGroups } from '../src/services/api';

jest.mock('../src/services/api', () => ({
  fetchConversations: jest.fn(),
  fetchGroups: jest.fn(),
  normalizeUser: jest.fn(user => ({
    id: user.id,
    kind: 'direct',
    name: user.displayName || user.username,
    username: user.username,
    avatar: null,
    bio: '',
    status: 'offline',
    unread: 0,
    createdAt: user.createdAt,
  })),
  normalizeGroup: jest.fn(group => ({
    id: group.id,
    kind: 'group',
    name: group.name,
    avatar: null,
    memberCount: (group.participants ?? []).length,
    participants: group.participants ?? [],
    unread: group.unread ?? 0,
    updatedAt: group.updatedAt,
  })),
}));

jest.mock('../src/context/AuthContext', () => ({
  useAuth: () => ({
    currentUser: { id: 'me', name: 'من', username: 'me' },
    logout: jest.fn(),
  }),
}));

jest.mock('../src/context/SocketContext', () => ({
  useSocket: () => ({ socket: null }),
}));

jest.mock('@react-navigation/native', () => {
  const React = require('react');
  return {
    useFocusEffect: callback => {
      React.useEffect(callback, [callback]);
    },
  };
});

const direct = {
  user: { id: 'u1', username: 'ali', displayName: 'علی' },
  unread: 2,
  updatedAt: '2026-10-21T10:00:00.000Z',
};
const group = {
  id: 'g1',
  name: 'تیم',
  participants: [{ id: 'u1' }, { id: 'u2' }],
  unread: 0,
  updatedAt: '2026-10-21T09:00:00.000Z',
};

const navigation = { setOptions: jest.fn(), navigate: jest.fn() };

beforeEach(() => {
  jest.clearAllMocks();
  fetchConversations.mockResolvedValue([direct]);
  fetchGroups.mockResolvedValue([group]);
});

test('renders direct and group rows with the unread badge', async () => {
  const view = render(<ChatListScreen navigation={navigation} />);
  expect(await view.findByText('علی')).toBeTruthy();
  expect(view.getByText('تیم')).toBeTruthy();
  expect(view.getByLabelText('2 پیام خوانده‌نشده')).toBeTruthy();
  expect(view.getByText('2 عضو')).toBeTruthy();
});

test('filters rows by name and username', async () => {
  const view = render(<ChatListScreen navigation={navigation} />);
  await view.findByText('علی');
  fireEvent.changeText(view.getByLabelText('جستجوی گفتگو'), 'ali');
  await waitFor(() => expect(view.queryByText('تیم')).toBeNull());
  expect(view.getByText('علی')).toBeTruthy();
  fireEvent.changeText(view.getByLabelText('جستجوی گفتگو'), 'نبود');
  await waitFor(() => expect(view.getByText('گفتگویی پیدا نشد')).toBeTruthy());
});

test('opens a conversation', async () => {
  const view = render(<ChatListScreen navigation={navigation} />);
  fireEvent.press(await view.findByText('علی'));
  expect(navigation.navigate).toHaveBeenCalledWith('Chat', {
    peer: expect.objectContaining({ id: 'u1', name: 'علی' }),
  });
});

test('shows the empty state for a new account', async () => {
  fetchConversations.mockResolvedValue([]);
  fetchGroups.mockResolvedValue([]);
  const view = render(<ChatListScreen navigation={navigation} />);
  expect(await view.findByText('هنوز گفتگویی نداری')).toBeTruthy();
});

test('shows the error banner and retries', async () => {
  fetchConversations.mockRejectedValue(new Error('خطای شبکه'));
  const view = render(<ChatListScreen navigation={navigation} />);
  expect(await view.findByText('خطای شبکه')).toBeTruthy();
  fireEvent.press(view.getByText('تلاش دوباره'));
  await waitFor(() => expect(fetchConversations).toHaveBeenCalledTimes(2));
});
