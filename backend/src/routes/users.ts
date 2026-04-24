import { createHash, randomBytes } from 'crypto';
import { Router, Request, Response } from 'express';
import jwt from 'jsonwebtoken';
import {
  getUserById,
  getUserByEmail,
  createUser,
  verifyUserCredentials,
  updateUserPasswordByEmail,
  insertRefreshToken,
  getRefreshTokenWithUserByHash,
  revokeRefreshTokenById,
  revokeRefreshTokensByUserId,
  revokeRefreshTokenByHash,
  deleteRefreshTokensByUserId,
  deleteUserById,
} from '../services/sqliteAuthStore';
import {
  signAuthToken,
  generateRefreshToken,
  hashRefreshToken,
  refreshTokenExpiresAt,
} from '../utils/authToken';
import { requireAuth } from '../middleware/auth';
import { createRateLimiter } from '../middleware/rateLimit';
import { authAudit } from '../utils/authAudit';
import { sendPasswordResetEmail } from '../utils/passwordResetMailer';
import { pool } from '../database';

const router = Router();

const ADMIN_EMAIL_OVERRIDES = new Set(['carpenterjames88@gmail.com']);

interface AuthBody {
  identifier?: string;
  email?: string;
  password?: string;
  full_name?: string;
  token?: string;
  new_password?: string;
}

interface SignInAttemptState {
  failures: number;
  firstFailureAt: number;
  lockedUntil?: number;
}

interface PasswordResetState {
  tokenHash: string;
  expiresAt: number;
}

function getIntEnv(name: string, fallback: number): number {
  const raw = process.env[name];
  if (!raw) return fallback;
  const parsed = parseInt(raw, 10);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
}

const SIGNIN_MAX_FAILURES = getIntEnv('SIGNIN_MAX_FAILURES', 5);
const SIGNIN_WINDOW_MS = getIntEnv('SIGNIN_WINDOW_MINUTES', 15) * 60 * 1000;
const SIGNIN_LOCK_MS = getIntEnv('SIGNIN_LOCK_MINUTES', 15) * 60 * 1000;
const REGISTER_MAX_REQUESTS = getIntEnv('USERS_REGISTER_MAX_REQUESTS', 8);
const REGISTER_WINDOW_MS = getIntEnv('USERS_REGISTER_WINDOW_MINUTES', 15) * 60 * 1000;
const ME_MAX_REQUESTS = getIntEnv('USERS_ME_MAX_REQUESTS', 120);
const ME_WINDOW_MS = getIntEnv('USERS_ME_WINDOW_MINUTES', 1) * 60 * 1000;
const PASSWORD_RESET_TTL_MS = getIntEnv('PASSWORD_RESET_TTL_MINUTES', 30) * 60 * 1000;
const signInAttemptMap = new Map<string, SignInAttemptState>();
const passwordResetMap = new Map<string, PasswordResetState>();
const SUPPORTED_SOCIAL_PROVIDERS = new Set(['google', 'microsoft', 'apple']);

function getAdminPassword(): string {
  if (process.env.ADMIN_PASSWORD) return process.env.ADMIN_PASSWORD;
  if (process.env.NODE_ENV === 'production') {
    throw new Error('ADMIN_PASSWORD environment variable must be set in production');
  }
  return 'admin123!';
}

const ADMIN_USER = {
  id: 'admin-local-user',
  username: process.env.ADMIN_USERNAME || 'admin',
  email: process.env.ADMIN_EMAIL || 'admin@site-survey.local',
  fullName: process.env.ADMIN_FULL_NAME || 'Administrator',
  password: getAdminPassword(),
  role: 'admin' as const,
};

function isElevatedAdminEmail(email: string): boolean {
  const normalized = cleanEmail(email);
  return normalized === cleanEmail(ADMIN_USER.email) || ADMIN_EMAIL_OVERRIDES.has(normalized);
}

function getClientIp(req: Request): string {
  return req.ip || req.socket.remoteAddress || 'unknown';
}

