import { useCallback, useEffect, useLayoutEffect, useMemo, useState } from 'react';
import {
  ActivityIndicator, Alert, FlatList, Pressable, StyleSheet, Text, TextInput, View,
} from 'react-native';
import { FontAwesome6 } from '@expo/vector-icons';
import { useFocusEffect } from '@react-navigation/native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { useAuth } from '../context/AuthContext';
import { useSocket } from '../context/SocketContext';
import { fetchConversations, fetchGroups, normalizeGroup, normalizeUser } from '../services/api';
import { fonts, radius, spacing, type, useAppTheme } from '../theme';
import { formatConversationTime } from '../utils/time';
import Avatar from '../components/Avatar';

export default function ChatListScreen({ navigation }) {
  const { currentUser, logout } = useAuth();
  const { socket } = useSocket();
  const { colors } = useAppTheme();
  const insets = useSafeAreaInsets();
  const [items, setItems]   = useState([]);
  const [loading, setLoading] = useState(true);
  const [error, setError]   = useState('');
  const [query, setQuery]   = useState('');

  const styles = useMemo(() => makeStyles(colors), [colors]);

  useLayoutEffect(() => {
    navigation.setOptions({
      headerRight: () => (
        <Pressable
          onPress={() => navigation.navigate('NewGroup')}
          hitSlop={10}
          style={styles.headerBtn}
          accessibilityRole="button"
          accessibilityLabel="ساخت گروه جدید"
        >
          <FontAwesome6 name="users" size={17} color={colors.text1} />
          <View style={styles.headerPlus}>
            <FontAwesome6 name="plus" size={8} color={colors.onAccent} />
          </View>
        </Pressable>
      ),
    });
  }, [navigation, colors, styles]);

  const load = useCallback(async (silent = false) => {
    if (!silent) setLoading(true);
    setError('');
    try {
      const [direct, groups] = await Promise.all([fetchConversations(), fetchGroups()]);
      const list = [
        ...direct
          .filter(c => c.user)
          .map(c => ({
            ...normalizeUser(c.user),
            unread: c.unread ?? 0,
            updatedAt: c.updatedAt,
          })),
        ...groups.map(normalizeGroup).filter(Boolean),
      ].sort((a, b) => new Date(b.updatedAt ?? 0) - new Date(a.updatedAt ?? 0));
      setItems(list);
    } catch (err) {
      setError(err.message ?? 'دریافت گفتگوها ناموفق بود');
    } finally {
      setLoading(false);
    }
  }, []);

  useFocusEffect(useCallback(() => { load(); }, [load]));

  useEffect(() => {
    if (!socket) return undefined;
    const refresh = () => load(true);
    socket.on('message:new', refresh);
    socket.on('connect', refresh);
    return () => {
      socket.off('message:new', refresh);
      socket.off('connect', refresh);
    };
  }, [socket, load]);

  const visible = useMemo(() => {
    const q = query.trim().toLowerCase();
    if (!q) return items;
    return items.filter(item =>
      item.name?.toLowerCase().includes(q) || item.username?.toLowerCase().includes(q),
    );
  }, [items, query]);

  function confirmLogout() {
    Alert.alert('خروج از حساب', 'از حساب OpenBridge خارج می‌شوی؟', [
      { text: 'انصراف', style: 'cancel' },
      { text: 'خروج', style: 'destructive', onPress: logout },
    ]);
  }

  function renderRow({ item }) {
    const isGroup = item.kind === 'group';
    const unread = item.unread ?? 0;
    return (
      <Pressable
        style={({ pressed }) => [styles.row, pressed && styles.rowPressed]}
        onPress={() => navigation.navigate('Chat', { peer: item })}
        accessibilityRole="button"
        accessibilityLabel={`${item.name}${unread ? `، ${unread} پیام خوانده‌نشده` : ''}`}
      >
        <Avatar
          uri={item.avatar}
          name={item.name}
          group={isGroup}
          status={isGroup ? undefined : item.status}
        />

        <View style={styles.rowBody}>
          <View style={styles.rowTop}>
            <Text style={styles.name} numberOfLines={1}>{item.name}</Text>
            {!!item.updatedAt && (
              <Text style={styles.time}>{formatConversationTime(item.updatedAt)}</Text>
            )}
          </View>

          <View style={styles.rowBottom}>
            <Text style={styles.meta} numberOfLines={1}>
              {isGroup ? `${item.memberCount ?? 0} عضو` : `@${item.username ?? ''}`}
            </Text>
            {unread > 0 && (
              <View style={styles.badge} accessibilityLabel={`${unread} پیام خوانده‌نشده`}>
                <Text style={styles.badgeText}>{unread.toLocaleString('fa-IR')}</Text>
              </View>
            )}
          </View>
        </View>
      </Pressable>
    );
  }

  const empty = !loading && !error && visible.length === 0;

  return (
    <View style={styles.container}>
      <View style={styles.searchWrap}>
        <FontAwesome6 name="magnifying-glass" size={13} color={colors.text3} />
        <TextInput
          style={styles.searchInput}
          value={query}
          onChangeText={setQuery}
          placeholder="جستجوی گفتگو…"
          placeholderTextColor={colors.text3}
          accessibilityLabel="جستجوی گفتگو"
          returnKeyType="search"
        />
        {!!query && (
          <Pressable
            onPress={() => setQuery('')}
            hitSlop={10}
            style={styles.searchClear}
            accessibilityRole="button"
            accessibilityLabel="پاک‌کردن جستجو"
          >
            <FontAwesome6 name="xmark" size={12} color={colors.text2} />
          </Pressable>
        )}
      </View>

      {!!error && (
        <View style={styles.errorBanner} accessibilityRole="alert">
          <FontAwesome6 name="triangle-exclamation" size={13} color={colors.danger} />
          <Text style={styles.errorText}>{error}</Text>
          <Pressable onPress={() => load()} hitSlop={8} accessibilityRole="button">
            <Text style={styles.retryText}>تلاش دوباره</Text>
          </Pressable>
        </View>
      )}

      {loading && items.length === 0 ? (
        <View style={styles.state}>
          <ActivityIndicator color={colors.accent} />
          <Text style={styles.stateText}>در حال بارگذاری گفتگوها…</Text>
        </View>
      ) : empty ? (
        <View style={styles.state}>
          <View style={styles.emptyIcon}>
            <FontAwesome6 name={query ? 'magnifying-glass' : 'comments'} size={24} color={colors.accentText} />
          </View>
          <Text style={styles.emptyTitle}>
            {query ? 'گفتگویی پیدا نشد' : 'هنوز گفتگویی نداری'}
          </Text>
          <Text style={styles.stateText}>
            {query
              ? 'عبارت دیگری را جستجو کن.'
              : 'گفتگوها پس از رد و بدل شدن پیام اینجا نمایش داده می‌شوند. با دکمهٔ بالای صفحه یک گروه بساز.'}
          </Text>
          {query ? (
            <Pressable style={styles.stateBtn} onPress={() => setQuery('')} accessibilityRole="button">
              <Text style={styles.stateBtnText}>پاک‌کردن جستجو</Text>
            </Pressable>
          ) : (
            <Pressable
              style={styles.stateBtn}
              onPress={() => navigation.navigate('NewGroup')}
              accessibilityRole="button"
            >
              <FontAwesome6 name="users" size={13} color={colors.onAccent} />
              <Text style={styles.stateBtnText}>ساخت گروه جدید</Text>
            </Pressable>
          )}
        </View>
      ) : (
        <FlatList
          data={visible}
          keyExtractor={item => `${item.kind}-${item.id}`}
          renderItem={renderRow}
          refreshing={loading}
          onRefresh={() => load()}
          keyboardShouldPersistTaps="handled"
          contentContainerStyle={styles.listContent}
          ItemSeparatorComponent={() => <View style={styles.separator} />}
        />
      )}

      <View style={[styles.footer, { paddingBottom: spacing.sm + insets.bottom }]}>
        <View style={styles.footerUser}>
          <Avatar uri={currentUser?.avatar} name={currentUser?.name} size={32} />
          <View style={styles.footerText}>
            <Text style={styles.myName} numberOfLines={1}>{currentUser?.name}</Text>
            {!!currentUser?.username && (
              <Text style={styles.myUsername} numberOfLines={1}>@{currentUser.username}</Text>
            )}
          </View>
        </View>
        <Pressable
          onPress={confirmLogout}
          hitSlop={10}
          style={styles.logoutBtn}
          accessibilityRole="button"
          accessibilityLabel="خروج از حساب"
        >
          <FontAwesome6 name="right-from-bracket" size={16} color={colors.text2} />
        </Pressable>
      </View>
    </View>
  );
}

