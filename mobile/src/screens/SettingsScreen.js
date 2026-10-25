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

export default function SettingsScreen() {
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
          <Text style={styles.name}>{currentUser.name}</Text>
          <Text style={styles.username} dir="ltr">@{currentUser.username}</Text>
        </View>
      </View>

      <Text style={styles.sectionTitle}>ظاهر</Text>
      <View style={styles.group}>
        {THEME_OPTIONS.map((option, index) => {
          const selected = themeMode === option.value;
          return (
            <Pressable
              key={option.value}
              onPress={() => setThemeMode(option.value)}
              accessibilityRole="radio"
              accessibilityState={{ selected }}
              accessibilityLabel={option.label}
              style={({ pressed }) => [
                styles.row,
                index > 0 && styles.rowDivider,
                pressed && styles.rowPressed,
              ]}
            >
              <Text style={styles.rowLabel}>{option.label}</Text>
              {selected && <FontAwesome6 name="check" size={14} color={colors.accent} />}
            </Pressable>
          );
        })}
      </View>

      <Text style={styles.sectionTitle}>حساب</Text>
      <Pressable
        onPress={confirmLogout}
        accessibilityRole="button"
        accessibilityLabel="خروج از حساب"
        style={({ pressed }) => [styles.group, styles.logout, pressed && styles.rowPressed]}
      >
        <FontAwesome6 name="right-from-bracket" size={16} color={colors.danger} />
        <Text style={styles.logoutText}>خروج از حساب</Text>
      </Pressable>
    </ScrollView>
  );
}

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
      flexDirection: 'row',
      alignItems: 'center',
      gap: spacing.md,
      padding: spacing.md,
    },
    identityText: { flex: 1 },
    name: { ...navFonts.bold, fontSize: type.lg, color: colors.text1 },
    username: { ...navFonts.regular, fontSize: type.sm, color: colors.text2, marginTop: 2 },
    sectionTitle: {
      ...navFonts.medium,
      fontSize: type.sm,
      color: colors.text3,
      marginTop: spacing.sm,
      marginStart: spacing.xs,
    },
    row: {
      flexDirection: 'row',
      alignItems: 'center',
      justifyContent: 'space-between',
      paddingHorizontal: spacing.md,
      paddingVertical: 14,
    },
    rowDivider: { borderTopWidth: StyleSheet.hairlineWidth, borderTopColor: colors.border },
    rowPressed: { opacity: 0.7 },
    rowLabel: { ...navFonts.medium, fontSize: type.base, color: colors.text1 },
    logout: {
      flexDirection: 'row',
      alignItems: 'center',
      justifyContent: 'center',
      gap: spacing.sm,
      paddingVertical: spacing.md,
    },
    logoutText: { ...navFonts.medium, fontSize: type.base, color: colors.danger },
  });
}
