import { render, fireEvent, waitFor, act } from '@testing-library/react-native';
import { Linking } from 'react-native';
import ChatProfileScreen from '../src/screens/ChatProfileScreen';
import { fetchE2eeState, fetchShared, fetchUser, updateGroup } from '../src/services/api';

jest.mock('../src/services/api', () => {
  const actual = jest.requireActual('../src/services/api');
  return {
    ...actual,
    fetchUser:      jest.fn(),
    fetchShared:    jest.fn(),
    fetchE2eeState: jest.fn(),
    updateGroup:    jest.fn(),
  };
});

jest.mock('../src/context/AuthContext', () => ({
  useAuth: () => ({ currentUser: { id: 'me', name: 'من' } }),
}));

// The screen redraws from the group broadcast, so the test owns the listener.
let socketHandlers = {};
const socket = { on: (event, fn) => { socketHandlers[event] = fn; }, off: () => { socketHandlers = {}; } };
jest.mock('../src/context/SocketContext', () => ({
  useSocket: () => ({ socket, connected: true }),
}));

const joinedLabel = date => new Date(date).toLocaleDateString('fa-IR', {
  year: 'numeric', month: 'long', day: 'numeric',
});

const contact = {
  id: 'p1', kind: 'direct', name: 'سارا', username: 'sara', bio: 'طراح',
  status: 'online', createdAt: '2026-01-05T00:00:00.000Z',
};
// What GET /users/:id answers: a wire record, not the shape the app carries.
const contactWire = {
  id: 'p1', username: 'sara', displayName: 'سارا', avatar: null, bio: 'طراح',
  online: true, createdAt: '2026-01-05T00:00:00.000Z',
};
const groupPeer = {
  id: 'g1', kind: 'group', name: 'تیم طراحی', memberCount: 2, description: 'هماهنگی روزانه',
  createdAt: '2026-02-02T00:00:00.000Z', encrypted: false,
  participants: [
    { id: 'me', kind: 'direct', name: 'من',   username: 'me',   role: 'ADMIN' },
    { id: 'o1', kind: 'direct', name: 'نیلو', username: 'nilo', role: 'OWNER' },
  ],
};

const mediaItem = {
  id: 'm1', kind: 'media', type: 'IMAGE', url: '/uploads/one.png',
  name: 'تصویر.png', size: 1024, createdAt: '2026-03-01T10:00:00.000Z', sender: { id: 'p1', name: 'سارا' },
};
const fileItem = {
  id: 'f1', kind: 'files', type: 'FILE', url: '/uploads/list.txt',
  name: 'لیست.txt', size: 260, createdAt: '2026-03-02T10:00:00.000Z', sender: { id: 'p1', name: 'سارا' },
};
const linkItem = {
  id: 'l1', kind: 'links', type: 'TEXT', createdAt: '2026-03-03T10:00:00.000Z',
  text: 'ببین: https://example.com/a.', url: 'https://example.com/a', sender: { id: 'p1', name: 'سارا' },
};

function renderProfile(peer) {
  return render(<ChatProfileScreen route={{ params: { peer } }} navigation={{ setOptions: jest.fn() }} />);
}

beforeEach(() => {
  jest.clearAllMocks();
  socketHandlers = {};
  Linking.openURL = jest.fn(async () => true);
  fetchUser.mockResolvedValue(contactWire);
  fetchE2eeState.mockResolvedValue({ e2ee: false });
  fetchShared.mockResolvedValue({ kind: 'media', encrypted: false, items: [], nextCursor: null });
  updateGroup.mockResolvedValue({ ...groupPeer, name: 'تیم تازه' });
});

test('shows a contact identity, bio and the day the account joined', async () => {
  const view = renderProfile(contact);
  expect(await view.findByText('سارا')).toBeTruthy();
  expect(view.getByText('@sara')).toBeTruthy();
  expect(view.getByText('طراح')).toBeTruthy();
  expect(view.getByText('آنلاین')).toBeTruthy();
  expect(view.getByText(`پیوسته · ${joinedLabel(contact.createdAt)}`)).toBeTruthy();
  expect(fetchUser).toHaveBeenCalledWith('p1');
});

test('lists group members with their roles and marks this device', async () => {
  const view = renderProfile(groupPeer);
  expect(await view.findByText('تیم طراحی')).toBeTruthy();
  expect(view.getByText('۲ عضو')).toBeTruthy();
  expect(view.getByText('هماهنگی روزانه')).toBeTruthy();
  expect(view.getByText('اعضای گروه (۲)')).toBeTruthy();
  expect(view.getByText('مالک')).toBeTruthy();
  expect(view.getByText('شما')).toBeTruthy();
  expect(fetchUser).not.toHaveBeenCalled();
});

