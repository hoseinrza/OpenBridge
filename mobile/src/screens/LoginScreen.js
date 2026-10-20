import { useMemo, useRef, useState } from 'react';
import {
  ActivityIndicator, Image, KeyboardAvoidingView, Platform, Pressable,
  ScrollView, StyleSheet, Text, TextInput, View,
} from 'react-native';
import { FontAwesome6 } from '@expo/vector-icons';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { useAuth } from '../context/AuthContext';
import { fonts, radius, spacing, type, useAppTheme } from '../theme';

const USERNAME_RE = /^[a-zA-Z0-9_]+$/;

export default function LoginScreen() {
  const { login } = useAuth();
  const { colors } = useAppTheme();
  const insets = useSafeAreaInsets();
  const [mode, setMode] = useState('login');
  const [username, setUsername] = useState('');
  const [displayName, setDisplayName] = useState('');
  const [password, setPassword] = useState('');
  const [showPassword, setShowPassword] = useState(false);
  const [error, setError] = useState('');
  const [loading, setLoading] = useState(false);
  const passwordRef = useRef(null);

  const styles = useMemo(() => makeStyles(colors), [colors]);

  function switchMode(next) {
    if (loading || next === mode) return;
    setMode(next);
    setError('');
  }

  async function submit() {
    const u = username.trim();
    const dn = displayName.trim();
    if (!u) { setError('نام کاربری را وارد کنید'); return; }
    if (u.length < 2) { setError('نام کاربری باید حداقل ۲ کاراکتر باشد'); return; }
    if (mode === 'register' && !USERNAME_RE.test(u)) {
      setError('نام کاربری باید فقط شامل حروف انگلیسی، عدد و _ باشد'); return;
    }
    if (mode === 'register' && dn.length < 2) {
      setError('نام نمایشی باید حداقل ۲ کاراکتر باشد'); return;
    }
    if (!password) { setError('رمز عبور را وارد کنید'); return; }
    if (mode === 'register' && password.length < 8) {
      setError('رمز عبور باید حداقل ۸ کاراکتر باشد'); return;
    }

    setLoading(true);
    setError('');
    try {
      await login(u, password, mode, dn);
    } catch (err) {
      setError(err.message ?? 'خطا در اتصال به سرور');
    } finally {
      setLoading(false);
    }
  }

  const isRegister = mode === 'register';

  return (
    <KeyboardAvoidingView
      style={styles.page}
      behavior={Platform.OS === 'ios' ? 'padding' : undefined}
    >
      <ScrollView
        contentContainerStyle={[
          styles.scroll,
          { paddingTop: insets.top + spacing.xl, paddingBottom: insets.bottom + spacing.xl },
        ]}
        keyboardShouldPersistTaps="handled"
        showsVerticalScrollIndicator={false}
      >
        <View style={styles.brand}>
          <Image source={require('../../assets/icon.png')} style={styles.logo} accessibilityLabel="نشان OpenBridge" />
          <Text style={styles.title}>OpenBridge</Text>
          <Text style={styles.sub}>پل ارتباطی تیم و دوستان تو</Text>
        </View>

        <View style={styles.card}>
          <View style={styles.tabs} accessibilityRole="tablist">
            <Pressable
              style={[styles.tab, mode === 'login' && styles.tabActive]}
              onPress={() => switchMode('login')}
              accessibilityRole="tab"
              accessibilityState={{ selected: mode === 'login' }}
              accessibilityLabel="ورود"
            >
              <Text style={[styles.tabText, mode === 'login' && styles.tabTextActive]}>ورود</Text>
            </Pressable>
            <Pressable
              style={[styles.tab, isRegister && styles.tabActive]}
              onPress={() => switchMode('register')}
              accessibilityRole="tab"
              accessibilityState={{ selected: isRegister }}
              accessibilityLabel="ثبت‌نام"
            >
              <Text style={[styles.tabText, isRegister && styles.tabTextActive]}>ثبت‌نام</Text>
            </Pressable>
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
              maxLength={30}
              editable={!loading}
              accessibilityLabel="نام کاربری"
              returnKeyType="next"
              onSubmitEditing={() => passwordRef.current?.focus()}
            />
          </View>

          {isRegister && (
            <View style={styles.field}>
              <Text style={styles.label}>نام نمایشی</Text>
              <TextInput
                style={styles.input}
                value={displayName}
                onChangeText={(value) => { setDisplayName(value); setError(''); }}
                placeholder="مثلاً علی رضایی"
                placeholderTextColor={colors.text3}
                maxLength={50}
                editable={!loading}
                accessibilityLabel="نام نمایشی"
                returnKeyType="next"
                onSubmitEditing={() => passwordRef.current?.focus()}
              />
            </View>
          )}

          <View style={styles.field}>
            <Text style={styles.label}>رمز عبور</Text>
            <View style={styles.passwordRow}>
              <TextInput
                ref={passwordRef}
                style={[styles.input, styles.passwordInput]}
                value={password}
                onChangeText={(value) => { setPassword(value); setError(''); }}
                placeholder="••••••••"
                placeholderTextColor={colors.text3}
                secureTextEntry={!showPassword}
                maxLength={100}
                editable={!loading}
                accessibilityLabel="رمز عبور"
                returnKeyType="go"
                onSubmitEditing={submit}
              />
              <Pressable
                onPress={() => setShowPassword(value => !value)}
                hitSlop={6}
                style={styles.eyeBtn}
                accessibilityRole="switch"
                accessibilityLabel={showPassword ? 'پنهان کردن رمز عبور' : 'نمایش رمز عبور'}
                accessibilityState={{ checked: showPassword }}
              >
                <FontAwesome6
                  name={showPassword ? 'eye-slash' : 'eye'}
                  size={15}
                  color={colors.text2}
                />
              </Pressable>
            </View>
            {isRegister && (
              <Text style={styles.hint}>حداقل ۸ کاراکتر؛ فقط برای این حساب استفاده می‌شود.</Text>
            )}
          </View>

          {!!error && (
            <View style={styles.errorRow} accessibilityRole="alert">
              <FontAwesome6 name="circle-exclamation" size={13} color={colors.danger} />
              <Text style={styles.error}>{error}</Text>
            </View>
          )}

          <Pressable
            style={[styles.submit, loading && styles.submitBusy]}
            onPress={submit}
            disabled={loading}
            accessibilityRole="button"
            accessibilityLabel={isRegister ? 'ثبت‌نام' : 'ورود به چت'}
            accessibilityState={{ disabled: loading, busy: loading }}
          >
            {loading ? (
              <ActivityIndicator color={colors.onAccent} />
            ) : (
              <>
                <FontAwesome6
                  name={isRegister ? 'user-plus' : 'arrow-left'}
                  size={14}
                  color={colors.onAccent}
                />
                <Text style={styles.submitText}>{isRegister ? 'ثبت‌نام' : 'ورود به چت'}</Text>
              </>
            )}
          </Pressable>
        </View>

        <Text style={styles.footNote}>
          {isRegister
            ? 'با ساخت حساب، یک نام کاربری یکتا برای خودت انتخاب می‌کنی.'
            : 'برای شروع، وارد حساب کاربری خودت شو.'}
        </Text>
      </ScrollView>
    </KeyboardAvoidingView>
  );
}

