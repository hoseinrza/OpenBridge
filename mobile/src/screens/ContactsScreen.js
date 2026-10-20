import { useCallback, useMemo, useRef, useState } from 'react';
import {
  ActivityIndicator, Linking, Pressable, SectionList, StyleSheet, Text, View,
} from 'react-native';
import { FontAwesome6 } from '@expo/vector-icons';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { ensureContactsAccess, loadContactsWithAccounts } from '../services/contacts';
import { normalizeUser } from '../services/api';
import { fonts, radius, spacing, type, useAppTheme } from '../theme';
import Avatar from '../components/Avatar';

const fa = value => (Number.isFinite(value) ? value.toLocaleString('fa-IR') : '۰');

export default function ContactsScreen({ navigation }) {
  const { colors } = useAppTheme();
  const insets = useSafeAreaInsets();
  const [phase, setPhase] = useState('ask');
  const [canAskAgain, setCanAskAgain] = useState(true);
  const [error, setError] = useState('');
  const [refreshing, setRefreshing] = useState(false);
  const [showWithout, setShowWithout] = useState(false);
  const [data, setData] = useState({ checked: 0, withAccounts: [], withoutAccounts: [] });
  const loadedRef = useRef(false);

  const styles = useMemo(() => makeStyles(colors), [colors]);

  const sync = useCallback(async () => {
    setError('');
    if (loadedRef.current) setRefreshing(true);
    else setPhase('loading');
    try {
      const access = await ensureContactsAccess();
      if (!access.granted) {
        setCanAskAgain(access.canAskAgain);
        setPhase('denied');
        return;
      }
      const result = await loadContactsWithAccounts();
      setData(result);
      loadedRef.current = true;
      setPhase('ready');
    } catch (err) {
      setError(err?.message ?? 'دریافت مخاطبین ناموفق بود');
      if (!loadedRef.current) setPhase('ask');
    } finally {
      setRefreshing(false);
    }
  }, []);

  function renderPerson(contact, peer) {
    return (
      <View style={styles.row}>
        <Avatar uri={peer.avatar} name={peer.name} status={peer.status} />
        <View style={styles.rowBody}>
          <Text style={styles.rowName} numberOfLines={1}>{peer.name}</Text>
          <View style={styles.rowMeta}>
            {!!peer.username && (
              <Text style={styles.rowHandle} numberOfLines={1} writingDirection="ltr">@{peer.username}</Text>
            )}
            <FontAwesome6 name="mobile-screen-button" size={10} color={colors.text3} />
            <Text style={styles.rowNumber} numberOfLines={1} writingDirection="ltr">{contact.phone}</Text>
          </View>
        </View>
      </View>
    );
  }

  function renderItem({ item, section }) {
    if (section.key === 'others') {
      return (
        <View style={styles.row}>
          <Avatar name={item.name || item.phone || '؟'} />
          <View style={styles.rowBody}>
            <Text style={styles.rowName} numberOfLines={1}>{item.name || 'بی‌نام'}</Text>
            {!!item.phone && (
              <Text style={styles.rowNumber} numberOfLines={1} writingDirection="ltr">{item.phone}</Text>
            )}
          </View>
          <Text style={styles.rowTag}>بدون حساب</Text>
        </View>
      );
    }

    const peer = normalizeUser(item.user);
    return (
      <Pressable
        style={({ pressed }) => [styles.row, pressed && styles.rowPressed]}
        onPress={() => navigation.replace('Chat', { peer })}
        accessibilityRole="button"
        accessibilityLabel={`گفتگو با ${peer.name}`}
      >
        {renderPerson(item, peer)}
        <FontAwesome6 name="chevron-left" size={13} color={colors.text3} />
      </Pressable>
    );
  }

  if (phase !== 'ready') {
    const busy = phase === 'loading';
    const denied = phase === 'denied';
    return (
      <View style={styles.container}>
        <View style={styles.stateWrap}>
          <View style={styles.stateIcon}>
            <FontAwesome6 name={denied ? 'lock' : 'address-book'} size={24} color={colors.accentText} />
          </View>
          <Text style={styles.stateTitle}>
            {denied ? 'دسترسی به مخاطبین داده نشد' : 'مخاطبین تو در OpenBridge'}
          </Text>
          <Text style={styles.stateText}>
            {denied
              ? 'برای دیدن مخاطبینی که حساب دارند، در تنظیمات گوشی به OpenBridge دسترسی مخاطبین بده، سپس دوباره تلاش کن.'
              : 'شماره‌های ذخیره‌شده در گوشی با حساب‌های OpenBridge مقایسه می‌شوند. شماره‌ها در سرور ذخیره نمی‌شوند و تنها نتیجهٔ مقایسه برمی‌گردد.'}
          </Text>

          {!!error && (
            <View style={styles.errorBanner} accessibilityRole="alert">
              <FontAwesome6 name="triangle-exclamation" size={13} color={colors.danger} />
              <Text style={styles.errorText}>{error}</Text>
            </View>
          )}

          <Pressable
            style={[styles.primaryBtn, busy && styles.primaryBtnDisabled]}
            onPress={sync}
            disabled={busy}
            accessibilityRole="button"
            accessibilityLabel={denied ? 'تلاش دوباره برای دسترسی به مخاطبین' : 'دریافت مخاطبین'}
          >
            {busy
              ? <ActivityIndicator size="small" color={colors.onAccent} />
              : <FontAwesome6 name={denied ? 'arrow-rotate-right' : 'address-book'} size={14} color={colors.onAccent} />}
            <Text style={styles.primaryBtnText}>
              {busy ? 'در حال بررسی…' : denied ? 'تلاش دوباره' : 'دریافت مخاطبین'}
            </Text>
          </Pressable>

          {denied && !canAskAgain && (
            <Pressable
              style={styles.textBtn}
              onPress={() => Linking.openSettings()}
              accessibilityRole="button"
              accessibilityLabel="باز کردن تنظیمات گوشی"
            >
              <Text style={styles.textBtnText}>باز کردن تنظیمات گوشی</Text>
            </Pressable>
          )}
        </View>
      </View>
    );
  }

  const sections = [
    { key: 'matched', title: `در OpenBridge (${fa(data.withAccounts.length)})`, data: data.withAccounts },
  ];
  if (showWithout && data.withoutAccounts.length) {
    sections.push({
      key: 'others',
      title: `مخاطبین بدون حساب (${fa(data.withoutAccounts.length)})`,
      data: data.withoutAccounts,
    });
  }

  return (
    <View style={styles.container}>
      <SectionList
        sections={sections}
        keyExtractor={(item, index) => `${item.phone ?? 'contact'}-${index}`}
        renderItem={renderItem}
        renderSectionHeader={({ section }) => (
          <Text style={styles.sectionTitle}>{section.title}</Text>
        )}
        ListHeaderComponent={(
          <View style={styles.summary}>
            <FontAwesome6 name="circle-check" size={13} color={colors.success} />
            <Text style={styles.summaryText}>{fa(data.checked)} شماره از مخاطبین بررسی شد.</Text>
            {!data.withAccounts.length && (
              <Text style={styles.summaryHint}>هنوز هیچ‌یک از مخاطبینت حساب OpenBridge ندارد.</Text>
            )}
          </View>
        )}
        ListFooterComponent={!!data.withoutAccounts.length && (
          <Pressable
            style={styles.textBtn}
            onPress={() => setShowWithout(value => !value)}
            accessibilityRole="button"
          >
            <Text style={styles.textBtnText}>
              {showWithout
                ? 'پنهان‌کردن مخاطبین بدون حساب'
                : `نمایش مخاطبین بدون حساب (${fa(data.withoutAccounts.length)})`}
            </Text>
          </Pressable>
        )}
        refreshing={refreshing}
        onRefresh={sync}
        stickySectionHeadersEnabled={false}
        contentContainerStyle={[styles.listContent, { paddingBottom: spacing.xl + insets.bottom }]}
        ItemSeparatorComponent={() => <View style={styles.separator} />}
      />
    </View>
  );
}