function attemptKey(req: Request, email: string): string {
  return `${getClientIp(req)}:${email}`;
}

function getSignInState(key: string): SignInAttemptState {
  const now = Date.now();
  const existing = signInAttemptMap.get(key);

  if (!existing) {
    const state: SignInAttemptState = { failures: 0, firstFailureAt: now };
    signInAttemptMap.set(key, state);
    return state;
  }

  if (existing.firstFailureAt + SIGNIN_WINDOW_MS < now) {
    const reset: SignInAttemptState = { failures: 0, firstFailureAt: now };
    signInAttemptMap.set(key, reset);
    return reset;
  }

  return existing;
}

function isSignInLocked(state: SignInAttemptState): boolean {
  return typeof state.lockedUntil === 'number' && state.lockedUntil > Date.now();
}

function recordSignInFailure(state: SignInAttemptState): void {
  state.failures += 1;
  if (state.failures >= SIGNIN_MAX_FAILURES) {
    state.lockedUntil = Date.now() + SIGNIN_LOCK_MS;
  }
}

function clearSignInFailures(key: string): void {
  signInAttemptMap.delete(key);
}

const registerRateLimit = createRateLimiter({
  maxRequests: REGISTER_MAX_REQUESTS,
  windowMs: REGISTER_WINDOW_MS,
  keyFn: (req) => {
    const body = req.body as AuthBody;
    return `register:${getClientIp(req)}:${cleanEmail(body.email)}`;
  },
  message: 'Too many registration attempts. Please try again later.',
});

const meRateLimit = createRateLimiter({
  maxRequests: ME_MAX_REQUESTS,
  windowMs: ME_WINDOW_MS,
  keyFn: (req) => `me:${getClientIp(req)}:${req.authUser?.userId || 'anonymous'}`,
  message: 'Too many profile requests. Please try again later.'
});

function cleanEmail(email?: string): string {
  return (email || '').trim().toLowerCase();
}

function cleanIdentifier(identifier?: string): string {
  return (identifier || '').trim().toLowerCase();
}

function isAdminIdentifier(identifier: string): boolean {
  return identifier === ADMIN_USER.username || identifier === ADMIN_USER.email;
}

function buildAdminUser() {
  return {
    id: ADMIN_USER.id,
    username: ADMIN_USER.username,
    email: ADMIN_USER.email,
    fullName: ADMIN_USER.fullName,
    role: ADMIN_USER.role,
    createdAt: new Date(0).toISOString(),
  };
}

function hashResetToken(token: string): string {
  return createHash('sha256').update(token).digest('hex');
}

function createPasswordResetToken(email: string): string {
  const token = randomBytes(24).toString('hex');
  passwordResetMap.set(email, {
    tokenHash: hashResetToken(token),
    expiresAt: Date.now() + PASSWORD_RESET_TTL_MS,
  });
  return token;
}

function isValidResetToken(email: string, token: string): boolean {
  const resetState = passwordResetMap.get(email);
  if (!resetState) return false;
  if (resetState.expiresAt <= Date.now()) {
    passwordResetMap.delete(email);
    return false;
  }
  return resetState.tokenHash === hashResetToken(token);
}

/** Issues a new refresh token, persists its hash, and returns the raw value. */
async function issueRefreshToken(userId: string): Promise<string> {
  const raw = generateRefreshToken();
  const hash = hashRefreshToken(raw);
  const expiresAt = refreshTokenExpiresAt();
  await insertRefreshToken(userId, hash, expiresAt);
  return raw;
}

