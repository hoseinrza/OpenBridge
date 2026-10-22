import { render, fireEvent } from '@testing-library/react-native';
import ChatHeaderTitle from '../src/components/ChatHeaderTitle';

test('a group header names the chat, counts its members and opens the profile', () => {
  const onPress = jest.fn();
  const view = render(
    <ChatHeaderTitle peer={{ kind: 'group', name: 'تیم طراحی', memberCount: 12 }} onPress={onPress} />,
  );
  expect(view.getByText('تیم طراحی')).toBeTruthy();
  expect(view.getByText('۱۲ عضو')).toBeTruthy();
  fireEvent.press(view.getByTestId('chat-header-profile'));
  expect(onPress).toHaveBeenCalledTimes(1);
});

test('a contact header shows whether that person is online', () => {
  const view = render(<ChatHeaderTitle peer={{ kind: 'direct', name: 'سارا', status: 'online' }} onPress={jest.fn()} />);
  expect(view.getByText('سارا')).toBeTruthy();
  expect(view.getByText('آنلاین')).toBeTruthy();
});