function makeStyles(colors) {
  return StyleSheet.create({
    container: { flex: 1, backgroundColor: colors.bg },

    stateWrap: {
      flex: 1,
      alignItems: 'center',
      justifyContent: 'center',
      gap: spacing.md,
      padding: spacing.xxl,
    },
    stateIcon: {
      width: 64, height: 64, borderRadius: radius.xl,
      backgroundColor: colors.accentSoft,
      alignItems: 'center', justifyContent: 'center',
    },
    stateTitle: { color: colors.text1, fontFamily: fonts.semibold, fontSize: type.md, textAlign: 'center' },
    stateText: {
      color: colors.text2,
      fontFamily: fonts.regular,
      fontSize: type.sm,
      textAlign: 'center',
      lineHeight: 22,
    },

    primaryBtn: {
      flexDirection: 'row-reverse',
      alignItems: 'center',
      justifyContent: 'center',
      gap: spacing.sm,
      marginTop: spacing.sm,
      minHeight: 48,
      paddingHorizontal: spacing.xl,
      borderRadius: radius.md,
      backgroundColor: colors.accent,
    },
    primaryBtnDisabled: { opacity: 0.7 },
    primaryBtnText: { color: colors.onAccent, fontFamily: fonts.semibold, fontSize: type.base },
    textBtn: { minHeight: 44, paddingHorizontal: spacing.md, alignItems: 'center', justifyContent: 'center' },
    textBtnText: { color: colors.accentText, fontFamily: fonts.semibold, fontSize: type.sm },

    errorBanner: {
      flexDirection: 'row-reverse',
      alignItems: 'center',
      gap: spacing.sm,
      paddingHorizontal: spacing.md,
      paddingVertical: spacing.sm,
      borderRadius: radius.sm,
      backgroundColor: colors.dangerSoft,
    },
    errorText: {
      flex: 1,
      color: colors.text1,
      fontFamily: fonts.regular,
      fontSize: type.sm,
      textAlign: 'right',
    },

    listContent: { paddingHorizontal: spacing.md },
    summary: {
      flexDirection: 'row-reverse',
      alignItems: 'center',
      flexWrap: 'wrap',
      gap: spacing.sm,
      paddingHorizontal: spacing.sm,
      paddingVertical: spacing.md,
    },
    summaryText: { color: colors.text2, fontFamily: fonts.regular, fontSize: type.sm },
    summaryHint: { width: '100%', color: colors.text3, fontFamily: fonts.regular, fontSize: type.xs },

    sectionTitle: {
      color: colors.text3,
      fontFamily: fonts.semibold,
      fontSize: type.xs,
      textAlign: 'right',
      paddingHorizontal: spacing.sm,
      paddingTop: spacing.md,
      paddingBottom: spacing.xs,
    },
    row: {
      flexDirection: 'row-reverse',
      alignItems: 'center',
      gap: spacing.md,
      minHeight: 64,
      paddingHorizontal: spacing.sm,
      paddingVertical: spacing.sm,
      borderRadius: radius.md,
      backgroundColor: colors.surface,
    },
    rowPressed: { backgroundColor: colors.surface2 },
    rowBody: { flex: 1, gap: 3 },
    rowName: { color: colors.text1, fontFamily: fonts.semibold, fontSize: type.base, textAlign: 'right' },
    rowMeta: { flexDirection: 'row-reverse', alignItems: 'center', gap: spacing.xs },
    rowHandle: { flexShrink: 1, color: colors.text3, fontFamily: fonts.regular, fontSize: type.xs },
    rowNumber: { color: colors.text3, fontFamily: fonts.regular, fontSize: type.xs },
    rowTag: { color: colors.text3, fontFamily: fonts.medium, fontSize: type.xs },
    separator: { height: 1, backgroundColor: colors.border, marginHorizontal: spacing.md },
  });
}