test('each tab is fetched once, and a picture opens full size', async () => {
  fetchShared.mockResolvedValue({
    kind: 'media', encrypted: false, items: [mediaItem, { ...mediaItem, id: 'm2' }], nextCursor: null,
  });
  const view = renderProfile(groupPeer);
  await waitFor(() => expect(view.getAllByTestId('profile-media-cell')).toHaveLength(2));
  expect(fetchShared).toHaveBeenCalledTimes(1);
  expect(fetchShared.mock.calls[0]).toEqual(['g1', 'media', undefined]);

  fireEvent.press(view.getAllByTestId('profile-media-cell')[0]);
  await view.findByTestId('profile-image-viewer');
  expect(view.getByTestId('profile-viewer-image').props.source.uri).toContain('/uploads/one.png');
  fireEvent.press(view.getByTestId('profile-viewer-close'));
  await waitFor(() => expect(view.queryByTestId('profile-image-viewer')).toBeNull());

  fireEvent.press(view.getByTestId('profile-tab-files'));
  await waitFor(() => expect(fetchShared).toHaveBeenCalledTimes(2));
  expect(fetchShared.mock.calls[1]).toEqual(['g1', 'files', undefined]);
  fireEvent.press(view.getByTestId('profile-tab-files'));
  expect(fetchShared).toHaveBeenCalledTimes(2);
});

test('a file row opens its signed url and a link row its own address', async () => {
  const itemsByKind = { media: [mediaItem], files: [fileItem], links: [linkItem] };
  fetchShared.mockImplementation((target, kind, before) => Promise.resolve({
    kind,
    encrypted:  false,
    // The next page of links carries the older ones, never the same row twice.
    items:      kind === 'links' && before
      ? [{ ...linkItem, id: 'l2', text: 'نمونه: https://example.org/b', url: 'https://example.org/b' }]
      : itemsByKind[kind],
    nextCursor: kind === 'links' && !before ? 'cursor-1' : null,
  }));
  const view = renderProfile(groupPeer);
  await view.findByText('تیم طراحی');

  fireEvent.press(view.getByTestId('profile-tab-files'));
  fireEvent.press(await view.findByTestId('profile-file-row'));
  expect(view.getByText('لیست.txt')).toBeTruthy();
  expect(Linking.openURL).toHaveBeenCalledWith(expect.stringContaining('/uploads/list.txt'));

  fireEvent.press(view.getByTestId('profile-tab-links'));
  expect(await view.findByText('example.com')).toBeTruthy();
  expect(view.getByText('ببین: https://example.com/a.')).toBeTruthy();
  fireEvent.press(view.getByTestId('profile-link-row'));
  expect(Linking.openURL).toHaveBeenLastCalledWith('https://example.com/a');

  fireEvent.press(view.getByTestId('profile-load-more'));
  // 0 media, 1 files, 2 links, 3 the next page of links.
  await waitFor(() => expect(fetchShared.mock.calls[3]).toEqual(['g1', 'links', 'cursor-1']));
  expect(await view.findByText('example.org')).toBeTruthy();
  expect(view.getAllByTestId('profile-link-row')).toHaveLength(2);
  expect(view.queryByTestId('profile-load-more')).toBeNull();
});

test('an encrypted chat explains itself instead of showing an empty grid', async () => {
  fetchE2eeState.mockResolvedValue({ e2ee: true });
  const view = renderProfile({ ...groupPeer, encrypted: true });
  expect(await view.findByText(/این گفتگو سرتاسری رمزنگاری شده/)).toBeTruthy();
  expect(fetchShared).not.toHaveBeenCalled();
  expect(view.queryByTestId('profile-tab-media')).toBeNull();
});

test('admins edit the name, and only the field that changed is sent', async () => {
  const view = renderProfile(groupPeer);
  await view.findByText('تیم طراحی');
  fireEvent.press(view.getByTestId('profile-edit'));
  fireEvent.changeText(view.getByTestId('profile-edit-name'), 'تیم تازه');
  fireEvent.press(view.getByTestId('profile-save'));
  await waitFor(() => expect(updateGroup).toHaveBeenCalledWith('g1', { name: 'تیم تازه' }));
  expect(await view.findByText('تیم تازه')).toBeTruthy();
  expect(view.queryByTestId('profile-edit-name')).toBeNull();
});

test('a plain member is offered no edit control', async () => {
  const view = renderProfile({
    ...groupPeer,
    participants: [{ id: 'me', kind: 'direct', name: 'من', role: 'MEMBER' }],
  });
  await view.findByText('تیم طراحی');
  expect(view.queryByTestId('profile-edit')).toBeNull();
});

test('a name below the server bound is refused before sending', async () => {
  const view = renderProfile(groupPeer);
  await view.findByText('تیم طراحی');
  fireEvent.press(view.getByTestId('profile-edit'));
  fireEvent.changeText(view.getByTestId('profile-edit-name'), 'ا');
  fireEvent.press(view.getByTestId('profile-save'));
  expect(await view.findByText('نام گروه باید حداقل ۲ کاراکتر باشد')).toBeTruthy();
  expect(updateGroup).not.toHaveBeenCalled();
});

test('a group rename broadcast reaches the open profile', async () => {
  const view = renderProfile(groupPeer);
  await view.findByText('تیم طراحی');
  act(() => {
    socketHandlers['group:updated']({
      id: 'g1', name: 'تیم محصول', description: 'بیو تازه', e2ee: false, avatar: null, participants: [],
    });
  });
  expect(await view.findByText('تیم محصول')).toBeTruthy();
  expect(view.getByText('بیو تازه')).toBeTruthy();
});
