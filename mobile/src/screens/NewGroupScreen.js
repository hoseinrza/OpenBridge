import { useEffect, useMemo, useRef, useState } from 'react';
import {
  ActivityIndicator, FlatList, KeyboardAvoidingView, Platform, Pressable,
  StyleSheet, Text, TextInput, View,
} from 'react-native';
import { FontAwesome6 } from '@expo/vector-icons';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { useAuth } from '../context/AuthContext';
import { createGroup, normalizeGroup, normalizeUser, searchUsers } from '../services/api';
import { fonts, radius, spacing, type, useAppTheme } from '../theme';
import Avatar from '../components/Avatar';

const SEARCH_DEBOUNCE = 350;

export default function NewGroupScreen({ navigation }) {
  const { currentUser } = useAuth();
  const { colors } = useAppTheme();
  const insets = useSafeAreaInsets();
  const [name, setName] = useState('');
  const [query, setQuery] = useState('');
  const [results, setResults] = useState([]);
  const [selected, setSelected] = useState([]);
  const [searching, setSearching] = useState(false);
  const [creating, setCreating] = useState(false);
  const [error, setError] = useState('');
  const debounceRef = useRef(null);

  const styles = useMemo(() => makeStyles(colors), [colors]);

  useEffect(() => () => clearTimeout(debounceRef.current), []);

  useEffect(() => {
    clearTimeout(debounceRef.current);
    const q = query.trim();
    if (!q) {
      setResults([]);
      setSearching(false);
      return undefined;
    }

    debounceRef.current = setTimeout(async () => {
      setSearching(true);
      setError('');
      try {
        const list = await searchUsers(q);
        setResults(
          list
            .map(normalizeUser)
            .filter(user => user && user.id !== currentUser?.id),
        );
      } catch (err) {
        setError(err.message ?? 'جستجو ناموفق بود؛ اتصال را بررسی کن');
        setResults([]);
      } finally {
        setSearching(false);
      }
    }, SEARCH_DEBOUNCE);

    return () => clearTimeout(debounceRef.current);
  }, [query, currentUser?.id]);

  function toggleMember(user) {
    setError('');
    setSelected(prev => (
      prev.some(item => item.id === user.id)
        ? prev.filter(item => item.id !== user.id)
        : [...prev, user]
    ));
  }

  async function handleCreate() {
    if (creating) return;
    const trimmed = name.trim();
    if (trimmed.length < 2) {
      setError('نام گروه باید حداقل ۲ کاراکتر باشد');
      return;
    }
    if (selected.length === 0) {
      setError('حداقل یک عضو دیگر انتخاب کن');
      return;
    }

    setCreating(true);
    setError('');
    try {
      const conversation = await createGroup(trimmed, selected.map(item => item.id));
      navigation.replace('Chat', { peer: normalizeGroup(conversation) });
    } catch (err) {
      setError(err.message ?? 'ساخت گروه ناموفق بود');
    } finally {
      setCreating(false);
    }
  }

  function renderResult({ item }) {
    const isSelected = selected.some(user => user.id === item.id);
    return (
      <Pressable
        style={({ pressed }) => [
          styles.result,
          isSelected && styles.resultSelected,
          pressed && styles.resultPressed,
        ]}
        onPress={() => toggleMember(item)}
        accessibilityRole="button"
        accessibilityLabel={`${item.name}${item.username ? `، @${item.username}` : ''}`}
        accessibilityState={{ selected: isSelected }}
      >
        <Avatar uri={item.avatar} name={item.name} size={38} status={item.status} />
        <View style={styles.resultBody}>
          <Text style={styles.resultName} numberOfLines={1}>{item.name}</Text>
          {!!item.username && (
            <Text style={styles.resultUsername} numberOfLines={1}>@{item.username}</Text>
          )}
        </View>
        <View style={[styles.check, isSelected && styles.checkOn]}>
          <FontAwesome6
            name={isSelected ? 'check' : 'plus'}
            size={12}
            color={isSelected ? colors.onAccent : colors.text2}
          />
        </View>
      </Pressable>
    );
  }

  const valid = name.trim().length >= 2 && selected.length > 0;
  const canCreate = valid && !creating;

  return (
    <KeyboardAvoidingView
      style={styles.container}
      behavior={Platform.OS === 'ios' ? 'padding' : undefined}
      keyboardVerticalOffset={Platform.OS === 'ios' ? 96 : 0}
    >
      <FlatList
        data={results}
        keyExtractor={item => item.id}
        renderItem={renderResult}
        keyboardShouldPersistTaps="handled"
        contentContainerStyle={styles.listContent}
        ListHeaderComponent={(
          <View style={styles.header}>
            <View style={styles.field}>
              <Text style={styles.label}>نام گروه</Text>
              <TextInput
                style={styles.input}
                value={name}
                onChangeText={(value) => { setName(value); setError(''); }}
                placeholder="مثلاً تیم طراحی"
                placeholderTextColor={colors.text3}
                maxLength={60}
                accessibilityLabel="نام گروه"
                returnKeyType="next"
              />
            </View>

            {selected.length > 0 && (
              <View style={styles.chips} accessibilityLabel="اعضای انتخاب‌شده">
                {selected.map(user => (
                  <View key={user.id} style={styles.chip}>
                    <Avatar uri={user.avatar} name={user.name} size={20} />
                    <Text style={styles.chipName} numberOfLines={1}>{user.name}</Text>
                    <Pressable
                      onPress={() => toggleMember(user)}
                      hitSlop={8}
                      style={styles.chipRemove}
                      accessibilityRole="button"
                      accessibilityLabel={`حذف ${user.name}`}
                    >
                      <FontAwesome6 name="xmark" size={10} color={colors.text2} />
                    </Pressable>
                  </View>
                ))}
              </View>
            )}

            <View style={styles.field}>
              <Text style={styles.label}>اعضا</Text>
              <View style={styles.searchWrap}>
                <FontAwesome6 name="magnifying-glass" size={13} color={colors.text3} />
                <TextInput
                  style={styles.searchInput}
                  value={query}
                  onChangeText={setQuery}
                  placeholder="جستجوی نام نمایشی یا نام کاربری…"
                  placeholderTextColor={colors.text3}
                  autoCapitalize="none"
                  autoCorrect={false}
                  accessibilityLabel="جستجوی عضو برای افزودن"
                  returnKeyType="search"
                />
                {searching && <ActivityIndicator size="small" color={colors.accent} />}
              </View>
            </View>

            {!!error && (
              <View style={styles.errorBanner} accessibilityRole="alert">
                <FontAwesome6 name="triangle-exclamation" size={12} color={colors.danger} />
                <Text style={styles.errorText}>{error}</Text>
              </View>
            )}

            {!query.trim() && (
              <View style={styles.hintState}>
                <FontAwesome6 name="user-plus" size={20} color={colors.accentText} />
                <Text style={styles.hintText}>
                  اعضای گروه را با نام نمایشی یا نام کاربری جستجو و انتخاب کن.
                </Text>
              </View>
            )}

            {!!query.trim() && !searching && results.length === 0 && !error && (
              <View style={styles.hintState}>
                <FontAwesome6 name="user-slash" size={20} color={colors.text3} />
                <Text style={styles.hintText}>کاربری با این نام پیدا نشد.</Text>
              </View>
            )}
          </View>
        )}
      />

      <View style={[styles.footer, { paddingBottom: Math.max(insets.bottom, spacing.md) }]}>
        <Pressable
          style={[styles.createBtn, !valid && styles.createBtnDisabled]}
          onPress={handleCreate}
          disabled={!canCreate}
          accessibilityRole="button"
          accessibilityLabel={selected.length > 0 ? `ساخت گروه با ${selected.length} عضو` : 'ساخت گروه'}
          accessibilityState={{ disabled: !canCreate }}
        >
          {creating ? (
            <ActivityIndicator color={colors.onAccent} size="small" />
          ) : (
            <>
              <FontAwesome6 name="user-group" size={14} color={valid ? colors.onAccent : colors.text2} />
              <Text style={[styles.createText, !valid && styles.createTextDisabled]}>
                ساخت گروه
                {selected.length > 0 && ` (${selected.length.toLocaleString('fa-IR')} عضو)`}
              </Text>
            </>
          )}
        </Pressable>
      </View>
    </KeyboardAvoidingView>
  );
}

