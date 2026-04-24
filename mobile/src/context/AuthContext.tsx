import AsyncStorage from '@react-native-async-storage/async-storage';
import React, { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState } from 'react';
import {
  fetchCurrentUser,
  forgotPassword,
  logout as apiLogout,
  refreshAccessToken,
  register,
  resetPassword,
  signIn,
  solarproSso,
  type AuthUser,
} from '../api/client';

// Bump key version to invalidate stale sessions after auth flow rollout.
const AUTH_TOKEN_KEY = 'site-survey.auth.token.v2';
const REFRESH_TOKEN_KEY = 'site-survey.auth.refresh-token.v1';

// Refresh the access token this many ms before it expires (2 minutes)
const REFRESH_BUFFER_MS = 2 * 60 * 1000;

async function getStoredToken(): Promise<string | null> {
  if (!AsyncStorage || typeof AsyncStorage.getItem !== 'function') return null;
  try { return await AsyncStorage.getItem(AUTH_TOKEN_KEY); } catch { return null; }
}

async function setStoredToken(token: string): Promise<void> {
  if (!AsyncStorage || typeof AsyncStorage.setItem !== 'function') return;
  try { await AsyncStorage.setItem(AUTH_TOKEN_KEY, token); } catch { /* ignore */ }
}

async function clearStoredToken(): Promise<void> {
  if (!AsyncStorage || typeof AsyncStorage.removeItem !== 'function') return;
  try { await AsyncStorage.removeItem(AUTH_TOKEN_KEY); } catch { /* ignore */ }
}

async function getStoredRefreshToken(): Promise<string | null> {
  if (!AsyncStorage || typeof AsyncStorage.getItem !== 'function') return null;
  try { return await AsyncStorage.getItem(REFRESH_TOKEN_KEY); } catch { return null; }
}

async function setStoredRefreshToken(token: string): Promise<void> {
  if (!AsyncStorage || typeof AsyncStorage.setItem !== 'function') return;
  try { await AsyncStorage.setItem(REFRESH_TOKEN_KEY, token); } catch { /* ignore */ }
}

async function clearStoredRefreshToken(): Promise<void> {
  if (!AsyncStorage || typeof AsyncStorage.removeItem !== 'function') return;
  try { await AsyncStorage.removeItem(REFRESH_TOKEN_KEY); } catch { /* ignore */ }
}

/** Parse the exp claim from a JWT without verifying the signature. */
function getTokenExpMs(token: string): number | null {
  try {
    const payload = token.split('.')[1];
    if (!payload) return null;
    const decoded = JSON.parse(atob(payload)) as { exp?: number };
    if (typeof decoded.exp !== 'number') return null;
    return decoded.exp * 1000;
  } catch {
    return null;
  }
}

interface AuthContextValue {
  user: AuthUser | null;
  token: string | null;
  loading: boolean;
  signInWithPassword: (identifier: string, password: string) => Promise<void>;
  signInWithSolarPro: (token: string) => Promise<void>;
  registerWithPassword: (email: string, password: string, fullName: string) => Promise<void>;
  requestPasswordReset: (email: string) => Promise<{ message: string; resetToken?: string; expiresInMinutes?: number }>;
  completePasswordReset: (email: string, token: string, newPassword: string) => Promise<{ message: string }>;
  signOut: () => Promise<void>;
}

const AuthContext = createContext<AuthContextValue | null>(null);

