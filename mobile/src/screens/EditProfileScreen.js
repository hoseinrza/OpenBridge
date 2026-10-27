import { useMemo, useState } from 'react';
import {
  ActivityIndicator, KeyboardAvoidingView, Platform, Pressable,
  ScrollView, StyleSheet, Text, TextInput, View,
} from 'react-native';
import { FontAwesome6 } from '@expo/vector-icons';
import { useAuth } from '../context/AuthContext';
import Avatar from '../components/Avatar';
import { fonts, radius, spacing, type, useAppTheme } from '../theme';

const USERNAME_PATTERN = /^[a-zA-Z0-9_]{2,30}$/;
// Mirrors the backend rule: letters of any script (Persian ZWNJ included),
// spaces, apostrophes and hyphens; at least two characters.
const NAME_PATTERN = /^[\p{L}][\p{L}\p{M}\u200c'’ .-]{1,49}$/u;

// Built from code points: a typed Persian-digit literal can silently lose
// characters, and every label through it would then read wrong.
const DIGIT_MAP = Array.from({ length: 10 }, (_, index) => String.fromCharCode(0x06f0 + index)).join('');

function persian(value) {
  return String(value).replace(/\d/g, (digit) => DIGIT_MAP[Number(digit)]);
}

// Accounts predating the name split only have a display name, so fall back to
// its first word rather than showing an empty required field.
function nameParts(user) {
  if (user?.firstName) {
    return { firstName: user.firstName, lastName: user.lastName ?? '' };
  }
  const parts = String(user?.name ?? '').trim().split(/\s+/).filter(Boolean);
  return { firstName: parts[0] ?? '', lastName: parts.slice(1).join(' ') };
}

export default function EditProfileScreen({ navigation }) {
  const { currentUser, saveProfile } = useAuth();
  const { colors } = useAppTheme();
  const styles = useMemo(() => makeStyles(colors), [colors]);

  const [firstName, setFirstName] = useState(() => nameParts(currentUser).firstName);
  const [lastName, setLastName] = useState(() => nameParts(currentUser).lastName);
  const [username, setUsername] = useState(currentUser?.username ?? '');
  const [bio, setBio] = useState(currentUser?.bio ?? '');
  const [error, setError] = useState('');
  const [saving, setSaving] = useState(false);

  const given  = firstName.trim();
  const family = lastName.trim();
  const handle = username.trim();
  const previewName = [given, family].filter(Boolean).join(' ') || currentUser?.name;

  async function submit() {
    if (saving) return;
    if (!NAME_PATTERN.test(given)) {
      setError('نام باید حداقل ۲ حرف باشد و عدد نداشته باشد');
      return;
    }
    if (family && !NAME_PATTERN.test(family)) {
      setError('نام خانوادگی باید حداقل ۲ حرف باشد و عدد نداشته باشد');
      return;
    }
    // Legacy accounts may hold a handle the current rule would reject. Only a
    // changed handle is validated, so editing the name alone still works for
    // them, and an unchanged one is never sent back to the server.
    if (handle !== currentUser?.username && !USERNAME_PATTERN.test(handle)) {
      setError('نام کاربری باید ۲ تا ۳۰ کاراکتر و فقط حروف انگلیسی، عدد و _ باشد');
      return;
    }

    setSaving(true);
    setError('');
    try {
      const patch = { firstName: given, lastName: family, bio: bio.trim() };
      if (handle !== currentUser?.username) patch.username = handle;
      await saveProfile(patch);
      navigation?.goBack?.();
    } catch (err) {
      setError(err.message ?? 'ذخیره تغییرات ناموفق بود');
    } finally {
      setSaving(false);
    }
  }

  return (
    <KeyboardAvoidingView
      style={styles.page}
      behavior={Platform.OS === 'ios' ? 'padding' : undefined}
    >
      <ScrollView
        style={styles.page}
        contentContainerStyle={styles.scroll}
        keyboardShouldPersistTaps="handled"
      >
        {!!previewName && (
          <View style={styles.preview} accessibilityLiveRegion="polite">
            <Avatar uri={currentUser?.avatar} name={previewName} size={56} />
            <View style={styles.previewText}>
              <Text style={styles.previewName} numberOfLines={1}>{previewName}</Text>
              {!!handle && (
                <Text style={styles.previewHandle} dir="ltr" numberOfLines={1}>@{handle}</Text>
              )}
            </View>
          </View>
        )}

        <View style={styles.field}>
          <Text style={styles.label}>نام</Text>
          <TextInput
            style={styles.input}
            value={firstName}
            onChangeText={(value) => { setFirstName(value); setError(''); }}
            placeholder="مثلاً علی"
            placeholderTextColor={colors.text3}
            autoComplete="given-name"
            maxLength={50}
            editable={!saving}
            accessibilityLabel="نام"
            returnKeyType="next"
          />
        </View>

        <View style={styles.field}>
          <Text style={styles.label}>
            نام خانوادگی
            <Text style={styles.optionalBadge}>اختیاری</Text>
          </Text>
          <TextInput
            style={styles.input}
            value={lastName}
            onChangeText={(value) => { setLastName(value); setError(''); }}
            placeholder="مثلاً رضایی"
            placeholderTextColor={colors.text3}
            autoComplete="family-name"
            maxLength={50}
            editable={!saving}
            accessibilityLabel="نام خانوادگی، اختیاری"
            returnKeyType="next"
          />
          <Text style={styles.hint}>خالی بگذاری، فقط نام کوچک نمایش داده می‌شود.</Text>
        </View>

        <View style={styles.field}>
          <Text style={styles.label}>نام کاربری</Text>
          <TextInput
            style={[styles.input, styles.inputLtr]}
            value={username}
            onChangeText={(value) => { setUsername(value); setError(''); }}
            placeholder="username"
            placeholderTextColor={colors.text3}
            autoCapitalize="none"
            autoCorrect={false}
            autoComplete="username"
            maxLength={30}
            editable={!saving}
            accessibilityLabel="نام کاربری"
            returnKeyType="next"
          />
          <Text style={styles.hint}>
            هر نام کاربری یکتاست؛ فقط حروف انگلیسی، عدد و _ (۲ تا ۳۰ کاراکتر).
          </Text>
        </View>

        <View style={styles.field}>
          <Text style={styles.label}>
            بیوگرافی
            <Text style={styles.optionalBadge}>اختیاری</Text>
          </Text>
          <TextInput
            style={[styles.input, styles.bioInput]}
            value={bio}
            onChangeText={(value) => { setBio(value); setError(''); }}
            placeholder="چند خط درباره تو"
            placeholderTextColor={colors.text3}
            multiline
            textAlignVertical="top"
            maxLength={150}
            editable={!saving}
            accessibilityLabel="بیوگرافی، اختیاری"
          />
          <Text style={styles.hint}>{`${persian(bio.length)} از ${persian(150)} کاراکتر`}</Text>
        </View>

        <View style={styles.field}>
          <Text style={styles.label}>شماره موبایل</Text>
          <View style={styles.readonlyRow} accessibilityLabel={`شماره موبایل ${currentUser?.phone ?? ''}, قابل تغییر نیست`}>
            <Text style={styles.readonlyValue} dir="ltr">
              {currentUser?.phone ?? '—'}
            </Text>
            <FontAwesome6 name="lock" size={13} color={colors.text3} />
          </View>
          <Text style={styles.hint}>شماره، هویت تو در OpenBridge است و از این‌جا تغییر نمی‌کند.</Text>
        </View>

        {!!error && (
          <View style={styles.errorRow} accessibilityRole="alert">
            <FontAwesome6 name="circle-exclamation" size={13} color={colors.danger} />
            <Text style={styles.error}>{error}</Text>
          </View>
        )}

        <Pressable
          style={[styles.submit, saving && styles.submitBusy]}
          onPress={submit}
          disabled={saving}
          accessibilityRole="button"
          accessibilityLabel="ذخیره تغییرات پروفایل"
          accessibilityState={{ disabled: saving, busy: saving }}
        >
          {saving ? (
            <ActivityIndicator color={colors.onAccent} />
          ) : (
            <>
              <FontAwesome6 name="check" size={14} color={colors.onAccent} />
              <Text style={styles.submitText}>ذخیره</Text>
            </>
          )}
        </Pressable>

        <Pressable
          style={styles.cancel}
          onPress={() => navigation?.goBack?.()}
          disabled={saving}
          accessibilityRole="button"
          accessibilityLabel="انصراف از ویرایش"
          accessibilityState={{ disabled: saving }}
        >
          <Text style={[styles.linkText, saving && styles.linkTextDisabled]}>انصراف</Text>
        </Pressable>
      </ScrollView>
    </KeyboardAvoidingView>
  );
}

// The fields follow the rendered convention of the screens around this one:
// labels and values read from the right edge, and the form reuses the login
// card's metrics so both screens feel like one product.
function makeStyles(colors) {
  return StyleSheet.create({
    page: { flex: 1, backgroundColor: colors.bg },
    scroll: { padding: spacing.lg, gap: spacing.md },

    preview: {
      flexDirection: 'row-reverse',
      alignItems: 'center',
      gap: spacing.md,
      borderWidth: 1,
      borderColor: colors.border,
      borderRadius: radius.md,
      backgroundColor: colors.surface,
      padding: spacing.md,
    },
    previewText: { flex: 1, gap: 2 },
    previewName: { color: colors.text1, fontFamily: fonts.semibold, fontSize: type.base, textAlign: 'right' },
    previewHandle: { color: colors.text3, fontFamily: fonts.regular, fontSize: type.xs, textAlign: 'right' },

    field: { gap: spacing.xs },
    label: { color: colors.text2, fontFamily: fonts.medium, fontSize: type.sm, textAlign: 'right' },
    optionalBadge: {
      color: colors.text3,
      fontFamily: fonts.regular,
      fontSize: type.xs,
      backgroundColor: colors.surface3,
      borderRadius: radius.pill,
      paddingHorizontal: spacing.sm,
      paddingVertical: 1,
      marginInlineStart: spacing.sm,
    },
    input: {
      minHeight: 48,
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
    inputLtr: { textAlign: 'left' },
    bioInput: { minHeight: 88, paddingTop: spacing.md, paddingBottom: spacing.md },

    readonlyRow: {
      flexDirection: 'row-reverse',
      alignItems: 'center',
      gap: spacing.sm,
      minHeight: 48,
      paddingHorizontal: spacing.md + 2,
      borderRadius: radius.md,
      borderWidth: 1,
      borderStyle: 'dashed',
      borderColor: colors.borderStrong,
      backgroundColor: colors.surface2,
    },
    readonlyValue: {
      flex: 1,
      color: colors.text2,
      fontFamily: fonts.regular,
      fontSize: type.base,
      textAlign: 'left',
    },

    hint: { color: colors.text3, fontFamily: fonts.regular, fontSize: type.xs, textAlign: 'right', lineHeight: 18 },

    errorRow: {
      flexDirection: 'row-reverse',
      alignItems: 'center',
      gap: spacing.sm,
      paddingHorizontal: spacing.md,
      paddingVertical: spacing.sm,
      borderRadius: radius.sm,
      backgroundColor: colors.dangerSoft,
    },
    error: { flex: 1, color: colors.text1, fontFamily: fonts.regular, fontSize: type.sm, textAlign: 'right', lineHeight: 20 },

    submit: {
      flexDirection: 'row-reverse',
      alignItems: 'center',
      justifyContent: 'center',
      gap: spacing.sm,
      minHeight: 48,
      borderRadius: radius.md,
      backgroundColor: colors.accent,
      marginTop: spacing.xs,
    },
    submitBusy: { opacity: 0.8 },
    submitText: { color: colors.onAccent, fontFamily: fonts.semibold, fontSize: type.md },

    cancel: {
      minHeight: 44,
      alignItems: 'center',
      justifyContent: 'center',
      borderRadius: radius.sm,
    },
    linkText: { color: colors.accentText, fontFamily: fonts.medium, fontSize: type.sm, textAlign: 'center' },
    linkTextDisabled: { color: colors.text3 },
  });
}
