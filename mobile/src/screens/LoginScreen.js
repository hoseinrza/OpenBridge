import { useState } from 'react';
import { ActivityIndicator, KeyboardAvoidingView, Platform, Pressable, StyleSheet, Text, TextInput, View } from 'react-native';
import { useAuth } from '../context/AuthContext';
import { colors, fonts, radius } from '../theme';

export default function LoginScreen() {
  const { login } = useAuth();
  const [mode, setMode]         = useState('login'); // 'login' | 'register'
  const [username, setUsername] = useState('');
  const [password, setPassword] = useState('');
  const [error, setError]       = useState('');
  const [loading, setLoading]   = useState(false);

  async function submit() {
    const u = username.trim();
    if (!u)           { setError('نام کاربری را وارد کنید');    return; }
    if (u.length < 2) { setError('حداقل ۲ کاراکتر وارد کنید'); return; }
    if (!password)    { setError('رمز عبور را وارد کنید');      return; }
    if (mode === 'register' && password.length < 6) { setError('رمز عبور حداقل ۶ کاراکتر'); return; }

    setLoading(true);
    setError('');
    try {
      await login(u, password, mode);
    } catch (err) {
      setError(err.message ?? 'خطا در اتصال به سرور');
    } finally {
      setLoading(false);
    }
  }

  return (
    <KeyboardAvoidingView
      style={styles.page}
      behavior={Platform.OS === 'ios' ? 'padding' : undefined}
    >
      <View style={styles.card}>
        <Text style={styles.title}>OpenBridge</Text>
        <Text style={styles.sub}>
          {mode === 'login' ? 'به حساب کاربری خود وارد شوید' : 'حساب جدید بسازید'}
        </Text>

        <View style={styles.tabs}>
          <Pressable
            style={[styles.tab, mode === 'login' && styles.tabActive]}
            onPress={() => { setMode('login'); setError(''); }}
          >
            <Text style={[styles.tabText, mode === 'login' && styles.tabTextActive]}>ورود</Text>
          </Pressable>
          <Pressable
            style={[styles.tab, mode === 'register' && styles.tabActive]}
            onPress={() => { setMode('register'); setError(''); }}
          >
            <Text style={[styles.tabText, mode === 'register' && styles.tabTextActive]}>ثبت‌نام</Text>
          </Pressable>
        </View>

        <TextInput
          style={styles.input}
          value={username}
          onChangeText={(v) => { setUsername(v); setError(''); }}
          placeholder="نام کاربری..."
          placeholderTextColor={colors.t3}
          autoCapitalize="none"
          autoCorrect={false}
          maxLength={30}
          editable={!loading}
        />
        <TextInput
          style={styles.input}
          value={password}
          onChangeText={(v) => { setPassword(v); setError(''); }}
          placeholder="رمز عبور..."
          placeholderTextColor={colors.t3}
          secureTextEntry
          maxLength={100}
          editable={!loading}
        />

        {!!error && <Text style={styles.error}>{error}</Text>}

        <Pressable style={[styles.submitBtn, loading && styles.submitBtnDisabled]} onPress={submit} disabled={loading}>
          {loading
            ? <ActivityIndicator color="#fff" />
            : <Text style={styles.submitText}>{mode === 'login' ? 'ورود به چت' : 'ثبت‌نام'}</Text>}
        </Pressable>
      </View>
    </KeyboardAvoidingView>
  );
}

const styles = StyleSheet.create({
  page: { flex: 1, backgroundColor: colors.s0, alignItems: 'center', justifyContent: 'center', padding: 20 },
  card: {
    width: '100%', maxWidth: 360, backgroundColor: colors.s1,
    borderRadius: 22, borderWidth: 1, borderColor: colors.border,
    padding: 28, alignItems: 'center',
  },
  title: { fontFamily: fonts.bold, fontSize: 24, color: colors.t1, marginBottom: 6 },
  sub:   { fontFamily: fonts.regular, fontSize: 13, color: colors.t3, marginBottom: 18, textAlign: 'center' },

  tabs: {
    flexDirection: 'row', width: '100%', backgroundColor: colors.s2,
    borderRadius: radius.md, padding: 3, marginBottom: 16, gap: 3,
  },
  tab:           { flex: 1, paddingVertical: 9, borderRadius: radius.md - 2, alignItems: 'center' },
  tabActive:     { backgroundColor: colors.s3 },
  tabText:       { fontFamily: fonts.semibold, fontSize: 13, color: colors.t3 },
  tabTextActive: { color: colors.t1 },

  input: {
    width: '100%', backgroundColor: colors.s2, borderWidth: 1, borderColor: colors.border,
    borderRadius: radius.md, paddingHorizontal: 16, paddingVertical: 13,
    fontFamily: fonts.regular, fontSize: 14, color: colors.t1, marginBottom: 10, textAlign: 'right',
  },
  error: { color: colors.red, fontFamily: fonts.regular, fontSize: 12, alignSelf: 'flex-end', marginBottom: 8 },

  submitBtn:         { width: '100%', backgroundColor: colors.accent, borderRadius: radius.md, paddingVertical: 13, alignItems: 'center', marginTop: 6 },
  submitBtnDisabled: { opacity: 0.7 },
  submitText:        { color: '#fff', fontFamily: fonts.semibold, fontSize: 15 },
});