function makeStyles(colors) {
  return StyleSheet.create({
    container: { flex: 1, backgroundColor: colors.bg },

    searchWrap: {
      flexDirection: 'row-reverse',
      alignItems: 'center',
      gap: spacing.sm,
      marginHorizontal: spacing.lg,
      marginTop: spacing.md,
      marginBottom: spacing.sm,
      paddingHorizontal: spacing.md,
      height: 44,
      backgroundColor: colors.surface,
      borderWidth: 1,
      borderColor: colors.border,
      borderRadius: radius.md,
    },
    searchInput: {
      flex: 1,
      minHeight: 42,
      color: colors.text1,
      fontFamily: fonts.regular,
      fontSize: type.base,
      textAlign: 'right',
      padding: 0,
    },
    searchClear: {
      width: 28, height: 28, borderRadius: radius.pill,
      alignItems: 'center', justifyContent: 'center',
      backgroundColor: colors.surface2,
    },

    listContent: { paddingHorizontal: spacing.md, paddingBottom: spacing.sm },
    row: {
      flexDirection: 'row-reverse',
      alignItems: 'center',
      gap: spacing.md,
      paddingHorizontal: spacing.sm,
      paddingVertical: spacing.sm + 2,
      minHeight: 64,
      borderRadius: radius.md,
    },
    rowPressed: { backgroundColor: colors.surface2 },
    rowBody: { flex: 1, gap: 3 },
    rowTop: { flexDirection: 'row-reverse', alignItems: 'center', gap: spacing.sm },
    rowBottom: { flexDirection: 'row-reverse', alignItems: 'center', gap: spacing.sm },
    name: {
      flex: 1,
      color: colors.text1,
      fontFamily: fonts.semibold,
      fontSize: type.base,
      textAlign: 'right',
    },
    time: {
      color: colors.text3,
      fontFamily: fonts.regular,
      fontSize: type.xs,
    },
    meta: {
      flex: 1,
      color: colors.text3,
      fontFamily: fonts.regular,
      fontSize: type.sm,
      textAlign: 'right',
    },
    separator: { height: 1, backgroundColor: colors.border, marginHorizontal: spacing.lg },

    badge: {
      minWidth: 20, height: 20, paddingHorizontal: 6,
      borderRadius: radius.pill,
      backgroundColor: colors.accent,
      alignItems: 'center', justifyContent: 'center',
    },
    badgeText: { color: colors.onAccent, fontFamily: fonts.semibold, fontSize: type.xs },

    state: {
      flex: 1,
      alignItems: 'center',
      justifyContent: 'center',
      gap: spacing.md,
      paddingHorizontal: spacing.xxxl,
    },
    stateText: {
      color: colors.text2,
      fontFamily: fonts.regular,
      fontSize: type.sm,
      textAlign: 'center',
      lineHeight: 22,
    },
    emptyIcon: {
      width: 64, height: 64, borderRadius: radius.xl,
      backgroundColor: colors.accentSoft,
      alignItems: 'center', justifyContent: 'center',
    },
    emptyTitle: { color: colors.text1, fontFamily: fonts.semibold, fontSize: type.md },
    stateBtn: {
      flexDirection: 'row-reverse',
      alignItems: 'center',
      gap: spacing.sm,
      marginTop: spacing.sm,
      minHeight: 44,
      paddingHorizontal: spacing.lg,
      borderRadius: radius.md,
      backgroundColor: colors.accent,
    },
    stateBtnText: { color: colors.onAccent, fontFamily: fonts.semibold, fontSize: type.base },

    errorBanner: {
      flexDirection: 'row-reverse',
      alignItems: 'center',
      gap: spacing.sm,
      marginHorizontal: spacing.lg,
      marginBottom: spacing.sm,
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
    retryText: { color: colors.accentText, fontFamily: fonts.semibold, fontSize: type.sm },

    footer: {
      flexDirection: 'row-reverse',
      alignItems: 'center',
      gap: spacing.md,
      paddingHorizontal: spacing.lg,
      paddingTop: spacing.sm,
      paddingBottom: spacing.sm,
      borderTopWidth: 1,
      borderTopColor: colors.border,
      backgroundColor: colors.surface,
    },
    footerUser: { flex: 1, flexDirection: 'row-reverse', alignItems: 'center', gap: spacing.sm },
    footerText: { flex: 1 },
    myName: { color: colors.text1, fontFamily: fonts.semibold, fontSize: type.sm, textAlign: 'right' },
    myUsername: { color: colors.text3, fontFamily: fonts.regular, fontSize: type.xs, textAlign: 'right' },
    logoutBtn: {
      width: 44, height: 44, borderRadius: radius.md,
      alignItems: 'center', justifyContent: 'center',
      backgroundColor: colors.surface2,
    },

    headerBtn: {
      width: 40, height: 40,
      alignItems: 'center', justifyContent: 'center',
      marginHorizontal: spacing.xs,
    },
    headerPlus: {
      position: 'absolute', top: 6, right: 4,
      width: 14, height: 14, borderRadius: radius.pill,
      backgroundColor: colors.accent,
      alignItems: 'center', justifyContent: 'center',
    },
  });
}