function makeStyles(colors) {
  return StyleSheet.create({
    page: { flex: 1, backgroundColor: colors.bg },
    scroll: {
      flexGrow: 1,
      justifyContent: 'center',
      paddingHorizontal: spacing.xl,
      gap: spacing.xl,
    },

    brand: { alignItems: 'center', gap: spacing.sm },
    logo: {
      width: 68,
      height: 68,
      borderRadius: 17,
      marginBottom: spacing.xs,
    },
    title: { color: colors.text1, fontFamily: fonts.bold, fontSize: type.xxl },
    sub: { color: colors.text3, fontFamily: fonts.regular, fontSize: type.sm },

    card: {
      backgroundColor: colors.surface,
      borderRadius: radius.xl,
      borderWidth: 1,
      borderColor: colors.border,
      padding: spacing.xl,
      gap: spacing.md,
    },

    tabs: {
      flexDirection: 'row-reverse',
      backgroundColor: colors.surface2,
      borderRadius: radius.md,
      padding: 3,
      gap: 3,
      marginBottom: spacing.xs,
    },
    tab: { flex: 1, minHeight: 44, borderRadius: radius.sm, alignItems: 'center', justifyContent: 'center' },
    tabActive: { backgroundColor: colors.surface, borderWidth: 1, borderColor: colors.border },
    tabText: { color: colors.text3, fontFamily: fonts.medium, fontSize: type.sm },
    tabTextActive: { color: colors.text1, fontFamily: fonts.semibold },

    field: { gap: spacing.xs },
    label: { color: colors.text2, fontFamily: fonts.medium, fontSize: type.sm, textAlign: 'right' },
    input: {
      height: 48,
      paddingHorizontal: spacing.md + 2,
      borderRadius: radius.md,
      borderWidth: 1,
      borderColor: colors.borderStrong,
      backgroundColor: colors.surface2,
      color: colors.text1,
      fontFamily: fonts.regular,
      fontSize: type.base,
      textAlign: 'right',
    },
    inputLtr: { textAlign: 'left' },
    passwordRow: { position: 'relative' },
    passwordInput: { paddingLeft: 48 },
    eyeBtn: {
      position: 'absolute',
      left: 2,
      top: 2,
      width: 44,
      height: 44,
      alignItems: 'center',
      justifyContent: 'center',
    },
    hint: { color: colors.text3, fontFamily: fonts.regular, fontSize: type.xs, textAlign: 'right' },

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

    footNote: { color: colors.text3, fontFamily: fonts.regular, fontSize: type.xs, textAlign: 'center', lineHeight: 20 },
  });
}
