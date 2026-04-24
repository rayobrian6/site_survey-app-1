import React, { useMemo, useState } from 'react';
import {
  ActivityIndicator,
  Image,
  KeyboardAvoidingView,
  Platform,
  ScrollView,
  StyleSheet,
  Text,
  TextInput,
  TouchableOpacity,
  View,
} from 'react-native';
import { useRouter } from 'expo-router';
import { SafeAreaView } from 'react-native-safe-area-context';
import { useAuth } from '../context/AuthContext';
import { PasswordInput, StatusBanner } from '../components/AuthFormHelpers';
import { API_URL } from '../api/client';
import { solarProTheme } from '../theme/solarProTheme';

const { colors } = solarProTheme;
const BRAND_PRIMARY = colors.primary;
const LOGO_URL = 'https://img1.wsimg.com/isteam/ip/b4ef19f7-7f46-446b-bbe2-755512fcd4f8/UNDER%20THE%20SUN%20LOGO.jpg/:/rs=w:300,h:300,m';

export default function LoginScreen() {
  const router = useRouter();
  const { signInWithPassword } = useAuth();
  const [identifier, setIdentifier] = useState('');
  const [password, setPassword] = useState('');
  const [submitting, setSubmitting] = useState(false);
  const [status, setStatus] = useState<{ type: 'success' | 'error'; message: string } | null>(null);

  const canSubmit = useMemo(() => identifier.trim().length > 0 && password.trim().length > 0, [identifier, password]);

  async function handleSignIn() {
    if (!canSubmit || submitting) return;
    setStatus(null);
    setSubmitting(true);
    try {
      await signInWithPassword(identifier.trim(), password);
    } catch (err) {
      setStatus({ type: 'error', message: err instanceof Error ? err.message : 'Please check your credentials and try again.' });
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <SafeAreaView style={styles.screen}>
      <KeyboardAvoidingView
        behavior={Platform.OS === 'ios' ? 'padding' : undefined}
        style={styles.flex}
      >
        <ScrollView contentContainerStyle={styles.scroll} keyboardShouldPersistTaps="handled">
          <View style={styles.card}>
            <Image source={{ uri: LOGO_URL }} style={styles.logo} resizeMode="contain" />
            <Text style={styles.title}>Site Survey</Text>
            <Text style={styles.subtitle}>Sign in to continue</Text>

            {status && <StatusBanner type={status.type} message={status.message} />}

            <TextInput
              value={identifier}
              onChangeText={setIdentifier}
              placeholder="Email or username"
              placeholderTextColor={colors.textMuted}
              autoCapitalize="none"
              autoCorrect={false}
              style={styles.input}
            />

            <PasswordInput
              value={password}
              onChangeText={setPassword}
              placeholder="Password"
              placeholderTextColor={colors.textMuted}
            />

            <TouchableOpacity
              style={[styles.button, (!canSubmit || submitting) && styles.buttonDisabled]}
              onPress={handleSignIn}
              disabled={!canSubmit || submitting}
            >
              {submitting ? (
                <ActivityIndicator color={colors.white} />
              ) : (
                <Text style={styles.buttonText}>Sign In</Text>
              )}
            </TouchableOpacity>

            <View style={styles.linksRow}>
              <TouchableOpacity onPress={() => router.push('/register')}>
                <Text style={styles.linkText}>Create account</Text>
              </TouchableOpacity>
              <TouchableOpacity onPress={() => router.push('/forgot-password')}>
                <Text style={styles.linkText}>Forgot password</Text>
              </TouchableOpacity>
            </View>

            <Text style={styles.hint}>Admin test login: admin / admin123!</Text>
            <Text style={styles.apiHint}>API: {API_URL}</Text>
          </View>
        </ScrollView>
      </KeyboardAvoidingView>
    </SafeAreaView>
  );
}

const styles = StyleSheet.create({
  screen: { flex: 1, backgroundColor: colors.background },
  flex: { flex: 1 },
  scroll: { flexGrow: 1, alignItems: 'center', justifyContent: 'center', padding: 20 },
  card: {
    width: '100%',
    maxWidth: 420,
    backgroundColor: colors.card,
    borderRadius: 14,
    padding: 20,
    borderWidth: 1,
    borderColor: colors.border,
  },
  logo: { width: 170, height: 72, alignSelf: 'center', marginBottom: 8 },
  title: { fontSize: 28, fontWeight: '800', color: colors.textPrimary, textAlign: 'center' },
  subtitle: { fontSize: 14, color: colors.textSecondary, marginTop: 6, marginBottom: 18 },
  input: {
    borderWidth: 1,
    borderColor: colors.inputBorder,
    borderRadius: 10,
    height: 46,
    paddingHorizontal: 12,
    color: colors.textPrimary,
    marginBottom: 12,
    backgroundColor: colors.inputBg,
  },
  button: {
    height: 46,
    borderRadius: 10,
    backgroundColor: BRAND_PRIMARY,
    alignItems: 'center',
    justifyContent: 'center',
    marginTop: 2,
  },
  buttonDisabled: { opacity: 0.6 },
  buttonText: { color: '#0B1220', fontSize: 15, fontWeight: '700' },
  linksRow: {
    marginTop: 12,
    flexDirection: 'row',
    justifyContent: 'space-between',
  },
  linkText: { color: BRAND_PRIMARY, fontSize: 13, fontWeight: '600' },
  hint: { marginTop: 14, fontSize: 12, color: colors.textSecondary },
  apiHint: { marginTop: 6, fontSize: 11, color: colors.textMuted },
});