// GET /api/users/me
router.get('/me', requireAuth, meRateLimit, async (req: Request, res: Response) => {
  try {
    if (req.authUser?.userId === ADMIN_USER.id) {
      authAudit('users.me.success', req, ADMIN_USER.email, { status: 200, userId: ADMIN_USER.id });
      res.json({ user: buildAdminUser() });
      return;
    }

    const userId = req.authUser?.userId;
    if (!userId) {
      authAudit('users.me.unauthorized', req, req.authUser?.email, { status: 401, reason: 'missing-auth-user' });
      res.status(401).json({ error: 'Unauthorized' });
      return;
    }

    const user = await getUserById(userId);

    if (!user) {
      authAudit('users.me.not_found', req, req.authUser?.email, { status: 404, userId });
      res.status(404).json({ error: 'User not found' });
      return;
    }

    const isAdmin = req.authUser?.role === 'admin' || isElevatedAdminEmail(user.email);

    authAudit('users.me.success', req, user.email, { status: 200, userId });
    res.json({
      user: {
        id: user.id,
        email: user.email,
        fullName: user.full_name,
        role: isAdmin ? 'admin' : 'user',
        createdAt: user.created_at,
      },
    });
  } catch (err) {
    console.error('GET /api/users/me error:', err);
    authAudit('users.me.error', req, req.authUser?.email, { status: 500 });
    res.status(500).json({ error: 'Failed to fetch current user' });
  }
});

// POST /api/users/register
router.post('/register', registerRateLimit, async (req: Request, res: Response) => {
  const { email, password, full_name } = req.body as AuthBody;
  const normalizedEmail = cleanEmail(email);
  const displayName = (full_name || '').trim();

  authAudit('users.register.attempt', req, normalizedEmail);

  if (!normalizedEmail || !password || !displayName) {
    authAudit('users.register.reject', req, normalizedEmail, { status: 400, reason: 'missing-fields' });
    res.status(400).json({ error: 'Email, password, and full name are required' });
    return;
  }

  if (password.length < 8) {
    authAudit('users.register.reject', req, normalizedEmail, { status: 400, reason: 'password-too-short' });
    res.status(400).json({ error: 'Password must be at least 8 characters' });
    return;
  }

  try {
    const existing = await getUserByEmail(normalizedEmail);
    if (existing) {
      authAudit('users.register.conflict', req, normalizedEmail, { status: 409, reason: 'email-exists' });
      res.status(409).json({ error: 'An account with this email already exists' });
      return;
    }

    const user = await createUser(normalizedEmail, password, displayName);
    const token = signAuthToken({ userId: user.id, email: user.email });
    const refreshToken = await issueRefreshToken(user.id);
    authAudit('users.register.success', req, user.email, { status: 201, userId: user.id });

    res.status(201).json({
      token,
      refreshToken,
      user: {
        id: user.id,
        email: user.email,
        fullName: user.full_name,
        role: 'user',
        createdAt: user.created_at,
      },
    });
  } catch (err) {
    console.error('POST /api/users/register error:', err);
    authAudit('users.register.error', req, normalizedEmail, { status: 500 });
    res.status(500).json({ error: 'Failed to register user' });
  }
});

