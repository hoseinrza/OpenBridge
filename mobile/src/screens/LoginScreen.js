import { useEffect, useMemo, useRef, useState } from 'react';
import {
  ActivityIndicator, Image, KeyboardAvoidingView, Platform, Pressable,
  ScrollView, StyleSheet, Text, TextInput, View,
} from 'react-native';
import { FontAwesome6 } from '@expo/vector-icons';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { useAuth } from '../context/AuthContext';
import { normalizeIranMobile } from '../utils/phone';
import { fonts, radius, spacing, type, useAppTheme } from '../theme';

const DIGIT_MAP = { fa: '۰۱۲۳۴۵۶۷۸۹', ar: '٠١٢٣٤٥٦٧٨٩' };

function normalizeCode(value) {
  return value
    .replace(/[۰-۹]/g, digit => String(DIGIT_MAP.fa.indexOf(digit)))
    .replace(/[٠-٩]/g, digit => String(DIGIT_MAP.ar.indexOf(digit)))
    .replace(/\D/g, '')
    .slice(0, 6);
}

function persianNumber(value) {
  return String(value).replace(/\d/g, digit => DIGIT_MAP.fa[Number(digit)]);
}

export default function LoginScreen() {
  const { requestOtp, verifyOtp, login } = useAuth();
  const { colors } = useAppTheme();
  const insets = useSafeAreaInsets();

  const [mode,        setMode]        = useState('otp');    // 'otp' | 'password'
  const [step,        setStep]        = useState('phone');  // 'phone' | 'code'
  const [phone,       setPhone]       = useState('');
  const [code,        setCode]        = useState('');
  const [newUsername, setNewUsername] = useState('');
  const [displayName, setDisplayName] = useState('');
  const [isNewUser,   setIsNewUser]   = useState(false);
  const [testCode,    setTestCode]    = useState('');
  const [resendIn,    setResendIn]    = useState(0);

  const [username,     setUsername]     = useState('');
  const [password,     setPassword]     = useState('');
  const [showPassword, setShowPassword] = useState(false);

  const [error,      setError]      = useState('');
  const [busyAction, setBusyAction] = useState(null); // 'request' | 'verify' | 'resend' | 'password'
  const busy = busyAction !== null;

  const codeRef     = useRef(null);
  const nameRef     = useRef(null);
  const passwordRef = useRef(null);

  const styles = useMemo(() => makeStyles(colors), [colors]);

  useEffect(() => {
    if (resendIn <= 0) return undefined;
    const timer = setTimeout(() => setResendIn(value => Math.max(0, value - 1)), 1000);
    return () => clearTimeout(timer);
  }, [resendIn]);

  function switchMode(next) {
    if (busy || next === mode) return;
    setMode(next);
    setError('');
    setStep('phone');
    setCode('');
    setTestCode('');
    setNewUsername('');
    setDisplayName('');
    setIsNewUser(false);
    setResendIn(0);
    setShowPassword(false);
  }

  async function issueCode(isResend = false) {
    if (busy) return;
    const normalized = normalizeIranMobile(phone);
    if (!normalized) {
      setError('شماره موبایل معتبر نیست؛ نمونه: ۰۹۱۲۳۴۵۶۷۸۹');
      return;
    }

    setBusyAction(isResend ? 'resend' : 'request');
    setError('');
    try {
      const data = await requestOtp(normalized);
      setPhone(normalized);
      setIsNewUser(!!data.isNewUser);
      setTestCode(typeof data.testCode === 'string' ? data.testCode : '');
      setCode('');
      setStep('code');
      setResendIn(30);
      if (isResend) codeRef.current?.focus();
    } catch (err) {
      setError(err.message ?? 'خطا در اتصال به سرور');
    } finally {
      setBusyAction(null);
    }
  }

  async function submitCode() {
    if (busy) return;
    if (code.length !== 6) { setError('کد تأیید باید ۶ رقم باشد'); return; }
    if (isNewUser) {
      const u = newUsername.trim();
      if (u.length < 2 || !/^[a-zA-Z0-9_]+$/.test(u)) {
        setError('نام کاربری باید فقط شامل حروف انگلیسی، عدد و _ باشد (حداقل ۲ کاراکتر)');
        return;
      }
      if (displayName.trim().length < 2) {
        setError('نام نمایشی باید حداقل ۲ کاراکتر باشد');
        return;
      }
    }

    setBusyAction('verify');
    setError('');
    try {
      await verifyOtp(
        phone,
        code,
        isNewUser ? newUsername.trim() : undefined,
        isNewUser ? displayName.trim() : undefined,
      );
    } catch (err) {
      setError(err.message ?? 'خطا در اتصال به سرور');
    } finally {
      setBusyAction(null);
    }
  }

  function changePhone() {
    if (busy) return;
    setStep('phone');
    setCode('');
    setTestCode('');
    setNewUsername('');
    setDisplayName('');
    setIsNewUser(false);
    setResendIn(0);
    setError('');
  }

  async function submitPassword() {
    if (busy) return;
    const u = username.trim();
    if (!u) { setError('نام کاربری را وارد کنید'); return; }
    if (!password) { setError('رمز عبور را وارد کنید'); return; }

    setBusyAction('password');
    setError('');
    try {
      await login(u, password);
    } catch (err) {
      setError(err.message ?? 'خطا در اتصال به سرور');
    } finally {
      setBusyAction(null);
    }
  }

  const heading = mode === 'password'
    ? { title: 'ورود با رمز عبور', sub: 'این روش برای حساب‌های قدیمی است.' }
    : step === 'phone'
      ? { title: 'ورود یا ثبت‌نام', sub: 'شماره موبایلات را وارد کن تا کد تأیید صادر شود.' }
      : { title: 'کد تأیید', sub: 'کد ۶ رقمی صادرشده را وارد کن.' };

  const footNote = mode === 'password'
    ? 'اگر شماره موبایلات را به حساب وصل کرده‌ای، از ورود با کد تأیید استفاده کن.'
    : step === 'phone'
      ? 'با تأیید شماره، اگر حسابی نداشته باشی در مرحله بعد نام کاربری و نام نمایشی انتخاب می‌کنی.'
      : 'اگر شماره را اشتباه وارد کردی، گزینه «تغییر شماره» را بزن.';

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
          <View style={styles.formHead}>
            <Text style={styles.formTitle}>{heading.title}</Text>
            <Text style={styles.formSub}>{heading.sub}</Text>
          </View>

          {mode === 'password' ? (
            <>
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
                  editable={!busy}
                  accessibilityLabel="نام کاربری"
                  returnKeyType="next"
                  onSubmitEditing={() => passwordRef.current?.focus()}
                />
              </View>

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
                    autoComplete="current-password"
                    maxLength={72}
                    editable={!busy}
                    accessibilityLabel="رمز عبور"
                    returnKeyType="go"
                    onSubmitEditing={submitPassword}
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
              </View>

              {!!error && (
                <View style={styles.errorRow} accessibilityRole="alert">
                  <FontAwesome6 name="circle-exclamation" size={13} color={colors.danger} />
                  <Text style={styles.error}>{error}</Text>
                </View>
              )}

              <Pressable
                style={[styles.submit, busy && styles.submitBusy]}
                onPress={submitPassword}
                disabled={busy}
                accessibilityRole="button"
                accessibilityLabel="ورود به حساب"
                accessibilityState={{ disabled: busy, busy }}
              >
                {busyAction === 'password' ? (
                  <ActivityIndicator color={colors.onAccent} />
                ) : (
                  <>
                    <FontAwesome6 name="arrow-left" size={14} color={colors.onAccent} />
                    <Text style={styles.submitText}>ورود به حساب</Text>
                  </>
                )}
              </Pressable>

              <Pressable
                style={styles.switchBtn}
                onPress={() => switchMode('otp')}
                disabled={busy}
                accessibilityRole="button"
                accessibilityLabel="ورود با شماره موبایل"
                accessibilityState={{ disabled: busy }}
              >
                <Text style={styles.linkText}>ورود با شماره موبایل</Text>
              </Pressable>
            </>
          ) : step === 'phone' ? (
            <>
              <View style={styles.field}>
                <Text style={styles.label}>شماره موبایل</Text>
                <TextInput
                  style={[styles.input, styles.inputLtr]}
                  value={phone}
                  onChangeText={(value) => { setPhone(value); setError(''); }}
                  placeholder="09123456789"
                  placeholderTextColor={colors.text3}
                  keyboardType="phone-pad"
                  textContentType="telephoneNumber"
                  autoComplete="tel"
                  maxLength={20}
                  editable={!busy}
                  accessibilityLabel="شماره موبایل"
                  returnKeyType="send"
                  onSubmitEditing={() => issueCode(false)}
                />
                <Text style={styles.hint}>مثلاً ۰۹۱۲۳۴۵۶۷۸۹ یا +۹۸۹۱۲۳۴۵۶۷۸۹</Text>
              </View>

              {!!error && (
                <View style={styles.errorRow} accessibilityRole="alert">
                  <FontAwesome6 name="circle-exclamation" size={13} color={colors.danger} />
                  <Text style={styles.error}>{error}</Text>
                </View>
              )}

              <Pressable
                style={[styles.submit, busy && styles.submitBusy]}
                onPress={() => issueCode(false)}
                disabled={busy}
                accessibilityRole="button"
                accessibilityLabel="دریافت کد تأیید"
                accessibilityState={{ disabled: busy, busy }}
              >
                {busyAction === 'request' ? (
                  <ActivityIndicator color={colors.onAccent} />
                ) : (
                  <>
                    <FontAwesome6 name="paper-plane" size={14} color={colors.onAccent} />
                    <Text style={styles.submitText}>دریافت کد تأیید</Text>
                  </>
                )}
              </Pressable>

              <Pressable
                style={styles.switchBtn}
                onPress={() => switchMode('password')}
                disabled={busy}
                accessibilityRole="button"
                accessibilityLabel="ورود با نام کاربری و رمز، حساب‌های قدیمی"
                accessibilityState={{ disabled: busy }}
              >
                <Text style={styles.linkText}>ورود با نام کاربری و رمز (حساب‌های قدیمی)</Text>
              </Pressable>
            </>
          ) : (
            <>
              <View style={styles.targetRow}>
                <Text style={styles.target}>
                  کد تأیید برای <Text style={styles.targetValue}>{phone}</Text> صادر شد.
                </Text>
                <Pressable
                  onPress={changePhone}
                  hitSlop={6}
                  style={styles.linkBtn}
                  disabled={busy}
                  accessibilityRole="button"
                  accessibilityLabel="تغییر شماره موبایل"
                  accessibilityState={{ disabled: busy }}
                >
                  <Text style={styles.linkText}>تغییر شماره</Text>
                </Pressable>
              </View>

              {isNewUser && (
                <>
                  <View style={styles.field}>
                    <Text style={styles.label}>نام کاربری</Text>
                    <TextInput
                      style={[styles.input, styles.inputLtr]}
                      value={newUsername}
                      onChangeText={(value) => { setNewUsername(value); setError(''); }}
                      placeholder="username"
                      placeholderTextColor={colors.text3}
                      autoCapitalize="none"
                      autoCorrect={false}
                      autoComplete="username"
                      maxLength={30}
                      editable={!busy}
                      accessibilityLabel="نام کاربری"
                      returnKeyType="next"
                      onSubmitEditing={() => nameRef.current?.focus()}
                      autoFocus
                    />
                    <Text style={styles.hint}>هر نام کاربری یکتاست؛ فقط حروف انگلیسی، عدد و _</Text>
                  </View>

                  <View style={styles.field}>
                    <Text style={styles.label}>نام نمایشی</Text>
                    <TextInput
                      ref={nameRef}
                      style={styles.input}
                      value={displayName}
                      onChangeText={(value) => { setDisplayName(value); setError(''); }}
                      placeholder="مثلاً علی رضایی"
                      placeholderTextColor={colors.text3}
                      autoComplete="name"
                      maxLength={50}
                      editable={!busy}
                      accessibilityLabel="نام نمایشی"
                      returnKeyType="next"
                      onSubmitEditing={() => codeRef.current?.focus()}
                    />
                    <Text style={styles.hint}>این نام برای بقیه کاربران نمایش داده می‌شود.</Text>
                  </View>
                </>
              )}

              <View style={styles.field}>
                <Text style={styles.label}>کد تأیید ۶ رقمی</Text>
                <TextInput
                  ref={codeRef}
                  style={[styles.input, styles.codeInput]}
                  value={code}
                  onChangeText={(value) => { setCode(normalizeCode(value)); setError(''); }}
                  placeholder="123456"
                  placeholderTextColor={colors.text3}
                  keyboardType="number-pad"
                  textContentType="oneTimeCode"
                  autoComplete="sms-otp"
                  maxLength={6}
                  editable={!busy}
                  accessibilityLabel="کد تأیید ۶ رقمی"
                  returnKeyType="done"
                  onSubmitEditing={submitCode}
                  autoFocus={!isNewUser}
                />
              </View>

              {!!testCode && (
                <View style={styles.testCode} accessibilityLiveRegion="polite">
                  <FontAwesome6 name="flask" size={13} color={colors.text3} />
                  <Text style={styles.testCodeText}>
                    کد تست (فقط محیط توسعه): <Text selectable style={styles.testCodeValue}>{testCode}</Text>
                  </Text>
                </View>
              )}

              {!!error && (
                <View style={styles.errorRow} accessibilityRole="alert">
                  <FontAwesome6 name="circle-exclamation" size={13} color={colors.danger} />
                  <Text style={styles.error}>{error}</Text>
                </View>
              )}

              <Pressable
                style={[styles.submit, busy && styles.submitBusy]}
                onPress={submitCode}
                disabled={busy}
                accessibilityRole="button"
                accessibilityLabel={isNewUser ? 'ساخت حساب و ورود' : 'تأیید و ورود'}
                accessibilityState={{ disabled: busy, busy }}
              >
                {busyAction === 'verify' ? (
                  <ActivityIndicator color={colors.onAccent} />
                ) : (
                  <>
                    <FontAwesome6
                      name={isNewUser ? 'user-plus' : 'arrow-left'}
                      size={14}
                      color={colors.onAccent}
                    />
                    <Text style={styles.submitText}>{isNewUser ? 'ساخت حساب و ورود' : 'تأیید و ورود'}</Text>
                  </>
                )}
              </Pressable>

              <Pressable
                onPress={() => issueCode(true)}
                disabled={busy || resendIn > 0}
                accessibilityRole="button"
                accessibilityLabel="ارسال دوباره کد تأیید"
                accessibilityState={{ disabled: busy || resendIn > 0, busy: busyAction === 'resend' }}
                style={styles.resendRow}
              >
                <Text style={[styles.linkText, (busy || resendIn > 0) && styles.linkTextDisabled]}>
                  {busyAction === 'resend'
                    ? 'در حال ارسال…'
                    : resendIn > 0
                      ? `ارسال دوباره تا ${persianNumber(resendIn)} ثانیه`
                      : 'ارسال دوباره کد'}
                </Text>
              </Pressable>
            </>
          )}
        </View>

        <Text style={styles.footNote}>{footNote}</Text>
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

    formHead: { gap: spacing.xs },
    formTitle: { color: colors.text1, fontFamily: fonts.bold, fontSize: type.lg, textAlign: 'right' },
    formSub: { color: colors.text3, fontFamily: fonts.regular, fontSize: type.sm, textAlign: 'right', lineHeight: 20 },

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
    codeInput: {
      textAlign: 'center',
      letterSpacing: 8,
      paddingHorizontal: 8,
      fontFamily: fonts.semibold,
      fontSize: type.lg,
    },
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
    hint: { color: colors.text3, fontFamily: fonts.regular, fontSize: type.xs, textAlign: 'right', lineHeight: 18 },

    targetRow: { flexDirection: 'row-reverse', alignItems: 'center', gap: spacing.sm },
    target: { flex: 1, color: colors.text2, fontFamily: fonts.regular, fontSize: type.sm, textAlign: 'right', lineHeight: 20 },
    targetValue: { color: colors.text1, fontFamily: fonts.semibold, writingDirection: 'ltr' },

    linkBtn: {
      minHeight: 44,
      justifyContent: 'center',
      paddingHorizontal: spacing.sm,
      borderRadius: radius.sm,
    },
    linkText: { color: colors.accentText, fontFamily: fonts.medium, fontSize: type.sm, textAlign: 'center' },
    linkTextDisabled: { color: colors.text3 },
    switchBtn: {
      minHeight: 44,
      alignItems: 'center',
      justifyContent: 'center',
      borderRadius: radius.sm,
    },
    resendRow: { minHeight: 44, alignItems: 'center', justifyContent: 'center' },

    testCode: {
      flexDirection: 'row-reverse',
      alignItems: 'flex-start',
      gap: spacing.sm,
      borderWidth: 1,
      borderStyle: 'dashed',
      borderColor: colors.borderStrong,
      borderRadius: radius.sm,
      backgroundColor: colors.surface2,
      paddingHorizontal: spacing.md,
      paddingVertical: spacing.sm,
    },
    testCodeText: { flex: 1, color: colors.text2, fontFamily: fonts.regular, fontSize: type.xs, textAlign: 'right', lineHeight: 18 },
    testCodeValue: { color: colors.text1, fontFamily: fonts.bold, letterSpacing: 2 },

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