export function AuthProvider({ children }: { children: React.ReactNode }) {
  const [user, setUser] = useState<AuthUser | null>(null);
  const [token, setToken] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const refreshTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const refreshTokenRef = useRef<string | null>(null);

  const refreshSession = useCallback(async (storedRefreshToken: string): Promise<string | null> => {
    try {
      const result = await refreshAccessToken(storedRefreshToken);
      await setStoredToken(result.token);
      await setStoredRefreshToken(result.refreshToken);
      refreshTokenRef.current = result.refreshToken;
      setToken(result.token);
      return result.token;
    } catch {
      await clearStoredToken();
      await clearStoredRefreshToken();
      refreshTokenRef.current = null;
      setToken(null);
      setUser(null);
      return null;
    }
  }, []);

  /** Schedule a proactive token refresh REFRESH_BUFFER_MS before expiry. */
  const scheduleRefresh = useCallback((accessToken: string, storedRefreshToken: string) => {
    if (refreshTimerRef.current) {
      clearTimeout(refreshTimerRef.current);
      refreshTimerRef.current = null;
    }

    const expMs = getTokenExpMs(accessToken);
    if (!expMs) return;

    const delay = expMs - Date.now() - REFRESH_BUFFER_MS;
    if (delay <= 0) {
      void (async () => {
        const nextAccessToken = await refreshSession(storedRefreshToken);
        if (!nextAccessToken) return;
        scheduleRefresh(nextAccessToken, refreshTokenRef.current || storedRefreshToken);
      })();
      return;
    }

    refreshTimerRef.current = setTimeout(async () => {
      try {
        const result = await refreshAccessToken(storedRefreshToken);
        await setStoredToken(result.token);
        await setStoredRefreshToken(result.refreshToken);
        refreshTokenRef.current = result.refreshToken;
        setToken(result.token);
        scheduleRefresh(result.token, result.refreshToken);
      } catch {
        // Refresh failed — sign the user out gracefully
        await clearStoredToken();
        await clearStoredRefreshToken();
        refreshTokenRef.current = null;
        setToken(null);
        setUser(null);
      }
    }, delay);
  }, [refreshSession]);

  const signOut = useCallback(async () => {
    if (refreshTimerRef.current) clearTimeout(refreshTimerRef.current);
    await apiLogout(refreshTokenRef.current);
    await clearStoredToken();
    await clearStoredRefreshToken();
    refreshTokenRef.current = null;
    setToken(null);
    setUser(null);
  }, []);

  useEffect(() => {
    let mounted = true;

    async function restoreSession() {
      try {
        const savedToken = await getStoredToken();
        if (!savedToken) return;

        const savedRefreshToken = await getStoredRefreshToken();
        refreshTokenRef.current = savedRefreshToken;

        let activeToken = savedToken;
        let currentUser: AuthUser | null = null;

        try {
          currentUser = await fetchCurrentUser(savedToken);
        } catch {
          if (savedRefreshToken) {
            const refreshedToken = await refreshSession(savedRefreshToken);
            if (refreshedToken) {
              activeToken = refreshedToken;
              currentUser = await fetchCurrentUser(refreshedToken);
            }
          }
        }

        if (!mounted || !currentUser) return;

        setToken(activeToken);
        setUser(currentUser);

        if (refreshTokenRef.current) {
          scheduleRefresh(activeToken, refreshTokenRef.current);
        }
      } catch {
        await clearStoredToken();
        await clearStoredRefreshToken();
      } finally {
        if (mounted) setLoading(false);
      }
    }

    restoreSession();
    return () => {
      mounted = false;
      if (refreshTimerRef.current) clearTimeout(refreshTimerRef.current);
    };
  }, [refreshSession, scheduleRefresh]);

  const signInWithPassword = useCallback(async (identifier: string, password: string) => {
    const result = await signIn(identifier, password);
    await setStoredToken(result.token);
    if (result.refreshToken) {
      await setStoredRefreshToken(result.refreshToken);
      refreshTokenRef.current = result.refreshToken;
      scheduleRefresh(result.token, result.refreshToken);
    }
    setToken(result.token);
    setUser(result.user);
  }, [scheduleRefresh]);

  const signInWithSolarPro = useCallback(async (token: string) => {
    const result = await solarproSso(token);
    await setStoredToken(result.token);
    if (result.refreshToken) {
      await setStoredRefreshToken(result.refreshToken);
      refreshTokenRef.current = result.refreshToken;
      scheduleRefresh(result.token, result.refreshToken);
    }
    setToken(result.token);
    setUser(result.user);
  }, [scheduleRefresh]);

  const registerWithPassword = useCallback(async (email: string, password: string, fullName: string) => {
    const result = await register({ email, password, fullName });
    await setStoredToken(result.token);
    if (result.refreshToken) {
      await setStoredRefreshToken(result.refreshToken);
      refreshTokenRef.current = result.refreshToken;
      scheduleRefresh(result.token, result.refreshToken);
    }
    setToken(result.token);
    setUser(result.user);
  }, [scheduleRefresh]);

  const requestPasswordReset = useCallback(async (email: string) => {
    const result = await forgotPassword(email);
    return {
      message: result.message,
      resetToken: result.resetToken,
      expiresInMinutes: result.expiresInMinutes,
    };
  }, []);

  const completePasswordReset = useCallback(async (email: string, tokenValue: string, newPassword: string) => {
    return resetPassword(email, tokenValue, newPassword);
  }, []);

  const value = useMemo<AuthContextValue>(
    () => ({
      user,
      token,
      loading,
      signInWithPassword,
      signInWithSolarPro,
      registerWithPassword,
      requestPasswordReset,
      completePasswordReset,
      signOut,
    }),
    [
      user,
      token,
      loading,
      signInWithPassword,
      signInWithSolarPro,
      registerWithPassword,
      requestPasswordReset,
      completePasswordReset,
      signOut,
    ]
  );

  return <AuthContext.Provider value={value}>{children}</AuthContext.Provider>;
}

export function useAuth() {
  const context = useContext(AuthContext);
  if (!context) {
    throw new Error('useAuth must be used within AuthProvider');
  }
  return context;
}