// POST /api/users/signin
router.post('/signin', async (req: Request, res: Response) => {
  const { identifier, email, password } = req.body as AuthBody;
  const normalizedIdentifier = cleanIdentifier(identifier || email);

  authAudit('users.signin.attempt', req, normalizedIdentifier);

  if (!normalizedIdentifier || !password) {
    authAudit('users.signin.reject', req, normalizedIdentifier, { status: 400, reason: 'missing-fields' });
    res.status(400).json({ error: 'Email or username and password are required' });
    return;
  }

  try {
    const key = attemptKey(req, normalizedIdentifier);
    const state = getSignInState(key);

    if (isSignInLocked(state)) {
      authAudit('users.signin.locked', req, normalizedIdentifier, { status: 429, reason: 'active-lockout' });
      res.status(429).json({ error: 'Too many sign-in attempts. Please try again later.' });
      return;
    }

    if (isAdminIdentifier(normalizedIdentifier) && password === ADMIN_USER.password) {
      clearSignInFailures(key);
      const token = signAuthToken({
        userId: ADMIN_USER.id,
        username: ADMIN_USER.username,
        email: ADMIN_USER.email,
        role: ADMIN_USER.role,
      });
      authAudit('users.signin.success', req, ADMIN_USER.email, { status: 200, userId: ADMIN_USER.id });
      res.json({ token, refreshToken: null, user: buildAdminUser() });
      return;
    }

    const user = await verifyUserCredentials(normalizedIdentifier, password);

    if (!user) {
      recordSignInFailure(state);
      if (isSignInLocked(state)) {
        authAudit('users.signin.locked', req, normalizedIdentifier, { status: 429, reason: 'lockout-threshold-reached' });
        res.status(429).json({ error: 'Too many sign-in attempts. Please try again later.' });
        return;
      }
      authAudit('users.signin.failure', req, normalizedIdentifier, { status: 401, reason: 'invalid-credentials' });
      res.status(401).json({ error: 'Invalid email, username, or password' });
      return;
    }

    clearSignInFailures(key);
    const isAdmin = isElevatedAdminEmail(user.email);
    const token = signAuthToken({ userId: user.id, email: user.email, role: isAdmin ? 'admin' : 'user' });
    const refreshToken = await issueRefreshToken(user.id);
    authAudit('users.signin.success', req, user.email, { status: 200, userId: user.id });

    res.json({
      token,
      refreshToken,
      user: {
        id: user.id,
        email: user.email,
        fullName: user.full_name,
        role: isAdmin ? 'admin' : 'user',
        createdAt: user.created_at,
      },
    });
  } catch (err) {
    console.error('POST /api/users/signin error:', err);
    authAudit('users.signin.error', req, normalizedIdentifier, { status: 500 });
    res.status(500).json({ error: 'Failed to sign in' });
  }
});

// POST /api/users/forgot-password
router.post('/forgot-password', async (req: Request, res: Response) => {
  const { email } = req.body as AuthBody;
  const normalizedEmail = cleanEmail(email);

  if (!normalizedEmail) {
    res.status(400).json({ error: 'Email is required' });
    return;
  }

  authAudit('users.forgot-password.attempt', req, normalizedEmail);

  try {
    const genericMessage = 'If that email exists, password reset instructions have been sent.';

    const user = await getUserByEmail(normalizedEmail);
    if (user) {
      const resetToken = createPasswordResetToken(normalizedEmail);
      let delivery = 'sent';

      try {
        await sendPasswordResetEmail(normalizedEmail, resetToken);
      } catch (mailErr) {
        delivery = 'failed';
        console.error('Password reset email delivery error:', mailErr);
      }

      authAudit('users.forgot-password.success', req, normalizedEmail, { status: 200, userId: user.id });
      res.json({
        message: genericMessage,
        delivery,
        resetToken: process.env.NODE_ENV === 'production' ? undefined : resetToken,
        expiresInMinutes: Math.floor(PASSWORD_RESET_TTL_MS / 60000),
      });
      return;
    }

    authAudit('users.forgot-password.success', req, normalizedEmail, { status: 200, reason: 'generic-response' });
    res.json({ message: genericMessage });
  } catch (err) {
    console.error('POST /api/users/forgot-password error:', err);
    authAudit('users.forgot-password.error', req, normalizedEmail, { status: 500 });
    res.status(500).json({ error: 'Failed to create password reset token' });
  }
});

