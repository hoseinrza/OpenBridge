import { useEffect, useMemo, useRef, useState } from 'react';
import {
  ActivityIndicator, Image, KeyboardAvoidingView, Platform, Pressable,
  ScrollView, StyleSheet, Text, TextInput, View,
} from 'react-native';
import { FontAwesome6 } from '@expo/vector-icons';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { useAuth } from '../context/AuthContext';
import Avatar from '../components/Avatar';
import { normalizeIranMobile } from '../utils/phone';
import { fonts, radius, spacing, type, useAppTheme } from '../theme';

const DIGIT_MAP = { fa: '۰۱۲۳۴۵۶۷۸۹', ar: '٠١٢٣٤٥٦٧٨٩' };
const USERNAME_PATTERN = /^[a-zA-Z0-9_]{2,30}$/;
// Mirrors the backend rule: letters of any script (Persian ZWNJ included),
// spaces, apostrophes and hyphens; at least two characters.
const NAME_PATTERN = /^[\p{L}][\p{L}\p{M}\u200c'’ .-]{1,49}$/u;

const STEPS = ['phone', 'code', 'username', 'name'];
const STEP_LABELS = { phone: 'شماره', code: 'کد تأیید', username: 'نام کاربری', name: 'نام شما' };

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
  const { requestOtp, verifyOtp, completeSignup } = useAuth();
  const { colors } = useAppTheme();
  const insets = useSafeAreaInsets();

  const [step,        setStep]        = useState('phone');
  const [phone,       setPhone]       = useState('');
  const [code,        setCode]        = useState('');
  const [signupToken, setSignupToken] = useState('');
  const [newUsername, setNewUsername] = useState('');
  const [firstName,   setFirstName]   = useState('');
  const [lastName,    setLastName]    = useState('');
  const [isNewUser,   setIsNewUser]   = useState(false);
  const [testCode,    setTestCode]    = useState('');
  const [resendIn,    setResendIn]    = useState(0);

  const [error,      setError]      = useState('');
  const [busyAction, setBusyAction] = useState(null); // 'request' | 'verify' | 'resend' | 'signup'
  const busy = busyAction !== null;

  const lastNameRef = useRef(null);

  const styles = useMemo(() => makeStyles(colors), [colors]);

  useEffect(() => {
    if (resendIn <= 0) return undefined;
    const timer = setTimeout(() => setResendIn(value => Math.max(0, value - 1)), 1000);
    return () => clearTimeout(timer);
  }, [resendIn]);

  const steps = isNewUser ? STEPS : STEPS.slice(0, 2);

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
    } catch (err) {
      setError(err.message ?? 'خطا در اتصال به سرور');
    } finally {
      setBusyAction(null);
    }
  }

  async function submitCode() {
    if (busy) return;
    if (code.length !== 6) { setError('کد تأیید باید ۶ رقم باشد'); return; }

    setBusyAction('verify');
    setError('');
    try {
      const result = await verifyOtp(phone, code);
      if (result.requiresSignup) {
        setSignupToken(result.signupToken);
        setIsNewUser(true);
        setStep('username');
      }
    } catch (err) {
      setError(err.message ?? 'خطا در اتصال به سرور');
    } finally {
      setBusyAction(null);
    }
  }

  function submitUsername() {
    if (busy) return;
    if (!USERNAME_PATTERN.test(newUsername.trim())) {
      setError('نام کاربری باید ۲ تا ۳۰ کاراکتر و فقط حروف انگلیسی، عدد و _ باشد');
      return;
    }
    setError('');
    setStep('name');
  }

  async function submitName() {
    if (busy) return;
    const given = firstName.trim();
    const family = lastName.trim();
    if (!NAME_PATTERN.test(given)) {
      setError('نام باید حداقل ۲ حرف باشد و عدد نداشته باشد');
      return;
    }
    if (family && !NAME_PATTERN.test(family)) {
      setError('نام خانوادگی باید حداقل ۲ حرف باشد و عدد نداشته باشد');
      return;
    }

    setBusyAction('signup');
    setError('');
    try {
      await completeSignup(signupToken, {
        username: newUsername.trim(),
        firstName: given,
        lastName: family || undefined,
      });
    } catch (err) {
      // A 401 means the verification window closed, so the code has to be
      // requested again from the first screen.
      if (err.status === 401) startOver();
      setError(err.message ?? 'خطا در اتصال به سرور');
    } finally {
      setBusyAction(null);
    }
  }

  function startOver() {
    setStep('phone');
    setCode('');
    setSignupToken('');
    setNewUsername('');
    setFirstName('');
    setLastName('');
    setIsNewUser(false);
    setTestCode('');
    setResendIn(0);
    setError('');
  }

  const heading = {
    phone:    { title: 'ورود یا ثبت‌نام', sub: 'شماره موبایلت را وارد کن تا کد تأیید صادر شود.' },
    code:     { title: 'کد تأیید',        sub: 'کد ۶ رقمی صادرشده برای شماره‌ات را وارد کن.' },
    username: { title: 'نام کاربری',      sub: 'این نام یکتاست و راهی است که دیگران تو را با آن پیدا می‌کنند.' },
    name:     { title: 'نام تو',          sub: 'این نام را در چت‌ها می‌بینند. نام خانوادگی اختیاری است.' },
  }[step];

  const previewName = [firstName.trim(), lastName.trim()].filter(Boolean).join(' ');
  const trackerIndex = steps.indexOf(step) + 1;

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

          {trackerIndex > 0 && (
            <View style={styles.tracker} accessible accessibilityRole="text"
              accessibilityLabel={`مرحله ${persianNumber(trackerIndex)} از ${persianNumber(steps.length)}، ${STEP_LABELS[step]}`}>
              <View style={styles.trackerDots} accessibilityElementsHidden>
                {steps.map((key, index) => (
                  <View
                    key={key}
                    style={[
                      styles.trackerDot,
                      index < trackerIndex - 1 && styles.trackerDotDone,
                      index === trackerIndex - 1 && styles.trackerDotCurrent,
                    ]}
                  />
                ))}
              </View>
              <Text style={styles.trackerLabel}>
                مرحله {persianNumber(trackerIndex)} از {persianNumber(steps.length)} · {STEP_LABELS[step]}
              </Text>
            </View>
          )}

          {step === 'phone' && (
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
                  autoFocus
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
            </>
          )}

          {step === 'code' && (
            <>
              <View style={styles.targetRow}>
                <Text style={styles.target}>
                  کد تأیید برای <Text style={styles.targetValue}>{phone}</Text> صادر شد.
                </Text>
                <Pressable
                  onPress={startOver}
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

              <View style={styles.field}>
                <Text style={styles.label}>کد تأیید ۶ رقمی</Text>
                <TextInput
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
                  autoFocus
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
                accessibilityLabel={isNewUser ? 'ادامه ثبت‌نام' : 'تأیید و ورود'}
                accessibilityState={{ disabled: busy, busy }}
              >
                {busyAction === 'verify' ? (
                  <ActivityIndicator color={colors.onAccent} />
                ) : (
                  <>
                    <FontAwesome6 name="arrow-left" size={14} color={colors.onAccent} />
                    <Text style={styles.submitText}>{isNewUser ? 'ادامه ثبت‌نام' : 'تأیید و ورود'}</Text>
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

          {step === 'username' && (
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
                  returnKeyType="done"
                  onSubmitEditing={submitUsername}
                  autoFocus
                />
                <Text style={styles.hint}>هر نام کاربری یکتاست؛ فقط حروف انگلیسی، عدد و _ (۲ تا ۳۰ کاراکتر). بعداً می‌توانی عوضش کنی.</Text>
              </View>

              {!!error && (
                <View style={styles.errorRow} accessibilityRole="alert">
                  <FontAwesome6 name="circle-exclamation" size={13} color={colors.danger} />
                  <Text style={styles.error}>{error}</Text>
                </View>
              )}

              <Pressable
                style={[styles.submit, busy && styles.submitBusy]}
                onPress={submitUsername}
                disabled={busy}
                accessibilityRole="button"
                accessibilityLabel="ادامه به نام شما"
                accessibilityState={{ disabled: busy }}
              >
                <FontAwesome6 name="arrow-left" size={14} color={colors.onAccent} />
                <Text style={styles.submitText}>ادامه</Text>
              </Pressable>

              <Pressable
                style={styles.switchBtn}
                onPress={startOver}
                disabled={busy}
                accessibilityRole="button"
                accessibilityLabel="انصراف و تغییر شماره موبایل"
                accessibilityState={{ disabled: busy }}
              >
                <Text style={styles.linkText}>انصراف و تغییر شماره</Text>
              </Pressable>
            </>
          )}

          {step === 'name' && (
            <>
              {!!previewName && (
                <View style={styles.preview} accessibilityLiveRegion="polite">
                  <Avatar name={previewName} size={48} />
                  <View style={styles.previewText}>
                    <Text style={styles.previewName} numberOfLines={1}>{previewName}</Text>
                    <Text style={styles.previewHandle} accessibilityLabel={`نام کاربری ${newUsername}`}>@{newUsername.trim()}</Text>
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
                  editable={!busy}
                  accessibilityLabel="نام"
                  returnKeyType="next"
                  onSubmitEditing={() => lastNameRef.current?.focus()}
                  autoFocus
                />
              </View>

              <View style={styles.field}>
                <Text style={styles.label}>
                  نام خانوادگی
                  <Text style={styles.optionalBadge}>اختیاری</Text>
                </Text>
                <TextInput
                  ref={lastNameRef}
                  style={styles.input}
                  value={lastName}
                  onChangeText={(value) => { setLastName(value); setError(''); }}
                  placeholder="مثلاً رضایی"
                  placeholderTextColor={colors.text3}
                  autoComplete="family-name"
                  maxLength={50}
                  editable={!busy}
                  accessibilityLabel="نام خانوادگی، اختیاری"
                  returnKeyType="done"
                  onSubmitEditing={submitName}
                />
                <Text style={styles.hint}>خالی بگذاری، فقط نام کوچک نمایش داده می‌شود. تصویر پروفایل هم تا وقتی عکس ندازی، همین حرف اول نامت است.</Text>
              </View>

              {!!error && (
                <View style={styles.errorRow} accessibilityRole="alert">
                  <FontAwesome6 name="circle-exclamation" size={13} color={colors.danger} />
                  <Text style={styles.error}>{error}</Text>
                </View>
              )}

              <Pressable
                style={[styles.submit, busy && styles.submitBusy]}
                onPress={submitName}
                disabled={busy}
                accessibilityRole="button"
                accessibilityLabel="ساخت حساب و ورود"
                accessibilityState={{ disabled: busy, busy }}
              >
                {busyAction === 'signup' ? (
                  <ActivityIndicator color={colors.onAccent} />
                ) : (
                  <>
                    <FontAwesome6 name="user-plus" size={14} color={colors.onAccent} />
                    <Text style={styles.submitText}>ساخت حساب و ورود</Text>
                  </>
                )}
              </Pressable>

              <Pressable
                style={styles.switchBtn}
                onPress={() => setStep('username')}
                disabled={busy}
                accessibilityRole="button"
                accessibilityLabel="بازگشت به نام کاربری"
                accessibilityState={{ disabled: busy }}
              >
                <Text style={styles.linkText}>بازگشت به نام کاربری</Text>
              </Pressable>
            </>
          )}
        </View>

        <Text style={styles.footNote}>
          {step === 'phone'
            ? 'شماره، هویت تو در OpenBridge است. اگر حسابی نداشته باشی، بعد از تأیید کد در دو مرحله بعد نام کاربری و نامت را انتخاب می‌کنی.'
            : 'اگر شماره را اشتباه وارد کردی، از «تغییر شماره» یا «انصراف» استفاده کن.'}
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

    formHead: { gap: spacing.xs },
    formTitle: { color: colors.text1, fontFamily: fonts.bold, fontSize: type.lg, textAlign: 'right' },
    formSub: { color: colors.text3, fontFamily: fonts.regular, fontSize: type.sm, textAlign: 'right', lineHeight: 20 },

    tracker: { flexDirection: 'row-reverse', alignItems: 'center', gap: spacing.sm },
    trackerDots: { flexDirection: 'row-reverse', alignItems: 'center', gap: spacing.xs },
    trackerDot: {
      width: 8,
      height: 8,
      borderRadius: 4,
      backgroundColor: colors.border,
    },
    trackerDotDone: { backgroundColor: colors.accentSoft },
    trackerDotCurrent: { backgroundColor: colors.accent, width: 18 },
    trackerLabel: { color: colors.text3, fontFamily: fonts.regular, fontSize: type.xs },

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
    hint: { color: colors.text3, fontFamily: fonts.regular, fontSize: type.xs, textAlign: 'right', lineHeight: 18 },

    preview: {
      flexDirection: 'row-reverse',
      alignItems: 'center',
      gap: spacing.md,
      borderWidth: 1,
      borderColor: colors.border,
      borderRadius: radius.md,
      backgroundColor: colors.surface2,
      padding: spacing.md,
    },
    previewText: { flex: 1, gap: 2 },
    previewName: { color: colors.text1, fontFamily: fonts.semibold, fontSize: type.base, textAlign: 'right' },
    previewHandle: { color: colors.text3, fontFamily: fonts.regular, fontSize: type.xs, textAlign: 'right' },

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
