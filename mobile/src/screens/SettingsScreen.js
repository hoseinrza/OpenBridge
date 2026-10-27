import { useMemo } from 'react';
import { Alert, Pressable, ScrollView, StyleSheet, Text, View } from 'react-native';
import { FontAwesome6 } from '@expo/vector-icons';
import { useAuth } from '../context/AuthContext';
import { useSettings } from '../context/SettingsContext';
import { navFonts, radius, spacing, type, useAppTheme } from '../theme';
import Avatar from '../components/Avatar';

const THEME_OPTIONS = [
  { value: 'system', label: 'همراه سیستم' },
  { value: 'light', label: 'روشن' },
  { value: 'dark', label: 'تیره' },
];

export default function SettingsScreen({ navigation }) {
  const { currentUser, logout } = useAuth();
  const { themeMode, setThemeMode } = useSettings();
  const { colors } = useAppTheme();
  const styles = useMemo(() => makeStyles(colors), [colors]);

  function confirmLogout() {
    Alert.alert('خروج از حساب', 'از حساب OpenBridge خارج می‌شوی؟', [
      { text: 'انصراف', style: 'cancel' },
      { text: 'خروج', style: 'destructive', onPress: logout },
    ]);
  }

  return (
    <ScrollView style={styles.screen} contentContainerStyle={styles.content}>
      <View style={[styles.group, styles.identity]}>
        <Avatar uri={currentUser.avatar} name={currentUser.name} size={56} />
        <View style={styles.identityText}>
          <Text style={styles.name} numberOfLines={1}>{currentUser.name}</Text>
          {!!currentUser?.username && (
            <Text style={styles.username} numberOfLines={1} dir="ltr">@{currentUser.username}</Text>
          )}
        </View>
      </View>

      <Text style={styles.sectionTitle}>ظاهر</Text>
      <View style={styles.group} accessibilityRole="radiogroup" accessibilityLabel="حالت نمایش">
        {THEME_OPTIONS.map((option, index) => {
          const selected = themeMode === option.value;
          return (
            <Pressable
              key={option.value}
              onPress={() => setThemeMode(option.value)}
              accessibilityRole="radio"
              accessibilityState={{ checked: selected }}
              accessibilityLabel={option.label}
              style={({ pressed }) => [
                styles.row,
                index > 0 && styles.rowDivider,
                pressed && styles.rowPressed,
              ]}
            >
              <Text style={styles.rowLabel}>{option.label}</Text>
              {/* accentText is the icon-on-dark-surface token; accent fails
                  contrast against the dark card. */}
              {selected && <FontAwesome6 name="check" size={14} color={colors.accentText} />}
            </Pressable>
          );
        })}
      </View>

      <Text style={styles.sectionTitle}>حساب</Text>
      <View style={styles.group}>
        <Pressable
          onPress={() => navigation?.navigate?.('EditProfile')}
          accessibilityRole="button"
          accessibilityLabel="ویرایش پروفایل"
          style={({ pressed }) => [styles.row, pressed && styles.rowPressed]}
        >
          <FontAwesome6 name="pen-to-square" size={16} color={colors.text2} />
          <Text style={styles.rowLabel}>ویرایش پروفایل</Text>
          <FontAwesome6 name="chevron-left" size={13} color={colors.text3} />
        </Pressable>

        <Pressable
          onPress={confirmLogout}
          accessibilityRole="button"
          accessibilityLabel="خروج از حساب"
          style={({ pressed }) => [styles.row, styles.rowDivider, pressed && styles.rowPressed]}
        >
          <FontAwesome6 name="right-from-bracket" size={16} color={colors.danger} />
          <Text style={[styles.rowLabel, styles.logoutText]}>خروج از حساب</Text>
        </Pressable>
      </View>
    </ScrollView>
  );
}

// The rows follow the rendered convention of the screens around this one
// (ChatListScreen, ContactsScreen, ChatProfileScreen): content starts at the
// right edge with `row-reverse`, and the text is right-aligned.
function makeStyles(colors) {
  return StyleSheet.create({
    screen: { flex: 1, backgroundColor: colors.bg },
    content: { padding: spacing.lg, gap: spacing.md },
    group: {
      backgroundColor: colors.surface,
      borderRadius: radius.md,
      borderWidth: StyleSheet.hairlineWidth,
      borderColor: colors.border,
      overflow: 'hidden',
    },
    identity: {
      flexDirection: 'row-reverse',
      alignItems: 'center',
      gap: spacing.md,
      padding: spacing.md,
    },
    identityText: { flex: 1 },
    name: { ...navFonts.bold, fontSize: type.lg, color: colors.text1, textAlign: 'right' },
    username: { ...navFonts.regular, fontSize: type.sm, color: colors.text2, textAlign: 'right', marginTop: 2 },
    sectionTitle: {
      ...navFonts.medium,
      fontSize: type.sm,
      color: colors.text3,
      textAlign: 'right',
      paddingHorizontal: spacing.md,
      marginTop: spacing.sm,
    },
    row: {
      flexDirection: 'row-reverse',
      alignItems: 'center',
      gap: spacing.md,
      paddingHorizontal: spacing.md,
      paddingVertical: 14,
    },
    rowDivider: { borderTopWidth: StyleSheet.hairlineWidth, borderTopColor: colors.border },
    rowPressed: { opacity: 0.7 },
    rowLabel: { ...navFonts.medium, fontSize: type.base, color: colors.text1, flex: 1, textAlign: 'right' },
    logoutText: { ...navFonts.medium, fontSize: type.base, color: colors.danger },
  });
}