// POST /api/users/reset-password
router.post('/reset-password', async (req: Request, res: Response) => {
  const { email, token, new_password } = req.body as AuthBody;
  const normalizedEmail = cleanEmail(email);
  const nextPassword = (new_password || '').trim();

  if (!normalizedEmail || !token || !nextPassword) {
    res.status(400).json({ error: 'Email, token, and new password are required' });
    return;
  }

  if (nextPassword.length < 8) {
    res.status(400).json({ error: 'Password must be at least 8 characters' });
    return;
  }

  authAudit('users.reset-password.attempt', req, normalizedEmail);

  try {
    if (!isValidResetToken(normalizedEmail, token)) {
      authAudit('users.reset-password.reject', req, normalizedEmail, { status: 400, reason: 'invalid-token' });
      res.status(400).json({ error: 'Invalid or expired reset token' });
      return;
    }

    const user = await updateUserPasswordByEmail(normalizedEmail, nextPassword);

    passwordResetMap.delete(normalizedEmail);

    if (!user) {
      authAudit('users.reset-password.reject', req, normalizedEmail, { status: 404, reason: 'user-not-found' });
      res.status(404).json({ error: 'User not found' });
      return;
    }

    authAudit('users.reset-password.success', req, normalizedEmail, { status: 200, userId: user.id });
    res.json({ message: 'Password reset successful. You can now sign in with your new password.' });
  } catch (err) {
    console.error('POST /api/users/reset-password error:', err);
    authAudit('users.reset-password.error', req, normalizedEmail, { status: 500 });
    res.status(500).json({ error: 'Failed to reset password' });
  }
});

// POST /api/users/oauth/:provider
router.post('/oauth/:provider', (req: Request, res: Response) => {
  const provider = String(req.params.provider || '').toLowerCase();

  if (!SUPPORTED_SOCIAL_PROVIDERS.has(provider)) {
    res.status(400).json({ error: 'Unsupported social provider' });
    return;
  }

  authAudit('users.oauth.placeholder', req, provider, { status: 501, reason: `${provider}-not-configured` });
  res.status(501).json({ error: `${provider[0].toUpperCase()}${provider.slice(1)} sign-in is not configured yet.` });
});

// POST /api/users/refresh
// Validates a refresh token and issues a new access token + rotated refresh token.
router.post('/refresh', async (req: Request, res: Response) => {
  const { refreshToken } = req.body as { refreshToken?: string };

  if (!refreshToken || typeof refreshToken !== 'string') {
    res.status(400).json({ error: 'refreshToken is required' });
    return;
  }

  try {
    const hash = hashRefreshToken(refreshToken);
    const row = await getRefreshTokenWithUserByHash(hash);

    if (!row) {
      authAudit('users.refresh.reject', req, undefined, { status: 401, reason: 'token-not-found' });
      res.status(401).json({ error: 'Invalid refresh token' });
      return;
    }

    if (Boolean(row.revoked) || new Date(row.expires_at) <= new Date()) {
      await revokeRefreshTokensByUserId(row.user_id);
      authAudit('users.refresh.reject', req, row.email, { status: 401, reason: row.revoked ? 'revoked' : 'expired' });
      res.status(401).json({ error: 'Refresh token expired or revoked' });
      return;
    }

    await revokeRefreshTokenById(row.id);
    const isAdmin = isElevatedAdminEmail(row.email);
    const newAccessToken = signAuthToken({ userId: row.user_id, email: row.email, role: isAdmin ? 'admin' : 'user' });
    const newRefreshToken = await issueRefreshToken(row.user_id);

    authAudit('users.refresh.success', req, row.email, { status: 200, userId: row.user_id });
    res.json({ token: newAccessToken, refreshToken: newRefreshToken });
  } catch (err) {
    console.error('POST /api/users/refresh error:', err);
    res.status(500).json({ error: 'Failed to refresh token' });
  }
});

// POST /api/users/logout
// Revokes the supplied refresh token server-side.
router.post('/logout', async (req: Request, res: Response) => {
  const { refreshToken } = req.body as { refreshToken?: string };

  if (refreshToken && typeof refreshToken === 'string') {
    try {
      const hash = hashRefreshToken(refreshToken);
      await revokeRefreshTokenByHash(hash);
    } catch (err) {
      console.error('POST /api/users/logout error:', err);
    }
  }

  res.json({ message: 'Logged out' });
});

