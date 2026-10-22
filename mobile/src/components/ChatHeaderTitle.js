import { Pressable, StyleSheet, Text } from 'react-native';
import { useAppTheme, fonts, type, spacing } from '../theme';
import { fa } from '../utils/persian';

// Telegram opens a chat's profile from its header, so the title is the button:
// the name plus the one line that says who is there, and nothing else to tap.
export default function ChatHeaderTitle({ peer, onPress }) {
  const { colors } = useAppTheme();
  const isGroup = peer?.kind === 'group';
  const subtitle = isGroup
    ? `${fa(peer?.memberCount ?? 0)} عضو`
    : (peer?.status === 'online' ? 'آنلاین' : 'آفلاین');

  return (
    <Pressable
      onPress={onPress}
      style={styles.wrap}
      testID="chat-header-profile"
      accessibilityRole="button"
      accessibilityLabel={`بازکردن اطلاعات ${peer?.name ?? 'گفتگو'}`}
    >
      <Text style={[styles.title, { color: colors.text1 }]} numberOfLines={1}>{peer?.name}</Text>
      <Text style={[styles.subtitle, { color: isGroup ? colors.text3 : (peer?.status === 'online' ? colors.success : colors.text3) }]}>
        {subtitle}
      </Text>
    </Pressable>
  );
}

const styles = StyleSheet.create({
  wrap: { flex: 1, alignItems: 'center', justifyContent: 'center', paddingHorizontal: spacing.sm },
  title: { fontFamily: fonts.semibold, fontSize: type.md },
  subtitle: { fontFamily: fonts.regular, fontSize: type.xs, marginTop: 1 },
});
