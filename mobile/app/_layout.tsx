import React from 'react';
import { View, Text, ActivityIndicator, StyleSheet, TouchableOpacity, Linking } from 'react-native';
import { Stack, usePathname, useRouter } from 'expo-router';
import { StatusBar } from 'expo-status-bar';
import { AppBootstrapProvider, useAppBootstrap } from '../src/context/AppBootstrapContext';
import { AuthProvider, useAuth } from '../src/context/AuthContext';
import { solarProTheme } from '../src/theme/solarProTheme';

const { colors } = solarProTheme;

function BootstrapGate({ children }: { children: React.ReactNode }) {
  const { ready, error } = useAppBootstrap();

  if (error) {
    return (
      <View style={styles.center}>
        <Text style={styles.errorTitle}>Database Error</Text>
        <Text style={styles.errorMsg}>{error}</Text>
      </View>
    );
  }

  if (!ready) {
    return (
      <View style={styles.center}>
        <ActivityIndicator size="large" color={colors.primary} />
        <Text style={styles.loadingText}>Initialising...</Text>
      </View>
    );
  }

  return <>{children}</>;
}

function AuthGate({ children }: { children: React.ReactNode }) {
  const router = useRouter();
  const pathname = usePathname();
  const { user, loading, signInWithSolarPro } = useAuth();

  // Handle sitesurvey://login?token=<jwt> deep links for SolarPro SSO
  React.useEffect(() => {
    async function handleDeepLink(url: string) {
      try {
        const parsed = new URL(url);
        if (parsed.protocol === 'sitesurvey:' && parsed.hostname === 'login') {
          const token = parsed.searchParams.get('token');
          if (token) {
            await signInWithSolarPro(token);
            router.replace('/');
          }
        }
      } catch {
        // Ignore malformed URLs
      }
    }

    // Handle deep link that launched the app
    Linking.getInitialURL().then((url) => {
      if (url) handleDeepLink(url);
    });

    // Handle deep links while app is already open
    const sub = Linking.addEventListener('url', ({ url }) => handleDeepLink(url));
    return () => sub.remove();
  }, [signInWithSolarPro, router]);

  React.useEffect(() => {
    if (loading) return;

    const authRoutes = new Set(['/login', '/register', '/forgot-password']);
    const onAuthRoute = authRoutes.has(pathname);

    if (!user && !onAuthRoute) {
      router.replace('/login');
      return;
    }

    if (user && onAuthRoute) {
      router.replace('/');
    }
  }, [loading, pathname, router, user]);

  if (loading) {
    return (
      <View style={styles.center}>
        <ActivityIndicator size="large" color={colors.primary} />
        <Text style={styles.loadingText}>Checking session...</Text>
      </View>
    );
  }

  return <>{children}</>;
}

function FloatingHomeButton() {
  const router = useRouter();

  return (
    <TouchableOpacity
      style={styles.homeFab}
      onPress={() => router.replace('/')}
      accessibilityRole="button"
      accessibilityLabel="Go Home"
    >
      <Text style={styles.homeFabIcon}>⌂</Text>
      <Text style={styles.homeFabText}>Home</Text>
    </TouchableOpacity>
  );
}

export default function RootLayout() {
  return (
    <AppBootstrapProvider>
      <AuthProvider>
        <StatusBar style="light" />
        <BootstrapGate>
          <AuthGate>
            <View style={styles.rootShell}>
              <Stack
                screenOptions={{
                  headerStyle: { backgroundColor: colors.card },
                  headerTintColor: colors.textPrimary,
                  headerTitleStyle: { fontWeight: '700', fontSize: 18 },
                  contentStyle: { backgroundColor: colors.background },
                }}
              >
                <Stack.Screen name="index" options={{ title: 'Site Surveys', headerShown: false }} />
                <Stack.Screen name="login" options={{ title: 'Sign In', headerShown: false }} />
                <Stack.Screen name="register" options={{ title: 'Create Account', headerShown: false }} />
                <Stack.Screen name="forgot-password" options={{ title: 'Reset Password', headerShown: false }} />
                <Stack.Screen name="new-survey" options={{ title: 'New Survey', headerShown: true }} />
                <Stack.Screen name="survey/[id]" options={{ title: 'Survey Details', headerShown: true }} />
              </Stack>
              <FloatingHomeButton />
            </View>
          </AuthGate>
        </BootstrapGate>
      </AuthProvider>
    </AppBootstrapProvider>
  );
}

const styles = StyleSheet.create({
  rootShell: {
    flex: 1,
  },
  center: {
    flex: 1,
    alignItems: 'center',
    justifyContent: 'center',
    backgroundColor: colors.background,
    padding: 24,
  },
  errorTitle: { fontSize: 18, fontWeight: '700', color: colors.errorText, marginBottom: 8 },
  errorMsg: { fontSize: 14, color: colors.textSecondary, textAlign: 'center' },
  loadingText: { fontSize: 14, color: colors.textSecondary, marginTop: 12 },
  homeFab: {
    position: 'absolute',
    left: 16,
    bottom: 84,
    backgroundColor: colors.primary,
    borderRadius: 22,
    minHeight: 44,
    paddingHorizontal: 12,
    paddingVertical: 8,
    alignItems: 'center',
    justifyContent: 'center',
    flexDirection: 'row',
    gap: 6,
    shadowColor: colors.primary,
    shadowOffset: { width: 0, height: 6 },
    shadowOpacity: 0.28,
    shadowRadius: 10,
    elevation: 8,
    zIndex: 999,
  },
  homeFabIcon: {
    color: colors.background,
    fontSize: 15,
    fontWeight: '900',
    lineHeight: 17,
  },
  homeFabText: {
    color: colors.background,
    fontSize: 13,
    fontWeight: '800',
    letterSpacing: 0.2,
  },
});