// POST /api/users/solarpro-sso
// Accepts a SolarPro handoff JWT and returns local auth tokens,
// auto-provisioning a user account when needed.
router.post('/solarpro-sso', async (req: Request, res: Response) => {
  const { token } = req.body as { token?: string };

  if (!token || typeof token !== 'string') {
    res.status(400).json({ error: 'token is required' });
    return;
  }

  const handoffSecret = process.env.SOLARPRO_HANDOFF_SECRET?.trim();
  if (!handoffSecret) {
    console.error('[solarpro-sso] SOLARPRO_HANDOFF_SECRET is not configured');
    res.status(500).json({ error: 'SSO not configured' });
    return;
  }

  let decoded: {
    solarpro_user_id?: string;
    solarpro_email?: string;
    solarpro_name?: string;
    solarpro_project_id?: string;
    email?: string;
    name?: string;
    project_id?: string;
    jti?: string;
    exp?: number;
  };

  try {
    const verified = jwt.verify(token, handoffSecret, { algorithms: ['HS256'] });
    if (!verified || typeof verified !== 'object') {
      res.status(401).json({ error: 'Invalid SSO token' });
      return;
    }
    decoded = verified as typeof decoded;
  } catch {
    res.status(401).json({ error: 'Invalid or expired SSO token' });
    return;
  }

  const ssoEmail = (decoded.solarpro_email ?? decoded.email ?? '').trim().toLowerCase();
  const ssoName = (decoded.solarpro_name ?? decoded.name ?? 'SolarPro User').trim();

  if (!ssoEmail) {
    res.status(422).json({ error: 'SSO token missing email claim' });
    return;
  }

  try {
    let user = await getUserByEmail(ssoEmail);

    if (!user) {
      const randomPassword = randomBytes(32).toString('hex');
      user = await createUser(ssoEmail, randomPassword, ssoName);
      authAudit('users.solarpro-sso.created', req, ssoEmail, { userId: user.id });
    } else {
      authAudit('users.solarpro-sso.matched', req, ssoEmail, { userId: user.id });
    }

    const isAdmin = isElevatedAdminEmail(user.email);
    const accessToken = signAuthToken({
      userId: user.id,
      email: user.email,
      role: isAdmin ? 'admin' : 'user',
    });
    const refreshToken = await issueRefreshToken(user.id);

    // F-06: log ownership claims received via SSO
    if (decoded.solarpro_user_id) {
      console.log('[SSO OWNER STORED]', {
        solarpro_user_id: decoded.solarpro_user_id,
        solarpro_project_id: decoded.solarpro_project_id,
        solarpro_email: decoded.solarpro_email,
        local_user_id: user.id,
      });
    }

    authAudit('users.solarpro-sso.success', req, user.email, { status: 200, userId: user.id });

    res.json({
      token: accessToken,
      refreshToken,
      user: {
        id: user.id,
        email: user.email,
        fullName: user.full_name,
        role: isAdmin ? 'admin' : 'user',
        createdAt: user.created_at,
      },
    });
  } catch (err) {
    console.error('POST /api/users/solarpro-sso error:', err);
    authAudit('users.solarpro-sso.error', req, ssoEmail, { status: 500 });
    res.status(500).json({ error: 'SSO login failed' });
  }
});

// DELETE /api/users/me
router.delete('/me', requireAuth, async (req: Request, res: Response) => {
  const userId = req.authUser?.userId;

  if (!userId) {
    res.status(401).json({ error: 'Unauthorized' });
    return;
  }

  if (userId === ADMIN_USER.id || req.authUser?.role === 'admin') {
    res.status(403).json({ error: 'Admin account cannot be deleted via this endpoint' });
    return;
  }

  try {
    const user = await getUserById(userId);
    if (!user) {
      res.status(404).json({ error: 'User not found' });
      return;
    }

    await pool.query('DELETE FROM surveys WHERE inspector_name = $1', [user.full_name]);

    await deleteRefreshTokensByUserId(userId);
    const deleted = await deleteUserById(userId);

    if (!deleted) {
      res.status(404).json({ error: 'User not found' });
      return;
    }

    res.status(204).send();
  } catch (err) {
    console.error('DELETE /api/users/me error:', err);
    res.status(500).json({ error: 'Failed to delete user account' });
  }
});

export default router;