function makeStyles(colors) {
  return StyleSheet.create({
    container: { flex: 1, backgroundColor: colors.bg },
    listContent: { padding: spacing.lg, paddingBottom: spacing.xl },
    header: { gap: spacing.md },

    field: { gap: spacing.sm },
    label: { color: colors.text2, fontFamily: fonts.medium, fontSize: type.sm, textAlign: 'right' },
    input: {
      height: 48,
      paddingHorizontal: spacing.md + 2,
      borderRadius: radius.md,
      borderWidth: 1,
      borderColor: colors.borderStrong,
      backgroundColor: colors.surface,
      color: colors.text1,
      fontFamily: fonts.regular,
      fontSize: type.base,
      textAlign: 'right',
    },

    chips: { flexDirection: 'row-reverse', flexWrap: 'wrap', gap: spacing.sm },
    chip: {
      flexDirection: 'row-reverse',
      alignItems: 'center',
      gap: 6,
      maxWidth: '100%',
      paddingHorizontal: spacing.sm,
      paddingVertical: 5,
      borderRadius: radius.pill,
      backgroundColor: colors.surface2,
      borderWidth: 1,
      borderColor: colors.border,
    },
    chipName: { maxWidth: 140, color: colors.text1, fontFamily: fonts.medium, fontSize: type.xs },
    chipRemove: {
      width: 28, height: 28, borderRadius: radius.pill,
      alignItems: 'center', justifyContent: 'center',
      backgroundColor: colors.surface3,
    },

    searchWrap: {
      flexDirection: 'row-reverse',
      alignItems: 'center',
      gap: spacing.sm,
      height: 48,
      paddingHorizontal: spacing.md,
      backgroundColor: colors.surface,
      borderWidth: 1,
      borderColor: colors.border,
      borderRadius: radius.md,
    },
    searchInput: {
      flex: 1,
      color: colors.text1,
      fontFamily: fonts.regular,
      fontSize: type.base,
      textAlign: 'right',
      padding: 0,
    },

    errorBanner: {
      flexDirection: 'row-reverse',
      alignItems: 'center',
      gap: spacing.sm,
      paddingHorizontal: spacing.md,
      paddingVertical: spacing.sm,
      borderRadius: radius.sm,
      backgroundColor: colors.dangerSoft,
    },
    errorText: { flex: 1, color: colors.text1, fontFamily: fonts.regular, fontSize: type.sm, textAlign: 'right' },

    hintState: { alignItems: 'center', gap: spacing.sm, paddingVertical: spacing.xl, paddingHorizontal: spacing.lg },
    hintText: { color: colors.text3, fontFamily: fonts.regular, fontSize: type.sm, textAlign: 'center', lineHeight: 22 },

    result: {
      flexDirection: 'row-reverse',
      alignItems: 'center',
      gap: spacing.md,
      minHeight: 60,
      paddingHorizontal: spacing.sm,
      paddingVertical: spacing.sm,
      borderRadius: radius.md,
      marginTop: 2,
    },
    resultSelected: { backgroundColor: colors.accentSoft },
    resultPressed: { backgroundColor: colors.surface2 },
    resultBody: { flex: 1, gap: 2 },
    resultName: { color: colors.text1, fontFamily: fonts.semibold, fontSize: type.base, textAlign: 'right' },
    resultUsername: { color: colors.text3, fontFamily: fonts.regular, fontSize: type.xs, textAlign: 'right' },
    check: {
      width: 30, height: 30, borderRadius: radius.pill,
      alignItems: 'center', justifyContent: 'center',
      borderWidth: 1, borderColor: colors.borderStrong,
      backgroundColor: colors.surface,
    },
    checkOn: { backgroundColor: colors.accent, borderColor: colors.accent },

    footer: {
      paddingHorizontal: spacing.lg,
      paddingTop: spacing.md,
      borderTopWidth: 1,
      borderTopColor: colors.border,
      backgroundColor: colors.surface,
    },
    createBtn: {
      flexDirection: 'row-reverse',
      alignItems: 'center',
      justifyContent: 'center',
      gap: spacing.sm,
      minHeight: 48,
      borderRadius: radius.md,
      backgroundColor: colors.accent,
    },
    createBtnDisabled: { backgroundColor: colors.surface3 },
    createText: { color: colors.onAccent, fontFamily: fonts.semibold, fontSize: type.base },
    createTextDisabled: { color: colors.text2 },
  });
}
